/**
 * Requirement-aware verification.
 *
 * A completion is only as trustworthy as the checks it actually ran. This module
 * answers one question deterministically: given the requirements a task declared
 * (or the checks the project's config demands), which of them does the evidence
 * actually cover?
 *
 * Everything here is local and reproducible: normalised text matching, command
 * aliases and identifier references. No LLM, no embeddings, no fuzzy scoring
 * that could drift between runs.
 */
import type {
  Bug,
  ProjectConfig,
  Task,
  TaskType,
  VerificationResult,
  VerificationStatus,
} from '../domain/models.ts';
import { keywords, normalizeTerm, queryCoverage, truncate } from '../util/text.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Nothing more than a stored verification needs to expose to be assessed. */
export interface ClaimLike {
  /** Verification record id, when this claim came from storage. */
  id?: string;
  method: string;
  command: string | null;
  result: VerificationResult;
  evidence: readonly string[];
}

export type RequirementKind = 'test' | 'lint' | 'build' | 'regression' | 'docs' | 'manual' | 'other';

export interface RequirementAssessment {
  requirement: string;
  kind: RequirementKind;
  satisfied: boolean;
  /** Id of the verification that satisfied it, when one did. */
  verificationId: string | null;
}

export interface VerificationCoverage {
  status: VerificationStatus;
  satisfied: number;
  total: number;
  entries: RequirementAssessment[];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const KIND_PATTERNS: ReadonlyArray<readonly [RequirementKind, RegExp]> = [
  // Reproduction language comes first: "add a regression test" is a regression
  // requirement, not a plain test run.
  ['regression', /\b(regression|reproduce|reproduces|repro|no longer|still fails|still happens|before the fix|after the fix)\b/i],
  ['manual', /\b(manual|manually|by hand|visually|in the browser|smoke test)\b/i],
  ['lint', /\b(lint|linting|eslint|typecheck|type-check|type checking|tsc|format|formatter|prettier)\b/i],
  ['build', /\b(build|builds|compile|compiles|bundle|bundling|package|packaging)\b/i],
  ['docs', /\b(docs?|documentation|readme|changelog|comment|comments)\b/i],
  ['test', /\b(test|tests|testing|spec|specs|suite|jest|vitest|pytest|mocha|unit|integration|e2e|end to end)\b/i],
];

/**
 * Best-effort classification of a requirement sentence. Used for matching and
 * for the short label shown in a brief; never for scoring.
 */
export function classifyRequirement(text: string): RequirementKind {
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'other';
}

/** Classify a verification claim by the command it ran. */
export function classifyClaim(claim: ClaimLike): RequirementKind {
  const haystack = [claim.method, claim.command ?? '', ...claim.evidence].join(' ');
  return classifyRequirement(haystack);
}

// ---------------------------------------------------------------------------
// Command and reference extraction
// ---------------------------------------------------------------------------

/** Command-looking tokens: `npm run lint`, `pytest -q`, `./scripts/check.sh`. */
const COMMAND_START =
  /^(?:npm|npx|pnpm|yarn|bun|node|deno|make|cargo|go|python3?|pytest|jest|vitest|mocha|eslint|tsc|gradle|mvn|dotnet|swift|xcodebuild|cmake|bash|sh)\b/i;

function cleanCommand(raw: string): string {
  return raw
    .replace(/^[`'"$]+|[`'"$,.;)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the concrete commands a requirement or claim names.
 *
 * Backticked spans are always treated as commands; unwrapped text only counts
 * when it starts with a recognisable command runner, so prose is never
 * mistaken for a command.
 */
export function extractCommands(text: string): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    const command = cleanCommand(value);
    if (command.length === 0) return;
    if (!out.includes(command)) out.push(command);
  };

  for (const match of text.matchAll(/`([^`\n]+)`/g)) push(match[1] ?? '');
  for (const match of text.matchAll(/[^\s`]+(?:\s+[^\s`]+)*/g)) {
    const span = match[0] ?? '';
    for (const segment of span.split(/[;,]\s*/)) {
      const candidate = cleanCommand(segment);
      if (candidate.length > 0 && COMMAND_START.test(candidate)) push(candidate);
    }
  }
  return out;
}

/** Two commands agree when the shorter one is a normalised substring of the longer. */
export function commandMatches(a: string, b: string): boolean {
  const left = cleanCommand(a).toLowerCase().replace(/\s+/g, ' ');
  const right = cleanCommand(b).toLowerCase().replace(/\s+/g, ' ');
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= 4 && long.includes(short);
}

/**
 * Bug id referenced by a requirement or claim: `bug_1a2b3c4d` or `bug 1a2b3c4d`.
 *
 * Generated ids always use an underscore, so that form is accepted as-is. The
 * spaced prose form only counts when the token looks like an id (at least six
 * characters and a digit), otherwise "the bug before the fix" would be read as
 * a reference to a bug called "before".
 */
export function referencedBugId(text: string): string | null {
  const explicit = text.match(/\bbug[-_]([a-z0-9]{4,})\b/i);
  if (explicit?.[1]) return `bug_${explicit[1].toLowerCase()}`;
  const spaced = text.match(/\bbug\s+([a-z0-9]{6,})\b/i);
  if (spaced?.[1] && /\d/.test(spaced[1])) return `bug_${spaced[1].toLowerCase()}`;
  return null;
}

// ---------------------------------------------------------------------------
// Requirement ↔ evidence matching
// ---------------------------------------------------------------------------

/** Terms shared by two texts, after normalisation and stopword removal. */
function sharedTerms(a: string, b: string): string[] {
  const left = new Set(keywords(a));
  const right = new Set(keywords(b));
  return [...left].filter((term) => right.has(term));
}

const MIN_TERM_COVERAGE = 0.6;
const MIN_SHARED_TERMS = 2;

function claimText(claim: ClaimLike): string {
  return [claim.method, claim.command ?? '', ...claim.evidence].join(' ');
}

/**
 * Does one passing claim satisfy one requirement?
 *
 * Matching order, most specific first:
 *  1. the requirement names a command and the claim ran it
 *  2. the requirement names a bug and the claim references that bug
 *  3. the requirement's wording appears in the claim's evidence
 *  4. requirement and claim are the same kind of check
 *  5. the claim's text covers most of the requirement's terms
 *
 * A failing claim never satisfies anything.
 */
export function requirementSatisfied(requirement: string, claim: ClaimLike): boolean {
  if (claim.result !== 'pass') return false;
  const claimBody = claimText(claim);
  const claimBodyLower = claimBody.toLowerCase();
  const requirementText = requirement.trim();
  if (requirementText.length === 0) return false;

  const requiredCommands = extractCommands(requirementText);
  if (requiredCommands.length > 0) {
    const ran = extractCommands(claimBody);
    for (const required of requiredCommands) {
      if (claimBodyLower.includes(required.toLowerCase())) return true;
      if (ran.some((command) => commandMatches(required, command))) return true;
    }
    return false;
  }

  const bugId = referencedBugId(requirementText);
  if (bugId) {
    if (claimBodyLower.replace(/\s+/g, '_').includes(bugId)) return true;
    // Naming a different bug is not interchangeable with naming this one.
    const claimedBug = referencedBugId(claimBody);
    if (claimedBug && claimedBug !== bugId) return false;
  }

  // Verbatim (case-insensitive) recall of a short requirement is the strongest
  // prose signal an agent can offer.
  const normalisedRequirement = requirementText.replace(/\s+/g, ' ').toLowerCase();
  if (normalisedRequirement.length >= 12 && claimBodyLower.includes(normalisedRequirement)) return true;

  const requirementKind = classifyRequirement(requirementText);
  const claimKind = classifyClaim(claim);
  if (requirementKind !== 'other' && requirementKind === claimKind) {
    // A kind match is enough when the wording agrees on at least one term, so
    // "run the payment tests" is not satisfied by an unrelated suite.
    const shared = sharedTerms(requirementText, claimBody);
    if (shared.length >= 1) return true;
    // Very short requirements ("run the tests") carry no other signal.
    return normalisedRequirement.length <= 24;
  }

  const requirementTerms = new Set(keywords(requirementText));
  const claimTerms = new Set(keywords(claimBody));
  const shared = [...requirementTerms].filter((term) => claimTerms.has(term));
  if (shared.length < MIN_SHARED_TERMS) return false;
  return queryCoverage(requirementTerms, claimTerms) >= MIN_TERM_COVERAGE;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Assess how much of a requirement list the evidence covers.
 *
 * `verified` requires every requirement to be satisfied. Anything partly
 * covered stays `partial`, which the lifecycle maps to `implementation_done`.
 */
export function assessRequirements(
  requirements: readonly string[],
  claims: readonly ClaimLike[],
): VerificationCoverage {
  const entries: RequirementAssessment[] = requirements.map((requirement) => {
    const match = claims.find((claim) => requirementSatisfied(requirement, claim));
    return {
      requirement,
      kind: classifyRequirement(requirement),
      satisfied: match !== undefined,
      verificationId: match?.id ?? null,
    };
  });
  const satisfied = entries.filter((entry) => entry.satisfied).length;
  return {
    status: coverageStatus(entries, satisfied),
    satisfied,
    total: entries.length,
    entries,
  };
}

function coverageStatus(entries: readonly RequirementAssessment[], satisfied: number): VerificationStatus {
  if (entries.length === 0) return 'none';
  if (satisfied === entries.length) return 'verified';
  return 'partial';
}

/** Compact coverage label for briefs and completion output, e.g. "1/3". */
export function coverageLabel(coverage: VerificationCoverage): string {
  return `${coverage.satisfied}/${coverage.total}`;
}

/** Requirements that are not yet covered, in declaration order. */
export function missingRequirements(coverage: VerificationCoverage): string[] {
  return coverage.entries.filter((entry) => !entry.satisfied).map((entry) => entry.requirement);
}

// ---------------------------------------------------------------------------
// Effective requirements
// ---------------------------------------------------------------------------

/**
 * Task types whose completion is not gated on the configured build/test/lint
 * commands. Docs and investigation work still records evidence, but running the
 * suite is not what "done" means for it.
 */
export const CONFIG_EXEMPT_TASK_TYPES: readonly TaskType[] = ['docs', 'investigation'];

/**
 * Requirements implied by project configuration.
 *
 * These apply when the task declared none of its own, and only for task types
 * where the configured checks make sense.
 */
export function configuredRequirements(config: ProjectConfig, taskType: TaskType): string[] {
  if (CONFIG_EXEMPT_TASK_TYPES.includes(taskType)) return [];
  const out: string[] = [];
  const push = (label: string, command: string | null): void => {
    if (command && command.trim().length > 0) out.push(`${label} \`${command.trim()}\``);
  };
  push('Run the test command', config.verification.testCommand);
  push('Run the lint command', config.verification.lintCommand);
  push('Run the build command', config.verification.buildCommand);
  return out;
}

/**
 * The requirements a completion is judged against.
 *
 * Explicit task requirements always win: when a task declares its own checks,
 * configuration is a hint, not an extra gate. Otherwise configuration supplies
 * them (subject to the task-type exemption).
 */
export function effectiveRequirements(input: {
  task: Task | null;
  config: ProjectConfig;
  taskType: TaskType;
}): string[] {
  const declared = (input.task?.verificationRequirements ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (declared.length > 0) return declared;
  return configuredRequirements(input.config, input.taskType);
}

// ---------------------------------------------------------------------------
// Bug-specific evidence
// ---------------------------------------------------------------------------

const BUG_TITLE_COVERAGE = 0.75;

export interface BugEvidenceVerdict {
  satisfied: boolean;
  /** Human-readable justification, for the completion notes. */
  reason: string | null;
}

/** First requirement a claim satisfies, in declaration order. */
export function requirementFor(requirements: readonly string[], claim: ClaimLike): string | null {
  for (const requirement of requirements) {
    if (requirementSatisfied(requirement, claim)) return requirement;
  }
  return null;
}

/** True when one specific claim verifies one specific bug. */
export function claimVerifiesBug(bug: Bug, claim: ClaimLike, requirements: readonly string[]): boolean {
  return bugEvidence({ bug, claims: [claim], requirements }).satisfied;
}

/** Does the evidence verify one specific bug?
 *
 * Generic suite runs never count on their own. A bug is only verified by
 * evidence that (a) names the bug id, (b) covers most of its title, or
 * (c) satisfies a task requirement that is explicitly a regression check.
 */
export function bugEvidence(input: {
  bug: Bug;
  claims: readonly ClaimLike[];
  requirements: readonly string[];
}): BugEvidenceVerdict {
  const passing = input.claims.filter((claim) => claim.result === 'pass');
  if (passing.length === 0) return { satisfied: false, reason: null };

  const bugId = input.bug.id.toLowerCase();
  for (const claim of passing) {
    const body = claimText(claim).toLowerCase();
    if (body.replace(/\s+/g, '_').includes(bugId)) {
      return { satisfied: true, reason: `claim references ${input.bug.id}` };
    }
  }

  const titleTerms = new Set(keywords(input.bug.title));
  if (titleTerms.size >= 2) {
    for (const claim of passing) {
      const claimTerms = new Set(keywords(claimText(claim)));
      const shared = [...titleTerms].filter((term) => claimTerms.has(term));
      if (shared.length >= 2 && queryCoverage(titleTerms, claimTerms) >= BUG_TITLE_COVERAGE) {
        return {
          satisfied: true,
          reason: `claim matches the bug title (${shared.slice(0, 4).join(', ')})`,
        };
      }
    }
  }

  const regressionRequirements = input.requirements.filter(
    (requirement) => classifyRequirement(requirement) === 'regression',
  );
  for (const requirement of regressionRequirements) {
    const referenced = referencedBugId(requirement);
    if (referenced && referenced !== bugId) continue;
    if (passing.some((claim) => requirementSatisfied(requirement, claim))) {
      return { satisfied: true, reason: `regression requirement satisfied: ${truncate(requirement, 80)}` };
    }
  }

  return { satisfied: false, reason: null };
}

/** Normalised reference used to match a bug by id or title. */
export function sameBugReference(a: string, b: string): boolean {
  return normalizeTerm(a.trim()) === normalizeTerm(b.trim());
}
