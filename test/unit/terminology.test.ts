/**
 * Shared terminology normalization tests.
 *
 * Ranking, full-text query construction and dedup must agree on what counts as
 * the same term. These pin the vocabulary families themselves, not one caller's
 * private copy of them.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { dedupTerms } from '../../src/app/dedup.ts';
import { canonicalTerm, termVariants } from '../../src/util/terminology.ts';
import { keywords } from '../../src/util/text.ts';

describe('canonicalTerm', () => {
  it('folds every ownership morphology onto one term', () => {
    for (const variant of ['own', 'owns', 'owned', 'owning', 'owner', 'owners', 'ownership']) {
      assert.equal(canonicalTerm(variant), 'ownership', `${variant} should fold to ownership`);
    }
    assert.deepEqual(keywords('own owned owner owners ownership'), ['ownership']);
  });

  it('folds engineering abbreviations and their plurals', () => {
    assert.equal(canonicalTerm('tech'), 'technology');
    assert.equal(canonicalTerm('technologies'), 'technology');
    assert.equal(canonicalTerm('repo'), 'repository');
    assert.equal(canonicalTerm('repositories'), 'repository');
    assert.equal(canonicalTerm('db'), 'database');
    assert.equal(canonicalTerm('config'), 'configuration');
    assert.equal(canonicalTerm('perf'), 'performance');
    assert.equal(canonicalTerm('impl'), 'implementation');
    assert.equal(canonicalTerm('deps'), 'dependency');
  });

  it('is idempotent, so folding twice never changes the term', () => {
    for (const variant of ['tech', 'technologies', 'own', 'owner', 'repo', 'config']) {
      const once = canonicalTerm(variant);
      assert.equal(canonicalTerm(once), once);
    }
  });
});

describe('termVariants', () => {
  it('expands the ownership family for full-text search', () => {
    assert.deepEqual(termVariants('ownership'), [
      'ownership', 'own', 'owns', 'owned', 'owning', 'owner', 'owners',
    ]);
    assert.deepEqual(termVariants('owner'), termVariants('ownership'));
  });

  it('expands aliases whether the caller starts from the short or long form', () => {
    assert.deepEqual(termVariants('tech'), ['technology', 'tech', 'techs', 'technologies']);
    assert.deepEqual(termVariants('technology'), termVariants('tech'));
    assert.deepEqual(termVariants('repo'), ['repository', 'repo', 'repos', 'repositories']);
  });
});

describe('shared vocabulary across callers', () => {
  it('ranking terms and dedup terms produce the same canonical set', () => {
    const text = 'The owners tech repo config owned the API';
    assert.deepEqual(dedupTerms(text), keywords(text));
  });
});
