/**
 * Text utility tests.
 *
 * These functions define what "the same term" means across indexing, scoring
 * and path matching, so a regression here silently degrades every brief.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  approxTokens,
  bestPathAffinity,
  closestMatch,
  keywords,
  normalizeTerm,
  normalizePath,
  pathAffinity,
  pathTokens,
  queryCoverage,
  setOverlap,
  splitWords,
  tidy,
  truncate,
} from '../../src/util/text.ts';

describe('splitWords', () => {
  it('splits identifiers, paths and punctuation', () => {
    assert.deepEqual(splitWords('src/industry/offerEligibility.ts'), [
      'src', 'industry', 'offer', 'Eligibility', 'ts',
    ]);
  });

  it('splits snake_case and digit boundaries', () => {
    assert.deepEqual(splitWords('fix_offer42_check'), ['fix', 'offer', '42', 'check']);
  });

  it('keeps acronym runs together', () => {
    assert.deepEqual(splitWords('HTTPClient'), ['HTTP', 'Client']);
  });

  it('returns nothing for empty input', () => {
    assert.deepEqual(splitWords(''), []);
  });
});

describe('normalizeTerm', () => {
  it('singularises plurals and ies forms', () => {
    assert.equal(normalizeTerm('offers'), 'offer');
    assert.equal(normalizeTerm('policies'), 'policy');
    assert.equal(normalizeTerm('classes'), 'class');
  });

  it('leaves short and ss/us words alone', () => {
    assert.equal(normalizeTerm('status'), 'status');
    assert.equal(normalizeTerm('css'), 'css');
    assert.equal(normalizeTerm('ui'), 'ui');
  });
});

describe('keywords', () => {
  it('drops stopwords, normalises and de-duplicates', () => {
    assert.deepEqual(keywords('Fix the incorrect ownership checks in the offer UI'), [
      'fix', 'incorrect', 'ownership', 'check', 'offer', 'ui',
    ]);
  });

  it('is order-stable, so rendering is reproducible', () => {
    assert.deepEqual(keywords('beta alpha beta'), ['beta', 'alpha']);
  });
});

describe('pathTokens', () => {
  it('splits directory and file segments into normalised tokens', () => {
    assert.deepEqual(pathTokens('src/industry/offer-eligibility.ts'), ['src', 'industry', 'offer', 'eligibility']);
  });

  it('handles nested package paths', () => {
    assert.deepEqual(pathTokens('packages/checkout/cart.ts'), ['package', 'checkout', 'cart']);
  });
});

describe('pathAffinity', () => {
  it('scores an identical path at 1', () => {
    assert.equal(pathAffinity('src/a/b.ts', 'src/a/b.ts'), 1);
  });

  it('scores a suffix relationship highly', () => {
    assert.equal(pathAffinity('src/a/b.ts', 'a/b.ts'), 0.9);
  });

  it('prefers a shared basename over shared directories', () => {
    assert.ok(pathAffinity('src/a/offer.ts', 'lib/b/offer.ts') > pathAffinity('src/a/offer.ts', 'src/a/other.ts'));
  });

  it('returns 0 for unrelated paths', () => {
    assert.equal(pathAffinity('src/a.ts', 'docs/readme.md'), 0);
  });

  it('bestPathAffinity takes the strongest match', () => {
    assert.equal(bestPathAffinity('src/a/b.ts', ['zzz.ts', 'b.ts']), 0.9);
  });
});

describe('overlap helpers', () => {
  it('setOverlap is symmetric and empty-safe', () => {
    assert.equal(setOverlap(new Set(), new Set(['a'])), 0);
    assert.equal(setOverlap(new Set(['a', 'b']), new Set(['b'])), 0.5);
  });

  it('queryCoverage measures how much of the query is covered', () => {
    assert.equal(queryCoverage(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'z'])), 2 / 3);
  });
});

describe('formatting helpers', () => {
  it('truncate cuts on a word boundary and marks the cut', () => {
    assert.equal(truncate('the quick brown fox jumps', 20), 'the quick brown…');
  });

  it('truncate leaves short text untouched and collapses whitespace', () => {
    assert.equal(truncate('  fix   the bug  ', 40), 'fix the bug');
  });

  it('approxTokens is a descending-friendly size estimate', () => {
    assert.equal(approxTokens('abcd'), 1);
    assert.equal(approxTokens(''), 0);
  });

  it('tidy strips a trailing period', () => {
    assert.equal(tidy('Fix the thing.'), 'Fix the thing');
  });

  it('normalizePath removes ./ and trailing slashes', () => {
    assert.equal(normalizePath('./src//a/b.ts/'), 'src//a/b.ts');
  });
});

describe('closestMatch', () => {
  it('finds a near spelling of a candidate', () => {
    assert.equal(closestMatch('concurrent studio', ['concurrent-studios', 'other-project']), 'concurrent-studios');
  });

  it('returns undefined when nothing overlaps', () => {
    assert.equal(closestMatch('zzzz', ['concurrent-studios']), undefined);
  });
});
