/**
 * Durable-record lifecycle tests.
 *
 * Decisions and constraints are guidance, so replacing them must be explicit,
 * atomic and durable: the old record stays searchable and exportable, but it
 * stops steering work. These tests exercise supersession, replacement and
 * deactivation through the service, including error cases, conflicts and an
 * export/import round-trip that must preserve the links.
 */
import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { harness, hasSection, section, tempDir, writeFiles } from '../helpers/harness.ts';
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

function seed(dir: string, project = 'offer-service'): void {
  writeFiles(dir, {
    '.mcp/master-mcp.yaml': CONFIG.replace('offer-service', project),
    [OFFER_FILE]: 'export function isEligible() { return true; }\n',
  });
}

describe('decision and constraint lifecycle', () => {
  it('supersedes a decision without deleting its history', async () => {
    const h = harness('lifecycle');
    try {
      seed(h.dir);
      let firstId = '';
      let secondId = '';

      await h.with(async (service) => {
        await service.context({ task: 'Fix the offer eligibility predicate', affectedFiles: [OFFER_FILE] });

        const first = service.record({
          kind: 'decision',
          body: 'Eligibility is inferred from the UI ownership flag',
          rationale: 'The UI already knows which studio owns the offer.',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
        });
        firstId = first.id;

        const second = service.record({
          kind: 'decision',
          body: 'Eligibility comes from the offer record predicate',
          rationale: 'One server-side source of truth.',
          subsystem: 'industry-offer',
          files: [OFFER_FILE],
          supersedes: first.id,
        });
        secondId = second.id;
        assert.match(second.text, /Superseded decision dec_[a-z0-9]+/);

        const brief = await service.context({
          task: 'Fix the offer eligibility predicate',
          affectedFiles: [OFFER_FILE],
        });
        const history = section(brief.text, 'RELEVANT HISTORY');
        assert.ok(history.includes(secondId), 'the replacement is live guidance');
        assert.ok(!history.includes(firstId), 'the superseded decision is not live guidance');

        // History remains retrievable on purpose.
        const search = service.search({ query: 'UI ownership flag' });
        assert.ok(search.hits.some((hit) => hit.id === firstId));
      });

      // The lifecycle link survives a process restart.
      await h.with(async (service) => {
        const brief = await service.context({
          task: 'Fix the offer eligibility predicate',
          affectedFiles: [OFFER_FILE],
        });
        const history = section(brief.text, 'RELEVANT HISTORY');
        assert.ok(history.includes(secondId));
        assert.ok(!history.includes(firstId));

        const exported = service.exportProject({ format: 'json' });
        const old = exported.snapshot.decisions.find((decision) => decision.id === firstId);
        const next = exported.snapshot.decisions.find((decision) => decision.id === secondId);
        assert.equal(old?.status, 'superseded');
        assert.equal(old?.supersededBy, secondId);
        assert.equal(next?.status, 'active');
        assert.equal(next?.supersededBy, null);
      });
    } finally {
      h.cleanup();
    }
  });

  it('replaces and then deactivates a constraint', async () => {
    const h = harness('lifecycle');
    try {
      seed(h.dir);
      await h.with(async (service) => {
        await service.context({ task: 'Review the offer ownership rules', affectedFiles: [OFFER_FILE] });

        const oldRule = service.record({
          kind: 'constraint',
          body: 'Ownership is inferred in the UI',
          severity: 'high',
          subsystem: 'industry-offer',
        });
        const newRule = service.record({
          kind: 'constraint',
          body: 'Ownership comes from the offer record',
          severity: 'high',
          subsystem: 'industry-offer',
          replaces: oldRule.id,
        });
        assert.match(newRule.text, /Replaced constraint con_[a-z0-9]+/);

        const brief = await service.context({
          task: 'Review the offer ownership rules',
          affectedFiles: [OFFER_FILE],
        });
        const constraints = section(brief.text, 'CRITICAL CONSTRAINTS');
        assert.match(constraints, new RegExp(newRule.id));
        assert.ok(!constraints.includes(oldRule.id), 'the replaced rule is no longer preflight guidance');

        const deactivated = service.record({
          kind: 'constraint',
          body: 'The offer-record rule no longer applies after the migration',
          deactivate: newRule.id,
        });
        assert.match(deactivated.text, /Deactivated constraint con_[a-z0-9]+/);
        assert.match(deactivated.text, /Reason: The offer-record rule no longer applies/);

        const after = await service.context({
          task: 'Review the offer ownership rules',
          affectedFiles: [OFFER_FILE],
        });
        assert.ok(!hasSection(after.text, 'CRITICAL CONSTRAINTS'));
        assert.ok(!hasSection(after.text, 'CONSTRAINTS'));

        const exported = service.exportProject({ format: 'json' });
        const old = exported.snapshot.constraints.find((constraint) => constraint.id === oldRule.id);
        const next = exported.snapshot.constraints.find((constraint) => constraint.id === newRule.id);
        assert.equal(old?.active, false);
        assert.equal(old?.replacedBy, newRule.id);
        assert.equal(next?.active, false);
      });
    } finally {
      h.cleanup();
    }
  });

  it('rejects lifecycle references that are invalid or belong to another project', async () => {
    const h = harness('lifecycle');
    try {
      seed(h.dir);
      const otherDir = tempDir('lifecycle-other');
      seed(otherDir, 'other-service');
      let foreignDecision = '';
      let foreignConstraint = '';

      try {
        const other = h.open({ cwd: otherDir });
        try {
          await other.context({ task: 'Register the other project' });
          foreignDecision = other.record({ kind: 'decision', body: 'Other project rule' }).id;
          foreignConstraint = other.record({ kind: 'constraint', body: 'Other project constraint' }).id;
        } finally {
          other.close();
        }

        await h.with(async (service) => {
          await service.context({ task: 'Fix the offer eligibility predicate', affectedFiles: [OFFER_FILE] });

          assert.throws(
            () =>
              service.record({
                kind: 'decision',
                body: 'Attempted supersession across projects',
                supersedes: foreignDecision,
              }),
            /No decision .* exists in project "offer-service"/,
          );
          assert.throws(
            () =>
              service.record({
                kind: 'constraint',
                body: 'Attempted replacement across projects',
                replaces: foreignConstraint,
              }),
            /No constraint .* exists in project "offer-service"/,
          );

          assert.throws(
            () =>
              service.record({
                kind: 'decision',
                body: 'Unknown supersession target',
                supersedes: 'dec_doesnotexist',
              }),
            /No decision "dec_doesnotexist" exists/,
          );

          const decision = service.record({ kind: 'decision', body: 'Eligibility lives in the predicate' });
          assert.throws(
            () => service.record({ kind: 'decision', body: 'Wrong lifecycle field', replaces: decision.id }),
            /"replaces" and "deactivate" apply to constraints/,
          );
          const constraint = service.record({ kind: 'constraint', body: 'Never infer ownership in the UI' });
          assert.throws(
            () => service.record({ kind: 'constraint', body: 'Wrong lifecycle field', supersedes: constraint.id }),
            /"supersedes" applies to decisions/,
          );
          assert.throws(
            () =>
              service.record({
                kind: 'constraint',
                body: 'Ambiguous lifecycle request',
                replaces: constraint.id,
                deactivate: constraint.id,
              }),
            /"replaces" and "deactivate" are alternatives/,
          );

          const replacement = service.record({
            kind: 'decision',
            body: 'Eligibility comes from the offer record',
            supersedes: decision.id,
          });
          assert.throws(
            () =>
              service.record({
                kind: 'decision',
                body: 'Supersede the same record twice',
                supersedes: decision.id,
              }),
            /already superseded/,
          );
          assert.ok(replacement.id);
        });
      } finally {
        // The other project's directory is outside the harness root.
        rmSync(otherDir, { recursive: true, force: true });
      }
    } finally {
      h.cleanup();
    }
  });

  it('warns about contradictions between active records only', async () => {
    const h = harness('lifecycle');
    try {
      seed(h.dir);
      await h.with(async (service) => {
        await service.context({ task: 'Review ownership decisions in the industry-offer UI', affectedFiles: [OFFER_FILE] });

        const positive = service.record({
          kind: 'decision',
          body: 'Ownership is inferred in the UI',
          subsystem: 'industry-offer',
        });
        service.record({
          kind: 'decision',
          body: 'Ownership is never inferred in the UI',
          subsystem: 'industry-offer',
        });

        const brief = await service.context({
          task: 'Review ownership decisions in the industry-offer UI',
          affectedFiles: [OFFER_FILE],
        });
        assert.match(section(brief.text, 'WARNINGS'), /look contradictory/);

        // Superseding one side removes the live contradiction.
        service.record({
          kind: 'decision',
          body: 'Ownership comes from the offer record, not the UI',
          subsystem: 'industry-offer',
          supersedes: positive.id,
        });
        const resolved = await service.context({
          task: 'Review ownership decisions in the industry-offer UI',
          affectedFiles: [OFFER_FILE],
        });
        assert.ok(!/look contradictory/.test(section(resolved.text, 'WARNINGS')));
      });
    } finally {
      h.cleanup();
    }
  });

  it('preserves lifecycle links through export and import', async () => {
    const h = harness('lifecycle');
    try {
      seed(h.dir);
      let snapshot: ExportSnapshot;

      await h.with(async (service) => {
        await service.context({ task: 'Fix the offer eligibility predicate', affectedFiles: [OFFER_FILE] });
        const oldDecision = service.record({
          kind: 'decision',
          body: 'Eligibility is inferred from the UI ownership flag',
          subsystem: 'industry-offer',
        });
        const newDecision = service.record({
          kind: 'decision',
          body: 'Eligibility comes from the offer record predicate',
          subsystem: 'industry-offer',
          supersedes: oldDecision.id,
        });
        const oldConstraint = service.record({
          kind: 'constraint',
          body: 'Ownership is inferred in the UI',
          severity: 'high',
          subsystem: 'industry-offer',
        });
        const newConstraint = service.record({
          kind: 'constraint',
          body: 'Ownership comes from the offer record',
          severity: 'high',
          subsystem: 'industry-offer',
          replaces: oldConstraint.id,
        });
        snapshot = {
          oldDecision: oldDecision.id,
          newDecision: newDecision.id,
          oldConstraint: oldConstraint.id,
          newConstraint: newConstraint.id,
          project: service.exportProject({ format: 'json' }).snapshot,
        };
      });

      const restored = harness('lifecycle-restored');
      seed(restored.dir);
      try {
        await restored.with(async (service) => {
          service.importSnapshot(snapshot.project);

          // Context first so the imported project is attached to this working
          // copy; export then resolves it from the current directory.
          const brief = await service.context({
            task: 'Fix the offer eligibility predicate',
            affectedFiles: [OFFER_FILE],
          });
          assert.match(section(brief.text, 'RELEVANT HISTORY'), new RegExp(snapshot.newDecision));
          assert.ok(!section(brief.text, 'RELEVANT HISTORY').includes(snapshot.oldDecision));

          const exported = service.exportProject({ format: 'json' });
          const oldDecision = exported.snapshot.decisions.find((decision) => decision.id === snapshot.oldDecision);
          const oldConstraint = exported.snapshot.constraints.find((constraint) => constraint.id === snapshot.oldConstraint);
          assert.equal(oldDecision?.status, 'superseded');
          assert.equal(oldDecision?.supersededBy, snapshot.newDecision);
          assert.equal(oldConstraint?.active, false);
          assert.equal(oldConstraint?.replacedBy, snapshot.newConstraint);
        });
      } finally {
        restored.cleanup();
      }
    } finally {
      h.cleanup();
    }
  });
});

/**
 * Snapshot plus the ids the assertions need. The explicit shape keeps the
 * helper above readable without coupling to service internals.
 */
type ExportSnapshot = {
  oldDecision: string;
  newDecision: string;
  oldConstraint: string;
  newConstraint: string;
  project: ReturnType<import('../../src/app/service.ts').MasterMcpService['exportProject']>['snapshot'];
};
