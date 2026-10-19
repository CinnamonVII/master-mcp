/**
 * Dedup behaviour through the service.
 *
 * Dedup is deliberately conservative: an exact restatement merges into the
 * existing record, a near miss is created with a note, and inactive history is
 * never reactivated by a fresh write. These tests drive the public tools, so
 * they cover the merge paths (evidence/files/commits) as agents experience them.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { harness, writeFiles } from '../helpers/harness.ts';

const CONFIG = [
  'project: offer-service',
  'goal: Ship the industry offer service',
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

describe('near-duplicate handling', () => {
  it('merges a repeated decision and keeps the union of its files', async () => {
    const h = harness('dedup');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Fix the offer eligibility predicate', affectedFiles: [OFFER_FILE] });
        const first = service.record({
          kind: 'decision',
          body: 'Eligibility lives in the offer predicate',
          rationale: 'One source of truth.',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });
        const second = service.record({
          kind: 'decision',
          body: 'Eligibility lives in the offer predicate',
          rationale: 'One source of truth.',
          subsystem: 'industry-offer',
          files: ['docs/ownership.md'],
        });
        assert.match(second.text, /already covers this/);
        assert.equal(second.id, first.id);

        const decisions = service.exportProject({ format: 'json' }).snapshot.decisions;
        assert.equal(decisions.length, 1);
        assert.deepEqual(decisions[0]?.files, [OFFER_FILE, 'docs/ownership.md']);
      });
    } finally {
      h.cleanup();
    }
  });

  it('merges a repeated constraint instead of duplicating the rule', async () => {
    const h = harness('dedup');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Review the offer ownership rules', affectedFiles: [OFFER_FILE] });
        const first = service.record({
          kind: 'constraint',
          body: 'Never infer offer ownership from UI state',
          severity: 'critical',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });
        const second = service.record({
          kind: 'constraint',
          body: 'Never infer offer ownership from UI state',
          severity: 'critical',
          subsystem: 'industry-offer',
          files: ['docs/ownership.md'],
        });
        assert.match(second.text, /already covers this/);
        assert.equal(second.id, first.id);

        const constraints = service.exportProject({ format: 'json' }).snapshot.constraints;
        assert.equal(constraints.length, 1);
        assert.deepEqual(constraints[0]?.files, [OFFER_FILE, 'docs/ownership.md']);
      });
    } finally {
      h.cleanup();
    }
  });

  it('merges a repeated bug report and keeps its evidence', async () => {
    const h = harness('dedup');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
        const first = service.record({
          kind: 'bug',
          body: 'Ownership check passes for unverified offers',
          severity: 'high',
          subsystem: 'industry-offer',
          observed: 'The offer is visible.',
          evidence: ['screenshot.png'],
          files: [OFFER_FILE],
        });
        const second = service.record({
          kind: 'bug',
          body: 'Ownership check passes for unverified offers',
          severity: 'high',
          subsystem: 'industry-offer',
          observed: 'The offer is visible.',
          evidence: ['trace.json'],
          files: ['src/industry/offer-list.ts'],
        });
        assert.match(second.text, /already matches this report/);
        assert.equal(second.id, first.id);

        const bugs = service.exportProject({ format: 'json' }).snapshot.bugs;
        assert.equal(bugs.length, 1);
        assert.deepEqual(bugs[0]?.evidence, ['screenshot.png', 'trace.json']);
        assert.equal(bugs[0]?.status, 'open', 'a duplicate report never changes lifecycle state');
      });
    } finally {
      h.cleanup();
    }
  });

  it('creates a similar-but-distinct record with an explicit note', async () => {
    const h = harness('dedup');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Fix the offer eligibility predicate', affectedFiles: [OFFER_FILE] });
        const first = service.record({
          kind: 'decision',
          body: 'Eligibility lives in the offer predicate',
          subsystem: 'industry-offer',
        });
        const second = service.record({
          kind: 'decision',
          body: 'Eligibility is decided by the offer predicate in the backend service layer',
          subsystem: 'industry-offer',
        });
        assert.notEqual(second.id, first.id);
        assert.match(second.text, /similar to dec_[a-z0-9]+/);
        assert.match(second.text, /created separately/);

        const decisions = service.exportProject({ format: 'json' }).snapshot.decisions;
        assert.equal(decisions.length, 2);
      });
    } finally {
      h.cleanup();
    }
  });

  it('never reactivates a superseded decision through dedup', async () => {
    const h = harness('dedup');
    try {
      seed(h);
      await h.with(async (service) => {
        await service.context({ task: 'Fix the offer eligibility predicate', affectedFiles: [OFFER_FILE] });
        const old = service.record({
          kind: 'decision',
          body: 'Eligibility is inferred from the UI ownership flag',
          subsystem: 'industry-offer',
        });
        service.record({
          kind: 'decision',
          body: 'Eligibility comes from the offer record predicate',
          subsystem: 'industry-offer',
          supersedes: old.id,
        });

        const revived = service.record({
          kind: 'decision',
          body: 'Eligibility is inferred from the UI ownership flag',
          subsystem: 'industry-offer',
        });
        assert.notEqual(revived.id, old.id, 'a new record was created instead of editing history');
        assert.match(revived.text, /superseded or inactive/);

        const decisions = service.exportProject({ format: 'json' }).snapshot.decisions;
        const oldRecord = decisions.find((decision) => decision.id === old.id);
        assert.equal(oldRecord?.status, 'superseded');
        assert.equal(decisions.length, 3);
      });
    } finally {
      h.cleanup();
    }
  });

  it('merges discoveries without downgrading their confidence', async () => {
    const h = harness('dedup');
    try {
      seed(h);
      await h.with(async (service) => {
        const context = await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
        await service.complete({
          summary: 'Confirmed where eligibility is decided.',
          taskId: context.taskId,
          discoveries: [
            {
              statement: 'isEligible decides ownership for every offer.',
              confidence: 'runtime_confirmed',
              evidence: ['observed in the offer debugger'],
              files: [OFFER_FILE],
            },
          ],
        });

        const second = await service.complete({
          summary: 'Re-ran the investigation and saw the same code path.',
          taskId: context.taskId,
          discoveries: [
            {
              statement: 'isEligible decides ownership for every offer.',
              confidence: 'suspected',
              files: ['src/industry/offer-list.ts'],
            },
          ],
        });
        assert.ok(second.notes.some((note) => /already existed; merged evidence/.test(note)));

        const findings = service.exportProject({ format: 'json' }).snapshot.findings;
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.confidence, 'runtime_confirmed', 'merging never downgrades confidence');
        assert.deepEqual(findings[0]?.files, [OFFER_FILE, 'src/industry/offer-list.ts']);
      });
    } finally {
      h.cleanup();
    }
  });

  it('does not duplicate a follow-up task', async () => {
    const h = harness('dedup');
    try {
      seed(h);
      await h.with(async (service) => {
        const context = await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
        const first = await service.complete({
          summary: 'Fixed the ownership check.',
          taskId: context.taskId,
          followUp: [{ title: 'Add a regression test for the ownership check', priority: 'P2' }],
        });
        assert.equal(first.recorded.followUps.length, 1);

        const second = await service.complete({
          summary: 'Re-verified and repeated the hand-off from the previous pass.',
          taskId: context.taskId,
          followUp: [{ title: 'Add a regression test for the ownership check', priority: 'P2' }],
        });
        assert.equal(second.recorded.followUps.length, 0);
        assert.ok(second.notes.some((note) => /not duplicated/.test(note)));

        const tasks = service.exportProject({ format: 'json' }).snapshot.tasks;
        assert.equal(
          tasks.filter((task) => task.title === 'Add a regression test for the ownership check').length,
          1,
        );
      });
    } finally {
      h.cleanup();
    }
  });
});
