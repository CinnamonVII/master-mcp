/**
 * Task lifecycle and the completion trust boundary.
 *
 * The rules here decide what a completion claim is allowed to become in
 * persistent memory. The guiding principle: an agent's *statement* is recorded
 * as a statement, and only evidence promotes it to verified fact.
 *
 * Pure functions only — no storage, no clock, no I/O — so the trust rules are
 * directly testable.
 */
import type {
  Confidence,
  Task,
  TaskStatus,
  VerificationResult,
  VerificationStatus,
} from '../domain/models.ts';
import { confidenceRank } from '../domain/vocabulary.ts';
import { keywords, queryCoverage, setOverlap, truncate } from '../util/text.ts';
import {
  assessRequirements,
  coverageLabel,
  missingRequirements,
  type VerificationCoverage,
} from './verification.ts';

// ---------------------------------------------------------------------------
// Matching a task string to an existing record
// ---------------------------------------------------------------------------

/** Similarity threshold above which a task string is considered the same task. */
export const TASK_MATCH_THRESHOLD = 0.62;

/**
 * A candidate must share at least this many content terms with the task string.
 * "Fix ownership regression in Industry offers" and "Refactor ownership
 * serialization" share only "ownership"; without this guard the second could
 * collapse into the first.
 */
export const TASK_MATCH_MIN_SHARED_TERMS = 2;

/** …and the task string must cover at least this much of the stored title. */
export const TASK_MATCH_MIN_COVERAGE = 0.6;

function titleTerms(title: string): Set<string> {
  return new Set(keywords(title));
}

export interface TaskMatch {
  task: Task;
  /** 1 for an exact title match, otherwise a token-overlap ratio. */
  similarity: number;
  /** True when the match is an exact, case-insensitive title comparison. */
  exact: boolean;
}

/**
 * Find the task record a free-text task refers to.
 *
 * Exact title matches win outright. Otherwise the best token overlap among
 * still-open tasks is used, so "Fix technology ownership regression" reuses an
 * existing "Fix the technology ownership regression bug" record instead of
 * creating a duplicate on the second call of the same piece of work.
 *
 * Two conservative guards keep distinct work apart: the titles must share at
 * least two content terms and the task string must cover most of the stored
 * title. Preferring a duplicate over collapsing two different tasks is
 * deliberate — duplicates are visible and cheap, a wrong merge is neither.
 */
export function matchTask(tasks: readonly Task[], title: string): TaskMatch | null {
  const needle = title.trim();
  if (needle.length === 0) return null;

  const exact = tasks.find((task) => task.title.trim().toLowerCase() === needle.toLowerCase());
  if (exact) return { task: exact, similarity: 1, exact: true };

  const needleTerms = titleTerms(needle);
  if (needleTerms.size === 0) return null;

  let best: TaskMatch | null = null;
  for (const task of tasks) {
    if (task.status === 'cancelled' || task.status === 'verified_done') continue;
    const taskTerms = titleTerms(task.title);
    const similarity = setOverlap(needleTerms, taskTerms);
    if (similarity < TASK_MATCH_THRESHOLD) continue;
    const shared = [...needleTerms].filter((term) => taskTerms.has(term)).length;
    if (shared < TASK_MATCH_MIN_SHARED_TERMS) continue;
    if (queryCoverage(needleTerms, taskTerms) < TASK_MATCH_MIN_COVERAGE) continue;
    if (!best || similarity > best.similarity) best = { task, similarity, exact: false };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Verification classification
// ---------------------------------------------------------------------------

/** Normalised input for a single verification claim. */
export interface VerificationClaim {
  method: string;
  command: string | null;
  result: VerificationResult;
  evidence: string[];
}

/** Outcome of classifying a completion's evidence. */
export interface VerificationClassification {
  status: VerificationStatus;
  /** Claims that were accepted, to be stored as verification records. */
  accepted: VerificationClaim[];
  /** Explanations for the caller: what was accepted, downgraded or ignored. */
  notes: string[];
}

/** True when a claim carries something a third party could re-run or re-read. */
export function claimHasEvidence(claim: VerificationClaim): boolean {
  if (claim.result !== 'pass') return false;
  return Boolean(claim.command && claim.command.trim().length > 0) || claim.evidence.length > 0;
}

/**
 * Classify a completion's evidence into a verification status.
 *
 * - `verified`  : at least one passing claim with a command or recorded evidence
 * - `failed`    : at least one claim that reported a failure
 * - `partial`   : claims exist but none are pass-with-evidence
 * - `claimed`   : the agent asserted results without any structured claim
 * - `none`      : nothing was offered
 *
 * `results` is the free-text "what I saw" field; it is deliberately *not*
 * enough for `verified`, because prose is not re-checkable evidence.
 */
export function classifyVerification(input: {
  claims: readonly VerificationClaim[];
  results?: readonly string[];
}): VerificationClassification {
  const notes: string[] = [];
  const accepted = input.claims.filter((claim) => claim.result !== 'unknown' || claim.evidence.length > 0);

  if (input.claims.some((claim) => claim.result === 'fail')) {
    notes.push('At least one verification reported a failure: the task is not verified.');
    return { status: 'failed', accepted, notes };
  }

  const evidenced = input.claims.filter(claimHasEvidence);
  if (evidenced.length > 0) {
    return { status: 'verified', accepted, notes };
  }

  if (input.claims.length > 0) {
    notes.push(
      'Verification claims were recorded without a command or evidence, so they do not count as verified.',
    );
    return { status: 'partial', accepted, notes };
  }

  if ((input.results?.length ?? 0) > 0) {
    notes.push(
      'Results were described but no test command or evidence was provided: recorded as claimed, not verified.',
    );
    return { status: 'claimed', accepted: [], notes };
  }

  notes.push('No verification evidence was provided: implementation is recorded, verification is missing.');
  return { status: 'none', accepted: [], notes };
}

// ---------------------------------------------------------------------------
// Requirement-aware completion classification
// ---------------------------------------------------------------------------

/** A classification that also carries the coverage it was derived from. */
export interface CompletionClassification extends VerificationClassification {
  /** Present when the task declared requirements or config supplied them. */
  coverage: VerificationCoverage | null;
}

/**
 * Classify a completion against the requirements the task has to meet.
 *
 * This is the trust boundary that makes `master_complete` requirement-aware:
 * with requirements in play, only full coverage reaches `verified`. One check
 * of three is `partial`, which the status rules map to `implementation_done`
 * rather than `verified_done`.
 *
 * With no requirements the previous evidence-only rules apply unchanged, so
 * projects that declare nothing keep working exactly as before.
 */
export function classifyCompletion(input: {
  requirements: readonly string[];
  claims: readonly VerificationClaim[];
  results?: readonly string[];
}): CompletionClassification {
  const requirements = input.requirements.map((requirement) => requirement.trim()).filter((requirement) => requirement.length > 0);
  if (requirements.length === 0) {
    const base = classifyVerification({ claims: input.claims, results: input.results });
    return { ...base, coverage: null };
  }

  const notes: string[] = [];
  const accepted = input.claims.filter((claim) => claim.result !== 'unknown' || claim.evidence.length > 0);
  const coverage = assessRequirements(requirements, input.claims);

  if (input.claims.some((claim) => claim.result === 'fail')) {
    notes.push(
      `At least one verification reported a failure: the task is not verified (coverage ${coverageLabel(coverage)}).`,
    );
    return { status: 'failed', accepted, notes, coverage };
  }

  if (input.claims.length === 0) {
    if ((input.results?.length ?? 0) > 0) {
      notes.push(
        `Declared requirements: ${coverage.total}. None were covered by a test command or evidence.`,
      );
      notes.push(
        'Results were described but no test command or evidence was provided: recorded as claimed, not verified.',
      );
      return { status: 'claimed', accepted: [], notes, coverage };
    }
    notes.push('No verification evidence was provided: implementation is recorded, verification is missing.');
    return { status: 'none', accepted: [], notes, coverage };
  }

  if (coverage.status === 'verified') {
    notes.push(`All ${coverage.total} declared requirement(s) covered by passing evidence.`);
    return { status: 'verified', accepted, notes, coverage };
  }

  const missing = missingRequirements(coverage);
  notes.push(
    `Verification coverage ${coverageLabel(coverage)}: ${missing.length} requirement(s) still uncovered — ` +
      `${missing.slice(0, 3).map((requirement) => truncate(requirement, 90)).join('; ')}. ` +
      'Recorded as implementation_done, not verified_done.',
  );
  return { status: 'partial', accepted, notes, coverage };
}

// ---------------------------------------------------------------------------
// Task status transitions
// ---------------------------------------------------------------------------

export interface StatusDecisionInput {
  current: TaskStatus;
  verification: VerificationStatus;
  /** Free-text blockers reported with the completion. */
  blockers: readonly string[];
  /** Explicit status requested by the agent, if any. */
  requested?: TaskStatus | null;
  /** Files the completion says changed; used to detect "nothing changed". */
  filesChanged: number;
}

export interface StatusDecision {
  status: TaskStatus;
  notes: string[];
}

/**
 * Decide the task's status after a work pass.
 *
 * `verified_done` is only reachable with verified evidence — an explicit request
 * for it without evidence is downgraded and reported, which is the single most
 * important rule in this module.
 */
export function decideTaskStatus(input: StatusDecisionInput): StatusDecision {
  const notes: string[] = [];

  if (input.blockers.length > 0) {
    if (input.requested === 'verified_done' || input.requested === 'implementation_done') {
      notes.push(
        `Requested status "${input.requested}" downgraded to "blocked": the completion reported blockers.`,
      );
    }
    return { status: 'blocked', notes };
  }

  if (input.requested) {
    if (input.requested === 'verified_done' && input.verification !== 'verified') {
      notes.push(
        `Requested status "verified_done" was not accepted: verification is "${input.verification}", and ` +
          'verified_done requires a passing command or recorded evidence. Recorded as "implementation_done".',
      );
      return { status: 'implementation_done', notes };
    }
    if (input.requested === 'todo' || input.requested === 'in_progress') {
      notes.push(`Requested status "${input.requested}" honours the explicit request.`);
    }
    return { status: input.requested, notes };
  }

  switch (input.verification) {
    case 'verified':
      return { status: 'verified_done', notes };
    case 'failed':
      notes.push('Implementation is recorded, but verification failed; the task stays open.');
      return { status: 'implementation_done', notes };
    case 'partial':
    case 'claimed':
      notes.push('Implementation recorded; verification is incomplete, so the task is not marked done.');
      return { status: 'implementation_done', notes };
    case 'none':
      if (input.filesChanged === 0 && input.current !== 'todo') {
        notes.push('No files were reported as changed and no verification was given.');
      }
      return { status: 'implementation_done', notes };
  }
}

// ---------------------------------------------------------------------------
// Confidence promotion guard for findings
// ---------------------------------------------------------------------------

export interface ConfidenceGuardResult {
  confidence: Confidence;
  /** Set when the requested level was reduced. */
  downgradedFrom: Confidence | null;
  reason: string | null;
}

/**
 * Keep a finding's confidence honest.
 *
 * Declaring `runtime_confirmed` requires recorded evidence; declaring
 * `statically_supported` or above requires at least a file, symbol or evidence
 * reference so the claim is checkable. Requesting more than the input supports
 * is downgraded and the reason is reported back.
 */
export function guardConfidence(input: {
  requested: Confidence;
  evidence: readonly string[];
  files: readonly string[];
  symbols: readonly string[];
}): ConfidenceGuardResult {
  const requested = input.requested;
  const hasEvidence = input.evidence.length > 0;
  const hasStaticAnchor = input.files.length > 0 || input.symbols.length > 0 || hasEvidence;

  const cap = (level: Confidence, reason: string): ConfidenceGuardResult => ({
    confidence: level,
    downgradedFrom: requested,
    reason,
  });

  if (confidenceRank(requested) >= confidenceRank('runtime_observed') && !hasEvidence) {
    return cap(
      'statically_supported',
      `${requested} requires recorded runtime evidence; downgraded to statically_supported.`,
    );
  }
  if (confidenceRank(requested) >= confidenceRank('statically_supported') && !hasStaticAnchor) {
    return cap(
      'suspected',
      `${requested} requires at least a file, symbol or evidence reference; downgraded to suspected.`,
    );
  }
  return { confidence: requested, downgradedFrom: null, reason: null };
}

/** True when a task is in a state that still needs work. */
export function needsWork(task: Task): boolean {
  return task.status !== 'verified_done' && task.status !== 'cancelled';
}
