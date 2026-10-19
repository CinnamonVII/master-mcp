/**
 * Requirement-aware completion tests.
 *
 * A completion is only "verified" when the checks the project (or the task)
 * declared were actually covered. These tests exercise that boundary through the
 * real service and the rendered brief, including the config policy and the
 * task-type exemption for docs work.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { harness, section, writeFiles } from '../helpers/harness.ts';

const CONFIG = [
  'project: offer-service',
  'goal: Ship the industry offer service',
  'phase: implementation',
  'subsystems:',
  '  - industry-offer',
  'verification:',
  '  test_command: npm test',
  '  lint_command: npm run lint',
  '  build_command: npm run build',
  '',
].join('\n');

const OFFER_FILE = 'src/industry/offer.ts';

function seed(h: ReturnType<typeof harness>): void {
  writeFiles(h.dir, {
    '.mcp/master-mcp.yaml': CONFIG,
    [OFFER_FILE]: 'export function isEligible() { return true; }\n',
  });
}

describe('requirement-aware completion', () => {
  it('stops at implementation_done when only one of three configured checks passed', async () => {
    const h = harness('verification');
    try {
      seed(h);
      await h.with(async (service) => {
        const context = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
        });
        assert.ok(context.taskId);

        const partial = await service.complete({
          summary: 'Ownership now comes from the offer record.',
          taskId: context.taskId,
          filesChanged: [OFFER_FILE],
          testsRun: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
        });
        assert.equal(partial.taskStatus, 'implementation_done');
        assert.equal(partial.verificationStatus, 'partial');
        assert.match(partial.text, /task tsk_[a-z0-9]+ → implementation_done \(verification: partial, coverage: 1\/3\)/);
        assert.match(partial.text, /uncovered: .*lint/);
        assert.match(partial.text, /uncovered: .*build/);
        assert.ok(partial.notes.some((note) => /coverage 1\/3/.test(note)));

        // The next brief makes the gap visible before the agent claims victory.
        const after = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
        });
        const verification = section(after.text, 'VERIFICATION');
        assert.match(verification, /coverage: 1\/3 · status: partial/);
        assert.match(verification, /- ✓ Run the test command `npm test`/);
        assert.match(verification, /- ✗ Run the lint command `npm run lint`/);
        assert.match(verification, /- ✗ Run the build command `npm run build`/);
        assert.match(section(after.text, 'TASK'), /\[implementation_done/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('reaches verified_done only after the remaining checks are recorded', async () => {
    const h = harness('verification');
    try {
      seed(h);
      await h.with(async (service) => {
        const context = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
        });

        await service.complete({
          summary: 'First pass: tests only.',
          taskId: context.taskId,
          testsRun: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
        });

        const complete = await service.complete({
          summary: 'Lint and build now pass as well.',
          taskId: context.taskId,
          filesChanged: [OFFER_FILE],
          testsRun: [
            { command: 'npm test', result: 'pass', evidence: ['24 passing'] },
            { command: 'npm run lint', result: 'pass', evidence: ['no issues'] },
            { command: 'npm run build', result: 'pass', evidence: ['bundle written'] },
          ],
        });
        assert.equal(complete.taskStatus, 'verified_done');
        assert.equal(complete.verificationStatus, 'verified');
        assert.match(complete.text, /verification: verified, coverage: 3\/3/);
        assert.ok(!/uncovered:/.test(complete.text));

        const after = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
        });
        assert.match(section(after.text, 'VERIFICATION'), /coverage: 3\/3 · status: verified/);
        assert.match(section(after.text, 'TASK'), /\[verified_done/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('lets a task declare requirements that replace the configured checks', async () => {
    const h = harness('verification');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Register the project', affectedFiles: [OFFER_FILE] });
        const task = service.record({
          kind: 'todo',
          body: 'Fix the offer ownership check',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
          verificationRequirements: ['Run `npm test`', 'The original report no longer reproduces.'],
        });

        const context = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
        });
        assert.equal(context.taskId, task.id);

        const partial = await service.complete({
          summary: 'Tests pass; reproduction not re-checked yet.',
          taskId: task.id,
          testsRun: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
        });
        assert.equal(partial.verificationStatus, 'partial');
        assert.match(partial.text, /coverage: 1\/2/, 'the declared pair replaces test+lint+build');
        assert.match(partial.text, /uncovered: The original report no longer reproduces\./);
        assert.ok(!/lint/.test(partial.text));

        const complete = await service.complete({
          summary: 'Reproduced the report, then confirmed it no longer happens.',
          taskId: task.id,
          testsRun: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
          verification: [
            { method: 'manual reproduction', result: 'pass', evidence: ['the original report no longer reproduces'] },
          ],
        });
        assert.equal(complete.verificationStatus, 'verified');
        assert.equal(complete.taskStatus, 'verified_done');
        assert.match(complete.text, /coverage: 2\/2/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('does not gate docs work on the configured build checks', async () => {
    const h = harness('verification');
    try {
      seed(h);
      await h.with(async (service) => {
        const context = await service.context({
          task: 'Document the offer ownership rules in the README',
          affectedFiles: ['README.md'],
        });

        const complete = await service.complete({
          summary: 'Documented how ownership is derived from the offer record.',
          taskId: context.taskId,
          filesChanged: ['README.md'],
        });
        // No requirements apply, so the evidence-only rules decide: nothing was
        // claimed, hence implementation_done rather than a fabricated 1/3.
        assert.equal(complete.verificationStatus, 'none');
        assert.equal(complete.taskStatus, 'implementation_done');
        assert.ok(!/coverage:/.test(complete.text));

        const after = await service.context({ task: 'Document the offer ownership rules in the README' });
        assert.equal(after.brief.coverage, null);
        assert.ok(!/coverage: \d\/\d/.test(section(after.text, 'VERIFICATION')));
      });
    } finally {
      h.cleanup();
    }
  });

  it('counts a failing check as failed even when others pass', async () => {
    const h = harness('verification');
    try {
      seed(h);
      await h.with(async (service) => {
        const context = await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
        const complete = await service.complete({
          summary: 'Tests pass but lint fails.',
          taskId: context.taskId,
          testsRun: [
            { command: 'npm test', result: 'pass', evidence: ['24 passing'] },
            { command: 'npm run lint', result: 'fail', evidence: ['2 errors'] },
          ],
        });
        assert.equal(complete.verificationStatus, 'failed');
        assert.equal(complete.taskStatus, 'implementation_done');
        assert.match(complete.text, /coverage: 1\/3/);
        assert.ok(complete.notes.some((note) => /reported a failure/.test(note)));
      });
    } finally {
      h.cleanup();
    }
  });
});
