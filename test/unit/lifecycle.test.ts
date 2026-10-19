/**
 * Trust-rule tests.
 *
 * `lifecycle.ts` holds the rules that stop the server from believing claims it
 * cannot check: task matching, verification classification, status decisions
 * and the finding-confidence guard. These are the most important tests in the
 * suite — everything else can be wrong without corrupting the record.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Task } from '../../src/domain/models.ts';
import {
  claimHasEvidence,
  classifyCompletion,
  classifyVerification,
  decideTaskStatus,
  guardConfidence,
  matchTask,
  needsWork,
  type VerificationClaim,
} from '../../src/app/lifecycle.ts';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    projectId: 'prj_1',
    title: 'Fix the ownership check',
    description: null,
    priority: 'P2',
    status: 'in_progress',
    subsystem: 'ownership',
    affectedFiles: [],
    dependencies: [],
    blockers: [],
    verificationRequirements: [],
    verificationStatus: 'none',
    source: 'master_context',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    head: null,
    branch: null,
    ...overrides,
  };
}

function claim(overrides: Partial<VerificationClaim> = {}): VerificationClaim {
  return { method: 'unit tests', command: null, result: 'pass', evidence: [], ...overrides };
}

describe('matchTask', () => {
  it('matches an exact title case-insensitively', () => {
    const match = matchTask([task({ title: 'Fix the Ownership Check' })], 'fix the ownership check');
    assert.ok(match);
    assert.equal(match.exact, true);
    assert.equal(match.similarity, 1);
  });

  it('reuses a near-identical open task instead of duplicating it', () => {
    const match = matchTask([task({ title: 'Fix the technology ownership regression bug' })], 'Fix technology ownership regression');
    assert.ok(match);
    assert.equal(match.exact, false);
    assert.ok(match.similarity >= 0.62);
  });

  it('does not match unrelated work', () => {
    assert.equal(matchTask([task({ title: 'Fix the ownership check' })], 'Add CSV export to the billing screen'), null);
  });

  it('does not collapse two different ownership tasks', () => {
    // "Fix ownership regression in Industry offers" and "Refactor ownership
    // serialization" share only "ownership"; merging them would hide work.
    const stored = task({ title: 'Refactor ownership serialization' });
    assert.equal(matchTask([stored], 'Fix ownership regression in Industry offers'), null);
  });

  it('matches the technology ownership regression wording used in practice', () => {
    const stored = task({ title: 'Fix the technology ownership regression bug' });
    const match = matchTask([stored], 'Fix technology ownership regression');
    assert.ok(match);
    assert.equal(match.task.id, stored.id);
  });

  it('never matches a finished or cancelled task by similarity', () => {
    const done = task({ status: 'verified_done' });
    assert.equal(matchTask([done], 'Fix technology ownership regression'), null);
    // ...but an exact title still resolves, so the caller can report on it.
    const exact = matchTask([done], 'Fix the ownership check');
    assert.ok(exact?.exact);
  });

  it('ignores empty titles', () => {
    assert.equal(matchTask([task()], '   '), null);
  });
});

describe('claimHasEvidence', () => {
  it('requires a passing result', () => {
    assert.equal(claimHasEvidence(claim({ result: 'fail', command: 'npm test' })), false);
    assert.equal(claimHasEvidence(claim({ result: 'unknown', command: 'npm test' })), false);
  });

  it('accepts a command or recorded evidence', () => {
    assert.equal(claimHasEvidence(claim({ command: 'npm test' })), true);
    assert.equal(claimHasEvidence(claim({ evidence: ['12 passing'] })), true);
  });

  it('rejects a bare assertion', () => {
    assert.equal(claimHasEvidence(claim({ method: 'looks fine' })), false);
  });
});

describe('classifyVerification', () => {
  it('is verified by a passing command', () => {
    const result = classifyVerification({ claims: [claim({ command: 'npm test' })], results: [] });
    assert.equal(result.status, 'verified');
    assert.equal(result.accepted.length, 1);
  });

  it('is verified by passing evidence even without a command', () => {
    const result = classifyVerification({ claims: [claim({ evidence: ['all 12 tests pass'] })], results: [] });
    assert.equal(result.status, 'verified');
  });

  it('fails as soon as one claim fails, even if another passes', () => {
    const result = classifyVerification({
      claims: [claim({ command: 'npm test' }), claim({ command: 'npm run e2e', result: 'fail' })],
      results: [],
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.notes.some((note) => /reported a failure/.test(note)));
  });

  it('is only partial when claims carry no evidence', () => {
    const result = classifyVerification({ claims: [claim({ method: 'manual check' })], results: [] });
    assert.equal(result.status, 'partial');
    assert.ok(result.notes.some((note) => /without a command or evidence/.test(note)));
  });

  it('treats prose results as claimed, never verified', () => {
    const result = classifyVerification({ claims: [], results: ['I checked it and it works'] });
    assert.equal(result.status, 'claimed');
    assert.equal(result.accepted.length, 0);
  });

  it('reports missing verification when nothing was offered', () => {
    const result = classifyVerification({ claims: [], results: [] });
    assert.equal(result.status, 'none');
    assert.ok(result.notes.some((note) => /verification is missing/.test(note)));
  });
});

describe('decideTaskStatus', () => {
  const base = { current: 'in_progress' as const, blockers: [], filesChanged: 1 };

  it('marks implementation done when verification is missing', () => {
    const decision = decideTaskStatus({ ...base, verification: 'none' });
    assert.equal(decision.status, 'implementation_done');
  });

  it('reaches verified_done only with verified evidence', () => {
    assert.equal(decideTaskStatus({ ...base, verification: 'verified' }).status, 'verified_done');
  });

  it('keeps the task open when verification failed', () => {
    const decision = decideTaskStatus({ ...base, verification: 'failed' });
    assert.equal(decision.status, 'implementation_done');
    assert.ok(decision.notes.some((note) => /verification failed/.test(note)));
  });

  it('refuses an explicit verified_done claim without evidence and says why', () => {
    const decision = decideTaskStatus({ ...base, verification: 'claimed', requested: 'verified_done' });
    assert.equal(decision.status, 'implementation_done');
    assert.ok(decision.notes.some((note) => /not accepted/.test(note)));
  });

  it('honours an explicit verified_done when evidence backs it', () => {
    assert.equal(decideTaskStatus({ ...base, verification: 'verified', requested: 'verified_done' }).status, 'verified_done');
  });

  it('blocks the task when blockers are reported, even if asked for done', () => {
    const decision = decideTaskStatus({
      ...base,
      verification: 'verified',
      blockers: ['waiting on the API key'],
      requested: 'implementation_done',
    });
    assert.equal(decision.status, 'blocked');
    assert.ok(decision.notes.some((note) => /downgraded to "blocked"/.test(note)));
  });

  it('mentions that nothing changed when no files were reported', () => {
    const decision = decideTaskStatus({ current: 'in_progress', verification: 'none', blockers: [], filesChanged: 0 });
    assert.ok(decision.notes.some((note) => /No files were reported/.test(note)));
  });
});

describe('guardConfidence', () => {
  it('accepts a claim that evidence supports', () => {
    const result = guardConfidence({ requested: 'runtime_confirmed', evidence: ['reproduced twice'], files: [], symbols: [] });
    assert.equal(result.confidence, 'runtime_confirmed');
    assert.equal(result.downgradedFrom, null);
  });

  it('downgrades runtime claims without recorded evidence', () => {
    const result = guardConfidence({ requested: 'runtime_observed', evidence: [], files: ['src/a.ts'], symbols: [] });
    assert.equal(result.confidence, 'statically_supported');
    assert.equal(result.downgradedFrom, 'runtime_observed');
    assert.match(result.reason ?? '', /requires recorded runtime evidence/);
  });

  it('downgrades statically supported claims with no anchor at all', () => {
    const result = guardConfidence({ requested: 'statically_supported', evidence: [], files: [], symbols: [] });
    assert.equal(result.confidence, 'suspected');
  });

  it('accepts a symbol as a static anchor', () => {
    const result = guardConfidence({ requested: 'statically_supported', evidence: [], files: [], symbols: ['0x401000'] });
    assert.equal(result.confidence, 'statically_supported');
  });

  it('never downgrades hypotheses or suspicions', () => {
    assert.equal(guardConfidence({ requested: 'hypothesis', evidence: [], files: [], symbols: [] }).confidence, 'hypothesis');
    assert.equal(guardConfidence({ requested: 'suspected', evidence: [], files: [], symbols: [] }).confidence, 'suspected');
  });
});

describe('classifyCompletion', () => {
  const requirements = ['Run `npm test`', 'Run `npm run lint`', 'Run `npm run build`'];

  it('maps one of three passing checks to partial, not verified', () => {
    const result = classifyCompletion({
      requirements,
      claims: [claim({ command: 'npm test' })],
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.coverage?.status, 'partial');
    assert.equal(result.coverage?.satisfied, 1);
    assert.equal(result.coverage?.total, 3);
    assert.ok(result.notes.some((note) => /coverage 1\/3/.test(note)));
    assert.ok(result.notes.some((note) => /implementation_done, not verified_done/.test(note)));
  });

  it('reaches verified only when every requirement is covered', () => {
    const result = classifyCompletion({
      requirements,
      claims: [
        claim({ command: 'npm test' }),
        claim({ command: 'npm run lint' }),
        claim({ command: 'npm run build' }),
      ],
    });
    assert.equal(result.status, 'verified');
    assert.equal(result.coverage?.status, 'verified');
    assert.ok(result.notes.some((note) => /All 3 declared requirement/.test(note)));
  });

  it('lets a failure win over partial coverage', () => {
    const result = classifyCompletion({
      requirements,
      claims: [claim({ command: 'npm test' }), claim({ command: 'npm run lint', result: 'fail' })],
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.coverage?.satisfied, 1);
    assert.ok(result.notes.some((note) => /not verified \(coverage 1\/3\)/.test(note)));
  });

  it('stays claimed or none when no claim covers a requirement', () => {
    const claimed = classifyCompletion({ requirements, claims: [], results: ['looked fine locally'] });
    assert.equal(claimed.status, 'claimed');
    assert.ok(claimed.notes.some((note) => /Declared requirements: 3/.test(note)));

    const none = classifyCompletion({ requirements, claims: [] });
    assert.equal(none.status, 'none');
  });

  it('keeps evidence-only behaviour when nothing is required', () => {
    const result = classifyCompletion({
      requirements: [],
      claims: [claim({ command: 'npm test' })],
    });
    assert.equal(result.status, 'verified');
    assert.equal(result.coverage, null, 'no coverage is invented when nothing is required');
  });

  it('ignores blank requirement strings', () => {
    const result = classifyCompletion({
      requirements: ['   ', ''],
      claims: [claim({ command: 'npm test' })],
    });
    assert.equal(result.coverage, null);
    assert.equal(result.status, 'verified');
  });
});

describe('needsWork', () => {
  it('is true for every status except finished and cancelled', () => {
    assert.equal(needsWork(task({ status: 'implementation_done' })), true);
    assert.equal(needsWork(task({ status: 'blocked' })), true);
    assert.equal(needsWork(task({ status: 'verified_done' })), false);
    assert.equal(needsWork(task({ status: 'cancelled' })), false);
  });
});
