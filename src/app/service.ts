/**
 * Application service layer.
 *
 * Both the MCP tools and the CLI call this and nothing below it. It owns the
 * one-pass workflow:
 *
 *   context()  → identify project, gather memory, assemble and render brief
 *   complete() → classify evidence, update task state, persist the handoff
 *
 * It is the only place that writes to the store, which keeps the
 * "never record speculative facts" rule enforceable in one review.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  Bug,
  Confidence,
  Constraint,
  Decision,
  Handoff,
  MemoryItem,
  Project,
  Repository,
  Severity,
  Task,
  TaskStatus,
  VerificationResult,
  VerificationStatus,
} from '../domain/models.ts';
import type { ProjectSnapshot, RestoreReport } from '../domain/transfer.ts';
import { openDatabase, resolveDatabasePath, schemaVersion } from '../store/db.ts';
import { Store } from '../store/store.ts';
import { readSnapshot, writeSnapshot } from '../store/transfer.ts';
import type { Clock } from '../util/time.ts';
import { isoNow, systemClock } from '../util/time.ts';
import { MasterMcpError, notFoundError, usageError } from '../util/errors.ts';
import { loadProjectConfig } from '../config/config.ts';
import { discoverProject } from '../repo/discovery.ts';
import { countCommitsBetween, isAncestor } from '../repo/git.ts';
import type { RepositoryObservation } from '../domain/models.ts';
import {
  CONFIDENCES,
  parseConfidence,
  parsePriority,
  parseSeverity,
  parseTaskStatus,
  parseVerificationResult,
} from '../domain/vocabulary.ts';
import { keywords, truncate } from '../util/text.ts';
import { CONTEXT_MODES, interpretTask, type ContextMode, type TaskInterpretation } from './interpret.ts';
import { assembleBrief, type Brief } from './assembler.ts';
import { renderBrief, renderStatus, resolveBriefBudget } from './render.ts';
import { buildStatus, type StatusReport } from './status.ts';
import {
  classifyCompletion,
  decideTaskStatus,
  guardConfidence,
  matchTask,
  needsWork,
  type VerificationClaim,
} from './lifecycle.ts';
import {
  bugEvidence,
  claimVerifiesBug,
  effectiveRequirements,
  missingRequirements,
  requirementFor,
  type VerificationCoverage,
} from './verification.ts';
import { findDuplicate, mergeStrings, type DedupExisting } from './dedup.ts';
import { exportMarkdown } from './transfer.ts';

// ---------------------------------------------------------------------------
// Input / output contracts
// ---------------------------------------------------------------------------

export interface MasterContextInput {
  task: string;
  project?: string | null;
  repositoryPath?: string | null;
  affectedFiles?: readonly string[] | null;
  mode?: string | null;
  refresh?: boolean | null;
  /** Per-call brief budget override, clamped to the absolute ceiling. */
  maxTokens?: number | null;
}

export interface MasterContextResult {
  text: string;
  brief: Brief;
  taskId: string | null;
  projectSlug: string;
}

export interface MasterCompleteInput {
  summary: string;
  project?: string | null;
  repositoryPath?: string | null;
  taskId?: string | null;
  task?: string | null;
  filesChanged?: readonly string[] | null;
  commits?: readonly string[] | null;
  testsRun?: readonly (string | TestRunInput)[] | null;
  verification?: readonly VerificationInput[] | null;
  results?: readonly string[] | null;
  discoveries?: readonly (string | DiscoveryInput)[] | null;
  unresolved?: readonly string[] | null;
  blockers?: readonly string[] | null;
  followUp?: readonly (string | FollowUpInput)[] | null;
  bugsFound?: readonly (string | BugInput)[] | null;
  bugsResolved?: readonly string[] | null;
  subsystems?: readonly string[] | null;
  status?: string | null;
}

export interface TestRunInput {
  command?: string | null;
  method?: string | null;
  result?: string | null;
  evidence?: readonly string[] | null;
}

export interface VerificationInput extends TestRunInput {
  method?: string | null;
}

export interface DiscoveryInputShape {
  statement: string;
  confidence?: string | null;
  evidence?: readonly string[] | null;
  files?: readonly string[] | null;
  symbols?: readonly string[] | null;
}

export interface FollowUpInput {
  title: string;
  priority?: string | null;
  subsystem?: string | null;
  description?: string | null;
}

export interface BugInput {
  title: string;
  severity?: string | null;
  subsystem?: string | null;
  reproduction?: string | null;
  expected?: string | null;
  observed?: string | null;
  evidence?: readonly string[] | null;
  files?: readonly string[] | null;
}

export interface MasterCompleteResult {
  text: string;
  taskId: string;
  taskStatus: TaskStatus;
  verificationStatus: VerificationStatus;
  handoffId: string;
  recorded: {
    verifications: string[];
    findings: string[];
    bugsCreated: string[];
    bugsUpdated: string[];
    followUps: string[];
    decisions: string[];
  };
  notes: string[];
  projectSlug: string;
}

type DiscoveryInput = DiscoveryInputShape;

export interface MasterSearchInput {
  query: string;
  project?: string | null;
  kinds?: readonly string[] | null;
  limit?: number | null;
}

export interface MasterSearchResult {
  text: string;
  hits: Array<{ kind: string; id: string; title: string; subsystem: string | null; score: number }>;
  projectSlug: string | null;
}

export interface MasterStatusInput {
  project?: string | null;
  repositoryPath?: string | null;
}

export interface MasterStatusResult {
  text: string;
  report: StatusReport;
}

export interface MasterRecordInput {
  kind: string;
  body: string;
  project?: string | null;
  repositoryPath?: string | null;
  /** Free-form qualifiers; the meaning depends on `kind`. */
  subsystem?: string | null;
  severity?: string | null;
  priority?: string | null;
  confidence?: string | null;
  rationale?: string | null;
  alternatives?: readonly string[] | null;
  files?: readonly string[] | null;
  symbols?: readonly string[] | null;
  evidence?: readonly string[] | null;
  reproduction?: string | null;
  expected?: string | null;
  observed?: string | null;
  commits?: readonly string[] | null;
  /** `todo` only: extra task metadata. */
  verificationRequirements?: readonly string[] | null;
  /** `handoff` only: work that should happen next. */
  followUp?: readonly string[] | null;
  /** `verification` only. */
  taskId?: string | null;
  command?: string | null;
  result?: string | null;
  method?: string | null;
  /** `decision` only: id of the decision this one supersedes. */
  supersedes?: string | null;
  /** `constraint` only: id of the constraint this one replaces. */
  replaces?: string | null;
  /** `constraint` only: id of a constraint to deactivate without replacement. */
  deactivate?: string | null;
}

export interface MasterRecordResult {
  text: string;
  id: string;
  kind: string;
  projectSlug: string;
}

export interface MasterExportInput {
  project?: string | null;
  repositoryPath?: string | null;
  format?: string | null;
}

export interface MasterExportResult {
  text: string;
  format: 'markdown' | 'json';
  snapshot: ProjectSnapshot;
}

export interface ServiceOptions {
  /** Database path; defaults to `resolveDatabasePath()`. */
  dbPath?: string;
  clock?: Clock;
  /** Working directory used when no repository path is supplied. */
  cwd?: string;
  /** Pre-opened database handle, for tests. */
  database?: DatabaseSync;
}

function parseMode(raw: string | null | undefined): ContextMode {
  if (!raw) return 'auto';
  const needle = raw.trim().toLowerCase().replace(/-/g, '_');
  const found = CONTEXT_MODES.find((mode) => mode === needle);
  if (!found) {
    throw usageError(
      `Unknown mode "${raw}".`,
      `Valid modes: ${CONTEXT_MODES.join(', ')}.`,
    );
  }
  return found;
}

function dedupe(values: readonly string[] | null | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function requireText(value: string | null | undefined, field: string, hint?: string): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) throw usageError(`"${field}" must not be empty.`, hint);
  return trimmed;
}

/** Coerce an unknown id/title reference into a stable comparison key. */
function sameReference(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class MasterMcpService {
  readonly store: Store;
  private readonly clock: Clock;
  private readonly cwd: string;
  private readonly dbPath: string;
  private closed = false;

  constructor(options: ServiceOptions) {
    this.dbPath = options.dbPath ?? resolveDatabasePath();
    const db = options.database ?? openDatabase({ path: this.dbPath, clock: options.clock });
    this.store = new Store(db);
    this.clock = options.clock ?? systemClock;
    this.cwd = options.cwd ?? process.cwd();
  }

  /** Open a service against the configured database. */
  static open(options: ServiceOptions = {}): MasterMcpService {
    return new MasterMcpService(options);
  }

  get databasePath(): string {
    return this.dbPath;
  }

  get schemaVersion(): number {
    return schemaVersion(this.store.raw());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  // -------------------------------------------------------------------------
  // master_context
  // -------------------------------------------------------------------------

  async context(input: MasterContextInput): Promise<MasterContextResult> {
    const task = requireText(input.task, 'task', 'Pass the coding task as a sentence, e.g. "Fix the ownership check in the offer UI".');
    const mode = parseMode(input.mode);
    const allowCreate = mode !== 'read_only';
    const repositoryPath = input.repositoryPath ?? null;

    // Config is read before discovery so `context.recent_commits` bounds the
    // git log we ask for (discovery re-reads it once it knows the git root).
    const probeConfig = loadProjectConfig(repositoryPath ?? this.cwd).config;

    const discovery = await discoverProject({
      store: this.store,
      clock: this.clock,
      project: input.project ?? null,
      repositoryPath,
      cwd: this.cwd,
      allowCreate,
      observe: { recentCommits: probeConfig.context.recentCommits },
      refresh: input.refresh ?? false,
    });

    const now = isoNow(this.clock);
    const repository = discovery.repository;
    const observation = discovery.observation;

    // Conflict detection compares the repository to the last observation, so
    // read the previous values before recording the new ones.
    const previousHead = repository?.lastHead ?? null;
    const previousBranch = repository?.lastBranch ?? null;

    let headRelation: 'same' | 'advanced' | 'diverged' | 'unknown' = 'unknown';
    let commitsSincePrevious: number | null = null;
    if (previousHead && observation?.head && observation.root) {
      if (previousHead === observation.head) headRelation = 'same';
      else {
        const ancestor = await isAncestor(observation.root, previousHead, observation.head);
        if (ancestor === true) {
          headRelation = 'advanced';
          commitsSincePrevious = await countCommitsBetween(observation.root, previousHead, observation.head);
        } else if (ancestor === false) headRelation = 'diverged';
      }
    }

    const items = this.store.loadMemoryItems(discovery.project.id);
    const knownSubsystems = this.store.knownSubsystems(discovery.project.id);

    const interpretation = interpretTask({
      task,
      project: discovery.project,
      config: discovery.config,
      knownSubsystems,
      affectedFiles: dedupe(input.affectedFiles),
      recentlyChangedFiles: observation?.recentlyChangedFiles ?? [],
      mode,
    });

    const fullTextScores = this.fullTextScores(
      discovery.project.id,
      [task, ...dedupe(input.affectedFiles)].join(' '),
    );
    if (fullTextScores.size === 0) {
      // Fall back to the interpretation's own terms so an unusual wording still
      // gets the ranking benefit of full-text overlap.
      const fallback = this.fullTextScores(discovery.project.id, interpretation.terms.join(' '));
      for (const [id, score] of fallback) fullTextScores.set(id, score);
    }

    const taskRecord = allowCreate
      ? this.upsertTaskForContext({
          project: discovery.project,
          interpretation,
          taskText: task,
          observation,
          now,
        })
      : this.findTaskForContext(discovery.project, task);

    const openTasks = this.store.listTasks(discovery.project.id, { limit: 200 });

    const brief = assembleBrief({
      project: discovery.project,
      repository,
      observation,
      config: discovery.config,
      items,
      fullTextScores,
      interpretation,
      task: taskRecord,
      openTasks,
      clock: this.clock,
      previousHead,
      previousBranch,
      headRelation,
      commitsSincePrevious,
      discoverySource: discovery.source,
      registeredNow: discovery.createdProject,
      warnings: discovery.warnings,
    });

    // Budget policy: an explicit per-call value wins, then an explicit config
    // value, then the mode default — always clamped to the absolute ceiling.
    const maxTokens = resolveBriefBudget({
      mode: interpretation.mode,
      reverseEngineering: brief.reverseEngineering?.enabled ?? false,
      configured: discovery.config.context.maxBriefTokens,
      configuredExplicitly: discovery.config.context.maxBriefTokensSet,
      explicit: input.maxTokens ?? null,
    });
    const text = renderBrief(brief, { maxTokens });

    if (allowCreate) {
      if (repository && observation) {
        this.store.recordRepositoryObservation(repository.id, {
          branch: observation.branch,
          head: observation.head,
          dirty: observation.dirty,
          remoteUrl: observation.remoteUrl,
          name: observation.name,
          seenAt: now,
        });
      }
      // Project identity is refreshed from config on every pass; the brief itself
      // is where new engineering facts get recorded.
      const projectPatch: { goal?: string; phase?: string; now: string } = { now };
      if (!discovery.project.goal && discovery.config.goal) projectPatch.goal = discovery.config.goal;
      if (!discovery.project.phase && discovery.config.phase) projectPatch.phase = discovery.config.phase;
      if (projectPatch.goal || projectPatch.phase) {
        this.store.updateProject(discovery.project.id, projectPatch);
      }
      this.store.touchProject(discovery.project.id, now);
      this.store.recordActivity({
        projectId: discovery.project.id,
        kind: 'context',
        summary: `context: ${truncate(task, 120)}`,
        payload: {
          taskId: taskRecord?.id ?? null,
          mode: interpretation.mode,
          memoryConsidered: items.length,
          memorySelected: brief.stats.memorySelected,
          head: observation?.head ?? null,
        },
        source: 'master_context',
        now,
      });
    }

    return {
      text,
      brief,
      taskId: taskRecord?.id ?? null,
      projectSlug: discovery.project.slug,
    };
  }

  /** Full-text score overlay for ranking. Keys are record ids. */
  private fullTextScores(projectId: string, query: string): Map<string, number> {
    const scores = new Map<string, number>();
    if (keywords(query).length === 0) return scores;
    for (const hit of this.store.searchMemory({ query, projectId, limit: 80 })) {
      scores.set(hit.id, hit.score ?? 0);
    }
    return scores;
  }

  /** Read-only task lookup used by `mode=read_only`. */
  private findTaskForContext(project: Project, taskText: string): Task | null {
    const tasks = this.store.listTasks(project.id, { limit: 200 });
    return matchTask(tasks, taskText)?.task ?? null;
  }

  /**
   * Match the task string to a stored task, creating one when nothing matches.
   *
   * Creating a task here is not speculation: the agent stated the task, and the
   * record exists so that `master_complete` can attach evidence to it.
   */
  private upsertTaskForContext(input: {
    project: Project;
    interpretation: TaskInterpretation;
    taskText: string;
    observation: RepositoryObservation | null;
    now: string;
  }): Task | null {
    const { project, interpretation, taskText, observation, now } = input;
    const tasks = this.store.listTasks(project.id, { limit: 200 });
    const match = matchTask(tasks, taskText);
    const declaredFiles = interpretation.affectedFiles;

    if (match) {
      const task = match.task;
      const patch: Parameters<Store['updateTask']>[1] = { now };
      if (task.status === 'todo') patch.status = 'in_progress';
      if (!task.subsystem && interpretation.subsystems[0]) patch.subsystem = interpretation.subsystems[0];
      if (declaredFiles.length > 0) {
        patch.affectedFiles = dedupe([...task.affectedFiles, ...declaredFiles]);
      }
      if (observation?.branch) patch.branch = observation.branch;
      if (observation?.head) patch.head = observation.head;
      return this.store.updateTask(task.id, patch);
    }

    const title = truncate(taskText, 200);
    return this.store.createTask({
      projectId: project.id,
      title,
      description: interpretation.likelyComponents.length > 0
        ? `Inferred components: ${interpretation.likelyComponents.join(', ')}`
        : null,
      priority: inferPriority(taskText),
      status: 'in_progress',
      subsystem: interpretation.subsystems[0] ?? null,
      affectedFiles: declaredFiles,
      source: 'master_context',
      head: observation?.head ?? null,
      branch: observation?.branch ?? null,
      now,
    });
  }

  // -------------------------------------------------------------------------
  // master_complete
  // -------------------------------------------------------------------------

  async complete(input: MasterCompleteInput): Promise<MasterCompleteResult> {
    const summary = requireText(input.summary, 'summary', 'Summarise what was done in one sentence.');
    const notes: string[] = [];

    const discovery = await discoverProject({
      store: this.store,
      clock: this.clock,
      project: input.project ?? null,
      repositoryPath: input.repositoryPath ?? null,
      cwd: this.cwd,
      allowCreate: true,
      observe: { recentCommits: 1 },
    });
    const now = isoNow(this.clock);
    const observation = discovery.observation;

    const task = this.resolveTaskForCompletion({
      project: discovery.project,
      taskId: input.taskId ?? null,
      taskTitle: input.task ?? null,
      summary,
      observation,
      now,
      notes,
    });

    const filesChanged = dedupe(input.filesChanged);
    const commits = dedupe(input.commits);
    const blockers = dedupe(input.blockers);
    const unresolved = dedupe(input.unresolved);

    const claims = normalizeClaims(input.testsRun ?? [], input.verification ?? []);
    const results = dedupe(input.results);

    // Requirements are the task's own when it declared them, otherwise the
    // configured checks. The task type comes from the same deterministic
    // interpretation used by master_context, so docs/investigation work is
    // exempt from the build/test gate in both tools.
    const interpretation = interpretTask({
      task: task.title,
      project: discovery.project,
      config: discovery.config,
      knownSubsystems: this.store.knownSubsystems(discovery.project.id),
      affectedFiles: dedupe([...task.affectedFiles, ...filesChanged]),
      recentlyChangedFiles: observation?.recentlyChangedFiles ?? [],
      mode: 'auto',
    });
    const requirements = effectiveRequirements({
      task,
      config: discovery.config,
      taskType: interpretation.taskType,
    });
    const classification = classifyCompletion({ requirements, claims, results });
    notes.push(...classification.notes);

    const requestedStatus = parseTaskStatus(input.status) ?? null;
    if (input.status && !requestedStatus) {
      notes.push(`Ignored unknown status "${input.status}".`);
    }
    const decision = decideTaskStatus({
      current: task.status,
      verification: classification.status,
      blockers,
      requested: requestedStatus,
      filesChanged: filesChanged.length,
    });
    notes.push(...decision.notes);

    // ---------------------------------------------------------------------
    // Bugs to evaluate
    // ---------------------------------------------------------------------
    // Resolve every bug this completion speaks to *before* storing evidence, so
    // each verification can be attributed to the bug it actually verifies.
    const bugsToEvaluate = this.collectBugsToEvaluate(
      discovery.project.id,
      task.id,
      dedupe(input.bugsResolved),
      notes,
    );
    const bugVerdicts = new Map<string, ReturnType<typeof bugEvidence>>();
    for (const bug of bugsToEvaluate) {
      bugVerdicts.set(bug.id, bugEvidence({ bug, claims, requirements }));
    }

    // ---------------------------------------------------------------------
    // Verifications
    // ---------------------------------------------------------------------
    const verificationIds: string[] = [];
    for (const claim of classification.accepted) {
      const verifiedBug = bugsToEvaluate.find((candidate) => claimVerifiesBug(candidate, claim, requirements));
      const verification = this.store.createVerification({
        projectId: discovery.project.id,
        taskId: task.id,
        method: claim.method,
        command: claim.command,
        result: claim.result,
        evidence: claim.evidence,
        requirement: requirementFor(requirements, claim),
        bugId: verifiedBug?.id ?? null,
        now,
      });
      verificationIds.push(verification.id);
    }

    // ---------------------------------------------------------------------
    // Findings from discoveries
    // ---------------------------------------------------------------------
    const findingIds: string[] = [];
    const resolvedSubsystem = task.subsystem ?? null;
    const openFindingCandidates: DedupExisting[] = this.store
      .listFindings(discovery.project.id, { limit: 400 })
      .map((finding) => ({
        id: finding.id,
        text: finding.statement,
        detail: finding.evidence.join(' '),
        subsystem: finding.subsystem,
      }));
    for (const discoveryItem of input.discoveries ?? []) {
      const parsed = normalizeDiscovery(discoveryItem);
      if (!parsed) continue;
      const files = parsed.files.length > 0 ? parsed.files : [];
      const symbols = parsed.symbols;
      const guard = guardConfidence({
        requested: parsed.confidence,
        evidence: parsed.evidence,
        files,
        symbols,
      });
      if (guard.downgradedFrom) {
        notes.push(`Finding "${truncate(parsed.statement, 60)}": ${guard.reason}`);
      }

      const duplicate = findDuplicate(
        { text: parsed.statement, detail: parsed.evidence.join(' '), subsystem: parsed.subsystem ?? resolvedSubsystem },
        openFindingCandidates,
      );
      if (duplicate) {
        if (duplicate.verdict === 'borderline') {
          notes.push(`Finding "${truncate(parsed.statement, 60)}": ${duplicate.reason}.`);
        } else {
          const existing = this.store.getFinding(duplicate.id);
          if (existing) {
            // Same finding: strengthen rather than duplicate. Confidence never
            // drops, and evidence/files/symbols only ever grow.
            const mergedEvidence = dedupe([...existing.evidence, ...parsed.evidence]);
            const keepExisting = isConfidenceAtLeast(existing.confidence, guard.confidence);
            const updated = this.store.updateFinding(existing.id, {
              confidence: keepExisting ? existing.confidence : guard.confidence,
              evidence: mergedEvidence,
              files: dedupe([...existing.files, ...files]),
              symbols: dedupe([...existing.symbols, ...symbols]),
              now,
            });
            findingIds.push(updated.id);
            notes.push(`Finding ${updated.id} already existed; merged evidence instead of duplicating it.`);
            continue;
          }
        }
      }

      const finding = this.store.createFinding({
        projectId: discovery.project.id,
        statement: parsed.statement,
        evidence: parsed.evidence,
        confidence: guard.confidence,
        subsystem: parsed.subsystem ?? resolvedSubsystem,
        files,
        symbols,
        source: 'master_complete',
        now,
      });
      findingIds.push(finding.id);
      openFindingCandidates.push({
        id: finding.id,
        text: finding.statement,
        detail: finding.evidence.join(' '),
        subsystem: finding.subsystem,
      });
    }

    // ---------------------------------------------------------------------
    // Bugs
    // ---------------------------------------------------------------------
    const bugsCreated: string[] = [];
    const bugCandidates: DedupExisting[] = this.store
      .listBugs(discovery.project.id, { limit: 400 })
      .map((bug) => ({
        id: bug.id,
        text: bug.title,
        detail: [bug.observed, bug.expected, bug.reproduction].filter(Boolean).join(' '),
        subsystem: bug.subsystem,
      }));
    for (const bugInput of input.bugsFound ?? []) {
      const parsed = normalizeBug(bugInput);
      if (!parsed) continue;
      const duplicate = findDuplicate(
        {
          text: parsed.title,
          detail: [parsed.observed, parsed.expected, parsed.reproduction].filter(Boolean).join(' '),
          subsystem: parsed.subsystem ?? resolvedSubsystem,
        },
        bugCandidates,
      );
      if (duplicate) {
        if (duplicate.verdict === 'borderline') {
          notes.push(`Bug "${truncate(parsed.title, 60)}": ${duplicate.reason}.`);
        } else {
          const existing = this.store.getBug(duplicate.id);
          if (existing) {
            // Merge what the new report adds; the existing status stays put.
            const updated = this.store.updateBug(existing.id, {
              evidence: dedupe([...existing.evidence, ...parsed.evidence]),
              files: dedupe([...existing.files, ...parsed.files]),
              now,
            });
            bugsCreated.push(updated.id);
            notes.push(`Bug ${updated.id} already existed; merged evidence instead of duplicating it.`);
            continue;
          }
        }
      }
      const bug = this.store.createBug({
        projectId: discovery.project.id,
        title: parsed.title,
        severity: parsed.severity,
        status: 'open',
        subsystem: parsed.subsystem ?? resolvedSubsystem,
        reproduction: parsed.reproduction,
        expected: parsed.expected,
        observed: parsed.observed,
        evidence: parsed.evidence,
        files: parsed.files,
        now,
      });
      bugsCreated.push(bug.id);
      bugCandidates.push({
        id: bug.id,
        text: bug.title,
        detail: [bug.observed, bug.expected, bug.reproduction].filter(Boolean).join(' '),
        subsystem: bug.subsystem,
      });
    }

    const bugsUpdated: string[] = [];
    for (const bug of bugsToEvaluate) {
      const verdict = bugVerdicts.get(bug.id) ?? { satisfied: false, reason: null };
      const verified = verdict.satisfied && classification.status !== 'failed';
      const status = verified ? 'fixed_verified' : 'fix_claimed';
      const updated = this.store.updateBug(bug.id, {
        status,
        resolvedAt: verified ? now : null,
        taskId: task.id,
        now,
      });
      bugsUpdated.push(updated.id);
      if (verified) {
        notes.push(`Bug ${updated.id} marked fixed_verified: ${verdict.reason ?? 'bug-specific evidence provided'}.`);
      } else {
        notes.push(
          `Bug ${updated.id} marked fix_claimed, not fixed_verified: the evidence does not reference this bug ` +
            '(name it, run its regression check, or cover its title).',
        );
      }
    }

    // ---------------------------------------------------------------------
    // Follow-up tasks
    // ---------------------------------------------------------------------
    const followUps: string[] = [];
    const followUpLabels: string[] = [];
    const openTaskCandidates = (): DedupExisting[] =>
      this.store
        .listTasks(discovery.project.id, { limit: 200 })
        .filter((candidate) => needsWork(candidate))
        .map((candidate) => ({
          id: candidate.id,
          text: candidate.title,
          detail: candidate.description,
          subsystem: candidate.subsystem,
        }));
    for (const followUpInput of input.followUp ?? []) {
      const parsed = normalizeFollowUp(followUpInput);
      if (!parsed) continue;
      const candidate = {
        text: parsed.title,
        detail: parsed.description,
        subsystem: parsed.subsystem ?? resolvedSubsystem,
      };
      const duplicate = findDuplicate(candidate, openTaskCandidates());
      if (duplicate?.verdict === 'duplicate') {
        notes.push(`Follow-up "${truncate(parsed.title, 60)}": ${duplicate.reason}; not duplicated.`);
        continue;
      }
      if (duplicate) {
        notes.push(`Follow-up "${truncate(parsed.title, 60)}": ${duplicate.reason}.`);
      }
      const followUp = this.store.createTask({
        projectId: discovery.project.id,
        title: truncate(parsed.title, 200),
        description: parsed.description,
        priority: parsed.priority,
        status: 'todo',
        subsystem: parsed.subsystem ?? resolvedSubsystem,
        dependencies: [task.id],
        source: 'master_complete',
        now,
      });
      followUps.push(followUp.id);
      followUpLabels.push(`${truncate(parsed.title, 120)} (${followUp.id})`);
    }

    // Unresolved items that are not blockers still deserve a task so they are
    // not lost; they are recorded as follow-ups with the same dependency.
    for (const item of unresolved) {
      const existingOpen = this.store
        .listTasks(discovery.project.id, { limit: 200 })
        .find((candidate) => needsWork(candidate) && sameReference(candidate.title, item));
      if (existingOpen) continue;
      const followUp = this.store.createTask({
        projectId: discovery.project.id,
        title: truncate(item, 200),
        description: `Unresolved after ${task.id}: ${truncate(summary, 160)}`,
        priority: 'P3',
        status: 'todo',
        subsystem: resolvedSubsystem,
        dependencies: [task.id],
        source: 'master_complete',
        now,
      });
      followUps.push(followUp.id);
      followUpLabels.push(`${truncate(item, 120)} (${followUp.id})`);
    }

    // ---------------------------------------------------------------------
    // Task + handoff
    // ---------------------------------------------------------------------
    const updatedTask = this.store.updateTask(task.id, {
      status: decision.status,
      verificationStatus: classification.status,
      affectedFiles: dedupe([...task.affectedFiles, ...filesChanged]),
      blockers,
      completedAt: decision.status === 'verified_done' ? now : null,
      head: observation?.head ?? task.head,
      branch: observation?.branch ?? task.branch,
      now,
    });

    const handoff = this.store.createHandoff({
      projectId: discovery.project.id,
      taskId: updatedTask.id,
      summary: truncate(summary, 400),
      workAttempted: task.title,
      workCompleted: decision.status === 'blocked' ? null : truncate(summary, 400),
      failures: claims.filter((claim) => claim.result === 'fail').map((claim) => claim.command ?? claim.method),
      discoveries: findingIds,
      blockers,
      unresolved,
      followUp: followUpLabels,
      subsystem: updatedTask.subsystem,
      branch: observation?.branch ?? null,
      head: observation?.head ?? null,
      now,
    });

    if (commits.length > 0) {
      notes.push(`Commits recorded: ${commits.slice(0, 5).join(', ')}.`);
    }
    if (filesChanged.length === 0 && decision.status === 'implementation_done') {
      notes.push('No changed files were reported; if work did land, pass files_changed so the next brief can use it.');
    }
    if (discovery.createdProject) {
      notes.push(`Registered new project "${discovery.project.slug}" from ${discovery.repositoryPath}.`);
    }

    // A completion *is* a look at the repository, so it counts as the last
    // recorded observation. Without this the next brief would warn that state
    // advanced — even though the passing commit is already in the handoff.
    if (discovery.repository && observation) {
      this.store.recordRepositoryObservation(discovery.repository.id, {
        branch: observation.branch,
        head: observation.head,
        dirty: observation.dirty,
        remoteUrl: observation.remoteUrl,
        name: observation.name,
        seenAt: now,
      });
    }

    this.store.touchProject(discovery.project.id, now);
    this.store.recordActivity({
      projectId: discovery.project.id,
      kind: 'complete',
      summary: `complete: ${truncate(updatedTask.title, 100)} → ${decision.status}`,
      payload: {
        taskId: updatedTask.id,
        handoffId: handoff.id,
        verification: classification.status,
        findings: findingIds.length,
        bugsCreated: bugsCreated.length,
      },
      source: 'master_complete',
      now,
    });

    const result: MasterCompleteResult = {
      text: renderCompletion({
        task: updatedTask,
        verificationStatus: classification.status,
        handoff,
        coverage: classification.coverage,
      }),
      taskId: updatedTask.id,
      taskStatus: updatedTask.status,
      verificationStatus: classification.status,
      handoffId: handoff.id,
      recorded: {
        verifications: verificationIds,
        findings: findingIds,
        bugsCreated,
        bugsUpdated,
        followUps,
        decisions: [],
      },
      notes,
      projectSlug: discovery.project.slug,
    };
    return result;
  }

  /** Resolve (or create) the task a completion belongs to. */
  private resolveTaskForCompletion(input: {
    project: Project;
    taskId: string | null;
    taskTitle: string | null;
    summary: string;
    observation: RepositoryObservation | null;
    now: string;
    notes: string[];
  }): Task {
    const { project, taskId, taskTitle, summary, observation, now, notes } = input;

    if (taskId) {
      const byId = this.store.getTask(taskId.trim());
      if (byId && byId.projectId === project.id) return byId;
      const byTitle = byId ? null : this.store.findTaskByTitle(project.id, taskId.trim());
      if (byTitle) {
        notes.push(`No task id matched "${taskId}"; resolved it by exact title to ${byTitle.id}.`);
        return byTitle;
      }
      throw notFoundError(
        `No task "${taskId}" exists in project "${project.slug}".`,
        'Call master_context first, or pass the task title instead of an id.',
      );
    }

    if (taskTitle) {
      const tasks = this.store.listTasks(project.id, { limit: 200 });
      const match = matchTask(tasks, taskTitle);
      if (match) {
        if (!match.exact) {
          notes.push(`Matched task "${match.task.title}" (${match.task.id}) for the supplied title.`);
        }
        return match.task;
      }
      notes.push(`No stored task matched "${truncate(taskTitle, 60)}"; created a new one.`);
      return this.store.createTask({
        projectId: project.id,
        title: truncate(taskTitle, 200),
        status: 'in_progress',
        priority: inferPriority(taskTitle),
        source: 'master_complete',
        head: observation?.head ?? null,
        branch: observation?.branch ?? null,
        now,
      });
    }

    const tasks = this.store.listTasks(project.id, { limit: 200 });
    const openWork = tasks.filter((task) => task.status === 'in_progress' || task.status === 'blocked');
    if (openWork.length === 1) {
      notes.push(`No task supplied; attached the completion to the only in-progress task (${openWork[0]!.id}).`);
      return openWork[0]!;
    }
    notes.push('No task supplied; created a task from the summary.');
    return this.store.createTask({
      projectId: project.id,
      title: truncate(summary, 200),
      status: 'in_progress',
      source: 'master_complete',
      head: observation?.head ?? null,
      branch: observation?.branch ?? null,
      now,
    });
  }

  /**
   * Collect every bug a completion speaks to.
   *
   * That is the bugs it lists in `bugs_resolved` plus any bug previously
   * claimed fixed by this same task: re-checking those on later passes is what
   * lets a fix_claimed bug become fixed_verified without the agent having to
   * re-list it.
   */
  private collectBugsToEvaluate(
    projectId: string,
    taskId: string,
    references: readonly string[],
    notes: string[],
  ): Bug[] {
    const out: Bug[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const bug = this.store.getBug(reference) ?? this.store.findBugByTitle(projectId, reference) ?? null;
      if (!bug || bug.projectId !== projectId) {
        notes.push(`Could not resolve bug "${truncate(reference, 60)}"; nothing was recorded for it.`);
        continue;
      }
      if (seen.has(bug.id)) continue;
      seen.add(bug.id);
      out.push(bug);
    }
    for (const bug of this.store.listBugsForTask(projectId, taskId)) {
      if (seen.has(bug.id) || bug.status !== 'fix_claimed') continue;
      seen.add(bug.id);
      out.push(bug);
      notes.push(`Re-checking bug ${bug.id}, whose fix was claimed by this task but never verified.`);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // master_search
  // -------------------------------------------------------------------------

  search(input: MasterSearchInput): MasterSearchResult {
    const query = requireText(input.query, 'query', 'Pass the historical detail you are looking for.');
    const project = input.project ? this.resolveProjectReference(input.project) : this.resolveProjectFromCwd();
    const kinds = (input.kinds ?? [])
      .map((kind) => kind.trim().toLowerCase())
      .filter((kind): kind is MemoryItem['kind'] => MEMORY_KIND_VALUES.includes(kind as MemoryItem['kind']));
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

    const hits = this.store.searchMemory({
      query,
      projectId: project?.id,
      kinds: kinds.length > 0 ? kinds : undefined,
      limit,
    });

    const lines: string[] = [];
    lines.push(`SEARCH "${query}"`);
    lines.push(`scope: ${project ? `${project.slug} (${project.id})` : 'all projects allowed by the query'}`);
    if (kinds.length > 0) lines.push(`kinds: ${kinds.join(', ')}`);
    if (hits.length === 0) {
      lines.push('', 'No stored memory matched. Record it with master_record if it should exist.');
      return { text: `${lines.join('\n')}\n`, hits: [], projectSlug: project?.slug ?? null };
    }
    lines.push('', `${hits.length} hit(s), best first:`);
    for (const hit of hits) {
      const score = hit.score !== undefined ? ` ${(hit.score * 100).toFixed(0)}%` : '';
      const subsystem = hit.subsystem ? ` · ${hit.subsystem}` : '';
      lines.push(`- [${hit.kind}] ${truncate(hit.title, 140)}${subsystem} (${hit.id})${score}`);
      if (hit.body) lines.push(`    ${truncate(hit.body, 200)}`);
    }
    return {
      text: `${lines.join('\n')}\n`,
      hits: hits.map((hit) => ({
        kind: hit.kind,
        id: hit.id,
        title: hit.title,
        subsystem: hit.subsystem,
        score: hit.score ?? 0,
      })),
      projectSlug: project?.slug ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // master_status
  // -------------------------------------------------------------------------

  async status(input: MasterStatusInput = {}): Promise<MasterStatusResult> {
    const warnings: string[] = [];
    let project: Project | null = null;
    let observation: RepositoryObservation | null = null;
    let repository: Repository | null = null;

    try {
      const discovery = await discoverProject({
        store: this.store,
        clock: this.clock,
        project: input.project ?? null,
        repositoryPath: input.repositoryPath ?? null,
        cwd: this.cwd,
        allowCreate: false,
        observe: { recentCommits: 3 },
      });
      project = discovery.project;
      observation = discovery.observation;
      repository = discovery.repository;
      warnings.push(...discovery.warnings);
    } catch (error) {
      // Status is a convenience view: an unknown project yields an explanation,
      // not a hard failure.
      if (error instanceof MasterMcpError) warnings.push(error.message);
      else if (error instanceof Error) warnings.push(error.message);
    }

    const previousHead = repository?.lastHead ?? null;
    let headRelation: 'same' | 'advanced' | 'diverged' | 'unknown' = 'unknown';
    if (previousHead && observation?.head && observation.root) {
      if (previousHead === observation.head) headRelation = 'same';
      else {
        const ancestor = await isAncestor(observation.root, previousHead, observation.head);
        headRelation = ancestor === true ? 'advanced' : ancestor === false ? 'diverged' : 'unknown';
      }
    }

    const report = buildStatus({
      project,
      repository,
      observation,
      tasks: project ? this.store.listTasks(project.id, { limit: 200 }) : [],
      items: project ? this.store.loadMemoryItems(project.id) : [],
      activity: project ? this.store.listActivity(project.id, 8) : [],
      previousHead,
      headRelation,
      clock: this.clock,
      knownProjects: this.store.listProjects().map((candidate) => candidate.slug),
      warning: warnings,
    });

    // `master_status` is advertised as read-only, so it deliberately does not
    // touch `last_accessed_at`; only real work passes do that.
    return { text: renderStatus(report), report };
  }

  // -------------------------------------------------------------------------
  // master_record
  // -------------------------------------------------------------------------

  record(input: MasterRecordInput): MasterRecordResult {
    const kind = requireText(input.kind, 'kind').toLowerCase();
    const body = requireText(input.body, 'body', 'The statement/description of the record.');
    const project =
      (input.project ? this.resolveProjectReference(input.project) : null) ?? this.resolveProjectFromCwd();
    if (!project) {
      throw notFoundError(
        'No project could be identified for this record.',
        'Pass "project" or call from inside a registered repository.',
      );
    }
    const now = isoNow(this.clock);
    const files = dedupe(input.files);
    const evidence = dedupe(input.evidence);
    const subsystem = input.subsystem?.trim() || null;

    switch (kind) {
      case 'decision': {
        if (input.replaces || input.deactivate) {
          throw usageError(
            '"replaces" and "deactivate" apply to constraints, not decisions.',
            'Use "supersedes" to replace one decision with another.',
          );
        }
        const supersedesId = input.supersedes?.trim() || null;
        const superseded = supersedesId ? this.requireActiveDecision(project, supersedesId) : null;

        const duplicate = findDuplicate(
          { text: body, detail: input.rationale ?? null, subsystem },
          this.store
            .listDecisions(project.id, { activeOnly: false, limit: 400 })
            .filter((candidate) => candidate.id !== superseded?.id)
            .map((candidate) => ({
              id: candidate.id,
              text: candidate.statement,
              detail: candidate.rationale,
              subsystem: candidate.subsystem,
              inactive: candidate.status !== 'active',
            })),
        );
        if (duplicate?.verdict === 'duplicate') {
          const existing = this.store.getDecision(duplicate.id);
          if (existing) {
            const merged = this.store.updateDecision(existing.id, {
              files: mergeStrings(existing.files, files),
              commits: mergeStrings(existing.commits, dedupe(input.commits)),
              now,
            });
            this.afterWrite(project, 'record', `decision: merged into ${merged.id}`, { id: merged.id }, now);
            return {
              text: `Decision ${merged.id} already covers this (${duplicate.reason}); merged files/commits instead of duplicating it.\n`,
              id: merged.id,
              kind,
              projectSlug: project.slug,
            };
          }
        }
        if (duplicate) {
          // borderline: recorded anyway, with the similarity called out
        }

        const decision = this.store.transaction(() => {
          const created = this.store.createDecision({
            projectId: project.id,
            statement: body,
            rationale: input.rationale ?? null,
            subsystem,
            alternatives: dedupe(input.alternatives),
            files,
            commits: dedupe(input.commits),
            source: 'master_record',
            now,
          });
          if (superseded) this.store.supersedeDecision(superseded.id, created.id, now);
          return created;
        });
        this.afterWrite(project, 'record', `decision: ${truncate(body, 100)}`, { id: decision.id }, now);
        const supersedeNote = superseded
          ? `\nSuperseded decision ${superseded.id}; it stays searchable and exportable but is no longer active.\n`
          : '';
        const duplicateNote = duplicate ? `\nNote: ${duplicate.reason}.\n` : '';
        return {
          text: `Recorded decision ${decision.id}.\n${decision.statement}${supersedeNote}${duplicateNote}`,
          id: decision.id,
          kind,
          projectSlug: project.slug,
        };
      }
      case 'constraint': {
        if (input.supersedes) {
          throw usageError(
            '"supersedes" applies to decisions, not constraints.',
            'Use "replaces" to replace a constraint, or "deactivate" to retire one without a replacement.',
          );
        }
        const replacesId = input.replaces?.trim() || null;
        const deactivateId = input.deactivate?.trim() || null;
        if (replacesId && deactivateId) {
          throw usageError(
            '"replaces" and "deactivate" are alternatives; pass only one.',
            'Use "deactivate" when the invariant no longer applies and nothing replaces it.',
          );
        }

        // Deactivation without replacement: the body is the reason.
        if (deactivateId && !replacesId) {
          const retired = this.requireActiveConstraint(project, deactivateId);
          this.store.deactivateConstraint(retired.id, now);
          this.afterWrite(project, 'record', `constraint: deactivated ${retired.id}`, { id: retired.id }, now);
          return {
            text: `Deactivated constraint ${retired.id}.\nReason: ${body}\nIt stays searchable and exportable but no longer appears as preflight guidance.\n`,
            id: retired.id,
            kind,
            projectSlug: project.slug,
          };
        }

        const replaced = replacesId ? this.requireActiveConstraint(project, replacesId) : null;
        const duplicate = findDuplicate(
          { text: body, subsystem },
          this.store
            .listConstraints(project.id, { activeOnly: false, limit: 400 })
            .filter((candidate) => candidate.id !== replaced?.id)
            .map((candidate) => ({
              id: candidate.id,
              text: candidate.statement,
              subsystem: candidate.subsystem,
              inactive: !candidate.active,
            })),
        );
        if (duplicate?.verdict === 'duplicate') {
          const existing = this.store.getConstraint(duplicate.id);
          if (existing) {
            const merged = this.store.updateConstraint(existing.id, {
              files: mergeStrings(existing.files, files),
              now,
            });
            this.afterWrite(project, 'record', `constraint: merged into ${merged.id}`, { id: merged.id }, now);
            return {
              text: `Constraint ${merged.id} already covers this (${duplicate.reason}); merged files instead of duplicating it.\n`,
              id: merged.id,
              kind,
              projectSlug: project.slug,
            };
          }
        }

        const constraint = this.store.transaction(() => {
          const created = this.store.createConstraint({
            projectId: project.id,
            statement: body,
            subsystem,
            severity: parseSeverity(input.severity) ?? 'medium',
            files,
            source: 'master_record',
            now,
          });
          if (replaced) this.store.replaceConstraint(replaced.id, created.id, now);
          return created;
        });
        this.afterWrite(project, 'record', `constraint: ${truncate(body, 100)}`, { id: constraint.id }, now);
        const replaceNote = replaced
          ? `\nReplaced constraint ${replaced.id}; it stays searchable and exportable but no longer appears as preflight guidance.\n`
          : '';
        const duplicateNote = duplicate ? `\nNote: ${duplicate.reason}.\n` : '';
        return {
          text: `Recorded ${constraint.severity} constraint ${constraint.id}.\n${constraint.statement}${replaceNote}${duplicateNote}`,
          id: constraint.id,
          kind,
          projectSlug: project.slug,
        };
      }
      case 'bug': {
        const severity = parseSeverity(input.severity) ?? 'medium';
        const title = truncate(body, 200);
        const duplicate = findDuplicate(
          {
            text: title,
            detail: [input.observed, input.expected, input.reproduction].filter(Boolean).join(' '),
            subsystem,
          },
          this.store.listBugs(project.id, { limit: 400 }).map((candidate) => ({
            id: candidate.id,
            text: candidate.title,
            detail: [candidate.observed, candidate.expected, candidate.reproduction].filter(Boolean).join(' '),
            subsystem: candidate.subsystem,
          })),
        );
        if (duplicate?.verdict === 'duplicate') {
          const existing = this.store.getBug(duplicate.id);
          if (existing) {
            const merged = this.store.updateBug(existing.id, {
              evidence: mergeStrings(existing.evidence, evidence),
              files: mergeStrings(existing.files, files),
              commits: mergeStrings(existing.commits, dedupe(input.commits)),
              now,
            });
            this.afterWrite(project, 'record', `bug: merged into ${merged.id}`, { id: merged.id }, now);
            return {
              text: `Bug ${merged.id} already matches this report (${duplicate.reason}); merged evidence/files/commits into it.\n`,
              id: merged.id,
              kind,
              projectSlug: project.slug,
            };
          }
        }
        const bug = this.store.createBug({
          projectId: project.id,
          title,
          severity,
          status: 'open',
          subsystem,
          reproduction: input.reproduction ?? null,
          expected: input.expected ?? null,
          observed: input.observed ?? null,
          evidence,
          files,
          commits: dedupe(input.commits),
          now,
        });
        this.afterWrite(project, 'record', `bug: ${truncate(body, 100)}`, { id: bug.id }, now);
        const duplicateNote = duplicate ? `\nNote: ${duplicate.reason}.\n` : '';
        return {
          text: `Recorded ${severity} bug ${bug.id}.\n${bug.title}\nIt will appear as a preflight hazard for matching tasks.${duplicateNote}\n`,
          id: bug.id,
          kind,
          projectSlug: project.slug,
        };
      }
      case 'finding':
      case 'hypothesis': {
        const requested = parseConfidence(input.confidence) ?? (kind === 'hypothesis' ? 'hypothesis' : 'suspected');
        const symbols = dedupe(input.symbols);
        const guard = guardConfidence({ requested, evidence, files, symbols });
        const duplicate = findDuplicate(
          { text: body, detail: evidence.join(' '), subsystem },
          this.store.listFindings(project.id, { limit: 400 }).map((candidate) => ({
            id: candidate.id,
            text: candidate.statement,
            detail: candidate.evidence.join(' '),
            subsystem: candidate.subsystem,
          })),
        );
        if (duplicate?.verdict === 'duplicate') {
          const existing = this.store.getFinding(duplicate.id);
          if (existing) {
            // Confidence never falls: the merge keeps whichever is stronger.
            const keepExisting = isConfidenceAtLeast(existing.confidence, guard.confidence);
            const merged = this.store.updateFinding(existing.id, {
              confidence: keepExisting ? existing.confidence : guard.confidence,
              evidence: mergeStrings(existing.evidence, evidence),
              files: mergeStrings(existing.files, files),
              symbols: mergeStrings(existing.symbols, symbols),
              now,
            });
            this.afterWrite(project, 'record', `finding: merged into ${merged.id}`, { id: merged.id }, now);
            return {
              text: `Finding ${merged.id} already exists at confidence "${merged.confidence}" (${duplicate.reason}); merged evidence instead of duplicating it.\n`,
              id: merged.id,
              kind,
              projectSlug: project.slug,
            };
          }
        }
        const finding = this.store.createFinding({
          projectId: project.id,
          statement: body,
          evidence,
          confidence: guard.confidence,
          subsystem,
          files,
          symbols,
          source: 'master_record',
          now,
        });
        this.afterWrite(project, 'record', `finding: ${truncate(body, 100)}`, { id: finding.id }, now);
        const reason = guard.reason ? `\nNote: ${guard.reason}` : '';
        const duplicateNote = duplicate ? `\nNote: ${duplicate.reason}.` : '';
        return {
          text: `Recorded finding ${finding.id} at confidence "${finding.confidence}".\n${finding.statement}${reason}${duplicateNote}\n`,
          id: finding.id,
          kind,
          projectSlug: project.slug,
        };
      }
      case 'todo': {
        const title = truncate(body, 200);
        const duplicate = findDuplicate(
          { text: title, detail: input.rationale ?? null, subsystem },
          this.store
            .listTasks(project.id, { limit: 200 })
            .filter((candidate) => needsWork(candidate))
            .map((candidate) => ({
              id: candidate.id,
              text: candidate.title,
              detail: candidate.description,
              subsystem: candidate.subsystem,
            })),
        );
        if (duplicate?.verdict === 'duplicate') {
          this.afterWrite(project, 'record', `todo: matched ${duplicate.id}`, { id: duplicate.id }, now);
          return {
            text: `Todo ${duplicate.id} already covers this (${duplicate.reason}); not duplicated.\n`,
            id: duplicate.id,
            kind,
            projectSlug: project.slug,
          };
        }
        const task = this.store.createTask({
          projectId: project.id,
          title,
          description: input.rationale ?? null,
          priority: parsePriority(input.priority) ?? 'P2',
          status: 'todo',
          subsystem,
          affectedFiles: files,
          verificationRequirements: dedupe(input.verificationRequirements),
          source: 'master_record',
          now,
        });
        this.afterWrite(project, 'record', `todo: ${truncate(body, 100)}`, { id: task.id }, now);
        const duplicateNote = duplicate ? `\nNote: ${duplicate.reason}.\n` : '';
        return {
          text: `Recorded ${task.priority} task ${task.id}.\n${task.title}\nIt will surface as a follow-up in matching briefs.${duplicateNote}\n`,
          id: task.id,
          kind,
          projectSlug: project.slug,
        };
      }
      case 'handoff': {
        const handoff = this.store.createHandoff({
          projectId: project.id,
          taskId: input.taskId ?? null,
          summary: truncate(body, 400),
          workCompleted: input.rationale ?? null,
          discoveries: evidence,
          blockers: dedupe(input.alternatives),
          followUp: dedupe(input.followUp),
          subsystem,
          head: null,
          branch: null,
          source: 'master_record',
          now,
        } as Parameters<Store['createHandoff']>[0]);
        this.afterWrite(project, 'record', `handoff: ${truncate(body, 100)}`, { id: handoff.id }, now);
        return { text: `Recorded handoff ${handoff.id}.\n${handoff.summary}\n`, id: handoff.id, kind, projectSlug: project.slug };
      }
      case 'verification': {
        const taskId = input.taskId?.trim();
        if (taskId) {
          const existing = this.store.getTask(taskId);
          if (!existing || existing.projectId !== project.id) {
            throw notFoundError(
              `No task "${taskId}" in project "${project.slug}".`,
              'Omit task_id to record a project-level verification.',
            );
          }
        }
        const result: VerificationResult = parseVerificationResult(input.result) ?? 'unknown';
        const verification = this.store.createVerification({
          projectId: project.id,
          taskId: taskId && this.store.getTask(taskId) ? taskId : null,
          method: input.method?.trim() || truncate(body, 200),
          command: input.command ?? null,
          result,
          evidence,
          now,
        });
        this.afterWrite(project, 'record', `verification: ${truncate(verification.method, 100)}`, { id: verification.id }, now);
        return {
          text: `Recorded verification ${verification.id} (${verification.result}).\n${verification.method}\n`,
          id: verification.id,
          kind,
          projectSlug: project.slug,
        };
      }
      default:
        throw usageError(
          `Unknown record kind "${kind}".`,
          'Valid kinds: decision, constraint, bug, finding, hypothesis, todo, handoff, verification.',
        );
    }
  }

  private afterWrite(
    project: Project,
    kind: string,
    summary: string,
    payload: Record<string, unknown>,
    now: string,
  ): void {
    this.store.touchProject(project.id, now);
    this.store.recordActivity({ projectId: project.id, kind, summary, payload, source: 'master_record', now });
  }

  /** Resolve a decision that is still active and belongs to this project. */
  private requireActiveDecision(project: Project, id: string): Decision {
    const decision = this.store.getDecision(id);
    if (!decision || decision.projectId !== project.id) {
      throw notFoundError(
        `No decision "${id}" exists in project "${project.slug}".`,
        'Pass the id of a decision in this project (see master_search).',
      );
    }
    if (decision.status !== 'active') {
      throw usageError(
        `Decision ${id} is already ${decision.status}; it cannot be superseded again.`,
        'Record the new decision without "supersedes", or target the active decision it replaced.',
      );
    }
    return decision;
  }

  /** Resolve a constraint that is still active and belongs to this project. */
  private requireActiveConstraint(project: Project, id: string): Constraint {
    const constraint = this.store.getConstraint(id);
    if (!constraint || constraint.projectId !== project.id) {
      throw notFoundError(
        `No constraint "${id}" exists in project "${project.slug}".`,
        'Pass the id of a constraint in this project (see master_search).',
      );
    }
    if (!constraint.active) {
      throw usageError(
        `Constraint ${id} is already inactive; it cannot be replaced or deactivated again.`,
        'Record the new constraint without "replaces", or target the active constraint it replaced.',
      );
    }
    return constraint;
  }

  // -------------------------------------------------------------------------
  // Project resolution helpers (no repository inspection needed here)
  // -------------------------------------------------------------------------

  private resolveProjectReference(reference: string): Project | null {
    const trimmed = reference.trim();
    if (!trimmed) return null;
    const bySlug = this.store.getProjectBySlug(trimmed) ?? this.store.getProject(trimmed);
    if (bySlug) return bySlug;
    const byName = this.store
      .listProjects()
      .find((project) => project.name.toLowerCase() === trimmed.toLowerCase());
    return byName ?? null;
  }

  /**
   * Best-effort project for calls that only need a scope (search, record).
   * Walks the current directory upwards looking for a known repository path.
   */
  private resolveProjectFromCwd(): Project | null {
    const repository = this.store.findRepositoryForPath(this.cwd);
    return repository ? this.store.getProject(repository.projectId) : null;
  }

  // -------------------------------------------------------------------------
  // Export / import
  // -------------------------------------------------------------------------

  exportProject(input: MasterExportInput): MasterExportResult {
    const format = (input.format ?? 'markdown').trim().toLowerCase();
    if (format !== 'markdown' && format !== 'json') {
      throw usageError(`Unknown export format "${input.format}".`, 'Valid formats: markdown, json.');
    }
    const project = this.requireProject(input.project ?? null, input.repositoryPath ?? null);
    const snapshot = readSnapshot(this.store, project, isoNow(this.clock));
    return {
      format,
      snapshot,
      text: format === 'json' ? `${JSON.stringify(snapshot, null, 2)}\n` : exportMarkdown(snapshot),
    };
  }

  importSnapshot(snapshot: ProjectSnapshot, options: { mode?: 'merge' | 'replace' } = {}): RestoreReport {
    const mode = options.mode ?? 'merge';
    const now = isoNow(this.clock);
    const report = writeSnapshot(this.store, snapshot, { mode, now });
    this.store.recordActivity({
      projectId: report.projectId,
      kind: 'import',
      summary: `import: ${mode} restore of ${snapshot.project.slug}`,
      payload: { written: report.written, remapped: report.remappedIds.length },
      source: 'import',
      now,
    });
    return report;
  }

  private requireProject(project: string | null, repositoryPath: string | null): Project {
    if (project) {
      const resolved = this.resolveProjectReference(project);
      if (!resolved) {
        throw notFoundError(
          `No project named "${project}".`,
          `Known projects: ${this.store.listProjects().map((candidate) => candidate.slug).join(', ') || 'none'}.`,
        );
      }
      return resolved;
    }
    const fromCwd = repositoryPath
      ? this.store.findRepositoryForPath(repositoryPath)
      : this.store.findRepositoryForPath(this.cwd);
    const resolved = fromCwd ? this.store.getProject(fromCwd.projectId) : null;
    if (!resolved) {
      throw notFoundError(
        'No project could be identified from the current directory.',
        'Pass "project" explicitly, or run from inside a registered repository.',
      );
    }
    return resolved;
  }

  /** Diagnostics used by the CLI `doctor` command. */
  describe(): {
    databasePath: string;
    schemaVersion: number;
    projects: Array<{ slug: string; name: string; repositories: number; memoryRecords: number }>;
  } {
    const projects = this.store.listProjects().map((project) => ({
      slug: project.slug,
      name: project.name,
      repositories: this.store.listRepositories(project.id).length,
      memoryRecords: this.store.indexedCount(project.id),
    }));
    return { databasePath: this.dbPath, schemaVersion: this.schemaVersion, projects };
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers (shared by complete/record)
// ---------------------------------------------------------------------------

const MEMORY_KIND_VALUES: readonly MemoryItem['kind'][] = [
  'task',
  'decision',
  'constraint',
  'bug',
  'finding',
  'verification',
  'handoff',
];

/** Deterministic priority inference: only explicit markers change the default. */
export function inferPriority(text: string): 'P0' | 'P1' | 'P2' | 'P3' {
  if (/\bp0\b|critical|production down|outage/i.test(text)) return 'P0';
  if (/\bp1\b|urgent|blocker|regression|crash/i.test(text)) return 'P1';
  if (/\bp3\b|nice to have|cosmetic|typo|docs?\b/i.test(text)) return 'P3';
  return 'P2';
}

function isConfidenceAtLeast(a: Confidence, b: Confidence): boolean {
  return CONFIDENCES.indexOf(a) >= CONFIDENCES.indexOf(b);
}

function normalizeClaim(value: string | TestRunInput): VerificationClaim | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length === 0) return null;
    // A bare string is a description of a run, not a structured result.
    return { method: truncate(text, 200), command: null, result: 'unknown', evidence: [text] };
  }
  const method = (value.method ?? value.command ?? 'verification').trim() || 'verification';
  const result = parseVerificationResult(value.result) ?? (value.evidence && value.evidence.length > 0 ? 'pass' : 'unknown');
  return {
    method: truncate(method, 200),
    command: value.command?.trim() || null,
    result,
    evidence: dedupe(value.evidence),
  };
}

function normalizeClaims(
  testsRun: readonly (string | TestRunInput)[],
  verification: readonly VerificationInput[],
): VerificationClaim[] {
  const claims: VerificationClaim[] = [];
  for (const value of testsRun) {
    const claim = normalizeClaim(value);
    if (claim) claims.push(claim);
  }
  for (const value of verification) {
    const claim = normalizeClaim(value);
    if (claim) claims.push({ ...claim, method: value.method?.trim() || claim.method });
  }
  return claims;
}

function normalizeDiscovery(value: string | DiscoveryInput): {
  statement: string;
  confidence: Confidence;
  evidence: string[];
  files: string[];
  symbols: string[];
  subsystem: string | null;
} | null {
  if (typeof value === 'string') {
    const statement = value.trim();
    if (statement.length === 0) return null;
    return { statement: truncate(statement, 500), confidence: 'suspected', evidence: [], files: [], symbols: [], subsystem: null };
  }
  const statement = value.statement?.trim();
  if (!statement) return null;
  return {
    statement: truncate(statement, 500),
    confidence: parseConfidence(value.confidence) ?? 'suspected',
    evidence: dedupe(value.evidence),
    files: dedupe(value.files),
    symbols: dedupe(value.symbols),
    subsystem: null,
  };
}

function normalizeFollowUp(value: string | FollowUpInput): {
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  subsystem: string | null;
  description: string | null;
} | null {
  if (typeof value === 'string') {
    const title = value.trim();
    if (!title) return null;
    return { title, priority: 'P2', subsystem: null, description: null };
  }
  const title = value.title?.trim();
  if (!title) return null;
  return {
    title,
    priority: parsePriority(value.priority) ?? 'P2',
    subsystem: value.subsystem?.trim() || null,
    description: value.description?.trim() || null,
  };
}

function normalizeBug(value: string | BugInput): {
  title: string;
  severity: Severity;
  subsystem: string | null;
  reproduction: string | null;
  expected: string | null;
  observed: string | null;
  evidence: string[];
  files: string[];
} | null {
  if (typeof value === 'string') {
    const title = value.trim();
    if (!title) return null;
    return {
      title: truncate(title, 200),
      severity: 'medium',
      subsystem: null,
      reproduction: null,
      expected: null,
      observed: null,
      evidence: [],
      files: [],
    };
  }
  const title = value.title?.trim();
  if (!title) return null;
  return {
    title: truncate(title, 200),
    severity: parseSeverity(value.severity) ?? 'medium',
    subsystem: value.subsystem?.trim() || null,
    reproduction: value.reproduction ?? null,
    expected: value.expected ?? null,
    observed: value.observed ?? null,
    evidence: dedupe(value.evidence),
    files: dedupe(value.files),
  };
}

/** Confirmation text printed by `master_complete` and the CLI `complete` command. */
function renderCompletion(input: {
  task: Task;
  verificationStatus: VerificationStatus;
  handoff: Handoff;
  coverage?: VerificationCoverage | null;
}): string {
  const lines: string[] = [];
  const coverage = input.coverage
    ? `, coverage: ${input.coverage.satisfied}/${input.coverage.total}`
    : '';
  lines.push('RECORDED');
  lines.push(`task ${input.task.id} → ${input.task.status} (verification: ${input.verificationStatus}${coverage})`);
  lines.push(`title: ${input.task.title}`);
  if (input.coverage && input.coverage.total > 0) {
    const missing = missingRequirements(input.coverage);
    if (missing.length > 0) {
      lines.push(
        `uncovered: ${missing.slice(0, 4).map((requirement) => truncate(requirement, 90)).join('; ')}`,
      );
    }
  }
  if (input.task.affectedFiles.length > 0) {
    lines.push(`files: ${input.task.affectedFiles.join(', ')}`);
  }
  lines.push(`handoff: ${input.handoff.id}`);
  lines.push(
    '',
    'NEXT',
    `master_context with a related task will now include this handoff. Task state: ${input.task.status}.`,
  );
  if (input.verificationStatus !== 'verified') {
    lines.push(
      `Verification is "${input.verificationStatus}": the work is recorded but not confirmed. Run the verification plan and record it with master_complete (tests_run) or master_record (verification).`,
    );
  }
  return `${lines.join('\n')}\n`;
}
