/**
 * Contradiction detection across durable memory.
 *
 * Passive storage is not trust: if two *active* records contradict each other,
 * the brief has to say so before the agent acts on either. This module is
 * deliberately conservative — it reports only high-confidence contradictions
 * and a broken lifecycle reference, and caps the output so the warning section
 * never crowds out the work.
 *
 * Superseded decisions and inactive constraints are ignored: they are history,
 * not live guidance.
 */
import type { Bug, Constraint, Decision } from '../domain/models.ts';
import { findDuplicate, isNegated } from './dedup.ts';
import { truncate } from '../util/text.ts';

export interface DurableConflict {
  level: 'critical' | 'warning' | 'info';
  text: string;
}

/** Max warnings emitted; conflicts are a signal, not a report. */
export const MAX_CONFLICTS = 4;

/** Pairwise scan bounds, so a large project cannot make a brief expensive. */
const MAX_PAIRS_INPUT = 60;

function conflictBetween(
  kind: 'decision' | 'constraint',
  a: { id: string; text: string },
  b: { id: string; text: string },
): DurableConflict | null {
  // A contradiction needs opposite polarity *and* near-identical wording.
  if (isNegated(a.text) === isNegated(b.text)) return null;
  const match = findDuplicate(
    { text: a.text },
    [{ id: b.id, text: b.text }],
    { minSharedTerms: 3 },
  );
  if (!match || match.score < 0.6) return null;
  return {
    level: 'critical',
    text:
      `Active ${kind}s ${a.id} and ${b.id} look contradictory: "${truncate(a.text, 90)}" vs ` +
      `"${truncate(b.text, 90)}". Resolve which one holds before relying on either.`,
  };
}

/** Detect contradictions and dangling lifecycle links among durable records. */
export function detectDurableConflicts(input: {
  decisions: readonly Decision[];
  constraints: readonly Constraint[];
  bugs: readonly Bug[];
}): DurableConflict[] {
  const conflicts: DurableConflict[] = [];

  const activeDecisions = input.decisions.filter((decision) => decision.status === 'active').slice(0, MAX_PAIRS_INPUT);
  for (let i = 0; i < activeDecisions.length && conflicts.length < MAX_CONFLICTS; i += 1) {
    for (let j = i + 1; j < activeDecisions.length && conflicts.length < MAX_CONFLICTS; j += 1) {
      const conflict = conflictBetween(
        'decision',
        { id: activeDecisions[i]!.id, text: activeDecisions[i]!.statement },
        { id: activeDecisions[j]!.id, text: activeDecisions[j]!.statement },
      );
      if (conflict) conflicts.push(conflict);
    }
  }

  const activeConstraints = input.constraints.filter((constraint) => constraint.active).slice(0, MAX_PAIRS_INPUT);
  for (let i = 0; i < activeConstraints.length && conflicts.length < MAX_CONFLICTS; i += 1) {
    for (let j = i + 1; j < activeConstraints.length && conflicts.length < MAX_CONFLICTS; j += 1) {
      const conflict = conflictBetween(
        'constraint',
        { id: activeConstraints[i]!.id, text: activeConstraints[i]!.statement },
        { id: activeConstraints[j]!.id, text: activeConstraints[j]!.statement },
      );
      if (conflict) conflicts.push(conflict);
    }
  }

  const decisionIds = new Set(input.decisions.map((decision) => decision.id));
  for (const decision of input.decisions) {
    if (decision.status !== 'superseded') continue;
    if (!decision.supersededBy || !decisionIds.has(decision.supersededBy) || decision.supersededBy === decision.id) {
      conflicts.push({
        level: 'warning',
        text:
          `Decision ${decision.id} is marked superseded but points at ` +
          `${decision.supersededBy ? `unknown decision ${decision.supersededBy}` : 'no replacement'}; later passes may treat it as unresolved.`,
      });
    }
    if (conflicts.length >= MAX_CONFLICTS) break;
  }

  const constraintIds = new Set(input.constraints.map((constraint) => constraint.id));
  for (const constraint of input.constraints) {
    if (constraint.active) continue;
    if (constraint.replacedBy && !constraintIds.has(constraint.replacedBy)) {
      conflicts.push({
        level: 'warning',
        text: `Constraint ${constraint.id} references unknown replacement ${constraint.replacedBy}.`,
      });
    }
    if (conflicts.length >= MAX_CONFLICTS) break;
  }

  // The same bug tracked twice with incompatible statuses: one says the fix is
  // verified, the other that it is still open. One of them is wrong.
  for (let i = 0; i < input.bugs.length && conflicts.length < MAX_CONFLICTS; i += 1) {
    for (let j = i + 1; j < input.bugs.length && conflicts.length < MAX_CONFLICTS; j += 1) {
      const a = input.bugs[i]!;
      const b = input.bugs[j]!;
      const decided = (status: Bug['status']): boolean => status === 'fixed_verified' || status === 'wontfix';
      const unresolved = (status: Bug['status']): boolean => status === 'open' || status === 'investigating' || status === 'fix_claimed';
      if (!((decided(a.status) && unresolved(b.status)) || (decided(b.status) && unresolved(a.status)))) continue;
      const match = findDuplicate({ text: a.title }, [{ id: b.id, text: b.title }], { minSharedTerms: 3 });
      if (!match || match.verdict !== 'duplicate') continue;
      conflicts.push({
        level: 'warning',
        text:
          `Bugs ${a.id} (${a.status}) and ${b.id} (${b.status}) describe the same defect with incompatible ` +
          'statuses; confirm which state is real before trusting either.',
      });
    }
  }

  return conflicts.slice(0, MAX_CONFLICTS);
}
