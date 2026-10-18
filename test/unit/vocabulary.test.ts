/**
 * Vocabulary tests.
 *
 * One place decides what "P1" or "critical" means; these tests pin the
 * orderings, predicates and tolerant parsing that everything else relies on.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  confidenceRank,
  isActiveTask,
  isEstablished,
  isHazardousBug,
  isOpenBug,
  isUnresolvedTask,
  isVerified,
  nextConfidence,
  parseBugStatus,
  parseConfidence,
  parseMemoryKind,
  parsePriority,
  parseSeverity,
  parseTaskStatus,
  parseVerificationResult,
  priorityWeight,
  severityWeight,
} from '../../src/domain/vocabulary.ts';

describe('weights', () => {
  it('orders priorities from P0 (most urgent) to P3', () => {
    assert.ok(priorityWeight('P0') > priorityWeight('P1'));
    assert.ok(priorityWeight('P1') > priorityWeight('P2'));
    assert.ok(priorityWeight('P2') > priorityWeight('P3'));
  });

  it('orders severities from critical to low', () => {
    assert.ok(severityWeight('critical') > severityWeight('high'));
    assert.ok(severityWeight('high') > severityWeight('medium'));
    assert.ok(severityWeight('medium') > severityWeight('low'));
  });
});

describe('confidence ladder', () => {
  it('ranks levels in order', () => {
    assert.ok(confidenceRank('hypothesis') < confidenceRank('suspected'));
    assert.ok(confidenceRank('suspected') < confidenceRank('statically_supported'));
    assert.ok(confidenceRank('statically_supported') < confidenceRank('runtime_observed'));
    assert.ok(confidenceRank('runtime_observed') < confidenceRank('runtime_confirmed'));
  });

  it('walks to the next rung and stops at confirmed', () => {
    assert.equal(nextConfidence('suspected'), 'statically_supported');
    assert.equal(nextConfidence('runtime_confirmed'), null);
  });

  it('treats only runtime levels as established', () => {
    assert.equal(isEstablished('statically_supported'), false);
    assert.equal(isEstablished('runtime_observed'), true);
    assert.equal(isEstablished('runtime_confirmed'), true);
  });
});

describe('predicates', () => {
  it('knows which bugs are open', () => {
    assert.equal(isOpenBug('open'), true);
    assert.equal(isOpenBug('investigating'), true);
    assert.equal(isOpenBug('fixed_verified'), false);
    assert.equal(isOpenBug('wontfix'), false);
  });

  it('knows which tasks are active and which still need work', () => {
    assert.equal(isActiveTask('in_progress'), true);
    assert.equal(isActiveTask('verified_done'), false);
    assert.equal(isUnresolvedTask('implementation_done'), true);
    assert.equal(isUnresolvedTask('cancelled'), false);
  });

  it('flags only serious open bugs as hazards', () => {
    assert.equal(isHazardousBug('open', 'high'), true);
    assert.equal(isHazardousBug('investigating', 'critical'), true);
    assert.equal(isHazardousBug('open', 'low'), false);
    assert.equal(isHazardousBug('fixed_verified', 'critical'), false);
  });

  it('treats only "verified" as verified', () => {
    assert.equal(isVerified('verified'), true);
    assert.equal(isVerified('claimed'), false);
    assert.equal(isVerified('partial'), false);
  });
});

describe('parsing', () => {
  it('is case and separator tolerant', () => {
    assert.equal(parsePriority('p1'), 'P1');
    assert.equal(parseSeverity('HIGH'), 'high');
    assert.equal(parseTaskStatus('Implementation Done'), 'implementation_done');
    assert.equal(parseBugStatus('fix-claimed'), 'fix_claimed');
    assert.equal(parseConfidence('Runtime Confirmed'), 'runtime_confirmed');
    assert.equal(parseVerificationResult('PASS'), 'pass');
    assert.equal(parseMemoryKind('finding'), 'finding');
  });

  it('returns undefined for unrecognised input rather than guessing', () => {
    assert.equal(parsePriority('P9'), undefined);
    assert.equal(parseSeverity('catastrophic'), undefined);
    assert.equal(parseTaskStatus(42), undefined);
    assert.equal(parseConfidence(null), undefined);
  });
});
