/**
 * Export / import round-trip tests.
 *
 * The snapshot is the backup and migration path, so these tests exercise the
 * real files and both services: memory is exported from one database, imported
 * into another, re-exported, and the two snapshots must describe the same
 * project. Collisions between projects must be re-issued rather than silently
 * stealing records, and `replace` must clear prior memory before restoring.
 */
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateSnapshot, type ProjectSnapshot } from '../../src/domain/transfer.ts';
import { harness, tempDir, writeFiles } from '../helpers/harness.ts';

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

function seed(dir: string, project = 'concurrent-studios'): void {
  writeFiles(dir, {
    '.mcp/master-mcp.yaml': CONFIG.replace('concurrent-studios', project),
    [OFFER_FILE]: 'export function isEligible() { return true; }\n',
  });
}

/** Build a small but complete project: task, handoff, verification, findings, records. */
async function populate(service: import('../../src/app/service.ts').MasterMcpService): Promise<void> {
  const brief = await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
  assert.ok(brief.taskId);
  await service.complete({
    summary: 'Ownership now comes from the offer record instead of the UI state.',
    taskId: brief.taskId,
    filesChanged: [OFFER_FILE],
    testsRun: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
    discoveries: [
      {
        statement: 'isEligible decides ownership for every offer.',
        confidence: 'statically_supported',
        files: [OFFER_FILE],
      },
    ],
  });
  service.record({
    kind: 'decision',
    body: 'Eligibility lives in the offer predicate',
    rationale: 'One source of truth prevents UI drift.',
    subsystem: 'industry-offer',
    files: [OFFER_FILE],
  });
  service.record({
    kind: 'constraint',
    body: 'Never infer offer ownership from UI state',
    severity: 'critical',
    subsystem: 'industry-offer',
    files: [OFFER_FILE],
  });
  service.record({
    kind: 'bug',
    body: 'Offer list shows withdrawn offers as active',
    severity: 'medium',
    subsystem: 'industry-offer',
    files: [OFFER_FILE],
  });
}

/** Collections that must round-trip exactly (project is compared separately). */
const COLLECTIONS = [
  'repositories',
  'tasks',
  'decisions',
  'constraints',
  'bugs',
  'findings',
  'verifications',
  'handoffs',
] as const;

/**
 * Repository numeric ids are a local rowid, not a portable identity (the path
 * is unique and is what identifies a working copy), so they are compared
 * without it; every other collection round-trips exactly.
 */
function comparable(collection: (typeof COLLECTIONS)[number], rows: readonly unknown[]): unknown[] {
  if (collection !== 'repositories') return rows as unknown[];
  return rows.map((row) => {
    const copy = { ...(row as Record<string, unknown>) };
    delete copy['id'];
    return copy;
  });
}

describe('export / import', () => {
  it('exports complete Markdown and JSON that validates', async () => {
    const h = harness('transfer');
    try {
      seed(h.dir);
      await h.with(async (service) => {
        await populate(service);

        const markdown = service.exportProject({ format: 'markdown' });
        assert.equal(markdown.format, 'markdown');
        assert.match(markdown.text, /^# .+\(concurrent-studios\)/);
        for (const title of [
          'Repositories',
          'Constraints',
          'Decisions',
          'Known bugs',
          'Findings',
          'Tasks',
          'Verification history',
          'Handoffs',
        ]) {
          assert.ok(markdown.text.includes(`## ${title}`), `markdown export is missing ${title}`);
        }
        assert.match(markdown.text, /Fix the offer ownership check/);
        assert.match(markdown.text, /Eligibility lives in the offer predicate/);
        assert.match(markdown.text, /Offer list shows withdrawn offers as active/);

        const json = service.exportProject({ format: 'json' });
        assert.equal(json.format, 'json');
        const parsed = JSON.parse(json.text) as unknown;
        const validated = validateSnapshot(parsed);
        assert.ok(validated.ok);
        assert.deepEqual(validated.snapshot, json.snapshot);
        assert.equal(json.snapshot.exportedAt, '2026-03-01T09:00:00.000Z', 'exports use the service clock');
        assert.ok(json.text.endsWith('\n'));
        assert.equal(json.snapshot.tasks.length, 1);
        assert.equal(json.snapshot.handoffs.length, 1);
        assert.equal(json.snapshot.verifications.length, 1);

        assert.throws(
          () => service.exportProject({ format: 'xml' }),
          (error: unknown) => /Unknown export format "xml"/.test(String(error)),
        );
      });
    } finally {
      h.cleanup();
    }
  });

  it('restores a snapshot into a fresh database with full fidelity', async () => {
    const source = harness('transfer-src');
    const targetRoot = tempDir('transfer-target');
    const targetDb = join(targetRoot, 'memory.sqlite');
    try {
      seed(source.dir);
      let snapshot!: ProjectSnapshot;
      await source.with(async (service) => {
        await populate(service);
        snapshot = service.exportProject({ format: 'json' }).snapshot;
      });

      await source.with(
        async (service) => {
          const report = service.importSnapshot(snapshot);
          assert.equal(report.mode, 'merge');
          assert.equal(report.projectSlug, 'concurrent-studios');
          assert.deepEqual(report.remappedIds, [], 'a fresh database keeps every id');
          for (const collection of COLLECTIONS) {
            assert.equal(
              report.written[collection],
              snapshot[collection].length,
              `written.${collection} must match the snapshot`,
            );
          }

          // The memory is searchable again (the FTS index is rebuilt on import).
          const found = service.search({ query: 'ownership predicate' });
          assert.ok(found.hits.length >= 1, 'imported memory must be indexed');

          // And the next brief remembers the previous work.
          const brief = await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
          assert.match(brief.text, /previous work:/);
          assert.match(brief.text, /Ownership now comes from the offer record/);

          // Re-export: every collection must match the source exactly.
          const restored = service.exportProject({ project: 'concurrent-studios', format: 'json' }).snapshot;
          for (const collection of COLLECTIONS) {
            assert.deepEqual(
              comparable(collection, restored[collection]),
              comparable(collection, snapshot[collection]),
              `${collection} must round-trip exactly`,
            );
          }
          assert.equal(restored.project.id, snapshot.project.id);
          assert.equal(restored.project.createdAt, snapshot.project.createdAt);
          assert.equal(restored.project.goal, snapshot.project.goal);
          assert.equal(restored.project.phase, snapshot.project.phase);
        },
        { dbPath: targetDb },
      );
    } finally {
      source.cleanup();
    }
  });

  it('re-issues ids that collide with another project instead of stealing records', async () => {
    const source = harness('transfer-src');
    const targetRoot = tempDir('transfer-target');
    const targetDb = join(targetRoot, 'memory.sqlite');
    try {
      seed(source.dir);
      let alpha!: ProjectSnapshot;
      await source.with(async (service) => {
        await populate(service);
        alpha = service.exportProject({ format: 'json' }).snapshot;
      });
      const taskId = alpha.tasks[0]!.id;

      await source.with(
        async (service) => {
          service.importSnapshot(alpha);

          // A second project carrying the same task ids must not overwrite alpha.
          const beta: ProjectSnapshot = structuredClone(alpha);
          beta.project = { ...beta.project, id: 'prj_crafted_beta', slug: 'beta-project', name: 'Beta Project' };
          const betaReport = service.importSnapshot(beta);
          const taskRemap = betaReport.remappedIds.find((entry) => entry.kind === 'task' && entry.from === taskId);
          assert.ok(taskRemap, `expected a task remap, got ${JSON.stringify(betaReport.remappedIds)}`);
          const remappedTaskId = taskRemap.to;
          assert.notEqual(remappedTaskId, taskId);

          const restoredBeta = service.exportProject({ project: 'beta-project', format: 'json' }).snapshot;
          assert.equal(restoredBeta.tasks[0]?.id, remappedTaskId);
          assert.equal(
            restoredBeta.verifications[0]?.taskId,
            remappedTaskId,
            'references follow the remapped task id',
          );
          assert.equal(restoredBeta.handoffs[0]?.taskId, remappedTaskId);
          // Colliding record ids are re-issued as well, not overwritten.
          assert.ok(
            betaReport.remappedIds.some((entry) => entry.kind === 'verification'),
            'the verification id collision is reported',
          );
          assert.ok(
            betaReport.remappedIds.some((entry) => entry.kind === 'handoff'),
            'the handoff id collision is reported',
          );

          // Alpha keeps its original ids untouched.
          const restoredAlpha = service.exportProject({ project: 'concurrent-studios', format: 'json' }).snapshot;
          assert.equal(restoredAlpha.tasks[0]?.id, taskId);
          assert.equal(restoredAlpha.verifications.length, 1, 'alpha must not lose its verification to beta');
          assert.equal(restoredAlpha.verifications[0]?.taskId, taskId);
          assert.equal(restoredAlpha.verifications[0]?.id, alpha.verifications[0]?.id);
          assert.equal(restoredAlpha.handoffs.length, 1, 'alpha must not lose its handoff to beta');
          assert.equal(restoredAlpha.handoffs[0]?.id, alpha.handoffs[0]?.id);

          // A snapshot claiming the same slug under a different project id is
          // merged into the existing project, and the project remap is reported.
          const forged: ProjectSnapshot = structuredClone(alpha);
          forged.project = { ...forged.project, id: 'prj_forged' };
          const forgedReport = service.importSnapshot(forged);
          assert.ok(
            forgedReport.remappedIds.some((entry) => entry.kind === 'project' && entry.from === 'prj_forged'),
            'the project id collision is reported',
          );
          const projects = service.describe().projects;
          assert.equal(projects.filter((project) => project.slug === 'concurrent-studios').length, 1);
        },
        { dbPath: targetDb },
      );
    } finally {
      source.cleanup();
    }
  });

  it('replace mode clears prior memory before restoring', async () => {
    const source = harness('transfer-src');
    const targetRoot = tempDir('transfer-target');
    const targetDb = join(targetRoot, 'memory.sqlite');
    try {
      seed(source.dir);
      let snapshot!: ProjectSnapshot;
      await source.with(async (service) => {
        await populate(service);
        snapshot = service.exportProject({ format: 'json' }).snapshot;
      });

      await source.with(
        async (service) => {
          service.importSnapshot(snapshot);

          // Local work that is not in the backup.
          await service.context({ task: 'Extra local work that never got exported' });
          const withExtra = service.exportProject({ project: 'concurrent-studios', format: 'json' }).snapshot;
          assert.equal(withExtra.tasks.length, snapshot.tasks.length + 1);

          const report = service.importSnapshot(snapshot, { mode: 'replace' });
          assert.equal(report.mode, 'replace');
          const restored = service.exportProject({ project: 'concurrent-studios', format: 'json' }).snapshot;
          for (const collection of COLLECTIONS) {
            assert.deepEqual(
              comparable(collection, restored[collection]),
              comparable(collection, snapshot[collection]),
              `${collection} must be restored exactly`,
            );
          }
          assert.match(
            service.search({ query: 'Extra local work' }).text,
            /No stored memory matched/,
            'the FTS index must drop records removed by replace',
          );
        },
        { dbPath: targetDb },
      );
    } finally {
      source.cleanup();
    }
  });
});
