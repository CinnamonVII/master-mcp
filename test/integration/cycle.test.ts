/**
 * End-to-end cycle: context → work → complete → context.
 *
 * This is the workflow the whole product exists for, so it is exercised through
 * the service exactly as an agent would: a brief before the work, one call that
 * records the outcome, and a brief afterwards that must reflect it — including
 * the cases where the agent overstates what it did.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { commitAll, gitAvailable, harness, hasSection, initGitRepo, section, writeFiles } from '../helpers/harness.ts';

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

describe('one-pass cycle', () => {
  it('carries a finished task from brief to completion to the next brief', { skip }, async () => {
    const h = harness('cycle');
    try {
      writeFiles(h.dir, {
        '.mcp/master-mcp.yaml': CONFIG,
        'src/industry/offer.ts': [
          'export function isEligible(offer, user) {',
          '  // BUG: ownership inferred from the UI state instead of the offer.',
          '  return user.uiState === "verified";',
          '}',
          '',
        ].join('\n'),
        'reports/regression.md': 'The offer list shows unverified offers.\n',
      });
      initGitRepo(h.dir, [{ message: 'feat(industry): add the offer list', date: '2026-02-20T10:00:00Z' }]);

      await h.with(async (service) => {
        // --- 1. brief ------------------------------------------------------
        const task = 'Fix the incorrect ownership check for the offer list';
        const before = await service.context({ task, affectedFiles: ['src/industry/offer.ts'] });
        assert.ok(before.taskId, 'a task record is created so completion can attach to it');

        const beforeTitles = before.text.split('\n');
        for (const title of ['PROJECT', 'TASK', 'RECOMMENDED APPROACH', 'VERIFICATION', 'NEXT ACTION']) {
          assert.ok(beforeTitles.includes(title), `first brief is missing ${title}`);
        }
        assert.match(before.text, /^- npm test$/m, 'the configured test command is named');
        assert.ok(!before.text.includes('previous work:'), 'nothing has been done yet');

        // --- 2. work -------------------------------------------------------
        writeFiles(h.dir, {
          'src/industry/offer.ts': [
            'export function isEligible(offer, user) {',
            '  return user.verifiedOffers.has(offer.id);',
            '}',
            '',
          ].join('\n'),
        });
        const commit = commitAll(h.dir, {
          message: 'fix(industry): derive ownership from the offer, not the UI',
          date: '2026-03-01T09:05:00Z',
        });

        // --- 3. completion -------------------------------------------------
        const complete = await service.complete({
          summary: 'Ownership now comes from the offer record instead of the UI state.',
          taskId: before.taskId,
          filesChanged: ['src/industry/offer.ts'],
          commits: [commit.slice(0, 8)],
          testsRun: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
          discoveries: [
            {
              statement: 'isEligible is the only place ownership is decided.',
              confidence: 'statically_supported',
              files: ['src/industry/offer.ts'],
            },
          ],
          followUp: [{ title: 'Add a regression test for the inverted case', priority: 'P2' }],
        });

        assert.equal(complete.taskStatus, 'verified_done');
        assert.equal(complete.verificationStatus, 'verified');
        assert.equal(complete.recorded.verifications.length, 1);
        assert.equal(complete.recorded.findings.length, 1);
        assert.equal(complete.recorded.followUps.length, 1);

        // --- 4. next brief -------------------------------------------------
        const after = await service.context({ task, affectedFiles: ['src/industry/offer.ts'] });
        const history = section(after.text, 'RELEVANT HISTORY');
        assert.match(history, /previous work:/);
        assert.match(history, /Ownership now comes from the offer record/);
        assert.match(history, /verification history:/);
        assert.match(history, /npm test → pass/);
        assert.match(history, /findings/);
        assert.match(history, /isEligible is the only place ownership is decided/);
        assert.match(history, /recent commits:[\s\S]*fix\(industry\): derive ownership from the offer/);

        // The stored task is finished, so the brief must say so rather than
        // pretend the work is still open.
        assert.match(section(after.text, 'TASK'), /\[verified_done\/P2\]/);
        assert.match(section(after.text, 'NEXT ACTION'), /master_complete with task_id/);

        // The follow-up is queued for a later pass.
        assert.ok(hasSection(after.text, 'OPEN FOLLOW-UPS'));
        assert.match(section(after.text, 'OPEN FOLLOW-UPS'), /Add a regression test for the inverted case/);

        // The completion recorded its own view of the repository, so the next
        // brief has no unrecorded work to warn about: the handoff covers HEAD.
        assert.ok(!hasSection(after.text, 'WARNINGS'), 'a recorded pass leaves no stale-state warning');

        // Nothing in the second brief claims the first brief's work is pending.
        assert.match(after.text, /level: (low|medium|high|critical)/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('warns that a handoff went stale when work lands after it', { skip }, async () => {
    const h = harness('cycle');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'src/industry/offer.ts': 'export {};\n' } }]);
      await h.with(async (service) => {
        const brief = await service.context({ task: 'Fix the offer ownership check' });
        await service.complete({
          summary: 'Checked ownership against the offer record.',
          taskId: brief.taskId,
          filesChanged: ['src/industry/offer.ts'],
          testsRun: [{ command: 'npm test', result: 'pass' }],
        });

        // Work lands out of band, with no completion to explain it.
        commitAll(h.dir, {
          message: 'chore(industry): unrelated cleanup',
          files: { 'src/industry/offer.ts': 'export const cleaned = true;\n' },
          date: '2026-03-02T09:00:00Z',
        });

        const next = await service.context({ task: 'Fix the offer ownership check' });
        const warnings = section(next.text, 'WARNINGS');
        assert.match(warnings, /work has landed since that handoff/);
        assert.match(warnings, /Its findings may be stale/);
        // The generic "state advanced" warning would only repeat the above.
        assert.doesNotMatch(warnings, /advanced since the last recorded observation/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('records implementation_done and missing verification when nothing is proven', { skip }, async () => {
    const h = harness('cycle');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG, 'src/industry/offer.ts': 'export {};\n' });
      initGitRepo(h.dir, [{ message: 'initial', files: { 'src/industry/offer.ts': 'export {};\n' } }]);

      await h.with(async (service) => {
        const brief = await service.context({ task: 'Fix the offer ownership check' });
        const result = await service.complete({
          summary: 'I refactored the ownership check and it looks right.',
          taskId: brief.taskId,
          filesChanged: ['src/industry/offer.ts'],
        });

        assert.equal(result.taskStatus, 'implementation_done');
        assert.equal(result.verificationStatus, 'none');
        assert.ok(result.notes.some((note) => /verification is missing/i.test(note)));

        // The agent comes back with the task it was given, so the same record
        // is reused rather than a second task being opened for the same work.
        const next = await service.context({ task: 'Fix the offer ownership check' });
        assert.equal(next.taskId, brief.taskId);
        assert.match(section(next.text, 'TASK'), /\[implementation_done\/P2\]/);
        assert.match(next.text, /MEMORY GAPS/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('refuses to record verified_done when no evidence backs it', { skip }, async () => {
    const h = harness('cycle');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'src/industry/offer.ts': 'export {};\n' } }]);
      await h.with(async (service) => {
        const brief = await service.context({ task: 'Fix the offer ownership check' });
        const result = await service.complete({
          summary: 'Done, everything works.',
          taskId: brief.taskId,
          status: 'verified_done',
          results: ['I ran it and it worked'],
        });

        assert.equal(result.verificationStatus, 'claimed');
        assert.equal(result.taskStatus, 'implementation_done');
        assert.ok(result.notes.some((note) => /not accepted/.test(note)));
      });
    } finally {
      h.cleanup();
    }
  });

  it('keeps a task open and blocked when a blocker is reported', { skip }, async () => {
    const h = harness('cycle');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'a.ts': 'export {};\n' } }]);
      await h.with(async (service) => {
        const brief = await service.context({ task: 'Migrate the ownership table' });
        const result = await service.complete({
          summary: 'Started the migration and could not finish it.',
          taskId: brief.taskId,
          filesChanged: ['a.ts'],
          blockers: ['The staging database is unreachable.'],
          followUp: ['Finish the migration once staging is back'],
        });

        assert.equal(result.taskStatus, 'blocked');
        const next = await service.context({ task: 'Migrate the ownership table' });
        assert.equal(next.taskId, brief.taskId, 'the blocked task is picked up again, not duplicated');
        assert.match(section(next.text, 'TASK'), /\[blocked\/P2\]/);
        assert.match(next.text, /Resolve the blocker before coding/);
      });
    } finally {
      h.cleanup();
    }
  });

  it('does not reuse a verified task for unrelated work', { skip }, async () => {
    const h = harness('cycle');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'a.ts': 'export {};\n' } }]);
      await h.with(async (service) => {
        const first = await service.context({ task: 'Fix the offer ownership check' });
        await service.complete({
          summary: 'Fixed and verified.',
          taskId: first.taskId,
          testsRun: [{ command: 'npm test', result: 'pass' }],
        });

        const second = await service.context({ task: 'Add CSV export to the billing screen' });
        assert.notEqual(second.taskId, first.taskId);
        assert.equal(second.brief.task.status, 'in_progress');
      });
    } finally {
      h.cleanup();
    }
  });
});
