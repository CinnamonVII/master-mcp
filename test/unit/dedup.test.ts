/**
 * Near-duplicate detection tests.
 *
 * Dedup exists to stop one piece of work producing two records, but it is worse
 * to merge distinct work than to keep a visible duplicate. These tests pin both
 * sides of that trade-off: clear duplicates merge, near misses stay separate,
 * and inactive or negated records are never silently reactivated.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BORDERLINE_THRESHOLD,
  DUPLICATE_THRESHOLD,
  dedupTerms,
  findDuplicate,
  isNegated,
  mergeStrings,
  recordSimilarity,
  type DedupExisting,
} from '../../src/app/dedup.ts';

describe('recordSimilarity', () => {
  it('scores identical statements at 1', () => {
    const result = recordSimilarity(
      { text: 'Eligibility lives in the offer predicate' },
      { text: 'Eligibility lives in the offer predicate' },
    );
    assert.equal(result.score, 1);
  });

  it('scores a concise statement highly against a longer restatement', () => {
    const result = recordSimilarity(
      { text: 'Eligibility lives in the offer predicate' },
      { text: 'Eligibility lives in the offer predicate, not in the UI' },
    );
    assert.ok(result.score >= DUPLICATE_THRESHOLD, `expected a duplicate score, got ${result.score}`);
  });

  it('does not merge records that merely share a subsystem vocabulary', () => {
    const result = recordSimilarity(
      { text: 'Eligibility lives in the offer predicate' },
      { text: 'Ownership is serialized by the industry offer DTO' },
    );
    assert.ok(result.score < BORDERLINE_THRESHOLD, `expected a low score, got ${result.score}`);
  });

  it('folds common engineering abbreviations', () => {
    const withShort = recordSimilarity({ text: 'Auth config lives in the API' }, { text: 'Authentication configuration lives in the API' });
    const withoutSynonyms = recordSimilarity(
      { text: 'Auth config lives in the API' },
      { text: 'Authorization setup lives in the API' },
    );
    assert.ok(withShort.score > withoutSynonyms.score);
    assert.deepEqual(dedupTerms('Auth config'), ['authentication', 'configuration']);
  });
});

describe('findDuplicate', () => {
  const existing: DedupExisting[] = [
    { id: 'dec_1', text: 'Eligibility lives in the offer predicate' },
    { id: 'dec_2', text: 'Ownership is serialized by the industry offer DTO' },
  ];

  it('returns a duplicate verdict for the same statement', () => {
    const match = findDuplicate({ text: 'Eligibility lives in the offer predicate' }, existing);
    assert.equal(match?.verdict, 'duplicate');
    assert.equal(match?.id, 'dec_1');
    assert.ok((match?.score ?? 0) >= DUPLICATE_THRESHOLD);
  });

  it('returns a borderline verdict for a similar-but-distinct statement', () => {
    const match = findDuplicate(
      { text: 'Eligibility is decided by the offer predicate in the backend service layer' },
      existing,
      { minSharedTerms: 3 },
    );
    assert.equal(match?.verdict, 'borderline');
    assert.match(match?.reason ?? '', /created separately/);
  });

  it('returns null when fewer shared terms than the caller requires', () => {
    const match = findDuplicate({ text: 'Eligibility' }, existing, { minSharedTerms: 3 });
    assert.equal(match, null);
  });

  it('never merges into a superseded or inactive record', () => {
    const match = findDuplicate(
      { text: 'Eligibility lives in the offer predicate' },
      [{ id: 'dec_old', text: 'Eligibility lives in the offer predicate', inactive: true }],
    );
    assert.equal(match?.verdict, 'borderline');
    assert.match(match?.reason ?? '', /superseded or inactive/);
  });

  it('never merges opposite statements', () => {
    const match = findDuplicate(
      { text: 'Eligibility never lives in the offer predicate' },
      [{ id: 'dec_1', text: 'Eligibility lives in the offer predicate' }],
    );
    assert.equal(match?.verdict, 'borderline');
    assert.match(match?.reason ?? '', /states the opposite/);
  });

  it('keeps records from different subsystems separate', () => {
    const match = findDuplicate(
      { text: 'Eligibility lives in the offer predicate', subsystem: 'billing' },
      [{ id: 'dec_1', text: 'Eligibility lives in the offer predicate', subsystem: 'industry-offer' }],
    );
    assert.equal(match?.verdict, 'borderline');
    assert.match(match?.reason ?? '', /different subsystem/);
  });

  it('merges when the subsystem agrees or is unstated', () => {
    const sameSubsystem = findDuplicate(
      { text: 'Eligibility lives in the offer predicate', subsystem: 'industry-offer' },
      [{ id: 'dec_1', text: 'Eligibility lives in the offer predicate', subsystem: 'industry-offer' }],
    );
    assert.equal(sameSubsystem?.verdict, 'duplicate');
    const unstated = findDuplicate(
      { text: 'Eligibility lives in the offer predicate' },
      [{ id: 'dec_1', text: 'Eligibility lives in the offer predicate', subsystem: 'industry-offer' }],
    );
    assert.equal(unstated?.verdict, 'duplicate');
  });
});

describe('isNegated and mergeStrings', () => {
  it('recognises negated statements', () => {
    assert.equal(isNegated('Never infer ownership in the UI'), true);
    assert.equal(isNegated('Ownership comes from the offer record'), false);
  });

  it('merges lists without duplicates while preserving order', () => {
    assert.deepEqual(mergeStrings(['a.ts', 'b.ts'], ['b.ts', 'c.ts']), ['a.ts', 'b.ts', 'c.ts']);
    assert.deepEqual(mergeStrings([], ['x']), ['x']);
    assert.deepEqual(mergeStrings(['x'], []), ['x']);
  });
});
