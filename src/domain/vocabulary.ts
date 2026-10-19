/**
 * Controlled vocabularies and their orderings.
 *
 * Ranking, lifecycle decisions and rendering all lean on these helpers so a
 * status string is interpreted in exactly one place.
 */
import type {
  BugStatus,
  Confidence,
  MemoryKind,
  Priority,
  Severity,
  TaskStatus,
  VerificationResult,
  VerificationStatus,
} from './models.ts';

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'implementation_done',
  'verified_done',
  'blocked',
  'cancelled',
] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const BUG_STATUSES = ['open', 'investigating', 'fix_claimed', 'fixed_verified', 'wontfix'] as const;
export const CONFIDENCES = [
  'hypothesis',
  'suspected',
  'statically_supported',
  'runtime_observed',
  'runtime_confirmed',
] as const;
export const VERIFICATION_RESULTS = ['pass', 'fail', 'partial', 'unknown'] as const;
export const MEMORY_KINDS = [
  'task',
  'decision',
  'constraint',
  'bug',
  'finding',
  'verification',
  'handoff',
] as const;

// ---------------------------------------------------------------------------
// Orderings
// ---------------------------------------------------------------------------

/** Higher means more urgent. P0 = 1.0. */
export function priorityWeight(priority: Priority): number {
  switch (priority) {
    case 'P0':
      return 1;
    case 'P1':
      return 0.75;
    case 'P2':
      return 0.5;
    case 'P3':
      return 0.25;
  }
}

/** Higher means more severe. critical = 1.0. */
export function severityWeight(severity: Severity): number {
  switch (severity) {
    case 'critical':
      return 1;
    case 'high':
      return 0.75;
    case 'medium':
      return 0.5;
    case 'low':
      return 0.25;
  }
}

/** 0-based position on the confidence ladder; use to compare or promote. */
export function confidenceRank(confidence: Confidence): number {
  return CONFIDENCES.indexOf(confidence);
}

/** Human sentence explaining what a confidence level asserts. */
export const CONFIDENCE_CRITERIA: Record<Confidence, string> = {
  hypothesis: 'Plausible but untested idea.',
  suspected: 'Indirect signals point this way; no direct check yet.',
  statically_supported: 'Supported by static evidence (code, disassembly, strings, config).',
  runtime_observed: 'Seen once at runtime; not reproduced independently.',
  runtime_confirmed: 'Reproduced and confirmed at runtime, with recorded evidence.',
};

/** The next rung on the ladder, or null when already confirmed. */
export function nextConfidence(confidence: Confidence): Confidence | null {
  const index = confidenceRank(confidence);
  const next = CONFIDENCES[index + 1];
  return next ?? null;
}

/** What must happen before a finding may claim the next confidence level. */
export const CONFIDENCE_PROMOTION: Record<Confidence, string | null> = {
  hypothesis: 'Cite at least one concrete signal (file, symbol, string) to reach suspected.',
  suspected: 'Read the code/path in question to reach statically supported.',
  statically_supported: 'Run the binary or test once and capture output to reach runtime observed.',
  runtime_observed: 'Reproduce the result in a second independent run to reach runtime confirmed.',
  runtime_confirmed: null,
};

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

const OPEN_BUG_STATUSES: readonly BugStatus[] = ['open', 'investigating', 'fix_claimed'];
const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'implementation_done', 'blocked'];

export function isOpenBug(status: BugStatus): boolean {
  return OPEN_BUG_STATUSES.includes(status);
}

export function isActiveTask(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export function isUnresolvedTask(status: TaskStatus): boolean {
  return status !== 'verified_done' && status !== 'cancelled';
}

/** A bug is a preflight hazard when it is open and serious. */
export function isHazardousBug(status: BugStatus, severity: Severity): boolean {
  return severityWeight(severity) >= severityWeight('high') && isOpenBug(status);
}

export function isVerified(status: VerificationStatus): boolean {
  return status === 'verified';
}

/** Confidence levels that may be presented as established fact. */
export function isEstablished(confidence: Confidence): boolean {
  return confidenceRank(confidence) >= confidenceRank('runtime_observed');
}

// ---------------------------------------------------------------------------
// Parsing (case/perimeter tolerant, returns undefined when unrecognised)
// ---------------------------------------------------------------------------

function parseFrom<T extends string>(values: readonly T[], raw: unknown): T | undefined {
  if (typeof raw !== 'string') return undefined;
  const needle = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return values.find((value) => value.toLowerCase() === needle);
}

export const parsePriority = (raw: unknown): Priority | undefined =>
  typeof raw === 'string' ? (PRIORITIES.find((p) => p.toLowerCase() === raw.trim().toLowerCase()) ?? undefined) : undefined;
export const parseTaskStatus = (raw: unknown): TaskStatus | undefined => parseFrom(TASK_STATUSES, raw);
export const parseSeverity = (raw: unknown): Severity | undefined => parseFrom(SEVERITIES, raw);
export const parseBugStatus = (raw: unknown): BugStatus | undefined => parseFrom(BUG_STATUSES, raw);
export const parseConfidence = (raw: unknown): Confidence | undefined => parseFrom(CONFIDENCES, raw);
export const parseVerificationResult = (raw: unknown): VerificationResult | undefined =>
  parseFrom(VERIFICATION_RESULTS, raw);
export const parseMemoryKind = (raw: unknown): MemoryKind | undefined => parseFrom(MEMORY_KINDS, raw);
