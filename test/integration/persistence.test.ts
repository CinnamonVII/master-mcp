/**
 * Persistence and migration tests.
 *
 * Durable memory is the whole point of a project brain, so these tests close
 * the process boundary for real: one service writes, the service is closed and
 * a new instance opens the same file, and the memory must be intact, the
 * schema must be at the latest version, and no migration may run twice.
 */
import { strict as assert } from 'node:assert';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LATEST_VERSION, MIGRATIONS } from '../../src/store/migrations.ts';
import { section, harness, hasSection, writeFiles } from '../helpers/harness.ts';

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

describe('persistence', () => {
  it('keeps project memory intact across a service restart', async () => {
    const h = harness('persistence');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG, [OFFER_FILE]: 'export function isEligible() { return true; }\n' });

      let taskId: string | null = null;
      let before: unknown;

      await h.with(async (service) => {
        const brief = await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
        taskId = brief.taskId;
        assert.ok(taskId);

        const done = await service.complete({
          summary: 'Ownership now comes from the offer record instead of the UI state.',
          taskId,
          filesChanged: [OFFER_FILE],
          testsRun: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
          discoveries: [
            { statement: 'isEligible decides ownership for every offer.', confidence: 'statically_supported', files: [OFFER_FILE] },
          ],
          followUp: [{ title: 'Add a regression test for the inverted case', priority: 'P2' }],
        });
        assert.equal(done.taskStatus, 'verified_done');

        const described = service.describe();
        assert.equal(described.schemaVersion, LATEST_VERSION);
        before = JSON.parse(JSON.stringify(described.projects));
        assert.equal(described.projects.length, 1);
        assert.ok(described.projects[0]!.memoryRecords >= 4, 'task, handoff, verification and finding are indexed');
      });

      // --- restart: a fresh instance on the same file -----------------------
      await h.with(async (service) => {
        const described = service.describe();
        assert.deepEqual(described.projects, before, 'projects and memory counts survive restart');

        const reopened = await service.context({ task: 'Fix the offer ownership check', affectedFiles: [OFFER_FILE] });
        assert.ok(reopened.taskId, 'the task is still discoverable');
        const history = section(reopened.text, 'RELEVANT HISTORY');
        assert.match(history, /previous work:/);
        assert.match(history, /Ownership now comes from the offer record/);
        assert.match(history, /verification history:/);
        assert.match(history, /npm test → pass/);
        assert.match(history, /findings/);
        assert.match(history, /isEligible decides ownership/);
        assert.ok(hasSection(reopened.text, 'OPEN FOLLOW-UPS'));
        assert.match(section(reopened.text, 'OPEN FOLLOW-UPS'), /Add a regression test for the inverted case/);

        const status = await service.status({});
        assert.ok(status.report.registered);
        assert.ok((status.report.memoryCounts['task'] ?? 0) >= 1);
      });
    } finally {
      h.cleanup();
    }
  });

  it('creates missing database directories and migrates a fresh file', async () => {
    const h = harness('persistence');
    const nested = join(h.dir, 'state', 'deep', 'memory.sqlite');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG });
      assert.ok(!existsSync(nested));

      await h.with(
        async (service) => {
          assert.equal(service.describe().schemaVersion, LATEST_VERSION);
          assert.equal(service.describe().databasePath, nested);
        },
        { dbPath: nested },
      );
      assert.ok(existsSync(nested), 'the database file (and its directories) are created on demand');

      // A pre-existing empty file is migrated rather than rejected.
      const empty = join(h.dir, 'state', 'empty.sqlite');
      writeFileSync(empty, '');
      await h.with(
        async (service) => {
          assert.equal(service.describe().schemaVersion, LATEST_VERSION);
          await service.context({ task: 'Fix the offer ownership check' });
        },
        { dbPath: empty },
      );
    } finally {
      h.cleanup();
    }
  });

  it('applies each migration exactly once across repeated opens', async () => {
    const h = harness('persistence');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG });

      await h.with(async (service) => {
        assert.equal(service.describe().schemaVersion, LATEST_VERSION);
      });

      await h.with(async (service) => {
        // The service exposes only the schema version, so count rows through a
        // second raw handle on the same file.
        assert.equal(service.describe().schemaVersion, LATEST_VERSION);
        const { DatabaseSync } = await import('node:sqlite');
        const raw = new DatabaseSync(h.dbPath, { readOnly: true });
        try {
          const recorded = raw.prepare('SELECT version FROM migrations ORDER BY version').all() as Array<{ version: number }>;
          assert.deepEqual(
            recorded.map((row) => Number(row.version)),
            MIGRATIONS.map((migration) => migration.version),
            'exactly one row per known migration',
          );
        } finally {
          raw.close();
        }
      });
    } finally {
      h.cleanup();
    }
  });
});
