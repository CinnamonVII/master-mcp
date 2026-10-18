/**
 * Ordered, idempotent migrations.
 *
 * SQL lives here rather than in files so the compiled `dist` build has no
 * runtime dependency on shipping `.sql` assets. Applied versions are recorded
 * in the `migrations` table, so upgrading is a matter of appending an entry.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/** Version 1: full initial schema plus full-text index. */
const initialSchema = `
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT,
  goal             TEXT,
  phase            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_accessed_at TEXT
);

CREATE TABLE IF NOT EXISTS repositories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  remote_url  TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  last_seen_at    TEXT,
  last_branch     TEXT,
  last_head       TEXT,
  last_head_at    TEXT,
  last_dirty      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_repositories_project ON repositories(project_id);
CREATE INDEX IF NOT EXISTS idx_repositories_remote ON repositories(remote_url);

CREATE TABLE IF NOT EXISTS tasks (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  description             TEXT,
  priority                TEXT NOT NULL DEFAULT 'P2',
  status                  TEXT NOT NULL DEFAULT 'todo',
  subsystem               TEXT,
  affected_files          TEXT NOT NULL DEFAULT '[]',
  dependencies            TEXT NOT NULL DEFAULT '[]',
  blockers                TEXT NOT NULL DEFAULT '[]',
  verification_requirements TEXT NOT NULL DEFAULT '[]',
  verification_status     TEXT NOT NULL DEFAULT 'none',
  source                  TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  completed_at            TEXT,
  head                    TEXT,
  branch                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_subsystem ON tasks(project_id, subsystem);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  statement     TEXT NOT NULL,
  rationale     TEXT,
  subsystem     TEXT,
  alternatives  TEXT NOT NULL DEFAULT '[]',
  source        TEXT,
  files         TEXT NOT NULL DEFAULT '[]',
  commits       TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_project_status ON decisions(project_id, status);

CREATE TABLE IF NOT EXISTS constraints (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  statement  TEXT NOT NULL,
  subsystem  TEXT,
  severity   TEXT NOT NULL DEFAULT 'medium',
  files      TEXT NOT NULL DEFAULT '[]',
  source     TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_constraints_project_active ON constraints(project_id, active);

CREATE TABLE IF NOT EXISTS bugs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'medium',
  status       TEXT NOT NULL DEFAULT 'open',
  subsystem    TEXT,
  reproduction TEXT,
  expected     TEXT,
  observed     TEXT,
  evidence     TEXT NOT NULL DEFAULT '[]',
  files        TEXT NOT NULL DEFAULT '[]',
  commits      TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_bugs_project_status ON bugs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_bugs_project_severity ON bugs(project_id, severity);

CREATE TABLE IF NOT EXISTS findings (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  statement  TEXT NOT NULL,
  evidence   TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL DEFAULT 'suspected',
  subsystem  TEXT,
  files      TEXT NOT NULL DEFAULT '[]',
  symbols    TEXT NOT NULL DEFAULT '[]',
  source     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_project_confidence ON findings(project_id, confidence);

CREATE TABLE IF NOT EXISTS verifications (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  method     TEXT NOT NULL,
  command    TEXT,
  result     TEXT NOT NULL,
  evidence   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_project ON verifications(project_id);
CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications(task_id);

CREATE TABLE IF NOT EXISTS handoffs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  summary         TEXT NOT NULL,
  work_attempted  TEXT,
  work_completed  TEXT,
  failures        TEXT NOT NULL DEFAULT '[]',
  discoveries     TEXT NOT NULL DEFAULT '[]',
  blockers        TEXT NOT NULL DEFAULT '[]',
  unresolved      TEXT NOT NULL DEFAULT '[]',
  follow_up       TEXT NOT NULL DEFAULT '[]',
  subsystem       TEXT,
  branch          TEXT,
  head            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_project_created ON handoffs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_task ON handoffs(task_id);

CREATE TABLE IF NOT EXISTS activity (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  source     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_project_created ON activity(project_id, created_at);

-- Full-text index over every kind of engineering memory. Application code keeps
-- this in sync through Store.reindex(); ref_id is the source-of-truth id.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  project_id UNINDEXED,
  created_at UNINDEXED,
  subsystem,
  title,
  body,
  tokenize = 'porter unicode61'
);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => db.exec(initialSchema),
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
