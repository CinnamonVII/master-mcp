/**
 * Relevance ranking tests.
 *
 * Ranking is the only thing standing between "a brief" and "the whole
 * database", so these tests pin the ordering rules rather than exact scores:
 * subsystem and file matches beat unrelated severity, ties are deterministic,
 * and irrelevant records stay below the threshold.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Bug, MemoryItem } from '../../src/domain/models.ts';
import { fixedClock } from '../../src/util/time.ts';
import {
  describeBug,
  rankItems,
  RELEVANCE_THRESHOLD,
  scoreItem,
  strongestSeverity,
  type RelevanceContext,
} from '../../src/app/ranking.ts';

const clock = fixedClock('2026-03-01T00:00:00.000Z');

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    kind: 'bug',
    id: 'bug_1',
    projectId: 'prj_1',
    title: 'Ownership check passes for unverified offers',
    body: '',
    subsystem: null,
    files: [],
    symbols: [],
    status: 'open',
    priority: null,
    severity: null,
    confidence: null,
    verification: null,
    createdAt: '2026-02-25T00:00:00.000Z',
    taskId: null,
    head: null,
    branch: null,
    terms: [],
    raw: {},
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
    subsystem: 'ownership',
    reproduction: null,
    expected: null,
    observed: null,
    evidence: [],
    files: [],
    commits: [],
    createdAt: '2026-02-25T00:00:00.000Z',
    updatedAt: '2026-02-25T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function context(overrides: Partial<RelevanceContext> = {}): RelevanceContext {  return {
    terms: new Set<string>(),
    identifierTerms: new Set<string>(),
    subsystems: [],
    files: [],
    recentlyChangedFiles: [],
    taskType: 'bugfix',
    taskId: null,
    fullTextScores: new Map<string, number>(),
    clock,
    ...overrides,
  };
}

describe('scoreItem', () => {
  it('scores a subsystem match above an unrelated record', () => {
    const related = scoreItem(item({ subsystem: 'ownership' }), context({ subsystems: ['ownership'] }));
    const unrelated = scoreItem(item({ subsystem: 'billing' }), context({ subsystems: ['ownership'] }));
    assert.ok(related.score > unrelated.score);
    assert.ok(related.reasons.some((reason) => reason.includes('subsystem')));
  });

  it('scores a declared file match', () => {
    const scored = scoreItem(
      item({ files: ['src/industry/offer.ts'] }),
      context({ files: ['src/industry/offer.ts'] }),
    );
    assert.ok(scored.breakdown['files'] && scored.breakdown['files'] > 0);
    assert.ok(scored.reasons.some((reason) => reason.includes('offer.ts')));
  });

  it('scores term coverage from the task wording', () => {
    const scored = scoreItem(
      item({ terms: ['ownership', 'offer', 'eligibility'] }),
      context({ terms: new Set(['ownership', 'offer', 'eligibility', 'check']) }),
    );
    assert.ok(scored.score > 0);
  });

  it('scores a partial identifier hit above partial prose overlap', () => {
    const viaIdentifier = scoreItem(
      item({ terms: ['ownership'] }),
      context({ terms: new Set(['ownership', 'check', 'eligibility']), identifierTerms: new Set(['ownership']) }),
    );
    const viaProse = scoreItem(
      item({ terms: ['ownership'] }),
      context({ terms: new Set(['ownership', 'check', 'eligibility']) }),
    );
    assert.ok(
      viaIdentifier.score > viaProse.score,
      `identifier ${viaIdentifier.score} should beat prose ${viaProse.score}`,
    );
  });

  it('gives severity weight only to serious open records', () => {
    const critical = scoreItem(item({ severity: 'critical', status: 'open' }), context());
    const low = scoreItem(item({ severity: 'low', status: 'open' }), context());
    assert.ok(critical.score > low.score);
    const closed = scoreItem(item({ severity: 'critical', status: 'fixed_verified' }), context());
    assert.ok(closed.score < critical.score);
  });

  it('decays with age', () => {
    const fresh = scoreItem(item({ createdAt: '2026-02-28T00:00:00.000Z' }), context());
    const stale = scoreItem(item({ createdAt: '2024-01-01T00:00:00.000Z' }), context());
    assert.ok(fresh.score > stale.score);
  });

  it('promotes records attached to the current task', () => {
    const linked = scoreItem(item({ taskId: 'tsk_42', kind: 'verification' }), context({ taskId: 'tsk_42' }));
    assert.ok(linked.breakdown['relationship']);
    assert.ok(linked.reasons.includes('recorded for this task'));
  });

  it('uses full-text scores as an ordinal signal', () => {
    const scored = scoreItem(
      item({ id: 'bug_fts' }),
      context({ fullTextScores: new Map([['bug_fts', 1]]) }),
    );
    assert.ok((scored.breakdown['fullText'] ?? 0) > 0);
  });

  it('never exceeds a score of 1', () => {
    const scored = scoreItem(
      item({
        subsystem: 'ownership',
        files: ['src/industry/offer.ts'],
        terms: ['ownership', 'offer'],
        severity: 'critical',
        priority: 'P0',
        status: 'open',
        confidence: 'runtime_confirmed',
        taskId: 'tsk_42',
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
      context({
        subsystems: ['ownership'],
        files: ['src/industry/offer.ts'],
        terms: new Set(['ownership', 'offer']),
        identifierTerms: new Set(['ownership']),
        taskId: 'tsk_42',
        fullTextScores: new Map([['bug_1', 1]]),
      }),
    );
    assert.ok(scored.score <= 1);
  });
});

describe('rankItems', () => {
  it('drops records below the relevance threshold', () => {
    const items = [
      item({ id: 'bug_a', subsystem: 'ownership' }),
      item({ id: 'bug_b', subsystem: 'billing', createdAt: '2020-01-01T00:00:00.000Z' }),
    ];
    const ranked = rankItems(items, context({ subsystems: ['ownership'] }));
    assert.deepEqual(ranked.map((entry) => entry.item.id), ['bug_a']);
  });

  it('orders by score, then severity, then recency, then id', () => {
    const items = [
      item({ id: 'bug_low', subsystem: 'ownership', severity: 'low' }),
      item({ id: 'bug_critical', subsystem: 'ownership', severity: 'critical' }),
    ];
    const ranked = rankItems(items, context({ subsystems: ['ownership'] }));
    assert.equal(ranked[0]?.item.id, 'bug_critical');
  });

  it('orders equal records by effective freshness, then id', () => {
    const newer = item({ id: 'bug_b', subsystem: 'ownership', createdAt: '2026-02-27T00:00:00.000Z' });
    const older = item({ id: 'bug_a', subsystem: 'ownership', createdAt: '2026-02-20T00:00:00.000Z' });
    assert.deepEqual(
      rankItems([older, newer], context({ subsystems: ['ownership'] })).map((entry) => entry.item.id),
      ['bug_b', 'bug_a'],
    );

    const sameTimeA = item({ id: 'bug_a', subsystem: 'ownership', createdAt: '2026-02-27T00:00:00.000Z' });
    const sameTimeB = item({ id: 'bug_b', subsystem: 'ownership', createdAt: '2026-02-27T00:00:00.000Z' });
    assert.deepEqual(
      rankItems([sameTimeB, sameTimeA], context({ subsystems: ['ownership'] })).map((entry) => entry.item.id),
      ['bug_a', 'bug_b'],
    );
  });

  it('is deterministic across repeated runs', () => {
    const items = [
      item({ id: 'bug_1', subsystem: 'ownership' }),
      item({ id: 'bug_2', subsystem: 'ownership' }),
      item({ id: 'bug_3', subsystem: 'ownership' }),
    ];
    const first = rankItems(items, context({ subsystems: ['ownership'] })).map((entry) => entry.item.id);
    const second = rankItems([...items].reverse(), context({ subsystems: ['ownership'] })).map((entry) => entry.item.id);
    assert.deepEqual(first, second);
  });

  it('restricts to requested kinds', () => {
    const items = [
      item({ id: 'bug_a', kind: 'bug', subsystem: 'ownership' }),
      item({ id: 'dec_a', kind: 'decision', subsystem: 'ownership', status: null }),
    ];
    const ranked = rankItems(items, context({ subsystems: ['ownership'] }), { kinds: ['decision'] });
    assert.deepEqual(ranked.map((entry) => entry.item.id), ['dec_a']);
  });

  it('respects a custom threshold', () => {
    const items = [item({ id: 'bug_a', subsystem: 'billing' })];
    assert.equal(rankItems(items, context(), { threshold: RELEVANCE_THRESHOLD }).length, 0);
    assert.equal(rankItems(items, context(), { threshold: 0 }).length, 1);
  });
});

describe('describeBug and strongestSeverity', () => {
  it('renders the recorded observation and reproduction', () => {
    const text = describeBug(
      bug({
        observed: 'The ownership check passes for unverified offers.',
        reproduction: 'Open the offers screen as a new studio.',
      }),
    );
    assert.match(text, /observed: The ownership check passes/);
    assert.match(text, /repro: Open the offers screen/);
  });

  it('falls back to the expectation when nothing was observed', () => {
    const text = describeBug(bug({ expected: 'The offer should be hidden.' }));
    assert.match(text, /expected: The offer should be hidden/);
  });

  it('renders nothing for a bug with no detail, so callers can skip the line', () => {
    assert.equal(describeBug(bug()), '');
  });

  it('picks the most severe value or null', () => {
    assert.equal(strongestSeverity(['low', 'critical', 'medium']), 'critical');
    assert.equal(strongestSeverity([]), null);
  });
});
