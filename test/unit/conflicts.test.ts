/**
 * Durable-record conflict tests.
 *
 * Conflicts are warnings, not enforcement: the brief must tell an agent when
 * two *active* records disagree, while superseded history is allowed to contain
 * contradictions without raising an alarm. The tests pin that distinction and
 * the conservative matching threshold.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Bug, Constraint, Decision } from '../../src/domain/models.ts';
import { detectDurableConflicts, MAX_CONFLICTS } from '../../src/app/conflicts.ts';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec_1',
    projectId: 'prj_1',
    statement: 'Eligibility lives in the offer predicate',
    rationale: null,
    subsystem: 'industry-offer',
    alternatives: [],
    source: 'master_record',
    files: [],
    commits: [],
    status: 'active',
    supersededBy: null,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function constraint(overrides: Partial<Constraint> = {}): Constraint {
  return {
    id: 'con_1',
    projectId: 'prj_1',
    statement: 'Never infer ownership in the UI',
    subsystem: 'industry-offer',
    severity: 'high',
    files: [],
    source: 'master_record',
    active: true,
    replacedBy: null,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function bug(overrides: Partial<Bug> = {}): Bug {
  return {
    id: 'bug_1',
    projectId: 'prj_1',
    title: 'Ownership check passes for unverified offers',
    severity: 'high',
    status: 'open',
    subsystem: 'industry-offer',
    reproduction: null,
    expected: null,
    observed: null,
    evidence: [],
    files: [],
    commits: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    resolvedAt: null,
    taskId: null,
    ...overrides,
  };
}

function detect(overrides: Partial<Parameters<typeof detectDurableConflicts>[0]> = {}) {
  return detectDurableConflicts({ decisions: [], constraints: [], bugs: [], ...overrides });
}

describe('detectDurableConflicts', () => {
  it('warns when two active decisions are near-identical opposites', () => {
    const conflicts = detect({
      decisions: [
        decision({ id: 'dec_on', statement: 'Ownership is inferred in the UI' }),
        decision({ id: 'dec_off', statement: 'Ownership is never inferred in the UI' }),
      ],
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.level, 'critical');
    assert.match(conflicts[0]?.text ?? '', /Active decisions dec_on and dec_off look contradictory/);
  });

  it('does not warn for decisions that agree or merely share vocabulary', () => {
    assert.deepEqual(
      detect({
        decisions: [
          decision({ id: 'dec_a', statement: 'Ownership is inferred in the UI' }),
          decision({ id: 'dec_b', statement: 'Ownership is inferred in the UI layer' }),
          decision({ id: 'dec_c', statement: 'Eligibility lives in the offer predicate' }),
        ],
      }),
      [],
    );
  });

  it('ignores superseded decisions when looking for live contradictions', () => {
    const conflicts = detect({
      decisions: [
        decision({ id: 'dec_old', statement: 'Ownership is never inferred in the UI', status: 'superseded', supersededBy: 'dec_on' }),
        decision({ id: 'dec_on', statement: 'Ownership is inferred in the UI' }),
      ],
    });
    assert.deepEqual(
      conflicts.filter((conflict) => /look contradictory/.test(conflict.text)),
      [],
    );
  });

  it('flags a superseded decision with no valid replacement', () => {
    const missing = detect({
      decisions: [decision({ id: 'dec_old', status: 'superseded', supersededBy: null })],
    });
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.level, 'warning');
    assert.match(missing[0]?.text ?? '', /points at no replacement/);

    const dangling = detect({
      decisions: [decision({ id: 'dec_old', status: 'superseded', supersededBy: 'dec_gone' })],
    });
    assert.match(dangling[0]?.text ?? '', /unknown decision dec_gone/);

    const valid = detect({
      decisions: [
        decision({ id: 'dec_old', status: 'superseded', supersededBy: 'dec_new' }),
        decision({ id: 'dec_new' }),
      ],
    });
    assert.deepEqual(valid, []);
  });

  it('warns about contradictory active constraints', () => {
    const conflicts = detect({
      constraints: [
        constraint({ id: 'con_ui', statement: 'Ownership is inferred in the UI' }),
        constraint({ id: 'con_record', statement: 'Ownership is never inferred in the UI' }),
      ],
    });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0]?.text ?? '', /Active constraints con_ui and con_record/);
  });

  it('ignores inactive constraints and flags only dangling replacements', () => {
    const contradictoryHistory = detect({
      constraints: [
        constraint({ id: 'con_old', statement: 'Ownership is never inferred in the UI', active: false }),
        constraint({ id: 'con_new', statement: 'Ownership is inferred in the UI' }),
      ],
    });
    assert.deepEqual(contradictoryHistory, []);

    const dangling = detect({
      constraints: [constraint({ id: 'con_old', active: false, replacedBy: 'con_missing' })],
    });
    assert.equal(dangling.length, 1);
    assert.match(dangling[0]?.text ?? '', /unknown replacement con_missing/);
  });

  it('warns when the same bug is tracked with incompatible statuses', () => {
    const conflicts = detect({
      bugs: [
        bug({ id: 'bug_open', status: 'open' }),
        bug({ id: 'bug_done', status: 'fixed_verified' }),
      ],
    });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0]?.text ?? '', /bug_open \(open\) and bug_done \(fixed_verified\)/);
  });

  it('does not treat two open reports or two resolved reports as contradictory', () => {
    assert.deepEqual(
      detect({
        bugs: [
          bug({ id: 'bug_a', status: 'open' }),
          bug({ id: 'bug_b', status: 'investigating' }),
        ],
      }),
      [],
    );
    assert.deepEqual(
      detect({
        bugs: [
          bug({ id: 'bug_a', status: 'fixed_verified' }),
          bug({ id: 'bug_b', status: 'wontfix' }),
        ],
      }),
      [],
    );
  });

  it('caps the number of warnings', () => {
    const decisions = Array.from({ length: MAX_CONFLICTS + 3 }, (_, index) =>
      decision({
        id: `dec_${index}`,
        statement: `Ownership ${index % 2 === 0 ? 'is' : 'is never'} inferred in the UI`,
      }),
    );
    const conflicts = detect({ decisions });
    assert.ok(conflicts.length <= MAX_CONFLICTS);
  });
});
