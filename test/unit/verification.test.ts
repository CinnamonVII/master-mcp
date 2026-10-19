/**
 * Requirement-aware verification tests.
 *
 * These pin the deterministic matching rules that decide whether a completion
 * is verified: commands, bug references, declared requirements and the
 * config-derived defaults. No fuzzy scoring, no model calls — every case here
 * must produce the same answer on every run.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import type { Bug, ProjectConfig } from '../../src/domain/models.ts';
import {
  assessRequirements,
  bugEvidence,
  claimVerifiesBug,
  classifyClaim,
  classifyRequirement,
  commandMatches,
  configuredRequirements,
  coverageLabel,
  effectiveRequirements,
  extractCommands,
  missingRequirements,
  referencedBugId,
  requirementFor,
  requirementSatisfied,
  type ClaimLike,
} from '../../src/app/verification.ts';

function claim(overrides: Partial<ClaimLike> = {}): ClaimLike {
  return { method: 'tests', command: null, result: 'pass', evidence: [], ...overrides };
}

function bug(overrides: Partial<Bug> = {}): Bug {
  return {
    id: 'bug_1a2b3c4d',
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

function config(overrides: Partial<ProjectConfig['verification']> = {}): ProjectConfig {
  return {
    ...DEFAULT_CONFIG,
    verification: { testCommand: null, lintCommand: null, buildCommand: null, extraChecks: [], ...overrides },
  };
}

describe('classifyRequirement', () => {
  it('recognises the check kinds the lifecycle cares about', () => {
    assert.equal(classifyRequirement('Run `npm test`'), 'test');
    assert.equal(classifyRequirement('Run eslint over the changed files'), 'lint');
    assert.equal(classifyRequirement('Make sure the package builds'), 'build');
    assert.equal(classifyRequirement('Update the README'), 'docs');
    assert.equal(classifyRequirement('Exercise it manually in the browser'), 'manual');
    // Reproduction language outranks the test keyword: this is a regression check.
    assert.equal(classifyRequirement('Add a regression test for the inverted case'), 'regression');
    assert.equal(classifyRequirement('The pointer resolves lazily'), 'other');
  });
});

describe('extractCommands', () => {
  it('takes backticked commands verbatim', () => {
    assert.deepEqual(extractCommands('Run `npm test` and `npm run lint`.'), ['npm test', 'npm run lint']);
  });

  it('recognises commands written without backticks', () => {
    assert.deepEqual(extractCommands('pytest -q tests/unit'), ['pytest -q tests/unit']);
    assert.deepEqual(extractCommands('npm run lint --fix'), ['npm run lint --fix']);
    assert.deepEqual(extractCommands('./scripts/check.sh'), []);
    assert.deepEqual(extractCommands('Run the full suite'), []);
  });

  it('does not repeat duplicate commands', () => {
    assert.deepEqual(extractCommands('`npm test` then `npm test`'), ['npm test']);
  });
});

describe('commandMatches', () => {
  it('treats an exact command as a match', () => {
    assert.equal(commandMatches('npm test', 'npm test'), true);
  });

  it('allows a longer invocation of the same command', () => {
    assert.equal(commandMatches('npm test', 'npm test -- --runInBand'), true);
    assert.equal(commandMatches('npm run lint', 'npm run lint --fix'), true);
  });

  it('does not equate different commands', () => {
    assert.equal(commandMatches('npm test', 'npm run test:unit'), false);
    assert.equal(commandMatches('npm test', 'pytest -q'), false);
  });
});

describe('referencedBugId', () => {
  it('normalises underscore, space and dash spellings', () => {
    assert.equal(referencedBugId('regression for bug_1a2b3c4d'), 'bug_1a2b3c4d');
    assert.equal(referencedBugId('regression for bug 1a2b3c4d'), 'bug_1a2b3c4d');
    assert.equal(referencedBugId('regression for bug-1A2B3C4D'), 'bug_1a2b3c4d');
  });

  it('ignores prose that does not name an id', () => {
    assert.equal(referencedBugId('fix the bug in ownership'), null);
  });
});

describe('requirementSatisfied', () => {
  it('matches a named command that was actually run', () => {
    const requirement = 'Run the offer tests with `npm test`';
    assert.equal(requirementSatisfied(requirement, claim({ command: 'npm test' })), true);
    assert.equal(requirementSatisfied(requirement, claim({ command: 'npm test -- --runInBand' })), true);
    assert.equal(requirementSatisfied(requirement, claim({ command: 'npm run lint' })), false);
  });

  it('never accepts a failing claim', () => {
    assert.equal(
      requirementSatisfied('Run `npm test`', claim({ command: 'npm test', result: 'fail' })),
      false,
    );
  });

  it('matches a bug id named by the requirement', () => {
    const requirement = 'Add regression coverage for bug_1a2b3c4d';
    assert.equal(
      requirementSatisfied(requirement, claim({ evidence: ['bug_1a2b3c4d regression added'] })),
      true,
    );
    // A different bug id is not interchangeable.
    assert.equal(
      requirementSatisfied(requirement, claim({ evidence: ['bug_9999ffff regression added'] })),
      false,
    );
    // The id alone is not a passing check.
    assert.equal(
      requirementSatisfied(requirement, claim({ evidence: ['bug_1a2b3c4d regression added'], result: 'unknown' })),
      false,
    );
  });

  it('accepts a verbatim restatement of a short requirement', () => {
    const requirement = 'The offer list hides withdrawn offers';
    assert.equal(
      requirementSatisfied(
        requirement,
        claim({ evidence: ['verified: the offer list hides withdrawn offers'] }),
      ),
      true,
    );
  });

  it('accepts a same-kind check whose wording overlaps', () => {
    assert.equal(
      requirementSatisfied('Run the offer integration tests', claim({ command: 'npm run test:offer' })),
      true,
    );
  });

  it('falls back to term coverage for unclassified requirements', () => {
    const requirement = 'Eligibility predicate rejects withdrawn offers';
    assert.equal(
      requirementSatisfied(
        requirement,
        claim({ evidence: ['eligibility predicate rejects withdrawn offers after the fix'] }),
      ),
      true,
    );
    assert.equal(
      requirementSatisfied(requirement, claim({ evidence: ['billing invoice page renders correctly'] })),
      false,
    );
  });

  it('rejects empty requirements', () => {
    assert.equal(requirementSatisfied('   ', claim({ command: 'npm test' })), false);
  });
});

describe('classifyClaim and requirementFor', () => {
  it('classifies a claim by its command and evidence', () => {
    assert.equal(classifyClaim(claim({ command: 'npm run lint' })), 'lint');
    assert.equal(classifyClaim(claim({ command: 'npm test' })), 'test');
    assert.equal(classifyClaim(claim({ evidence: ['reproduced before the fix'] })), 'regression');
  });

  it('returns the first requirement a claim satisfies', () => {
    const requirements = ['Run `npm run lint`', 'Run `npm test`', 'Run `npm run build`'];
    assert.equal(requirementFor(requirements, claim({ command: 'npm test' })), 'Run `npm test`');
    assert.equal(requirementFor(requirements, claim({ command: 'pytest' })), null);
  });
});

describe('assessRequirements', () => {
  const requirements = ['Run `npm test`', 'Run `npm run lint`', 'Run `npm run build`'];

  it('keeps 1 of 3 checks explicitly partial', () => {
    const coverage = assessRequirements(requirements, [claim({ command: 'npm test' })]);
    assert.equal(coverage.status, 'partial');
    assert.equal(coverage.satisfied, 1);
    assert.equal(coverage.total, 3);
    assert.equal(coverageLabel(coverage), '1/3');
    assert.deepEqual(missingRequirements(coverage), ['Run `npm run lint`', 'Run `npm run build`']);
    assert.deepEqual(
      coverage.entries.map((entry) => entry.satisfied),
      [true, false, false],
      'entry order follows declaration order',
    );
    assert.equal(coverage.entries[0]?.verificationId, null, 'pure claims carry no stored id');
  });

  it('is verified only when every requirement is covered', () => {
    const coverage = assessRequirements(requirements, [
      claim({ command: 'npm test' }),
      claim({ command: 'npm run lint' }),
      claim({ command: 'npm run build' }),
    ]);
    assert.equal(coverage.status, 'verified');
    assert.equal(coverageLabel(coverage), '3/3');
    assert.deepEqual(missingRequirements(coverage), []);
  });

  it('records no state when nothing is required', () => {
    const coverage = assessRequirements([], [claim({ command: 'npm test' })]);
    assert.equal(coverage.status, 'none');
    assert.equal(coverageLabel(coverage), '0/0');
  });

  it('uses stored verification ids when they are available', () => {
    const coverage = assessRequirements(['Run `npm test`'], [
      claim({ id: 'ver_1', command: 'npm test' }),
    ]);
    assert.equal(coverage.entries[0]?.verificationId, 'ver_1');
  });
});

describe('configuredRequirements and effectiveRequirements', () => {
  const projectConfig = config({
    testCommand: 'npm test',
    lintCommand: 'npm run lint',
    buildCommand: 'npm run build',
  });

  it('derives test, lint and build requirements from config', () => {
    assert.deepEqual(configuredRequirements(projectConfig, 'bugfix'), [
      'Run the test command `npm test`',
      'Run the lint command `npm run lint`',
      'Run the build command `npm run build`',
    ]);
  });

  it('exempts docs and investigation tasks from configured commands', () => {
    assert.deepEqual(configuredRequirements(projectConfig, 'docs'), []);
    assert.deepEqual(configuredRequirements(projectConfig, 'investigation'), []);
  });

  it('lets explicit task requirements replace config-derived ones', () => {
    const task = {
      verificationRequirements: ['The original report no longer reproduces.'],
    } as Parameters<typeof effectiveRequirements>[0]['task'];
    assert.deepEqual(
      effectiveRequirements({ task, config: projectConfig, taskType: 'bugfix' }),
      ['The original report no longer reproduces.'],
    );
  });

  it('falls back to config when the task declares nothing', () => {
    assert.deepEqual(
      effectiveRequirements({ task: null, config: projectConfig, taskType: 'bugfix' }),
      configuredRequirements(projectConfig, 'bugfix'),
    );
  });
});

describe('bugEvidence', () => {
  const target = bug();

  it('does not verify a bug from a generic passing suite', () => {
    const verdict = bugEvidence({
      bug: target,
      claims: [claim({ command: 'npm test', evidence: ['24 passing'] })],
      requirements: ['Run `npm test`'],
    });
    assert.equal(verdict.satisfied, false);
    assert.equal(verdict.reason, null);
  });

  it('verifies when the evidence names the bug id', () => {
    const verdict = bugEvidence({
      bug: target,
      claims: [claim({ command: 'npm test', evidence: ['regression for bug_1a2b3c4d'] })],
      requirements: ['Run `npm test`'],
    });
    assert.equal(verdict.satisfied, true);
    assert.match(verdict.reason ?? '', /references bug_1a2b3c4d/);
  });

  it('verifies when the evidence covers the bug title', () => {
    const verdict = bugEvidence({
      bug: target,
      claims: [claim({ evidence: ['ownership check passes for unverified offers no longer reproduces'] })],
      requirements: [],
    });
    assert.equal(verdict.satisfied, true);
    assert.match(verdict.reason ?? '', /bug title/);
  });

  it('verifies through a declared regression requirement', () => {
    const verdict = bugEvidence({
      bug: target,
      claims: [claim({ evidence: ['withdrawn offers no longer appear'] })],
      requirements: ['Reproduce the withdrawn offer bug before the fix'],
    });
    assert.equal(verdict.satisfied, true);
    assert.match(verdict.reason ?? '', /regression requirement satisfied/);
  });

  it('does not let a regression requirement for another bug verify this one', () => {
    const verdict = bugEvidence({
      bug: target,
      claims: [claim({ evidence: ['bug_deadbeef regression passes'] })],
      requirements: ['Add a regression check for bug_deadbeef'],
    });
    assert.equal(verdict.satisfied, false);
  });

  it('ignores failing claims', () => {
    const verdict = bugEvidence({
      bug: target,
      claims: [claim({ command: 'npm test', result: 'fail', evidence: ['bug_1a2b3c4d still fails'] })],
      requirements: [],
    });
    assert.equal(verdict.satisfied, false);
  });

  it('claimVerifiesBug applies the same rule to one claim', () => {
    assert.equal(
      claimVerifiesBug(target, claim({ evidence: ['bug_1a2b3c4d covered'] }), []),
      true,
    );
    assert.equal(
      claimVerifiesBug(target, claim({ command: 'npm test' }), ['Run `npm test`']),
      false,
    );
  });
});
