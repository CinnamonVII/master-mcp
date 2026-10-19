/**
 * `mode=read_only` tests.
 *
 * Read-only mode exists for triage from a repository the agent must not touch:
 * it still renders a full brief, but it must not create a project, a task, an
 * activity row or a repository observation. These tests compare the database
 * row counts before and after a read-only call, so a future write cannot sneak
 * in unnoticed.
 */
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
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

/** Logical row counts plus the timestamps a context call would normally touch. */
function snapshotDatabase(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path);
  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const counts: Record<string, unknown> = {};
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      counts[table] = row.n;
    }
    counts['project:updated'] = db
      .prepare('SELECT id, updated_at, last_accessed_at FROM projects ORDER BY id')
      .all();
    counts['repository:seen'] = db
      .prepare('SELECT id, last_seen_at, last_head, last_branch FROM repositories ORDER BY id')
      .all();
    return counts;
  } finally {
    db.close();
  }
}

describe('mode=read_only', () => {
  it('renders a brief without writing any memory', async () => {
    const h = harness('read-only');
    try {
      writeFiles(h.dir, {
        '.mcp/master-mcp.yaml': CONFIG,
        [OFFER_FILE]: 'export function isEligible() { return true; }\n',
      });

      await h.with(async (service) => {
        const writable = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
        });
        assert.ok(writable.taskId);

        const before = snapshotDatabase(h.dbPath);
        const readOnly = await service.context({
          task: 'Triage the offer ownership check without changing memory',
          affectedFiles: [OFFER_FILE],
          mode: 'read_only',
        });
        const after = snapshotDatabase(h.dbPath);

        assert.deepEqual(after, before, 'read_only must not add or update a single row');
        assert.equal(readOnly.taskId, null, 'no task is created for a new read-only request');
        assert.match(readOnly.text, /TASK/);
        assert.match(readOnly.text, /NEXT ACTION/);

        // A read-only pass over an existing task still resolves it for context.
        const existing = await service.context({
          task: 'Fix the offer ownership check',
          affectedFiles: [OFFER_FILE],
          mode: 'read_only',
        });
        assert.equal(existing.taskId, writable.taskId);
        assert.deepEqual(snapshotDatabase(h.dbPath), before);
      });
    } finally {
      h.cleanup();
    }
  });

  it('refuses to register an unknown project in read-only mode', async () => {
    const h = harness('read-only');
    try {
      writeFiles(h.dir, {
        '.mcp/master-mcp.yaml': CONFIG,
        [OFFER_FILE]: 'export function isEligible() { return true; }\n',
      });

      await h.with(async (service) => {
        await assert.rejects(
          () => service.context({ task: 'Look around without registering', mode: 'read_only' }),
          (error: Error & { code?: string }) => {
            assert.equal(error.code, 'NOT_FOUND');
            assert.match(error.message, /not registered/);
            return true;
          },
        );
        const db = new DatabaseSync(h.dbPath, { readOnly: true });
        try {
          const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
          const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
          const activity = db.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number };
          assert.equal(projects.n, 0);
          assert.equal(tasks.n, 0);
          assert.equal(activity.n, 0);
        } finally {
          db.close();
        }
      });
    } finally {
      h.cleanup();
    }
  });
});
