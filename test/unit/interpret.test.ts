/**
 * Task interpretation tests.
 *
 * Interpretation is inference, and the brief labels it as such, but the
 * inference still has to be predictable: type, subsystem, components, mode and
 * the notes that warn the agent about weak input.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Project, ProjectConfig } from '../../src/domain/models.ts';
import {
  assessRisk,
  classifyTaskType,
  inferSubsystems,
  interpretTask,
  isReverseEngineeringTask,
  taskIdentityKey,
} from '../../src/app/interpret.ts';

const project: Project = {
  id: 'prj_test',
  slug: 'test-project',
  name: 'Test Project',
  description: null,
  goal: null,
  phase: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: null,
};

const config: ProjectConfig = {
  project: null,
  name: null,
  goal: null,
  phase: null,
  description: null,
  importantPaths: [],
  subsystems: ['industry-offer', 'technology-ownership', 'payment-service'],
  verification: { testCommand: 'npm test', lintCommand: null, buildCommand: null, extraChecks: [] },
  context: { recentCommits: 10, maxBriefTokens: 2000 },
  sourcePath: null,
  warnings: [],
};

function interpret(task: string, overrides: Partial<Parameters<typeof interpretTask>[0]> = {}) {
  return interpretTask({
    task,
    project,
    config,
    knownSubsystems: [],
    ...overrides,
  });
}

describe('classifyTaskType', () => {
  const cases: Array<[string, string]> = [
    ['Fix the incorrect ownership check in the offer UI', 'bugfix'],
    ['Add support for partial refunds', 'feature'],
    ['Refactor the offer predicate into a shared helper', 'refactor'],
    ['Investigate why the eligibility check returns false', 'investigation'],
    ['Page load is slow on the offers screen', 'performance'],
    ['Write tests for the offer predicate', 'test'],
    ['Update the README with the new workflow', 'docs'],
    ['Upgrade the TypeScript dependency', 'maintenance'],
  ];

  for (const [task, expected] of cases) {
    it(`classifies "${task}" as ${expected}`, () => {
      assert.equal(classifyTaskType(task).type, expected);
    });
  }

  it('reports low confidence for unrecognisable text', () => {
    const result = classifyTaskType('Hmm');
    assert.equal(result.type, 'unknown');
    assert.equal(result.confidence, 'low');
  });

  it('raises confidence when several signals agree', () => {
    assert.equal(classifyTaskType('Fix the broken crash bug').confidence, 'high');
  });
});

describe('inferSubsystems', () => {
  it('matches a known subsystem named in the task', () => {
    const result = inferSubsystems('Fix the industry-offer eligibility', config.subsystems, ['fix', 'industry', 'offer', 'eligibility']);
    assert.deepEqual(result.subsystems, ['industry-offer']);
    assert.equal(result.confidence, 'high');
  });

  it('returns no subsystem when nothing matches', () => {
    const result = inferSubsystems('Update the changelog', config.subsystems, ['update', 'changelog']);
    assert.deepEqual(result.subsystems, []);
    assert.equal(result.confidence, 'low');
  });

  it('ranks the best match first', () => {
    const result = inferSubsystems(
      'Move ownership checks out of the payment-service',
      config.subsystems,
      ['move', 'ownership', 'check', 'payment', 'service'],
    );
    assert.equal(result.subsystems[0], 'payment-service');
  });
});

describe('integration: interpretTask', () => {
  it('infers type, subsystem and components from wording alone', () => {
    const result = interpret('Fix the incorrect ownership check in the industry-offer UI');
    assert.equal(result.taskType, 'bugfix');
    assert.deepEqual(result.subsystems, ['industry-offer']);
    assert.deepEqual(result.affectedFiles, []);
    assert.ok(result.notes.every((note) => note.includes('component')));
  });

  it('never invents a component from the words that describe the defect', () => {
    // Regression: "incorrect ownership" used to be offered as a component name.
    assert.deepEqual(interpret('Fix the incorrect ownership check').likelyComponents, []);
    assert.deepEqual(interpret('The missing ownership check is broken').likelyComponents, []);
  });

  it('still recognises a genuine component phrase', () => {
    assert.deepEqual(interpret('Add retry to the payment service').likelyComponents, ['payment service']);
    assert.deepEqual(interpret('The offer dialog loses focus').likelyComponents, ['offer dialog']);
  });

  it('trusts declared files over inference and derives components from them', () => {
    const result = interpret('Fix the ownership check', {
      affectedFiles: ['src/industry/offer.ts'],
      recentlyChangedFiles: ['src/unrelated/thing.ts'],
    });
    assert.deepEqual(result.affectedFiles, ['src/industry/offer.ts']);
    assert.deepEqual(result.inferredFiles, []);
    assert.deepEqual(result.likelyComponents, ['offer.ts (in industry)']);
  });

  it('infers candidate files from recent commits only when nothing was declared', () => {
    const result = interpret('Fix the offer eligibility check', {
      recentlyChangedFiles: ['src/industry/offer.ts', 'docs/readme.md'],
    });
    assert.deepEqual(result.inferredFiles, ['src/industry/offer.ts']);
  });

  it('flags short task text as weakly interpretable', () => {
    const result = interpret('Fix bug');
    assert.equal(result.interpretability, 'low');
    assert.ok(result.notes.some((note) => /Short task text/.test(note)));
  });

  it('notes when no subsystem could be matched and memory holds none', () => {
    const result = interpret('Update the changelog', { config: { ...config, subsystems: [] }, knownSubsystems: [] });
    assert.ok(result.notes.some((note) => /no subsystems yet/.test(note)));
  });

  it('notes when stored subsystems exist but none match the wording', () => {
    const result = interpret('Update the changelog');
    assert.ok(result.notes.some((note) => /No stored subsystem name matched/.test(note)));
  });

  it('collects identifier-like terms and their parts for high-signal matching', () => {
    const result = interpret('Fix the offerEligibility check in offer-eligibility.ts');
    assert.ok(result.identifierTerms.includes('offer'), `expected offer in ${result.identifierTerms.join(',')}`);
    assert.ok(result.identifierTerms.includes('eligibility'));
    assert.ok(!result.identifierTerms.includes('the'));
  });

  it('keeps the requested mode unless it is auto', () => {
    assert.equal(interpret('Fix the check', { mode: 'deep' }).mode, 'deep');
    assert.equal(interpret('Fix the check', { mode: 'read_only' }).mode, 'read_only');
  });
});

describe('isReverseEngineeringTask', () => {
  it('detects reverse-engineering vocabulary', () => {
    assert.equal(isReverseEngineeringTask('Decompile the manager and identify symbols', null), true);
    assert.equal(isReverseEngineeringTask('Locate the function pointer in the binary', null), true);
  });

  it('does not fire on ordinary product work', () => {
    assert.equal(isReverseEngineeringTask('Fix the ownership check in the UI', 'implementation'), false);
  });

  it('fires when the project phase is reverse engineering', () => {
    assert.equal(isReverseEngineeringTask('Continue the audit', 'reverse engineering'), true);
  });

  it('does not fire on an ordinary phrase that merely contains "re"', () => {
    assert.equal(isReverseEngineeringTask('Fix the offer redemption flow', null), false);
  });
});

describe('assessRisk', () => {
  it('reports low risk with an explicit reason when nothing is known', () => {
    const risk = assessRisk({
      hasCriticalConstraint: false,
      worstOpenBug: null,
      relatedRecordCount: 0,
      previousFailure: false,
      broadTaskType: false,
    });
    assert.equal(risk.level, 'low');
    assert.equal(risk.reasons.length, 1);
  });

  it('escalates for a critical constraint plus a critical bug', () => {
    const risk = assessRisk({
      hasCriticalConstraint: true,
      worstOpenBug: 'critical',
      relatedRecordCount: 0,
      previousFailure: false,
      broadTaskType: false,
    });
    assert.equal(risk.level, 'critical');
  });

  it('accumulates medium risk from history volume and a previous failure', () => {
    const risk = assessRisk({
      hasCriticalConstraint: false,
      worstOpenBug: null,
      relatedRecordCount: 2,
      previousFailure: true,
      broadTaskType: false,
    });
    assert.equal(risk.level, 'medium');
  });
});

describe('taskIdentityKey', () => {
  it('produces a stable slug for a task title', () => {
    assert.equal(taskIdentityKey('Fix the Ownership Check!'), 'fix-the-ownership-check');
  });

  it('falls back to a fixed slug for titles with no usable characters', () => {
    assert.equal(taskIdentityKey('***'), 'task');
  });
});
