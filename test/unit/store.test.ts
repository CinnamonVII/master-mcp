/**
 * Storage layer tests.
 *
 * These exercise the SQLite layer directly — no service, no git — because that
 * is where durability bugs hide. Every test gets its own temporary database
 * file and fixed clock, so none of it can read or write the developer's real
 * master-mcp database, and assertions never depend on wall-clock timing.
 */
import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { LATEST_VERSION, MIGRATIONS, type Migration } from '../../src/store/migrations.ts';
import { migrate, openDatabase, resolveDatabasePath, schemaVersion } from '../../src/store/db.ts';
import { Store } from '../../src/store/store.ts';
import { fixedClock } from '../../src/util/time.ts';
import { tempDir } from '../helpers/harness.ts';

const NOW = '2026-03-01T09:00:00.000Z';
const LATER = '2026-03-01T10:00:00.000Z';

interface Fixture {
  store: Store;
  path: string;
  cleanup(): void;
}

function openFixture(): Fixture {
  const dir = tempDir('master-mcp-store');
  const path = join(dir, 'memory.sqlite');
  const store = new Store(openDatabase({ path, clock: fixedClock(NOW) }));
  return {
    store,
    path,
    cleanup: () => {
      try {
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function makeProject(store: Store, slug = 'concurrent-studios'): string {
  return store.createProject({
    slug,
    name: slug.replace(/-/g, ' '),
    goal: 'Ship the offer system',
    now: NOW,
  }).id;
}

// ---------------------------------------------------------------------------
// Projects and repositories
// ---------------------------------------------------------------------------

describe('projects and repositories', () => {
  it('round-trips a project and finds it by slug, case-insensitively', () => {
    const f = openFixture();
    try {
      const project = f.store.createProject({
        slug: 'concurrent-studios',
        name: 'Concurrent Studios',
        description: 'A game studio.',
        goal: 'Ship the offer system',
        phase: 'implementation',
        now: NOW,
      });

      assert.match(project.id, /^prj_[a-z0-9]+$/);
      assert.deepEqual(f.store.getProject(project.id), project);
      assert.equal(project.lastAccessedAt, NOW);
      assert.equal(f.store.getProjectBySlug('CONCURRENT-STUDIOS')?.id, project.id);
      assert.deepEqual(f.store.listProjects().map((p) => p.slug), ['concurrent-studios']);
      assert.equal(f.store.getProject('prj_missing'), null);
    } finally {
      f.cleanup();
    }
  });

  it('updates only the fields provided and tracks access', () => {
    const f = openFixture();
    try {
      const id = makeProject(f.store);
      const updated = f.store.updateProject(id, { goal: 'Ship billing', phase: 'polish', now: LATER });
      assert.equal(updated.goal, 'Ship billing');
      assert.equal(updated.phase, 'polish');
      assert.equal(updated.name, 'concurrent studios', 'untouched fields must survive the patch');
      assert.equal(updated.updatedAt, LATER);

      f.store.touchProject(id, LATER);
      assert.equal(f.store.getProject(id)?.lastAccessedAt, LATER);
    } finally {
      f.cleanup();
    }
  });

  it('upserts a repository once and resolves subdirectories to it', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const repoPath = join(tempDir('master-mcp-repo'), 'checkout');
      try {
        const first = f.store.upsertRepository({
          projectId,
          path: repoPath,
          name: 'checkout',
          remoteUrl: 'github.com/acme/checkout',
          isPrimary: true,
          now: NOW,
        });
        const second = f.store.upsertRepository({
          projectId,
          path: repoPath,
          name: 'checkout-renamed',
          remoteUrl: 'github.com/acme/checkout',
          now: LATER,
        });

        assert.equal(second.id, first.id, 'the same path must not create a second row');
        assert.equal(second.name, 'checkout-renamed');
        assert.equal(second.lastSeenAt, LATER);
        assert.equal(second.isPrimary, true, 'isPrimary survives an upsert that does not mention it');
        assert.equal(f.store.listRepositories(projectId).length, 1);

        assert.equal(f.store.getRepositoryByPath(repoPath)?.id, first.id);
        assert.equal(f.store.findRepositoryForPath(join(repoPath, 'src', 'industry'))?.id, first.id);
        assert.equal(f.store.findRepositoryForPath('/somewhere/else'), null);
      } finally {
        rmSync(join(repoPath, '..'), { recursive: true, force: true });
      }
    } finally {
      f.cleanup();
    }
  });

  it('records repository observations', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const repository = f.store.upsertRepository({ projectId, path: '/repos/app', name: 'app', now: NOW });
      const head = 'a'.repeat(40);
      f.store.recordRepositoryObservation(repository.id, {
        branch: 'fix/ownership',
        head,
        dirty: true,
        remoteUrl: 'github.com/acme/app',
        seenAt: LATER,
      });

      const observed = f.store.getRepository(repository.id)!;
      assert.equal(observed.lastBranch, 'fix/ownership');
      assert.equal(observed.lastHead, head);
      assert.equal(observed.lastHeadAt, LATER);
      assert.equal(observed.lastDirty, true);
      assert.equal(observed.lastSeenAt, LATER);
      assert.equal(observed.remoteUrl, 'github.com/acme/app');
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('tasks', () => {
  it('creates tasks with documented defaults', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const task = f.store.createTask({ projectId, title: 'Fix the offer ownership check', now: NOW });

      assert.match(task.id, /^tsk_[a-z0-9]+$/);
      assert.equal(task.priority, 'P2');
      assert.equal(task.status, 'todo');
      assert.equal(task.verificationStatus, 'none');
      assert.deepEqual(task.affectedFiles, []);
      assert.deepEqual(task.blockers, []);
      assert.equal(task.createdAt, NOW);
      assert.equal(task.updatedAt, NOW);
    } finally {
      f.cleanup();
    }
  });

  it('finds a task by exact title and lists by priority', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      f.store.createTask({ projectId, title: 'Polish the billing screen', priority: 'P3', now: '2026-03-01T07:00:00.000Z' });
      f.store.createTask({ projectId, title: 'Fix the offer ownership check', priority: 'P1', now: '2026-03-01T08:00:00.000Z' });
      f.store.createTask({ projectId, title: 'Ship the offer list', priority: 'P1', now: '2026-03-01T09:00:00.000Z' });
      f.store.createTask({ projectId, title: 'Cancelled idea', priority: 'P0', status: 'cancelled', now: NOW });

      assert.equal(f.store.findTaskByTitle(projectId, 'fix the offer ownership check')?.priority, 'P1');
      assert.equal(f.store.findTaskByTitle(projectId, 'nothing like this'), null);

      const all = f.store.listTasks(projectId);
      assert.deepEqual(
        all.map((task) => task.title),
        ['Cancelled idea', 'Ship the offer list', 'Fix the offer ownership check', 'Polish the billing screen'],
        'P0 first, then P1 newest-first, then P3',
      );
      const open = f.store.listTasks(projectId, { statuses: ['todo', 'in_progress'] });
      assert.ok(open.every((task) => task.status !== 'cancelled'));
      assert.equal(f.store.listTasks(projectId, { limit: 2 }).length, 2);
    } finally {
      f.cleanup();
    }
  });

  it('patches only the fields provided', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const task = f.store.createTask({ projectId, title: 'Fix it', subsystem: 'industry-offer', now: NOW });

      const patched = f.store.updateTask(task.id, {
        status: 'in_progress',
        affectedFiles: ['src/industry/offer.ts'],
        blockers: ['Waiting on the staging database.'],
        verificationStatus: 'partial',
        now: LATER,
      });

      assert.equal(patched.title, 'Fix it');
      assert.equal(patched.subsystem, 'industry-offer');
      assert.equal(patched.status, 'in_progress');
      assert.deepEqual(patched.affectedFiles, ['src/industry/offer.ts']);
      assert.deepEqual(patched.blockers, ['Waiting on the staging database.']);
      assert.equal(patched.verificationStatus, 'partial');
      assert.equal(patched.updatedAt, LATER);

      const completed = f.store.updateTask(task.id, { status: 'verified_done', completedAt: LATER, now: LATER });
      assert.equal(completed.completedAt, LATER);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Decisions, constraints, bugs, findings
// ---------------------------------------------------------------------------

describe('decisions, constraints, bugs and findings', () => {
  it('round-trips decisions and can supersede them', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const decision = f.store.createDecision({
        projectId,
        statement: 'Eligibility lives in the offer predicate',
        rationale: 'One source of truth prevents UI drift.',
        subsystem: 'industry-offer',
        alternatives: ['Check the UI state', 'Duplicate the rule'],
        files: ['src/industry/offer.ts'],
        commits: ['abc1234'],
        now: NOW,
      });

      assert.deepEqual(f.store.getDecision(decision.id), decision);
      assert.deepEqual(f.store.listDecisions(projectId).map((d) => d.id), [decision.id]);

      const replacement = f.store.createDecision({ projectId, statement: 'Newer rule', now: LATER });
      const superseded = f.store.supersedeDecision(decision.id, replacement.id, LATER)!;
      assert.equal(superseded.status, 'superseded');
      assert.equal(superseded.supersededBy, replacement.id);
      assert.deepEqual(f.store.listDecisions(projectId, { activeOnly: true }).map((d) => d.id), [replacement.id]);
    } finally {
      f.cleanup();
    }
  });

  it('round-trips constraints and can deactivate them', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const constraint = f.store.createConstraint({
        projectId,
        statement: 'Never infer ownership from UI state',
        subsystem: 'industry-offer',
        severity: 'critical',
        now: NOW,
      });

      assert.equal(constraint.active, true);
      assert.equal(constraint.severity, 'critical');
      assert.deepEqual(f.store.getConstraint(constraint.id), constraint);

      const deactivated = f.store.deactivateConstraint(constraint.id, LATER)!;
      assert.equal(deactivated.active, false);
      assert.equal(deactivated.updatedAt, LATER);
      assert.deepEqual(f.store.listConstraints(projectId), [], 'activeOnly is the default');
      assert.equal(f.store.listConstraints(projectId, { activeOnly: false }).length, 1);
    } finally {
      f.cleanup();
    }
  });

  it('round-trips bugs and applies patches', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const bug = f.store.createBug({
        projectId,
        title: 'Ownership check passes for unverified offers',
        severity: 'high',
        subsystem: 'industry-offer',
        reproduction: 'Open the offer list as an unverified user.',
        expected: 'The offer is hidden.',
        observed: 'The offer is visible.',
        evidence: ['screenshot.png'],
        files: ['src/industry/offer.ts'],
        now: NOW,
      });

      assert.equal(bug.status, 'open');
      assert.equal(bug.severity, 'high');
      assert.equal(f.store.findBugByTitle(projectId, 'OWNERSHIP CHECK PASSES FOR UNVERIFIED OFFERS')?.id, bug.id);

      const resolved = f.store.updateBug(bug.id, {
        status: 'fix_claimed',
        resolvedAt: LATER,
        now: LATER,
      })!;
      assert.equal(resolved.status, 'fix_claimed');
      assert.equal(resolved.resolvedAt, LATER);
      assert.equal(resolved.title, bug.title);
      assert.deepEqual(f.store.listBugs(projectId, { openOnly: true }).map((b) => b.id), [bug.id]);

      f.store.updateBug(bug.id, { status: 'fixed_verified', now: LATER })!;
      assert.deepEqual(f.store.listBugs(projectId, { openOnly: true }), []);
      assert.equal(f.store.listBugs(projectId, { severities: ['high'] }).length, 1);
      assert.deepEqual(f.store.listBugs(projectId, { severities: ['low'] }), []);
    } finally {
      f.cleanup();
    }
  });

  it('round-trips findings and filters by confidence floor', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      f.store.createFinding({
        projectId,
        statement: 'The UI caches ownership client-side.',
        confidence: 'suspected',
        evidence: [],
        now: NOW,
      });
      const established = f.store.createFinding({
        projectId,
        statement: 'isEligible decides ownership for every offer.',
        confidence: 'statically_supported',
        symbols: ['isEligible'],
        files: ['src/industry/offer.ts'],
        now: LATER,
      });

      assert.deepEqual(established.evidence, []);
      assert.deepEqual(f.store.getFinding(established.id)?.symbols, ['isEligible']);
      assert.equal(f.store.listFindings(projectId).length, 2);
      assert.deepEqual(
        f.store.listFindings(projectId, { minConfidence: 'statically_supported' }).map((finding) => finding.id),
        [established.id],
      );
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Verifications and handoffs
// ---------------------------------------------------------------------------

describe('verifications and handoffs', () => {
  it('lists verifications by task and finds the latest handoff', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const first = f.store.createTask({ projectId, title: 'First task', now: NOW });
      const second = f.store.createTask({ projectId, title: 'Second task', now: NOW });

      f.store.createVerification({
        projectId,
        taskId: first.id,
        method: 'command',
        command: 'npm test',
        result: 'pass',
        evidence: ['24 passing'],
        now: NOW,
      });
      f.store.createVerification({ projectId, taskId: second.id, method: 'manual', result: 'unknown', now: NOW });

      assert.equal(f.store.listVerifications(projectId, { taskId: first.id }).length, 1);
      assert.equal(f.store.listVerifications(projectId).length, 2);

      f.store.createHandoff({ projectId, taskId: first.id, summary: 'First pass', head: 'a'.repeat(40), now: NOW });
      f.store.createHandoff({
        projectId,
        taskId: first.id,
        summary: 'Second pass',
        followUp: ['Add the regression test'],
        now: LATER,
      });

      const latest = f.store.latestHandoff(projectId)!;
      assert.equal(latest.summary, 'Second pass');
      assert.deepEqual(latest.followUp, ['Add the regression test']);
      assert.equal(f.store.listHandoffs(projectId, { limit: 1 }).length, 1);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Full-text index
// ---------------------------------------------------------------------------

describe('full-text index', () => {
  it('finds records by keyword and stays in step with updates and removals', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const bug = f.store.createBug({
        projectId,
        title: 'Ownership check passes for unverified offers',
        subsystem: 'industry-offer',
        now: NOW,
      });

      const found = f.store.searchMemory({ query: 'unverified ownership', projectId });
      assert.deepEqual(found.map((hit) => hit.id), [bug.id]);
      assert.equal(found[0]?.kind, 'bug');
      assert.equal(found[0]?.score, 1, 'the best hit is normalised to 1');

      f.store.updateBug(bug.id, { title: 'CSV export crashes on empty billing data', now: LATER });
      assert.deepEqual(f.store.searchMemory({ query: 'unverified ownership', projectId }), []);
      assert.deepEqual(
        f.store.searchMemory({ query: 'crashes billing', projectId }).map((hit) => hit.id),
        [bug.id],
      );

      f.store.removeFromIndex('bug', bug.id);
      assert.deepEqual(f.store.searchMemory({ query: 'crashes billing', projectId }), []);

      f.store.updateBug(bug.id, { severity: 'low', now: LATER });
      assert.equal(f.store.searchMemory({ query: 'crashes billing', projectId }).length, 1, 'a patch reindexes');
    } finally {
      f.cleanup();
    }
  });

  it('filters by kind, limit, and project', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      const otherProjectId = makeProject(f.store, 'other-project');

      const bug = f.store.createBug({ projectId, title: 'CSV export crashes', subsystem: 'billing', now: NOW });
      const decision = f.store.createDecision({
        projectId,
        statement: 'Standardise CSV export naming',
        subsystem: 'billing',
        now: NOW,
      });
      const otherBug = f.store.createBug({ projectId: otherProjectId, title: 'CSV export crashes elsewhere', now: NOW });

      const hits = f.store.searchMemory({ query: 'CSV export', projectId });
      assert.deepEqual(new Set(hits.map((hit) => hit.id)), new Set([bug.id, decision.id]));

      const bugOnly = f.store.searchMemory({ query: 'CSV export', projectId, kinds: ['bug'] });
      assert.deepEqual(bugOnly.map((hit) => hit.id), [bug.id]);
      assert.equal(f.store.searchMemory({ query: 'CSV export', projectId, limit: 1 }).length, 1);

      const scoped = f.store.searchMemory({ query: 'CSV export', projectId: otherProjectId });
      assert.deepEqual(scoped.map((hit) => hit.id), [otherBug.id]);
    } finally {
      f.cleanup();
    }
  });

  it('returns nothing for an empty query and tolerates wildcard characters', () => {
    const f = openFixture();
    try {
      const projectId = makeProject(f.store);
      f.store.createBug({ projectId, title: 'Ownership regression', now: NOW });

      assert.deepEqual(f.store.searchMemory({ query: 'the and of to' }), []);
      assert.deepEqual(f.store.searchMemory({ query: '!!!' }), []);
      // FTS syntax characters in user input must not become syntax errors.
      const hits = f.store.searchMemory({ query: 'ownership "quoted" (regression) OR NOT*' });
      assert.deepEqual(hits.map((hit) => hit.kind), ['bug']);
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Database path resolution
// ---------------------------------------------------------------------------

describe('resolveDatabasePath', () => {
  it('prefers MASTER_MCP_DB and resolves relative paths', () => {
    assert.equal(resolveDatabasePath({ MASTER_MCP_DB: '/tmp/one/memory.db' }), '/tmp/one/memory.db');
    assert.equal(resolveDatabasePath({ MASTER_MCP_DB: 'relative/memory.db' }), resolve(process.cwd(), 'relative/memory.db'));
    assert.equal(resolveDatabasePath({ MASTER_MCP_DB: ':memory:' }), ':memory:');
  });

  it('honours MASTER_MCP_HOME and XDG_DATA_HOME', () => {
    assert.equal(resolveDatabasePath({ MASTER_MCP_HOME: '/tmp/home' }), '/tmp/home/master-mcp.db');
    assert.equal(resolveDatabasePath({ XDG_DATA_HOME: '/tmp/xdg' }), '/tmp/xdg/master-mcp/master-mcp.db');
    assert.equal(
      resolveDatabasePath({ MASTER_MCP_DB: '/tmp/one/memory.db', XDG_DATA_HOME: '/tmp/xdg' }),
      '/tmp/one/memory.db',
      'MASTER_MCP_DB wins over every default',
    );
  });

  it('falls back to the platform data directory', () => {
    assert.equal(resolveDatabasePath({}), join(homedir(), '.local', 'share', 'master-mcp', 'master-mcp.db'));
  });
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe('migrations', () => {
  it('initialises a fresh file at the latest version and is a no-op on reopen', () => {
    const dir = tempDir('master-mcp-migrate');
    const path = join(dir, 'memory.sqlite');
    try {
      const db = openDatabase({ path, clock: fixedClock(NOW) });
      assert.equal(schemaVersion(db), LATEST_VERSION);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      for (const table of ['projects', 'repositories', 'tasks', 'bugs', 'memory_fts', 'migrations']) {
        assert.ok(tables.includes(table), `expected table ${table}`);
      }
      assert.deepEqual(migrate(db, fixedClock(NOW)).applied, [], 'already-applied versions are skipped');
      db.close();

      const reopened = openDatabase({ path, clock: fixedClock(LATER) });
      assert.equal(schemaVersion(reopened), LATEST_VERSION);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies new migrations incrementally and records metadata', () => {
    const dir = tempDir('master-mcp-migrate');
    const path = join(dir, 'memory.sqlite');
    const extra: Migration = {
      version: LATEST_VERSION + 1,
      name: 'test-extra',
      up: (db) => db.exec('CREATE TABLE test_extra (id INTEGER PRIMARY KEY)'),
    };
    try {
      const db = openDatabase({ path, clock: fixedClock(NOW) });

      const upgrade = migrate(db, fixedClock(LATER), [...MIGRATIONS, extra]);
      assert.deepEqual(upgrade.applied, [LATEST_VERSION + 1]);
      assert.equal(upgrade.version, LATEST_VERSION + 1);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'test_extra'").get());
      assert.deepEqual(migrate(db, fixedClock(LATER), [...MIGRATIONS, extra]).applied, []);

      const row = db.prepare('SELECT name, applied_at FROM migrations WHERE version = ?').get(LATEST_VERSION + 1) as {
        name: string;
        applied_at: string;
      };
      assert.equal(row.name, 'test-extra');
      assert.equal(row.applied_at, LATER, 'the injected clock determines recorded time');
      db.close();

      // A database ahead of the code's known versions is left alone: the real
      // migration list applies nothing and the extra table survives.
      const fresh = openDatabase({ path, clock: fixedClock(NOW) });
      assert.equal(schemaVersion(fresh), LATEST_VERSION + 1);
      assert.deepEqual(migrate(fresh).applied, []);
      assert.ok(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'test_extra'").get());
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies out-of-order migration definitions in version order', () => {
    const dir = tempDir('master-mcp-migrate');
    const db = new DatabaseSync(join(dir, 'scratch.sqlite'));
    try {
      const applied: number[] = [];
      const migrations: Migration[] = [
        { version: 2, name: 'second', up: () => void applied.push(2) },
        { version: 1, name: 'first', up: () => void applied.push(1) },
      ];
      assert.deepEqual(migrate(db, undefined, migrations).applied, [1, 2]);
      assert.deepEqual(applied, [1, 2]);
      assert.deepEqual(migrate(db, undefined, migrations).applied, []);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
