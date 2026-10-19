/**
 * Memory trust tests.
 *
 * These cover what master-mcp remembers and how honestly it presents it:
 * conflict warnings when the repository moves on, the bug lifecycle under the
 * evidence rules, decisions and constraints in later briefs, the confidence
 * guard on findings, and reverse-engineering framing. Everything runs through
 * the real service against temp databases and real git repositories.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { commitAll, git, gitAvailable, harness, hasSection, initGitRepo, section, writeFiles } from '../helpers/harness.ts';

const hasGit = gitAvailable();
const skip = !hasGit;

const CONFIG = [
  'project: concurrent-studios',
  'goal: Ship the offer system',
  'phase: implementation',
  'subsystems:',
  '  - industry-offer',
  'verification:',
  '  test_command: npm test',
  '',
].join('\n');

const OFFER_FILE = 'src/industry/offer.ts';

function seed(h: ReturnType<typeof harness>): void {
  writeFiles(h.dir, {
    '.mcp/master-mcp.yaml': CONFIG,
    [OFFER_FILE]: 'export function isEligible() { return true; }\n',
  });
}

// ---------------------------------------------------------------------------
// Conflicting project state
// ---------------------------------------------------------------------------

describe('conflicting project state', () => {
  it('warns when the repository advanced without a completion recording it', { skip }, async () => {
    const h = harness('memory');
    try {
      seed(h);
      initGitRepo(h.dir, [{ message: 'feat(industry): add the offer list', files: { [OFFER_FILE]: 'export function isEligible() { return true; }\n' } }]);

      await h.with(async (service) => {
        const task = 'Fix the ownership check in the industry-offer list';
        const first = await service.context({ task, affectedFiles: [OFFER_FILE] });
        assert.ok(!/advanced since the last recorded observation/.test(first.text), 'nothing moved yet');

        commitAll(h.dir, { message: 'feat(industry): touch the offer list', files: { [OFFER_FILE]: 'export function isEligible() { return false; }\n' } });

        const second = await service.context({ task, affectedFiles: [OFFER_FILE] });
        const warnings = section(second.text, 'WARNINGS');
        assert.match(warnings, /\[WARNING\] Project state advanced since the last recorded observation/);
        assert.match(warnings, /\(1 commits\)/);
        // The new commit is part of the brief, so the agent can inspect it.
        assert.match(section(second.text, 'RELEVANT HISTORY'), /feat\(industry\): touch the offer list/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('warns when the branch changed since the last observation', { skip }, async () => {
    const h = harness('memory');
    try {
      seed(h);
      initGitRepo(h.dir, [{ message: 'feat(industry): add the offer list', files: { [OFFER_FILE]: 'export function isEligible() { return true; }\n' } }]);

      await h.with(async (service) => {
        const task = 'Fix the ownership check in the industry-offer list';
        const first = await service.context({ task, affectedFiles: [OFFER_FILE] });
        await service.complete({
          summary: 'Investigated the ownership path; no change yet.',
          taskId: first.taskId,
        });

        git(h.dir, ['checkout', '-b', 'fix/ownership']);

        const second = await service.context({ task, affectedFiles: [OFFER_FILE] });
        const warnings = section(second.text, 'WARNINGS');
        assert.match(warnings, /\[INFO\] Branch changed since the last recorded observation: main → fix\/ownership\./);
        assert.match(section(second.text, 'PROJECT'), /branch fix\/ownership/);
      });
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Bugs
// ---------------------------------------------------------------------------

describe('bugs', () => {
  it('surfaces an open bug as a preflight hazard for matching work', async () => {
    const h = harness('memory');
    try {
      seed(h);
      await h.with(async (service) => {
        // Register the project first: master_record only works inside a known repository.
        await service.context({ task: 'Fix the ownership check for unverified offers', affectedFiles: [OFFER_FILE] });

        const recorded = service.record({
          kind: 'bug',
          body: 'Ownership check passes for unverified offers',
          severity: 'high',
          subsystem: 'industry-offer',
          reproduction: 'Open the offer list as an unverified user.',
          observed: 'The offer is visible.',
          files: [OFFER_FILE],
        });
        assert.match(recorded.text, /Recorded high bug bug_[a-z0-9]+/);

        const brief = await service.context({
          task: 'Fix the ownership check for unverified offers',
          affectedFiles: [OFFER_FILE],
        });

        const history = section(brief.text, 'RELEVANT HISTORY');
        assert.match(history, /bugs:/);
        assert.match(history, /- \[high\/open, [^\]]+\] Ownership check passes for unverified offers \(bug_[a-z0-9]+\)/);
        assert.match(history, /observed: The offer is visible\./);
        assert.match(history, /files: src\/industry\/offer\.ts/);

        const risk = section(brief.text, 'KNOWN RISK');
        assert.match(risk, /level: (medium|high|critical)/);
        assert.match(risk, /An open high-severity bug affects this area\./);

        // Reproduction steps become the recommended first action.
        assert.match(section(brief.text, 'NEXT ACTION'), /Reproduce bug_[a-z0-9]+ first/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('marks a resolved bug fixed_verified only with evidence, fix_claimed otherwise', async () => {
    const h = harness('memory');
    try {
      seed(h);
      await h.with(async (service) => {
        // Register the project first; the task record is reused for completion.
        const verifiedTask = await service.context({ task: 'Fix the offer ownership check' });

        const first = service.record({
          kind: 'bug',
          body: 'Ownership check passes for unverified offers',
          severity: 'high',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });
        const second = service.record({
          kind: 'bug',
          body: 'Offer list shows withdrawn offers as active',
          severity: 'medium',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });

        // Verified resolution: generic suite passes are not enough — the
        // evidence must name the defect it actually covers.
        const verified = await service.complete({
          summary: 'Ownership now comes from the offer record.',
          taskId: verifiedTask.taskId,
          bugsResolved: [first.id],
          testsRun: [
            {
              command: 'npm test',
              result: 'pass',
              evidence: [`regression coverage for ${first.id}`, '24 passing'],
            },
          ],
        });
        assert.deepEqual(verified.recorded.bugsUpdated, [first.id]);
        assert.ok(!verified.notes.some((note) => /fix_claimed, not fixed_verified/.test(note)));

        // Claimed resolution without evidence.
        const claimedTask = await service.context({ task: 'Hide withdrawn offers from the offer list' });
        const claimed = await service.complete({
          summary: 'I adjusted the filter and it looks right.',
          taskId: claimedTask.taskId,
          bugsResolved: [second.id],
        });
        assert.deepEqual(claimed.recorded.bugsUpdated, [second.id]);
        assert.ok(claimed.notes.some((note) => /fix_claimed, not fixed_verified/.test(note)));

        // A later brief shows each bug with the status its evidence earned.
        const later = await service.context({
          task: 'Follow up on the offer ownership bugs in the industry-offer list',
          affectedFiles: [OFFER_FILE],
        });
        const history = section(later.text, 'RELEVANT HISTORY');
        assert.match(history, /- \[high\/fixed_verified, [^\]]+\] Ownership check passes for unverified offers/);
        assert.match(history, /- \[medium\/fix_claimed, [^\]]+\] Offer list shows withdrawn offers as active/);
      });
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Decisions and constraints
// ---------------------------------------------------------------------------

describe('decisions and constraints', () => {
  it('shows a decision and its rationale in a matching brief', async () => {
    const h = harness('memory');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Refactor the offer eligibility predicate', affectedFiles: [OFFER_FILE] });

        const recorded = service.record({
          kind: 'decision',
          body: 'Eligibility lives in the offer predicate',
          rationale: 'One source of truth prevents UI drift.',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });
        assert.match(recorded.text, /Recorded decision dec_[a-z0-9]+/);

        const brief = await service.context({
          task: 'Refactor the offer eligibility predicate',
          affectedFiles: [OFFER_FILE],
        });
        const history = section(brief.text, 'RELEVANT HISTORY');
        assert.match(history, /decisions:/);
        assert.match(history, /- Eligibility lives in the offer predicate \(dec_[a-z0-9]+, [^)]+\)/);
        assert.match(history, /why: One source of truth prevents UI drift\./);
      });
    } finally {
      h.cleanup();
    }
  });

  it('gives a critical constraint its own prominent section', async () => {
    const h = harness('memory');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });

        service.record({
          kind: 'constraint',
          body: 'Never infer offer ownership from UI state',
          severity: 'critical',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });

        const brief = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
        });
        const block = section(brief.text, 'CRITICAL CONSTRAINTS');
        assert.match(block, /- \[critical\] Never infer offer ownership from UI state — industry-offer \(con_[a-z0-9]+\)/);
        assert.match(section(brief.text, 'KNOWN RISK'), /A critical constraint applies to this subsystem\./);
      });
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Findings, the confidence guard, and reverse engineering
// ---------------------------------------------------------------------------

describe('findings and confidence', () => {
  it('downgrades an unevidenced runtime claim made in a completion', async () => {
    const h = harness('memory');
    try {
      seed(h);
      await h.with(async (service) => {
        const result = await service.complete({
          summary: 'Mapped the offer ownership path.',
          task: 'Map the offer ownership path',
          discoveries: [
            {
              statement: 'Ownership is decided in the offer predicate.',
              confidence: 'runtime_confirmed',
              files: [OFFER_FILE],
            },
          ],
        });
        assert.ok(
          result.notes.some((note) =>
            /runtime_confirmed requires recorded runtime evidence; downgraded to statically_supported/.test(note),
          ),
          `expected a downgrade note, got: ${JSON.stringify(result.notes)}`,
        );

        // The stored finding carries the guarded confidence, visible in an RE brief.
        const re = await service.context({ task: 'Map the offer ownership path', mode: 're' });
        const block = section(re.text, 'REVERSE ENGINEERING');
        assert.match(block, /unverified \(do not treat as fact\):/);
        assert.match(block, /- Ownership is decided in the offer predicate\. \[statically_supported, fnd_[a-z0-9]+, [^\]]+\]/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('frames reverse-engineering findings by confidence with promotion guidance', async () => {
    const h = harness('memory');
    try {
      seed(h);
      await h.with(async (service) => {
        // Register the project (and the task) before recording findings against it.
        await service.context({ task: 'Triage ownership behaviour at runtime' });

        service.record({
          kind: 'finding',
          body: 'isEligible decides ownership for every offer.',
          confidence: 'runtime_observed',
          evidence: ['breakpoint hit at offer.ts:42'],
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
          symbols: ['isEligible'],
        });
        service.record({
          kind: 'finding',
          body: 'The UI caches ownership client-side.',
          confidence: 'suspected',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });

        const re = await service.context({ task: 'Triage ownership behaviour at runtime', mode: 're' });
        const block = section(re.text, 'REVERSE ENGINEERING');
        assert.match(block, /established \(runtime evidence on record\):/);
        assert.match(block, /- isEligible decides ownership for every offer\. \[runtime_observed, fnd_[a-z0-9]+, [^\]]+\]/);
        assert.match(block, /unverified \(do not treat as fact\):/);
        assert.match(block, /- The UI caches ownership client-side\. \[suspected, fnd_[a-z0-9]+, [^\]]+ → next: statically_supported\]/);
        assert.match(block, /to promote a finding:/);
        assert.match(block, /- statically_supported: Run the binary or test once and capture output to reach runtime observed\./);
        assert.match(block, /- runtime_confirmed: Reproduced and confirmed at runtime, with recorded evidence\./);

        // The next action sends the agent to validate the open finding.
        assert.match(section(re.text, 'NEXT ACTION'), /Validate fnd_[a-z0-9]+ at runtime/);

        // A normal task in the same project must not be framed as reverse engineering.
        const normal = await service.context({ task: 'Add a regression test for offer ownership', affectedFiles: [OFFER_FILE] });
        assert.ok(!hasSection(normal.text, 'REVERSE ENGINEERING'));
        assert.match(normal.text, /findings \(unverified entries are not facts\):/);
      });
    } finally {
      h.cleanup();
    }
  });
});
