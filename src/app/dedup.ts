/**
 * Conservative near-duplicate detection for durable memory.
 *
 * The goal is not perfect clustering — it is to stop the same decision, bug or
 * follow-up being stored twice by two passes of the same work, while never
 * merging records that merely share vocabulary. Everything is deterministic
 * text matching: no embeddings, no ML, no network.
 *
 * Two thresholds, both intentionally high:
 *  - at or above `DUPLICATE_THRESHOLD` the record is an existing one; the
 *    caller merges evidence instead of creating a copy
 *  - at or above `BORDERLINE_THRESHOLD` the match is only worth a note, so the
 *    caller still creates the record but tells the agent a similar one exists
 */
import { keywords } from '../util/text.ts';

export interface DedupCandidate {
  /** Free text that identifies the record: a statement or a title. */
  text: string;
  /** Extra text that should participate in matching (rationale, observed, …). */
  detail?: string | null;
  /** Subsystem, when the caller has one; a mismatched subsystem suppresses merging. */
  subsystem?: string | null;
}

export interface DedupExisting extends DedupCandidate {
  id: string;
  /** Subsystem stored with the record; null/undefined means project-wide. */
  subsystem?: string | null;
  /** Set for records that were superseded or deactivated. */
  inactive?: boolean;
}

export interface DuplicateMatch {
  id: string;
  /** `duplicate` means merge; `borderline` means create but mention. */
  verdict: 'duplicate' | 'borderline';
  score: number;
  sharedTerms: string[];
  reason: string;
}

/** Score at or above which two records are treated as the same one. */
export const DUPLICATE_THRESHOLD = 0.8;
/** Score at or above which two records are worth mentioning to the agent. */
export const BORDERLINE_THRESHOLD = 0.55;

/**
 * Normalised content terms, with singularisation and vocabulary folding from the
 * shared terminology table, so dedup agrees with ranking and search.
 */
export function dedupTerms(text: string): string[] {
  return keywords(text.replace(/['’]/g, ''));
}

const NEGATIONS = /\b(not|never|no|without|avoid|avoids|avoided|prohibit|prohibited|forbid|forbidden|must not|cannot|can't|don't|does not|doesn't|isn't|aren't|instead of|rather than)\b/i;

/** True when a statement is negated; used to keep opposites from merging. */
export function isNegated(text: string): boolean {
  return NEGATIONS.test(text);
}

function polarityDiffers(a: string, b: string): boolean {
  return isNegated(a) !== isNegated(b);
}

/**
 * Similarity of two records in [0, 1].
 *
 * Blends Jaccard overlap (penalises verbose records) with containment
 * (rewards a short statement that is fully present in a longer one), so both
 * "same thing, more words" and "same words, one more clause" score highly.
 */
export function recordSimilarity(a: DedupCandidate, b: DedupCandidate): { score: number; shared: string[] } {
  const left = new Set(dedupTerms(`${a.text} ${a.detail ?? ''}`));
  const right = new Set(dedupTerms(`${b.text} ${b.detail ?? ''}`));
  if (left.size === 0 || right.size === 0) return { score: 0, shared: [] };
  const shared = [...left].filter((term) => right.has(term));
  const union = new Set([...left, ...right]);
  const jaccard = shared.length / union.size;
  const containment = shared.length / Math.min(left.size, right.size);
  const score = Number((0.5 * jaccard + 0.5 * containment).toFixed(4));
  return { score, shared };
}

/**
 * Find the closest existing record to a candidate.
 *
 * Never returns a `duplicate` verdict for a record the caller flagged inactive:
 * superseded decisions and deactivated constraints must not be silently
 * reactivated by a fresh write.
 */
export function findDuplicate(
  candidate: DedupCandidate,
  existing: readonly DedupExisting[],
  options: { minSharedTerms?: number } = {},
): DuplicateMatch | null {
  const minShared = options.minSharedTerms ?? 3;
  let best: DuplicateMatch | null = null;

  for (const record of existing) {
    const { score, shared } = recordSimilarity(candidate, record);
    if (shared.length < minShared || score < BORDERLINE_THRESHOLD) continue;
    if (best && score <= best.score) continue;
    const polarityClash = polarityDiffers(candidate.text, record.text);
    // A record filed under a different subsystem describes different work even
    // when the wording agrees; keep both rather than merging across areas.
    const subsystemClash = Boolean(
      candidate.subsystem && record.subsystem && candidate.subsystem !== record.subsystem,
    );
    const duplicate = score >= DUPLICATE_THRESHOLD && !polarityClash && !subsystemClash && !record.inactive;
    const reason = record.inactive
      ? 'a matching record exists but is superseded or inactive; kept separate'
      : subsystemClash
        ? `matching wording but a different subsystem (${candidate.subsystem} vs ${record.subsystem}); kept separate`
        : polarityClash
          ? 'the closest record states the opposite, so it was not merged'
          : duplicate
            ? `matches ${record.id} (${score.toFixed(2)})`
            : `similar to ${record.id} (${score.toFixed(2)}); created separately`;
    best = {
      id: record.id,
      verdict: duplicate ? 'duplicate' : 'borderline',
      score,
      sharedTerms: shared,
      reason,
    };
  }
  return best;
}

/** Merge two string lists without duplicates, preserving order. */
export function mergeStrings<T extends string>(first: readonly T[], second: readonly T[]): T[] {
  const out: T[] = [...first];
  for (const value of second) if (!out.includes(value)) out.push(value);
  return out;
}
