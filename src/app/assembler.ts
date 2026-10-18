/**
 * The context assembler.
 *
 * Accepts `project + task + repository state + stored memory` and produces one
 * coherent working brief. It is a pure function: no SQL, no git, no MCP. That
 * keeps the heart of the system unit-testable and makes the brief reproducible.
 *
 * Responsibilities:
 *  - select only the memory that is relevant to this task (ranked, capped)
 *  - state preflight constraints, hazards and conflicts *before* the agent edits
 *  - distinguish stored facts from inference, always
 *  - end with exactly one recommended first action
 */
import type {
  CommitInfo,
  Confidence,
  Constraint,
  MemoryItem,
  Project,
  Repository,
  RepositoryObservation,
  Severity,
  Task,
  Verification,
} from '../domain/models.ts';
import type { ProjectConfig } from '../domain/models.ts';
import type { Clock } from '../util/time.ts';
import { humanAge, isoNow } from '../util/time.ts';
import { truncate } from '../util/text.ts';
import {
  CONFIDENCE_CRITERIA,
  CONFIDENCE_PROMOTION,
  confidenceRank,
  nextConfidence,
  severityWeight,
} from '../domain/vocabulary.ts';
import type { ContextMode, InferenceConfidence, TaskInterpretation } from './interpret.ts';
import { assessRisk } from './interpret.ts';
import type { RelevanceContext, ScoredItem } from './ranking.ts';
import { confidenceLabel, describeBug, rankItems, strongestSeverity } from './ranking.ts';
import { normalizeTerm } from '../util/text.ts';

// ---------------------------------------------------------------------------
// Brief shape
// ---------------------------------------------------------------------------

export interface BriefWarning {
  /** `critical` means "do not start before reading this". */
  level: 'critical' | 'warning' | 'info';
  text: string;
}

export interface BriefProject {
  slug: string;
  name: string;
  goal: string | null;
  phase: string | null;
  branch: string | null;
  head: string | null;
  headShort: string | null;
  headSubject: string | null;
  dirty: boolean;
  changedFileCount: number;
  untrackedFileCount: number;
  repositoryPath: string | null;
  repositoryName: string | null;
  /** How the project was identified for this call. */
  discoverySource: string;
  /** True when this call registered the project for the first time. */
  registeredNow: boolean;
  gitAvailable: boolean;
}

export interface BriefTask {
  text: string;
  taskId: string | null;
  status: string | null;
  priority: string | null;
  type: string;
  typeConfidence: InferenceConfidence;
  subsystem: string | null;
  subsystemConfidence: InferenceConfidence;
  likelyComponents: string[];
  affectedFiles: string[];
  inferredFiles: string[];
  /** Interpretation notes, prefixed so they are never mistaken for facts. */
  notes: string[];
  mode: ContextMode;
  interpretability: InferenceConfidence;
}

export interface BriefConstraint {
  id: string;
  statement: string;
  severity: Severity;
  subsystem: string | null;
  reason: string;
}

export interface BriefBug {
  id: string;
  title: string;
  severity: Severity;
  status: string;
  detail: string;
  files: string[];
  age: string;
}

export interface BriefDecision {
  id: string;
  statement: string;
  rationale: string | null;
  subsystem: string | null;
  age: string;
}

export interface BriefFinding {
  id: string;
  statement: string;
  confidence: Confidence;
  evidenceCount: number;
  symbols: string[];
  age: string;
}

export interface BriefAttempt {
  id: string;
  summary: string;
  completed: string | null;
  failures: string[];
  followUp: string[];
  age: string;
  /** HEAD recorded by the handoff, when it recorded one. */
  head: string | null;
}

export interface BriefVerification {
  id: string;
  method: string;
  command: string | null;
  result: string;
  age: string;
}

export interface BriefFollowUp {
  id: string;
  title: string;
  priority: string;
  status: string;
  blockers: string[];
}

export interface BriefReverseEngineering {
  enabled: boolean;
  /** Findings presented as established facts. */
  established: Array<{ id: string; statement: string; confidence: Confidence; age: string }>;
  /** Findings that still need work before they can be relied on. */
  open: Array<{ id: string; statement: string; confidence: Confidence; next: string | null; age: string }>;
  /** What it takes to promote confidence. */
  promotion: string[];
}

export interface Brief {
  generatedAt: string;
  project: BriefProject;
  task: BriefTask;
  constraints: BriefConstraint[];
  bugs: BriefBug[];
  decisions: BriefDecision[];
  findings: BriefFinding[];
  attempts: BriefAttempt[];
  verifications: BriefVerification[];
  likelyFiles: string[];
  /** Files with uncommitted changes, so the renderer can flag them. */
  uncommittedFiles: string[];
  recentCommits: Array<{ shortHash: string; subject: string; ago: string }>;
  recentlyChangedFiles: string[];
  risk: { level: Severity; reasons: string[] };
  approach: Array<{ text: string; source: 'memory' | 'template' }>;
  verificationPlan: {
    commands: string[];
    requirements: string[];
    manualChecks: string[];
    regressionAreas: string[];
    /** True when nothing at all is known about how to verify this work. */
    unknown: boolean;
  };
  nextAction: string;
  followUps: BriefFollowUp[];
  gaps: string[];
  warnings: BriefWarning[];
  reverseEngineering: BriefReverseEngineering | null;
  stats: {
    memoryConsidered: number;
    memorySelected: number;
    countsByKind: Record<string, number>;
  };
}

export interface AssembleBriefInput {
  project: Project;
  repository: Repository | null;
  observation: RepositoryObservation | null;
  config: ProjectConfig;
  /** Every memory item stored for the project. */
  items: readonly MemoryItem[];
  /** Full-text scores by record id. */
  fullTextScores: ReadonlyMap<string, number>;
  interpretation: TaskInterpretation;
  /** Task record created or matched for this call. */
  task: Task | null;
  /** Open tasks for the project, excluding the current task. */
  openTasks: readonly Task[];
  clock: Clock;
  /** Head recorded by the previous observation, for conflict detection. */
  previousHead: string | null;
  previousBranch: string | null;
  /** Relationship between the previous head and the current head. */
  headRelation: 'same' | 'advanced' | 'diverged' | 'unknown';
  commitsSincePrevious: number | null;
  discoverySource: string;
  registeredNow: boolean;
  /** Warnings collected earlier in the call (config, discovery). */
  warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Selection caps: what keeps the brief low-token and high-signal
// ---------------------------------------------------------------------------

export interface SelectionCaps {
  constraints: number;
  bugs: number;
  decisions: number;
  findings: number;
  attempts: number;
  verifications: number;
  followUps: number;
  likelyFiles: number;
  recentCommits: number;
  approach: number;
}

export const DEFAULT_CAPS: SelectionCaps = {
  constraints: 6,
  bugs: 4,
  decisions: 4,
  findings: 4,
  attempts: 2,
  verifications: 2,
  followUps: 4,
  likelyFiles: 10,
  recentCommits: 5,
  approach: 6,
};

/** `deep` mode widens the net for investigation-style work. */
export const DEEP_CAPS: SelectionCaps = {
  ...DEFAULT_CAPS,
  constraints: 8,
  bugs: 6,
  decisions: 6,
  findings: 8,
  attempts: 4,
  verifications: 4,
  followUps: 6,
  likelyFiles: 14,
  recentCommits: 10,
};

export function capsForMode(mode: ContextMode): SelectionCaps {
  return mode === 'deep' ? DEEP_CAPS : DEFAULT_CAPS;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function byKind(items: readonly MemoryItem[], kind: MemoryItem['kind']): MemoryItem[] {
  return items.filter((item) => item.kind === kind);
}

/** Always-on constraints: global rules and rules for the matched subsystem. */
function selectConstraints(
  items: readonly MemoryItem[],
  scored: readonly ScoredItem[],
  context: RelevanceContext,
  caps: SelectionCaps,
): BriefConstraint[] {
  const byId = new Map(scored.map((entry) => [entry.item.id, entry]));
  const selected = new Map<string, BriefConstraint>();

  for (const item of items) {
    if (item.kind !== 'constraint' || item.status !== 'active') continue;
    const severity = item.severity ?? 'medium';
    const isGlobal = item.subsystem === null;
    const matched = item.subsystem
      ? context.subsystems.some(
          (candidate) =>
            normalizeTerm(candidate) === normalizeTerm(item.subsystem ?? '') ||
            normalizeTerm(candidate).includes(normalizeTerm(item.subsystem ?? '')) ||
            normalizeTerm(item.subsystem ?? '').includes(normalizeTerm(candidate)),
        )
      : false;
    const mustInclude = severityWeight(severity) >= severityWeight('critical') && (isGlobal || matched);
    if (!mustInclude) continue;
    const constraint = item.raw as Constraint;
    selected.set(item.id, {
      id: item.id,
      statement: constraint.statement,
      severity,
      subsystem: item.subsystem,
      reason: matched ? `applies to ${item.subsystem}` : 'project-wide rule',
    });
  }

  for (const entry of scored) {
    if (entry.item.kind !== 'constraint' || selected.has(entry.item.id)) continue;
    const constraint = entry.item.raw as Constraint;
    if (!constraint.active) continue;
    selected.set(entry.item.id, {
      id: entry.item.id,
      statement: constraint.statement,
      severity: constraint.severity,
      subsystem: constraint.subsystem,
      reason: entry.reasons.join('; ') || 'relevant to this task',
    });
  }

  return [...selected.values()]
    .sort((a, b) => {
      const delta = severityWeight(b.severity) - severityWeight(a.severity);
      if (delta !== 0) return delta;
      const aScore = byId.get(a.id)?.score ?? 0;
      const bScore = byId.get(b.id)?.score ?? 0;
      return bScore - aScore;
    })
    .slice(0, caps.constraints);
}

function toBriefBug(scored: ScoredItem, clock: Clock): BriefBug {
  const bug = scored.item.raw as import('../domain/models.ts').Bug;
  return {
    id: bug.id,
    title: bug.title,
    severity: bug.severity,
    status: bug.status,
    detail: describeBug(bug),
    files: bug.files,
    age: humanAge(bug.updatedAt, clock),
  };
}

function toBriefDecision(scored: ScoredItem, clock: Clock): BriefDecision {
  const decision = scored.item.raw as import('../domain/models.ts').Decision;
  return {
    id: decision.id,
    statement: decision.statement,
    rationale: decision.rationale,
    subsystem: decision.subsystem,
    age: humanAge(decision.createdAt, clock),
  };
}

function toBriefFinding(scored: ScoredItem, clock: Clock): BriefFinding {
  const finding = scored.item.raw as import('../domain/models.ts').Finding;
  return {
    id: finding.id,
    statement: finding.statement,
    confidence: finding.confidence,
    evidenceCount: finding.evidence.length,
    symbols: finding.symbols.slice(0, 4),
    age: humanAge(finding.createdAt, clock),
  };
}

function toBriefAttempt(scored: ScoredItem, clock: Clock): BriefAttempt {
  const handoff = scored.item.raw as import('../domain/models.ts').Handoff;
  return {
    id: handoff.id,
    summary: handoff.summary,
    completed: handoff.workCompleted,
    failures: handoff.failures,
    followUp: handoff.followUp,
    age: humanAge(handoff.createdAt, clock),
    head: handoff.head,
  };
}

function toBriefVerification(scored: ScoredItem, clock: Clock): BriefVerification {
  const verification = scored.item.raw as Verification;
  return {
    id: verification.id,
    method: verification.method,
    command: verification.command,
    result: verification.result,
    age: humanAge(verification.createdAt, clock),
  };
}

/**
 * Collect the files the agent should look at first.
 *
 * Declared files come first (they are facts), then files named by the selected
 * memory, then files inferred from recent commits.
 */
function selectLikelyFiles(input: {
  interpretation: TaskInterpretation;
  scored: readonly ScoredItem[];
  observation: RepositoryObservation | null;
  caps: SelectionCaps;
}): string[] {
  const out: string[] = [];
  const add = (file: string): void => {
    const clean = file.replace(/\\/g, '/').trim();
    if (clean.length === 0 || out.includes(clean)) return;
    out.push(clean);
  };

  for (const file of input.interpretation.affectedFiles) add(file);
  for (const file of input.interpretation.inferredFiles) add(file);
  for (const entry of input.scored) {
    for (const file of entry.item.files.slice(0, 3)) add(file);
  }
  // Files named by recent commits that also match the task vocabulary.
  const terms = new Set(input.interpretation.terms);
  for (const file of input.observation?.recentlyChangedFiles ?? []) {
    const tokens = new Set((file.match(/[A-Za-z0-9_]+/g) ?? []).map(normalizeTerm));
    if ([...terms].some((term) => tokens.has(term))) add(file);
  }
  return out.slice(0, input.caps.likelyFiles);
}

/**
 * Build the recommended approach.
 *
 * Memory-derived steps always come first: they encode what this project already
 * learned. Template steps are generic and labelled as such by the renderer.
 */
function buildApproach(input: {
  interpretation: TaskInterpretation;
  constraints: readonly BriefConstraint[];
  bugs: readonly ScoredItem[];
  decisions: readonly ScoredItem[];
  findings: readonly ScoredItem[];
  attempts: readonly ScoredItem[];
  likelyFiles: readonly string[];
  caps: SelectionCaps;
}): Array<{ text: string; source: 'memory' | 'template' }> {
  const steps: Array<{ text: string; source: 'memory' | 'template' }> = [];
  const push = (text: string, source: 'memory' | 'template'): void => {
    if (steps.some((step) => step.text === text)) return;
    steps.push({ text, source });
  };

  // ---- Memory-derived steps ---------------------------------------------
  const failedAttempt = input.attempts.find(
    (attempt) => (attempt.item.raw as import('../domain/models.ts').Handoff).failures.length > 0,
  );
  if (failedAttempt) {
    const handoff = failedAttempt.item.raw as import('../domain/models.ts').Handoff;
    const failure = handoff.failures[0] ?? '';
    push(
      `Do not repeat the previous attempt (${failedAttempt.item.id}): ${truncate(failure, 180)}. Choose a different strategy.`,
      'memory',
    );
  }

  const claimedButUnverified = input.bugs.find((bug) => (bug.item.raw as { status?: string }).status === 'fix_claimed');
  if (claimedButUnverified) {
    push(
      `A fix is already claimed for "${claimedButUnverified.item.title}" but is not verified: verify it instead of reimplementing.`,
      'memory',
    );
  }

  const canonicalDecision = input.decisions.find((decision) =>
    /canonical|single source|one source|never infer|must use|authoritative/i.test(decision.item.title),
  );
  if (canonicalDecision) {
    push(
      `Route the change through the recorded canonical source rather than adding a parallel path: ${truncate(canonicalDecision.item.title, 160)}.`,
      'memory',
    );
  }

  const confirmedFinding = input.findings.find(
    (finding) => confidenceRank(finding.item.confidence ?? 'suspected') >= confidenceRank('statically_supported'),
  );
  if (confirmedFinding) {
    push(
      `Use the stored finding (${confirmedFinding.item.id}, ${confidenceLabel(confirmedFinding.item.confidence ?? 'suspected')}): ${truncate(confirmedFinding.item.title, 160)}.`,
      'memory',
    );
  }

  const relevantConstraint = input.constraints.find((constraint) => constraint.severity === 'critical');
  if (relevantConstraint) {
    push(`Keep this invariant intact: ${truncate(relevantConstraint.statement, 160)}.`, 'memory');
  }

  const bugWithRepro = input.bugs.find((bug) => (bug.item.raw as { reproduction?: string | null }).reproduction);
  if (bugWithRepro) {
    const bug = bugWithRepro.item.raw as { id: string; title: string; reproduction: string | null };
    push(`Reproduce first: ${truncate(bug.reproduction ?? bug.title, 180)}.`, 'memory');
  }

  // ---- Template steps by task type --------------------------------------
  const target = input.interpretation.subsystems[0] ?? input.interpretation.likelyComponents[0] ?? 'the affected code';
  const templates: Record<string, string[]> = {
    bugfix: [
      `Reproduce the defect before editing, and capture the current (wrong) behaviour.`,
      `Locate the predicate that decides the behaviour, then trace it to its data source${input.likelyFiles[0] ? ` — start at ${input.likelyFiles[0]}` : ''}.`,
      `Fix the underlying logic rather than the surface condition, so every caller benefits.`,
      `Add a regression test that fails before the change and passes after.`,
    ],
    feature: [
      `Find the existing extension point for ${target} instead of adding a parallel implementation.`,
      `Implement the change behind the existing abstraction and keep call sites unchanged.`,
      `Cover the new behaviour and its boundary cases with tests.`,
    ],
    refactor: [
      `Capture current behaviour with tests before moving anything.`,
      `Restructure ${target} in small steps, keeping the build green between steps.`,
      `Remove the old path once all callers use the new one.`,
    ],
    investigation: [
      `Read the stored findings for ${target} first; do not re-derive anything already confirmed.`,
      `For each open hypothesis, design the cheapest experiment that could falsify it.`,
      `Record the outcome with master_complete so the next pass inherits it.`,
    ],
    performance: [
      `Measure before changing anything, and record the measurement.`,
      `Identify whether the cost is algorithmic, allocation-driven or I/O-bound.`,
      `Optimise the dominant term only, then re-measure to confirm the improvement.`,
    ],
    test: [
      `Identify the behaviour currently untested in ${target}.`,
      `Write the smallest test that would fail if that behaviour regressed.`,
      `Run the whole suite to confirm no existing expectation changed.`,
    ],
    docs: [
      `Read the current behaviour in code so the documentation matches reality.`,
      `Update the smallest set of documents; avoid duplicating explanations.`,
    ],
    maintenance: [
      `Confirm the current version/state before changing it.`,
      `Make the change in one place and verify the whole suite afterwards.`,
    ],
    unknown: [
      `Locate the code responsible for ${target} before making any change.`,
      `Confirm the intended behaviour with the constraints and decisions in this brief.`,
    ],
  };
  for (const step of templates[input.interpretation.taskType] ?? templates['unknown'] ?? []) {
    push(step, 'template');
  }

  const trimmed = steps.slice(0, input.caps.approach);
  return trimmed.length > 0 ? trimmed : [{ text: 'Locate the affected code and confirm the intended behaviour.', source: 'template' }];
}

/** Build the verification plan from configuration, memory and the task record. */
function buildVerificationPlan(input: {
  config: ProjectConfig;
  task: Task | null;
  interpretation: TaskInterpretation;
  bugs: readonly ScoredItem[];
  verifications: readonly ScoredItem[];
  likelyFiles: readonly string[];
}): Brief['verificationPlan'] {
  const commands = [
    input.config.verification.testCommand,
    input.config.verification.lintCommand,
    input.config.verification.buildCommand,
    ...input.config.verification.extraChecks,
  ].filter((command): command is string => typeof command === 'string' && command.length > 0);

  const requirements: string[] = [...(input.task?.verificationRequirements ?? [])];
  for (const bug of input.bugs.slice(0, 2)) {
    requirements.push(`Confirm "${truncate(bug.item.title, 120)}" no longer reproduces.`);
  }
  if (input.verifications.length === 0 && requirements.length === 0) {
    requirements.push('State exactly what you ran and what it returned when you call master_complete.');
  }

  const manualChecks: string[] = [];
  const bugForCheck = input.bugs[0]?.item.raw as { title?: string; expected?: string | null } | undefined;
  if (bugForCheck?.title) {
    manualChecks.push(
      `Reproduce the original report manually and confirm it is gone: ${truncate(bugForCheck.title, 140)}.`,
    );
  }
  if (input.interpretation.affectedFiles.length > 0) {
    manualChecks.push('Exercise the touched code path directly, not just through the test suite.');
  }
  if (input.interpretation.taskType === 'bugfix') {
    manualChecks.push('Confirm the opposite case still behaves correctly (the fix must not invert the bug).');
  }

  const regressionAreas = [...new Set([...input.interpretation.subsystems])].slice(0, 4);
  const unknown = commands.length === 0 && requirements.length === 0;
  return { commands, requirements, manualChecks, regressionAreas, unknown };
}

/** Pick the single most valuable first action, and say why. */
function buildNextAction(input: {
  interpretation: TaskInterpretation;
  task: Task | null;
  constraints: readonly BriefConstraint[];
  bugs: readonly ScoredItem[];
  findings: readonly ScoredItem[];
  likelyFiles: readonly string[];
  openFindings: readonly { id: string; statement: string }[];
}): string {
  if (input.task && input.task.blockers.length > 0) {
    return `Resolve the blocker before coding: ${truncate(input.task.blockers[0] ?? '', 180)}`;
  }
  if (input.interpretation.reverseEngineering && input.openFindings.length > 0) {
    const finding = input.openFindings[0]!;
    return `Validate ${finding.id} at runtime: ${truncate(finding.statement, 140)}. Capture the evidence before changing its confidence.`;
  }
  const bugWithRepro = input.bugs.find((bug) => (bug.item.raw as { reproduction?: string | null }).reproduction);
  if (bugWithRepro && input.interpretation.taskType === 'bugfix') {
    const bug = bugWithRepro.item.raw as { id: string; reproduction: string | null };
    return `Reproduce ${bug.id} first (${truncate(bug.reproduction ?? '', 120)}), then trace the code that allows it.`;
  }
  if (input.likelyFiles.length > 0) {
    const first = input.likelyFiles[0]!;
    const second = input.likelyFiles[1];
    return second
      ? `Start by inspecting ${first}, then ${second}.`
      : `Start by inspecting ${first}.`;
  }
  if (input.constraints.length > 0) {
    return `Start by locating the code path for ${input.interpretation.subsystems[0] ?? 'the affected area'} while keeping "${truncate(input.constraints[0]!.statement, 100)}" intact.`;
  }
  if (input.interpretation.subsystems.length > 0) {
    return `Search the repository for ${input.interpretation.subsystems[0]} and read the entry point of that subsystem.`;
  }
  return `Locate the code responsible for the task using your normal search tools, then record what you find with master_complete.`;
}

function buildReverseEngineering(input: {
  items: readonly MemoryItem[];
  interpretation: TaskInterpretation;
  clock: Clock;
}): BriefReverseEngineering | null {
  // Findings are only framed as "reverse engineering" when the task is one:
  // for any other task the same facts are history, and a section with that
  // title would misdescribe the work. Findings keep their confidence labels
  // there, and the history renderer adds the "not facts" caveat when needed.
  if (!input.interpretation.reverseEngineering) return null;
  const findings = input.items.filter((item) => item.kind === 'finding');
  const enabled = findings.length > 0;
  if (!enabled) return null;

  const established = findings
    .filter((item) => confidenceRank(item.confidence ?? 'hypothesis') >= confidenceRank('runtime_observed'))
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      statement: truncate(item.title, 200),
      confidence: item.confidence ?? 'suspected',
      age: humanAge(item.createdAt, input.clock),
    }));

  const open = findings
    .filter((item) => confidenceRank(item.confidence ?? 'hypothesis') < confidenceRank('runtime_observed'))
    .sort((a, b) => confidenceRank(b.confidence ?? 'hypothesis') - confidenceRank(a.confidence ?? 'hypothesis'))
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      statement: truncate(item.title, 200),
      confidence: item.confidence ?? 'suspected',
      next: nextConfidence(item.confidence ?? 'suspected'),
      age: humanAge(item.createdAt, input.clock),
    }));

  const promotionLevels = new Set<Confidence>();
  for (const finding of [...established, ...open]) {
    const next = nextConfidence(finding.confidence);
    if (next) promotionLevels.add(next);
  }
  const promotion = [...promotionLevels]
    .sort((a, b) => confidenceRank(a) - confidenceRank(b))
    .map((level) => `${level}: ${CONFIDENCE_PROMOTION[level] ?? CONFIDENCE_CRITERIA[level]}`);

  return { enabled: true, established, open, promotion };
}

/** Detect conflicts between stored state and the repository as it is now. */
function detectConflicts(input: AssembleBriefInput, latestHandoff: BriefAttempt | null): BriefWarning[] {
  const warnings: BriefWarning[] = [];
  const { observation, previousHead, headRelation, commitsSincePrevious, clock } = input;
  const relation = headRelation === 'same' ? 'unknown' : headRelation;

  if (latestHandoff?.head && observation?.head && latestHandoff.head !== observation.head) {
    // A handoff recorded further back is the more precise warning, so it takes
    // the place of the generic "state advanced" message rather than repeating it.
    const hint =
      relation === 'advanced'
        ? ' — work has landed since that handoff'
        : relation === 'diverged'
          ? ' — history was rewritten since that handoff'
          : '';
    warnings.push({
      level: 'warning',
      text:
        `Stored handoff ${latestHandoff.id} (${latestHandoff.age}) recorded HEAD ${latestHandoff.head.slice(0, 8)}, ` +
        `but the repository is at ${observation.head.slice(0, 8)}${hint}. ` +
        `Its findings may be stale.`,
    });
  } else if (previousHead && observation?.head && previousHead !== observation.head) {
    if (headRelation === 'advanced') {
      warnings.push({
        level: 'warning',
        text:
          `Project state advanced since the last recorded observation: ${previousHead.slice(0, 8)} → ` +
          `${observation.head.slice(0, 8)}${commitsSincePrevious !== null ? ` (${commitsSincePrevious} commits)` : ''}.`,
      });
    } else if (headRelation === 'diverged') {
      warnings.push({
        level: 'warning',
        text:
          `Repository HEAD no longer descends from the last recorded observation (${previousHead.slice(0, 8)} → ` +
          `${observation.head.slice(0, 8)}); history was rewritten or rewritten upstream. Treat stored state as suspect.`,
      });
    } else {
      warnings.push({
        level: 'warning',
        text: `Stored HEAD (${previousHead.slice(0, 8)}) differs from repository HEAD (${observation.head.slice(0, 8)}); relationship unknown.`,
      });
    }
  }

  if (latestHandoff && observation?.branch && input.previousBranch && input.previousBranch !== observation.branch) {
    warnings.push({
      level: 'info',
      text: `Branch changed since the last recorded observation: ${input.previousBranch} → ${observation.branch}.`,
    });
  }

  if (input.observation?.dirty && input.interpretation.taskType === 'bugfix') {
    warnings.push({
      level: 'info',
      text:
        `Working tree is dirty (${input.observation.changedFiles.length} modified, ` +
        `${input.observation.untrackedFiles.length} untracked). Reproduce on a clean state if the bug might depend on local changes.`,
    });
  }

  return warnings;
}

/** Facts that are missing but would make the next pass better. */
function buildGaps(input: {
  interpretation: TaskInterpretation;
  items: readonly MemoryItem[];
  constraints: readonly BriefConstraint[];
  decisions: readonly BriefDecision[];
  bugs: readonly BriefBug[];
  verifications: readonly BriefVerification[];
  config: ProjectConfig;
  hasGit: boolean;
}): string[] {
  const gaps: string[] = [];
  if (input.items.length === 0) {
    gaps.push('Project memory is empty: this brief is built from repository state alone.');
  }
  if (!input.config.verification.testCommand) {
    gaps.push('No test command configured; add verification.test_command to .mcp/master-mcp.yaml so future briefs can name it.');
  }
  if (input.constraints.length === 0 && input.interpretation.taskType !== 'docs') {
    gaps.push('No constraint recorded for this area; if you discover an invariant, record it so the next pass inherits it.');
  }
  if (input.decisions.length === 0 && input.interpretation.taskType !== 'bugfix') {
    gaps.push('No architectural decision matched this task; a design choice made here is worth recording.');
  }
  if (input.verifications.length === 0) {
    gaps.push('No verification history for this area yet.');
  }
  if (input.bugs.length === 0 && input.interpretation.taskType === 'bugfix') {
    gaps.push('No stored bug matches this task; create one with master_record so the fix can be tracked.');
  }
  if (!input.hasGit) {
    gaps.push('Repository metadata unavailable (not a git work tree or git missing); change history is unknown.');
  }
  return gaps.slice(0, 4);
}

/** Assemble one coherent brief. Pure: same input, same output. */
export function assembleBrief(input: AssembleBriefInput): Brief {
  const caps = capsForMode(input.interpretation.mode);
  const clock = input.clock;

  const relevanceContext: RelevanceContext = {
    terms: new Set(input.interpretation.terms),
    identifierTerms: new Set(input.interpretation.identifierTerms),
    subsystems: input.interpretation.subsystems,
    files: [...input.interpretation.affectedFiles, ...input.interpretation.inferredFiles],
    recentlyChangedFiles: input.observation?.recentlyChangedFiles ?? [],
    taskType: input.interpretation.taskType,
    taskId: input.task?.id ?? null,
    fullTextScores: input.fullTextScores,
    clock,
  };

  const scored = rankItems(input.items, relevanceContext);
  const scoredById = new Map(scored.map((entry) => [entry.item.id, entry]));

  const bugs = scored.filter((entry) => entry.item.kind === 'bug').slice(0, caps.bugs);
  const decisions = scored.filter((entry) => entry.item.kind === 'decision').slice(0, caps.decisions);
  const findings = scored.filter((entry) => entry.item.kind === 'finding').slice(0, caps.findings);
  const verifications = scored.filter((entry) => entry.item.kind === 'verification').slice(0, caps.verifications);

  // Attempts: the latest handoff always travels with the brief (it is the baton),
  // then any other handoff that is genuinely relevant.
  const handoffs = byKind(input.items, 'handoff')
    .map((item) => item.raw as import('../domain/models.ts').Handoff)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestHandoffItem = handoffs[0] ? input.items.find((item) => item.id === handoffs[0]!.id) : undefined;
  const attempts: ScoredItem[] = [];
  const latestScored = latestHandoffItem ? scoredById.get(latestHandoffItem.id) : undefined;
  if (latestScored) attempts.push(latestScored);
  else if (latestHandoffItem) {
    attempts.push({
      item: latestHandoffItem,
      score: 0,
      reasons: ['latest handoff'],
      breakdown: {},
    });
  }
  for (const entry of scored) {
    if (entry.item.kind !== 'handoff') continue;
    if (attempts.some((attempt) => attempt.item.id === entry.item.id)) continue;
    attempts.push(entry);
  }
  const attemptsCapped = attempts.slice(0, Math.max(1, caps.attempts));

  const constraints = selectConstraints(input.items, scored, relevanceContext, caps);

  // Follow-ups: open tasks, minus the one this call is about, prioritised.
  const followUps: BriefFollowUp[] = input.openTasks
    .filter((task) => task.id !== input.task?.id)
    .filter((task) => task.status !== 'verified_done' && task.status !== 'cancelled')
    .sort((a, b) => {
      const priorityDelta = severityWeight(b.priority === 'P0' ? 'critical' : b.priority === 'P1' ? 'high' : b.priority === 'P2' ? 'medium' : 'low') -
        severityWeight(a.priority === 'P0' ? 'critical' : a.priority === 'P1' ? 'high' : a.priority === 'P2' ? 'medium' : 'low');
      if (priorityDelta !== 0) return priorityDelta;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, caps.followUps)
    .map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      status: task.status,
      blockers: task.blockers,
    }));

  const likelyFiles = selectLikelyFiles({
    interpretation: input.interpretation,
    scored,
    observation: input.observation,
    caps,
  });

  const approach = buildApproach({
    interpretation: input.interpretation,
    constraints,
    bugs,
    decisions,
    findings,
    attempts: attemptsCapped,
    likelyFiles,
    caps,
  });

  const verificationPlan = buildVerificationPlan({
    config: input.config,
    task: input.task,
    interpretation: input.interpretation,
    bugs,
    verifications,
    likelyFiles,
  });

  const briefBugs = bugs.map((entry) => toBriefBug(entry, clock));
  const briefDecisions = decisions.map((entry) => toBriefDecision(entry, clock));
  const briefFindings = findings.map((entry) => toBriefFinding(entry, clock));
  const briefAttempts = attemptsCapped.map((entry) => toBriefAttempt(entry, clock));
  const briefVerifications = verifications.map((entry) => toBriefVerification(entry, clock));

  const worstOpenBug = strongestSeverity(
    briefBugs.filter((bug) => bug.status !== 'fixed_verified' && bug.status !== 'wontfix').map((bug) => bug.severity),
  );

  const risk = assessRisk({
    hasCriticalConstraint: constraints.some((constraint) => constraint.severity === 'critical'),
    worstOpenBug,
    relatedRecordCount: scored.length,
    previousFailure: briefAttempts.some((attempt) => attempt.failures.length > 0),
    broadTaskType: input.interpretation.taskType === 'refactor' || input.interpretation.taskType === 'feature',
  });

  const warnings: BriefWarning[] = [
    ...input.warnings.map((text) => ({ level: 'warning' as const, text })),
    ...detectConflicts(input, briefAttempts[0] ?? null),
  ];

  const reverseEngineering = buildReverseEngineering({
    items: input.items,
    interpretation: input.interpretation,
    clock,
  });
  if (reverseEngineering && input.interpretation.reverseEngineering && !input.project.phase) {
    warnings.push({
      level: 'info',
      text: 'This looks like reverse-engineering work, but the project has no recorded phase. Consider recording one.',
    });
  }

  const gaps = buildGaps({
    interpretation: input.interpretation,
    items: input.items,
    constraints,
    decisions: briefDecisions,
    bugs: briefBugs,
    verifications: briefVerifications,
    config: input.config,
    hasGit: Boolean(input.observation && !input.observation.error),
  });

  const nextAction = buildNextAction({
    interpretation: input.interpretation,
    task: input.task,
    constraints,
    bugs,
    findings,
    likelyFiles,
    openFindings: reverseEngineering?.open.map((finding) => ({ id: finding.id, statement: finding.statement })) ?? [],
  });

  const countsByKind: Record<string, number> = {};
  for (const item of input.items) countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1;

  return {
    generatedAt: isoNow(clock),
    project: {
      slug: input.project.slug,
      name: input.project.name,
      goal: input.project.goal ?? input.config.goal,
      phase: input.project.phase ?? input.config.phase,
      branch: input.observation?.branch ?? input.repository?.lastBranch ?? null,
      head: input.observation?.head ?? null,
      headShort: input.observation?.head ? input.observation.head.slice(0, 8) : null,
      headSubject: input.observation?.headSubject ?? null,
      dirty: input.observation?.dirty ?? false,
      changedFileCount: input.observation?.changedFiles.length ?? 0,
      untrackedFileCount: input.observation?.untrackedFiles.length ?? 0,
      repositoryPath: input.repository?.path ?? input.observation?.root ?? null,
      repositoryName: input.repository?.name ?? input.observation?.name ?? null,
      discoverySource: input.discoverySource,
      registeredNow: input.registeredNow,
      gitAvailable: Boolean(input.observation && !input.observation.error),
    },
    task: {
      text: input.interpretation.text,
      taskId: input.task?.id ?? null,
      status: input.task?.status ?? null,
      priority: input.task?.priority ?? null,
      type: input.interpretation.taskType,
      typeConfidence: input.interpretation.typeConfidence,
      subsystem: input.interpretation.subsystems[0] ?? null,
      subsystemConfidence: input.interpretation.subsystemConfidence,
      likelyComponents: input.interpretation.likelyComponents,
      affectedFiles: input.interpretation.affectedFiles,
      inferredFiles: input.interpretation.inferredFiles,
      notes: input.interpretation.notes,
      mode: input.interpretation.mode,
      interpretability: input.interpretation.interpretability,
    },
    constraints,
    bugs: briefBugs,
    decisions: briefDecisions,
    findings: briefFindings,
    attempts: briefAttempts,
    verifications: briefVerifications,
    likelyFiles,
    uncommittedFiles: [
      ...(input.observation?.changedFiles ?? []),
      ...(input.observation?.untrackedFiles ?? []),
    ].slice(0, 40),
    recentCommits: (input.observation?.commits ?? [])
      .slice(0, caps.recentCommits)
      .map((commit: CommitInfo) => ({
        shortHash: commit.shortHash,
        subject: truncate(commit.subject, 90),
        ago: humanAge(commit.date, clock),
      })),
    recentlyChangedFiles: (input.observation?.recentlyChangedFiles ?? []).slice(0, 8),
    risk,
    approach,
    verificationPlan,
    nextAction,
    followUps,
    gaps,
    warnings,
    reverseEngineering,
    stats: {
      memoryConsidered: input.items.length,
      memorySelected:
        constraints.length +
        briefBugs.length +
        briefDecisions.length +
        briefFindings.length +
        briefAttempts.length +
        briefVerifications.length,
      countsByKind,
    },
  };
}
