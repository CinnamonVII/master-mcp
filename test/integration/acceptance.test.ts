/**
 * Offer-service acceptance test.
 *
 * This is the realistic end-to-end pass the server is designed for: one call
 * before work, a partial completion, a second call that shows exactly which
 * checks are still missing, then a fully evidenced completion. The process is
 * closed and reopened between the last two steps, so nothing may depend on
 * in-memory state.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { harness, section, writeFiles } from '../helpers/harness.ts';

const CONFIG = [
  'project: offer-service',
  'goal: Make the industry offer service the single source of truth for eligibility',
  'phase: implementation',
  'subsystems:',
  '  - industry-offer',
  '  - ownership',
  'verification:',
  '  test_command: npm test',
  '  lint_command: npm run lint',
  '  build_command: npm run build',
  '',
].join('\n');

const OFFER_FILE = 'src/industry/offer.ts';
const OWNERSHIP_FILE = 'src/industry/ownership.ts';

function seed(): ReturnType<typeof harness> {
  const h = harness('acceptance');
  writeFiles(h.dir, {
    '.mcp/master-mcp.yaml': CONFIG,
    [OFFER_FILE]: 'export function isEligible(offer) { return offer.status === "active"; }\n',
    [OWNERSHIP_FILE]: 'export function ownerOf(offer) { return offer.studioId; }\n',
  });
  return h;
}

describe('offer-service acceptance', () => {
  it('recovers from a partial verification and finishes verified across a restart', async () => {
    const h = seed();
    try {
      const task = 'Fix the technology ownership regression in the industry offer service';
      let taskId = '';

      // --- before work ------------------------------------------------------
      await h.with(async (service) => {
        const context = await service.context({ task, affectedFiles: [OFFER_FILE, OWNERSHIP_FILE] });
        taskId = context.taskId ?? '';
        assert.match(taskId, /^tsk_/);
        assert.match(context.text, /offer-service/);
        assert.match(section(context.text, 'TASK'), /type: bugfix/);
        assert.match(section(context.text, 'VERIFICATION'), /run:\n- npm test\n- npm run lint\n- npm run build/);
        assert.match(section(context.text, 'NEXT ACTION'), /master_complete with task_id/);
      });

      // --- first pass: tests only -------------------------------------------
      await h.with(async (service) => {
        const partial = await service.complete({
          summary: 'Moved ownership derivation into the offer record and fixed the serialization path.',
          taskId,
          filesChanged: [OFFER_FILE, OWNERSHIP_FILE],
          testsRun: [{ command: 'npm test', result: 'pass', evidence: ['48 passing'] }],
          discoveries: [
            {
              statement: 'isEligible receives ownership from the offer record before serialization.',
              confidence: 'statically_supported',
              files: [OFFER_FILE],
            },
          ],
          followUp: [{ title: 'Add a regression test for the ownership serialization edge case', priority: 'P1' }],
        });
        assert.equal(partial.taskStatus, 'implementation_done');
        assert.equal(partial.verificationStatus, 'partial');
        assert.match(partial.text, /coverage: 1\/3/);
        assert.match(partial.text, /uncovered: .*npm run lint/);
        assert.match(partial.text, /uncovered: .*npm run build/);
      });

      // --- the next brief exposes the gap -----------------------------------
      await h.with(async (service) => {
        const context = await service.context({ task, affectedFiles: [OFFER_FILE, OWNERSHIP_FILE] });
        assert.equal(context.taskId, taskId, 'the same task record is reused');
        const taskBlock = section(context.text, 'TASK');
        assert.match(taskBlock, /\[implementation_done/);
        const verification = section(context.text, 'VERIFICATION');
        assert.match(verification, /coverage: 1\/3 · status: partial/);
        assert.match(verification, /- ✓ Run the test command `npm test`/);
        assert.match(verification, /- ✗ Run the lint command `npm run lint`/);
        assert.match(verification, /- ✗ Run the build command `npm run build`/);
        assert.match(section(context.text, 'RELEVANT HISTORY'), /previous work:/);
      });

      // --- second pass, after a fresh process -------------------------------
      await h.with(async (service) => {
        const complete = await service.complete({
          summary: 'Lint and production build now pass; ownership stays server-side.',
          taskId,
          filesChanged: [OFFER_FILE, OWNERSHIP_FILE],
          testsRun: [
            { command: 'npm test', result: 'pass', evidence: ['48 passing'] },
            { command: 'npm run lint', result: 'pass', evidence: ['0 problems'] },
            { command: 'npm run build', result: 'pass', evidence: ['production bundle written'] },
          ],
        });
        assert.equal(complete.taskStatus, 'verified_done');
        assert.equal(complete.verificationStatus, 'verified');
        assert.match(complete.text, /verification: verified, coverage: 3\/3/);
        assert.ok(!/uncovered:/.test(complete.text));
      });

      // --- a third process sees the verified state --------------------------
      await h.with(async (service) => {
        const context = await service.context({ task, affectedFiles: [OFFER_FILE, OWNERSHIP_FILE] });
        const taskBlock = section(context.text, 'TASK');
        assert.match(taskBlock, /\[verified_done/);
        assert.match(section(context.text, 'VERIFICATION'), /coverage: 3\/3 · status: verified/);
        assert.match(section(context.text, 'VERIFICATION'), /- ✓ Run the lint command/);

        const status = await service.status({});
        assert.equal(status.report.registered, true);
        assert.equal(status.report.project.slug, 'offer-service');
        const next = status.report.nextTask;
        assert.notEqual(next?.id, taskId, 'the verified task is no longer the next work item');
        assert.ok(
          status.report.todo.some((item) => item.title.includes('ownership serialization edge case')),
          'the follow-up from the first pass survives',
        );

        const search = service.search({ query: 'ownership serialization' });
        assert.ok(search.hits.some((hit) => hit.kind === 'finding'));
      });
    } finally {
      h.cleanup();
    }
  });
});
