/**
 * Database lifecycle: path resolution, opening, and migration application.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Clock } from '../util/time.ts';
import { isoNow } from '../util/time.ts';
import { configError } from '../util/errors.ts';
import { MIGRATIONS, type Migration } from './migrations.ts';

export const DEFAULT_DB_FILENAME = 'master-mcp.db';

/**
 * Resolve the SQLite file to use.
 *
 * Precedence:
 *  1. `MASTER_MCP_DB` (full path, or `:memory:`)
 *  2. `MASTER_MCP_HOME`/master-mcp.db
 *  3. `XDG_DATA_HOME`/master-mcp/master-mcp.db
 *  4. ~/.local/share/master-mcp/master-mcp.db
 */
export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['MASTER_MCP_DB']?.trim();
  if (explicit) {
    if (explicit === ':memory:') return explicit;
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  }

  const home = env['MASTER_MCP_HOME']?.trim();
  if (home) {
    const base = isAbsolute(home) ? home : resolve(process.cwd(), home);
    return join(base, DEFAULT_DB_FILENAME);
  }

  const xdg = env['XDG_DATA_HOME']?.trim();
  const dataHome = xdg
    ? isAbsolute(xdg)
      ? xdg
      : resolve(process.cwd(), xdg)
    : join(homedir(), '.local', 'share');
  return join(dataHome, 'master-mcp', DEFAULT_DB_FILENAME);
}

export interface OpenDatabaseOptions {
  /** Explicit path; defaults to `resolveDatabasePath()`. */
  path?: string;
  clock?: Clock;
}

/** Open (creating if needed) and migrate the database. */
export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseSync {
  const path = options.path ?? resolveDatabasePath();
  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      throw configError(
        `Cannot create database directory for ${path}: ${(error as Error).message}`,
        'Set MASTER_MCP_DB to a writable path.',
      );
    }
  }

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db, options.clock);
  return db;
}

export interface MigrationResult {
  applied: number[];
  version: number;
}

/**
 * Apply pending migrations. Safe to call on every open: already-applied
 * versions are skipped, so restarting the process is a no-op.
 *
 * `migrations` is injectable so tests can prove that a new migration is
 * applied incrementally to an existing database.
 */
export function migrate(
  db: DatabaseSync,
  clock?: Clock,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.prepare('SELECT version FROM migrations').all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const newlyApplied: number[] = [];

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    migration.up(db);
    db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      migration.version,
      migration.name,
      clock ? isoNow(clock) : new Date().toISOString(),
    );
    newlyApplied.push(migration.version);
  }

  const highest = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  return { applied: newlyApplied, version: highest };
}

/** Current schema version recorded in the database (0 for an unmigrated file). */
export function schemaVersion(db: DatabaseSync): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
    .get() as { name: string } | undefined;
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM migrations').get() as
    | { version: number | null }
    | undefined;
  return Number(row?.version ?? 0);
}
