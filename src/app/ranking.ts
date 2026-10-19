/**
 * Relevance engine.
 *
 * Deterministic, local and explainable: the same inputs always produce the same
 * ordering, and every score carries the reasons that produced it so the brief
 * (and the tests) can show *why* a record was included.
 *
 * No embeddings, no network, no LLM. Signals used:
 *   subsystem match · file affinity · terminology overlap · identifier match ·
 *   full-text rank · severity/priority · recency · unresolved status ·
 *   relationship to the current task
 */
import type { Bug, Confidence, MemoryItem, Severity, TaskType } from '../domain/models.ts';
import type { Clock } from '../util/time.ts';
import { recencyScore } from '../util/time.ts';
import { bestPathAffinity, queryCoverage, truncate } from '../util/text.ts';
import { confidenceRank, priorityWeight, severityWeight } from '../domain/vocabulary.ts';
import { normalizeTerm } from '../util/text.ts';

/**
 * Signal weights. Tuned so that *specific* evidence (subsystem, files,
 * terminology) dominates *soft* evidence (recency, full-text rank), which is
 * what keeps a recently touched but unrelated record out of the brief.
 */
export const WEIGHTS = {
  subsystemExact: 0.3,
  subsystemPartial: 0.15,
  files: 0.22,
  terms: 0.2,
  identifiers: 0.12,
  fullText: 0.1,
  severity: 0.1,
  recency: 0.08,
  unresolved: 0.06,
  relationship: 0.15,
  confidence: 0.06,
} as const;

/** Half-life for the recency signal, in days. */
export const RECENCY_HALF_LIFE_DAYS = 45;

/** Items scoring below this are not relevant enough to show. */
export const RELEVANCE_THRESHOLD = 0.16;

export interface RelevanceContext {
  terms: ReadonlySet<string>;
  identifierTerms: ReadonlySet<string>;
  /** Inferred and declared subsystems, best first. */
  subsystems: readonly string[];
  /** Files the task declares or that were inferred. */
  files: readonly string[];
  /** Repository files touched by the most recent commits. */
  recentlyChangedFiles: readonly string[];
  taskType: TaskType;
  /** Id of the task record this call created or matched, if any. */
  taskId: string | null;
  /** Full-text scores by record id (0..1), from `Store.searchMemory`. */
  fullTextScores: ReadonlyMap<string, number>;
  /** Files named by the highest-ranked bug, used as a late tie-breaker. */
  clock: Clock;
}

export interface ScoredItem {
  item: MemoryItem;
  /** Additive score; higher is more relevant. Capped at 1. */
  score: number;
  /** Human-readable explanations, rendered in the brief for transparency. */
  reasons: string[];
  /** Per-signal contributions, kept for tests and diagnostics. */
  breakdown: Record<string, number>;
}

function normalizedSubsystem(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Exact, containment or token-level agreement between two subsystem labels. */
function subsystemMatch(a: string | null, b: readonly string[]): { score: number; matched: string | null } {
  if (!a) return { score: 0, matched: null };
  const left = normalizedSubsystem(a);
  if (left.length === 0) return { score: 0, matched: null };
  for (const candidate of b) {
    const right = normalizedSubsystem(candidate);
    if (right.length === 0) continue;
    if (left === right) return { score: WEIGHTS.subsystemExact, matched: candidate };
  }
  for (const candidate of b) {
    const right = normalizedSubsystem(candidate);
    if (right.length >= 4 && (left.includes(right) || right.includes(left))) {
      return { score: WEIGHTS.subsystemPartial, matched: candidate };
    }
  }
  return { score: 0, matched: null };
}

function isUnresolved(item: MemoryItem): boolean {
  switch (item.kind) {
    case 'bug':
      return item.status === 'open' || item.status === 'investigating' || item.status === 'fix_claimed';
    case 'task':
      return item.status === 'blocked' || item.status === 'in_progress' || item.status === 'todo';
    case 'constraint':
      return item.status === 'active';
    case 'decision':
      return item.status === 'active';
    default:
      return false;
  }
}

/** Severity/priority signal, 0..1. */
function urgency(item: MemoryItem): number {
  const severity = item.severity ? severityWeight(item.severity) : 0;
  const priority = item.priority ? priorityWeight(item.priority) : 0;
  return Math.max(severity, priority);
}

/** Confidence signal for findings, 0..1 across the confidence ladder. */
function confidenceSignal(item: MemoryItem): number {
  if (item.kind !== 'finding' || !item.confidence) return 0;
  return confidenceRank(item.confidence) / 4;
}

/** Score one memory item against the relevance context. */
export function scoreItem(item: MemoryItem, context: RelevanceContext): ScoredItem {
  const breakdown: Record<string, number> = {};
  const reasons: string[] = [];

  const subsystem = subsystemMatch(item.subsystem, context.subsystems);
  if (subsystem.score > 0) {
    breakdown['subsystem'] = subsystem.score;
    reasons.push(`subsystem: ${item.subsystem}`);
  }

  if (context.files.length > 0 && item.files.length > 0) {
    let best = 0;
    let bestFile = '';
    for (const file of item.files) {
      const affinity = bestPathAffinity(file, context.files);
      if (affinity > best) {
        best = affinity;
        bestFile = file;
      }
    }
    if (best > 0) {
      breakdown['files'] = WEIGHTS.files * best;
      reasons.push(best >= 0.8 ? `same file: ${bestFile}` : `related file: ${bestFile}`);
    }
  }

  const itemTerms = new Set(item.terms);
  const coverage = queryCoverage(context.terms, itemTerms);
  if (coverage > 0) {
    breakdown['terms'] = WEIGHTS.terms * coverage;
    if (coverage >= 0.5) reasons.push('matches task wording');
  }

  if (context.identifierTerms.size > 0) {
    let hits = 0;
    const examples: string[] = [];
    for (const identifier of context.identifierTerms) {
      if (itemTerms.has(normalizeTerm(identifier))) {
        hits += 1;
        if (examples.length < 2) examples.push(identifier);
      }
    }
    if (hits > 0) {
      breakdown['identifiers'] = Math.min(1, hits / context.identifierTerms.size) * WEIGHTS.identifiers;
      reasons.push(`mentions ${examples.join(', ')}`);
    }
  }

  const fullText = context.fullTextScores.get(item.id);
  if (fullText && fullText > 0) {
    breakdown['fullText'] = WEIGHTS.fullText * fullText;
  }

  const urgencyScore = urgency(item);
  if (urgencyScore > 0) {
    breakdown['severity'] = WEIGHTS.severity * urgencyScore;
    if (item.kind === 'bug' && item.severity && severityWeight(item.severity) >= severityWeight('high')) {
      reasons.push(`${item.severity}-severity bug`);
    }
    if (item.priority === 'P0' || item.priority === 'P1') reasons.push(`${item.priority} task`);
  }

  const recency = recencyScore(item.createdAt, context.clock, RECENCY_HALF_LIFE_DAYS);
  breakdown['recency'] = WEIGHTS.recency * recency;

  if (isUnresolved(item)) {
    breakdown['unresolved'] = WEIGHTS.unresolved;
  }

  if (context.taskId && item.taskId === context.taskId) {
    breakdown['relationship'] = WEIGHTS.relationship;
    reasons.push('recorded for this task');
  } else if (item.head && item.head.length > 0 && item.kind === 'handoff') {
    // A handoff recorded at a recent HEAD is closer to the current state.
    const matchedFile = context.recentlyChangedFiles.some((file) => item.body.includes(file));
    if (matchedFile) {
      breakdown['relationship'] = WEIGHTS.relationship * 0.5;
      reasons.push('touches files changed in recent commits');
    }
  }

  const confidence = confidenceSignal(item);
  if (confidence > 0) breakdown['confidence'] = WEIGHTS.confidence * confidence;

  const total = Math.min(1, Object.values(breakdown).reduce((sum, value) => sum + value, 0));
  return { item, score: Number(total.toFixed(4)), reasons, breakdown };
}

export interface ScoreOptions {
  /** Keep only items scoring at least this much. Defaults to RELEVANCE_THRESHOLD. */
  threshold?: number;
  /** Restrict to specific memory kinds. */
  kinds?: readonly MemoryItem['kind'][];
}

/**
 * Score and rank a candidate set.
 *
 * Ordering is fully deterministic: score descending, then a stable tie-break on
 * severity, then creation time descending, then id, so equal scores never
 * reorder between runs.
 */
export function rankItems(
  items: readonly MemoryItem[],
  context: RelevanceContext,
  options: ScoreOptions = {},
): ScoredItem[] {
  const threshold = options.threshold ?? RELEVANCE_THRESHOLD;
  const allowed = options.kinds ? new Set(options.kinds) : null;
  return items
    .filter((item) => (allowed ? allowed.has(item.kind) : true))
    .map((item) => scoreItem(item, context))
    .filter((scored) => scored.score >= threshold)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const severityDelta = (b.item.severity ? severityWeight(b.item.severity) : 0) - (a.item.severity ? severityWeight(a.item.severity) : 0);
      if (severityDelta !== 0) return severityDelta;
      if (a.item.createdAt !== b.item.createdAt) return b.item.createdAt.localeCompare(a.item.createdAt);
      return a.item.id.localeCompare(b.item.id);
    });
}

/**
 * Render a bug as a compact, decision-ready line: what is wrong, and how it was
 * observed. Only fields actually recorded are shown.
 */
export function describeBug(bug: Bug): string {
  const parts: string[] = [];
  if (bug.observed) parts.push(`observed: ${truncate(bug.observed, 160)}`);
  else if (bug.expected) parts.push(`expected: ${truncate(bug.expected, 120)}`);
  if (bug.reproduction) parts.push(`repro: ${truncate(bug.reproduction, 140)}`);
  return parts.join(' | ');
}

/** Human label for a confidence level, used in reverse-engineering output. */
export function confidenceLabel(confidence: Confidence): string {
  return confidence.replace(/_/g, ' ');
}

/** Strongest severity present in a set, or null when empty. */
export function strongestSeverity(severities: readonly Severity[]): Severity | null {
  let best: Severity | null = null;
  for (const severity of severities) {
    if (!best || severityWeight(severity) > severityWeight(best)) best = severity;
  }
  return best;
}
