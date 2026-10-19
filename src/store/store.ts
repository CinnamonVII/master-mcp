/**
 * SQLite persistence.
 *
 * The store owns every SQL statement in the system. It performs no relevance
 * decisions: callers get rows or domain objects, and the application layer
 * decides what matters. Every write that produces engineering memory also
 * refreshes the full-text index so search can never drift from the tables.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  ActivityEntry,
  Bug,
  BugStatus,
  CommitInfo,
  Confidence,
  Constraint,
  Decision,
  Finding,
  Handoff,
  MemoryHit,
  MemoryItem,
  MemoryKind,
  Priority,
  Project,
  Repository,
  Severity,
  Task,
  TaskStatus,
  Verification,
  VerificationResult,
  VerificationStatus,
} from '../domain/models.ts';
import { confidenceRank } from '../domain/vocabulary.ts';
import { keywords, truncate } from '../util/text.ts';
import { termVariants } from '../util/terminology.ts';
import { newId } from '../util/ids.ts';

/** node:sqlite accepts only these value types; helpers keep callers honest. */
type SqlValue = string | number | bigint | null | Uint8Array;

function bool(value: boolean | null | undefined): SqlValue {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function toBool(value: unknown): boolean {
  return Number(value ?? 0) === 1;
}

function jsonArray(value: readonly string[] | null | undefined): string {
  return JSON.stringify(value ?? []);
}

function parseArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface RawRow {
  [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// Row → domain mappers
// ---------------------------------------------------------------------------

function mapProject(row: RawRow): Project {
  return {
    id: String(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    description: text(row['description']),
    goal: text(row['goal']),
    phase: text(row['phase']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    lastAccessedAt: text(row['last_accessed_at']),
  };
}

function mapRepository(row: RawRow): Repository {
  return {
    id: Number(row['id']),
    projectId: String(row['project_id']),
    path: String(row['path']),
    name: String(row['name']),
    remoteUrl: text(row['remote_url']),
    isPrimary: toBool(row['is_primary']),
    createdAt: String(row['created_at']),
    lastSeenAt: text(row['last_seen_at']),
    lastBranch: text(row['last_branch']),
    lastHead: text(row['last_head']),
    lastHeadAt: text(row['last_head_at']),
    lastDirty: row['last_dirty'] === null || row['last_dirty'] === undefined ? null : toBool(row['last_dirty']),
  };
}

function mapTask(row: RawRow): Task {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    title: String(row['title']),
    description: text(row['description']),
    priority: String(row['priority']) as Priority,
    status: String(row['status']) as TaskStatus,
    subsystem: text(row['subsystem']),
    affectedFiles: parseArray(row['affected_files']),
    dependencies: parseArray(row['dependencies']),
    blockers: parseArray(row['blockers']),
    verificationRequirements: parseArray(row['verification_requirements']),
    verificationStatus: String(row['verification_status']) as VerificationStatus,
    source: text(row['source']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    completedAt: text(row['completed_at']),
    head: text(row['head']),
    branch: text(row['branch']),
  };
}

function mapDecision(row: RawRow): Decision {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    statement: String(row['statement']),
    rationale: text(row['rationale']),
    subsystem: text(row['subsystem']),
    alternatives: parseArray(row['alternatives']),
    source: text(row['source']),
    files: parseArray(row['files']),
    commits: parseArray(row['commits']),
    status: String(row['status']) as Decision['status'],
    supersededBy: text(row['superseded_by']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function mapConstraint(row: RawRow): Constraint {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    statement: String(row['statement']),
    subsystem: text(row['subsystem']),
    severity: String(row['severity']) as Severity,
    files: parseArray(row['files']),
    source: text(row['source']),
    active: toBool(row['active']),
    replacedBy: text(row['replaced_by']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function mapBug(row: RawRow): Bug {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    title: String(row['title']),
    severity: String(row['severity']) as Severity,
    status: String(row['status']) as BugStatus,
    subsystem: text(row['subsystem']),
    reproduction: text(row['reproduction']),
    expected: text(row['expected']),
    observed: text(row['observed']),
    evidence: parseArray(row['evidence']),
    files: parseArray(row['files']),
    commits: parseArray(row['commits']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    resolvedAt: text(row['resolved_at']),
    taskId: text(row['task_id']),
  };
}

function mapFinding(row: RawRow): Finding {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    statement: String(row['statement']),
    evidence: parseArray(row['evidence']),
    confidence: String(row['confidence']) as Confidence,
    subsystem: text(row['subsystem']),
    files: parseArray(row['files']),
    symbols: parseArray(row['symbols']),
    source: text(row['source']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function mapVerification(row: RawRow): Verification {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    taskId: text(row['task_id']),
    method: String(row['method']),
    command: text(row['command']),
    result: String(row['result']) as VerificationResult,
    evidence: parseArray(row['evidence']),
    requirement: text(row['requirement']),
    bugId: text(row['bug_id']),
    createdAt: String(row['created_at']),
  };
}

function mapHandoff(row: RawRow): Handoff {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    taskId: text(row['task_id']),
    summary: String(row['summary']),
    workAttempted: text(row['work_attempted']),
    workCompleted: text(row['work_completed']),
    failures: parseArray(row['failures']),
    discoveries: parseArray(row['discoveries']),
    blockers: parseArray(row['blockers']),
    unresolved: parseArray(row['unresolved']),
    followUp: parseArray(row['follow_up']),
    subsystem: text(row['subsystem']),
    branch: text(row['branch']),
    head: text(row['head']),
    createdAt: String(row['created_at']),
  };
}

// ---------------------------------------------------------------------------
// Create inputs
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  id?: string;
  slug: string;
  name: string;
  description?: string | null;
  goal?: string | null;
  phase?: string | null;
  now: string;
}

export interface UpsertRepositoryInput {
  projectId: string;
  path: string;
  name: string;
  remoteUrl?: string | null;
  isPrimary?: boolean;
  now: string;
}

export interface RepositoryObservationUpdate {
  remoteUrl?: string | null;
  name?: string;
  branch?: string | null;
  head?: string | null;
  dirty?: boolean | null;
  seenAt: string;
}

export interface CreateTaskInput {
  id?: string;
  projectId: string;
  title: string;
  description?: string | null;
  priority?: Priority;
  status?: TaskStatus;
  subsystem?: string | null;
  affectedFiles?: readonly string[];
  dependencies?: readonly string[];
  blockers?: readonly string[];
  verificationRequirements?: readonly string[];
  verificationStatus?: VerificationStatus;
  source?: string | null;
  head?: string | null;
  branch?: string | null;
  now: string;
}

export interface CreateDecisionInput {
  id?: string;
  projectId: string;
  statement: string;
  rationale?: string | null;
  subsystem?: string | null;
  alternatives?: readonly string[];
  source?: string | null;
  files?: readonly string[];
  commits?: readonly string[];
  now: string;
}

export interface CreateConstraintInput {
  id?: string;
  projectId: string;
  statement: string;
  subsystem?: string | null;
  severity?: Severity;
  files?: readonly string[];
  source?: string | null;
  now: string;
}

export interface CreateBugInput {
  id?: string;
  projectId: string;
  title: string;
  severity?: Severity;
  status?: BugStatus;
  subsystem?: string | null;
  reproduction?: string | null;
  expected?: string | null;
  observed?: string | null;
  evidence?: readonly string[];
  files?: readonly string[];
  commits?: readonly string[];
  taskId?: string | null;
  now: string;
}

export interface CreateFindingInput {
  id?: string;
  projectId: string;
  statement: string;
  evidence?: readonly string[];
  confidence?: Confidence;
  subsystem?: string | null;
  files?: readonly string[];
  symbols?: readonly string[];
  source?: string | null;
  now: string;
}

export interface CreateVerificationInput {
  id?: string;
  projectId: string;
  taskId?: string | null;
  method: string;
  command?: string | null;
  result: VerificationResult;
  evidence?: readonly string[];
  requirement?: string | null;
  bugId?: string | null;
  now: string;
}

export interface CreateHandoffInput {
  id?: string;
  projectId: string;
  taskId?: string | null;
  summary: string;
  workAttempted?: string | null;
  workCompleted?: string | null;
  failures?: readonly string[];
  discoveries?: readonly string[];
  blockers?: readonly string[];
  unresolved?: readonly string[];
  followUp?: readonly string[];
  subsystem?: string | null;
  branch?: string | null;
  head?: string | null;
  now: string;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  priority?: Priority;
  status?: TaskStatus;
  subsystem?: string | null;
  affectedFiles?: readonly string[];
  dependencies?: readonly string[];
  blockers?: readonly string[];
  verificationRequirements?: readonly string[];
  verificationStatus?: VerificationStatus;
  completedAt?: string | null;
  head?: string | null;
  branch?: string | null;
  now: string;
}

export interface BugPatch {
  title?: string;
  severity?: Severity;
  status?: BugStatus;
  subsystem?: string | null;
  reproduction?: string | null;
  expected?: string | null;
  observed?: string | null;
  evidence?: readonly string[];
  files?: readonly string[];
  commits?: readonly string[];
  resolvedAt?: string | null;
  taskId?: string | null;
  now: string;
}

export interface FindingPatch {
  statement?: string;
  evidence?: readonly string[];
  confidence?: Confidence;
  subsystem?: string | null;
  files?: readonly string[];
  symbols?: readonly string[];
  now: string;
}

export interface DecisionPatch {
  statement?: string;
  rationale?: string | null;
  subsystem?: string | null;
  alternatives?: readonly string[];
  files?: readonly string[];
  commits?: readonly string[];
  status?: Decision['status'];
  supersededBy?: string | null;
  now: string;
}

export interface ConstraintPatch {
  statement?: string;
  subsystem?: string | null;
  severity?: Severity;
  files?: readonly string[];
  active?: boolean;
  replacedBy?: string | null;
  now: string;
}

export interface MemoryQuery {
  query: string;
  projectId?: string;
  kinds?: readonly MemoryKind[];
  limit?: number;
}

export interface StoreOptions {
  /** Maximum activity rows kept per project before pruning oldest entries. */
  activityRetention?: number;
}

const DEFAULT_ACTIVITY_RETENTION = 400;

/** Columns of memory_fts, in index order, used to weight bm25. */
const FTS_TITLE_WEIGHT = 4.0;
const FTS_BODY_WEIGHT = 1.0;

export class Store {
  private readonly db: DatabaseSync;
  private readonly activityRetention: number;
  private readonly statementCache = new Map<string, StatementSync>();
  private transactionDepth = 0;

  constructor(db: DatabaseSync, options: StoreOptions = {}) {
    this.db = db;
    this.activityRetention = options.activityRetention ?? DEFAULT_ACTIVITY_RETENTION;
  }

  /** Escape hatch for maintenance tasks (export/import, diagnostics). */
  raw(): DatabaseSync {
    return this.db;
  }

  /** Prepared-statement reuse keeps repeated calls cheap. */
  private stmt(sql: string): StatementSync {
    let cached = this.statementCache.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statementCache.set(sql, cached);
    }
    return cached;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  createProject(input: CreateProjectInput): Project {
    const id = input.id ?? newId('project');
    this.stmt(
      `INSERT INTO projects (id, slug, name, description, goal, phase, created_at, updated_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.slug,
      input.name,
      input.description ?? null,
      input.goal ?? null,
      input.phase ?? null,
      input.now,
      input.now,
      input.now,
    );
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const row = this.stmt('SELECT * FROM projects WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapProject(row) : null;
  }

  getProjectBySlug(slug: string): Project | null {
    const row = this.stmt('SELECT * FROM projects WHERE slug = ? COLLATE NOCASE').get(slug) as RawRow | undefined;
    return row ? mapProject(row) : null;
  }

  listProjects(): Project[] {
    return (this.stmt('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as RawRow[]).map(mapProject);
  }

  updateProject(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      goal?: string | null;
      phase?: string | null;
      now: string;
    },
  ): Project {
    const sets: string[] = ['updated_at = ?'];
    const values: SqlValue[] = [patch.now];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      values.push(patch.description);
    }
    if (patch.goal !== undefined) {
      sets.push('goal = ?');
      values.push(patch.goal);
    }
    if (patch.phase !== undefined) {
      sets.push('phase = ?');
      values.push(patch.phase);
    }
    values.push(id);
    this.stmt(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const project = this.getProject(id);
    if (!project) throw new Error(`Project ${id} disappeared during update`);
    return project;
  }

  touchProject(id: string, at: string): void {
    this.stmt('UPDATE projects SET last_accessed_at = ? WHERE id = ?').run(at, id);
  }

  // -------------------------------------------------------------------------
  // Repositories
  // -------------------------------------------------------------------------

  upsertRepository(input: UpsertRepositoryInput): Repository {
    const existing = this.getRepositoryByPath(input.path);
    if (existing) {
      const sets: string[] = ['project_id = ?', 'name = ?', 'remote_url = ?', 'last_seen_at = ?'];
      const values: SqlValue[] = [input.projectId, input.name, input.remoteUrl ?? null, input.now];
      if (input.isPrimary !== undefined) {
        sets.push('is_primary = ?');
        values.push(bool(input.isPrimary));
      }
      values.push(existing.id);
      this.stmt(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      return this.getRepository(existing.id)!;
    }
    const info = this.stmt(
      `INSERT INTO repositories (project_id, path, name, remote_url, is_primary, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.projectId,
      input.path,
      input.name,
      input.remoteUrl ?? null,
      bool(input.isPrimary ?? false),
      input.now,
      input.now,
    );
    return this.getRepository(Number(info.lastInsertRowid))!;
  }

  getRepository(id: number): Repository | null {
    const row = this.stmt('SELECT * FROM repositories WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapRepository(row) : null;
  }

  getRepositoryByPath(path: string): Repository | null {
    const row = this.stmt('SELECT * FROM repositories WHERE path = ?').get(path) as RawRow | undefined;
    return row ? mapRepository(row) : null;
  }

  listRepositories(projectId?: string): Repository[] {
    const rows = projectId
      ? (this.stmt('SELECT * FROM repositories WHERE project_id = ? ORDER BY is_primary DESC, id').all(projectId) as RawRow[])
      : (this.stmt('SELECT * FROM repositories ORDER BY project_id, is_primary DESC, id').all() as RawRow[]);
    return rows.map(mapRepository);
  }

  /**
   * Longest-prefix repository match, so a call made from a subdirectory still
   * resolves to its repository.
   */
  findRepositoryForPath(path: string): Repository | null {
    const candidate = path.replace(/\/+$/, '');
    let best: Repository | null = null;
    for (const repository of this.listRepositories()) {
      const root = repository.path.replace(/\/+$/, '');
      if (candidate === root || candidate.startsWith(`${root}/`)) {
        if (!best || root.length > best.path.length) best = repository;
      }
    }
    return best;
  }

  recordRepositoryObservation(id: number, update: RepositoryObservationUpdate): void {
    const sets: string[] = ['last_seen_at = ?'];
    const values: SqlValue[] = [update.seenAt];
    if (update.remoteUrl !== undefined) {
      sets.push('remote_url = ?');
      values.push(update.remoteUrl);
    }
    if (update.name !== undefined) {
      sets.push('name = ?');
      values.push(update.name);
    }
    if (update.branch !== undefined) {
      sets.push('last_branch = ?');
      values.push(update.branch);
    }
    if (update.head !== undefined) {
      sets.push('last_head = ?', 'last_head_at = ?');
      values.push(update.head, update.seenAt);
    }
    if (update.dirty !== undefined) {
      sets.push('last_dirty = ?');
      values.push(bool(update.dirty));
    }
    values.push(id);
    this.stmt(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  createTask(input: CreateTaskInput): Task {
    const id = input.id ?? newId('task');
    this.stmt(
      `INSERT INTO tasks (id, project_id, title, description, priority, status, subsystem, affected_files,
                          dependencies, blockers, verification_requirements, verification_status, source,
                          created_at, updated_at, head, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.title,
      input.description ?? null,
      input.priority ?? 'P2',
      input.status ?? 'todo',
      input.subsystem ?? null,
      jsonArray(input.affectedFiles),
      jsonArray(input.dependencies),
      jsonArray(input.blockers),
      jsonArray(input.verificationRequirements),
      input.verificationStatus ?? 'none',
      input.source ?? null,
      input.now,
      input.now,
      input.head ?? null,
      input.branch ?? null,
    );
    const task = this.getTask(id)!;
    this.indexTask(task);
    return task;
  }

  /** Keep a task's searchable text in step with its row. */
  private indexTask(task: Task): void {
    this.reindex('task', task.id, task.projectId, task.updatedAt, task.subsystem, task.title, [
      task.description,
      task.affectedFiles.join(' '),
      task.blockers.join(' '),
      task.verificationRequirements.join(' '),
    ]);
  }

  getTask(id: string): Task | null {
    const row = this.stmt('SELECT * FROM tasks WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapTask(row) : null;
  }

  findTaskByTitle(projectId: string, title: string): Task | null {
    const row = this.stmt(
      'SELECT * FROM tasks WHERE project_id = ? AND title = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1',
    ).get(projectId, title.trim()) as RawRow | undefined;
    return row ? mapTask(row) : null;
  }

  listTasks(projectId: string, options: { statuses?: readonly TaskStatus[]; limit?: number } = {}): Task[] {
    const limit = options.limit ?? 200;
    if (options.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => '?').join(', ');
      const rows = this.stmt(
        `SELECT * FROM tasks WHERE project_id = ? AND status IN (${placeholders})
         ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
                  updated_at DESC LIMIT ?`,
      ).all(projectId, ...options.statuses, limit) as RawRow[];
      return rows.map(mapTask);
    }
    const rows = this.stmt(
      `SELECT * FROM tasks WHERE project_id = ?
       ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
                updated_at DESC LIMIT ?`,
    ).all(projectId, limit) as RawRow[];
    return rows.map(mapTask);
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const sets: string[] = ['updated_at = ?'];
    const values: SqlValue[] = [patch.now];
    const push = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.subsystem !== undefined) push('subsystem', patch.subsystem);
    if (patch.affectedFiles !== undefined) push('affected_files', jsonArray(patch.affectedFiles));
    if (patch.dependencies !== undefined) push('dependencies', jsonArray(patch.dependencies));
    if (patch.blockers !== undefined) push('blockers', jsonArray(patch.blockers));
    if (patch.verificationRequirements !== undefined) {
      push('verification_requirements', jsonArray(patch.verificationRequirements));
    }
    if (patch.verificationStatus !== undefined) push('verification_status', patch.verificationStatus);
    if (patch.completedAt !== undefined) push('completed_at', patch.completedAt);
    if (patch.head !== undefined) push('head', patch.head);
    if (patch.branch !== undefined) push('branch', patch.branch);
    values.push(id);
    this.stmt(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const task = this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    this.indexTask(task);
    return task;
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  createDecision(input: CreateDecisionInput): Decision {
    const id = input.id ?? newId('decision');
    this.stmt(
      `INSERT INTO decisions (id, project_id, statement, rationale, subsystem, alternatives, source, files,
                              commits, status, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.statement,
      input.rationale ?? null,
      input.subsystem ?? null,
      jsonArray(input.alternatives),
      input.source ?? null,
      jsonArray(input.files),
      jsonArray(input.commits),
      input.now,
      input.now,
    );
    const decision = this.getDecision(id)!;
    this.reindex('decision', decision.id, decision.projectId, decision.updatedAt, decision.subsystem, decision.statement, [
      decision.rationale,
      ...decision.alternatives,
    ]);
    return decision;
  }

  getDecision(id: string): Decision | null {
    const row = this.stmt('SELECT * FROM decisions WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapDecision(row) : null;
  }

  listDecisions(projectId: string, options: { activeOnly?: boolean; limit?: number } = {}): Decision[] {
    const limit = options.limit ?? 200;
    const sql = options.activeOnly
      ? `SELECT * FROM decisions WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?`
      : 'SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?';
    return (this.stmt(sql).all(projectId, limit) as RawRow[]).map(mapDecision);
  }

  supersedeDecision(id: string, supersededBy: string, now: string): Decision | null {
    this.stmt("UPDATE decisions SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(
      supersededBy,
      now,
      id,
    );
    const decision = this.getDecision(id);
    if (decision) {
      this.reindex('decision', decision.id, decision.projectId, decision.updatedAt, decision.subsystem, decision.statement, [
        decision.rationale,
        ...decision.alternatives,
      ]);
    }
    return decision;
  }

  updateDecision(id: string, patch: DecisionPatch): Decision {
    const sets: string[] = ['updated_at = ?'];
    const values: SqlValue[] = [patch.now];
    const push = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.statement !== undefined) push('statement', patch.statement);
    if (patch.rationale !== undefined) push('rationale', patch.rationale);
    if (patch.subsystem !== undefined) push('subsystem', patch.subsystem);
    if (patch.alternatives !== undefined) push('alternatives', jsonArray(patch.alternatives));
    if (patch.files !== undefined) push('files', jsonArray(patch.files));
    if (patch.commits !== undefined) push('commits', jsonArray(patch.commits));
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.supersededBy !== undefined) push('superseded_by', patch.supersededBy);
    values.push(id);
    this.stmt(`UPDATE decisions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const decision = this.getDecision(id);
    if (!decision) throw new Error(`Decision ${id} not found`);
    this.reindex('decision', decision.id, decision.projectId, decision.updatedAt, decision.subsystem, decision.statement, [
      decision.rationale,
      ...decision.alternatives,
    ]);
    return decision;
  }

  // -------------------------------------------------------------------------
  // Constraints
  // -------------------------------------------------------------------------

  createConstraint(input: CreateConstraintInput): Constraint {
    const id = input.id ?? newId('constraint');
    this.stmt(
      `INSERT INTO constraints (id, project_id, statement, subsystem, severity, files, source, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.statement,
      input.subsystem ?? null,
      input.severity ?? 'medium',
      jsonArray(input.files),
      input.source ?? null,
      input.now,
      input.now,
    );
    const constraint = this.getConstraint(id)!;
    this.reindex('constraint', constraint.id, constraint.projectId, constraint.updatedAt, constraint.subsystem, constraint.statement, []);
    return constraint;
  }

  getConstraint(id: string): Constraint | null {
    const row = this.stmt('SELECT * FROM constraints WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapConstraint(row) : null;
  }

  listConstraints(projectId: string, options: { activeOnly?: boolean; limit?: number } = {}): Constraint[] {
    const limit = options.limit ?? 300;
    const sql =
      options.activeOnly === false
        ? 'SELECT * FROM constraints WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
        : 'SELECT * FROM constraints WHERE project_id = ? AND active = 1 ORDER BY created_at DESC LIMIT ?';
    return (this.stmt(sql).all(projectId, limit) as RawRow[]).map(mapConstraint);
  }

  deactivateConstraint(id: string, now: string): Constraint | null {
    this.stmt('UPDATE constraints SET active = 0, updated_at = ? WHERE id = ?').run(now, id);
    const constraint = this.getConstraint(id);
    if (constraint) {
      this.reindex('constraint', constraint.id, constraint.projectId, constraint.updatedAt, constraint.subsystem, constraint.statement, []);
    }
    return constraint;
  }

  /**
   * Deactivate a constraint and record which constraint replaced it, in one
   * transaction so the pair of updates cannot half-apply.
   */
  replaceConstraint(id: string, replacedBy: string, now: string): Constraint | null {
    let replaced: Constraint | null = null;
    this.transaction(() => {
      this.stmt('UPDATE constraints SET active = 0, replaced_by = ?, updated_at = ? WHERE id = ?').run(
        replacedBy,
        now,
        id,
      );
      replaced = this.getConstraint(id);
    });
    return replaced;
  }

  updateConstraint(id: string, patch: ConstraintPatch): Constraint {
    const sets: string[] = ['updated_at = ?'];
    const values: SqlValue[] = [patch.now];
    const push = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.statement !== undefined) push('statement', patch.statement);
    if (patch.subsystem !== undefined) push('subsystem', patch.subsystem);
    if (patch.severity !== undefined) push('severity', patch.severity);
    if (patch.files !== undefined) push('files', jsonArray(patch.files));
    if (patch.active !== undefined) push('active', bool(patch.active));
    if (patch.replacedBy !== undefined) push('replaced_by', patch.replacedBy);
    values.push(id);
    this.stmt(`UPDATE constraints SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const constraint = this.getConstraint(id);
    if (!constraint) throw new Error(`Constraint ${id} not found`);
    this.reindex('constraint', constraint.id, constraint.projectId, constraint.updatedAt, constraint.subsystem, constraint.statement, []);
    return constraint;
  }

  /**
   * Run `fn` inside one SQLite transaction. Any throw rolls the whole unit of
   * work back, which is what keeps lifecycle edits (create + supersede) atomic.
   *
   * Reentrant: a helper such as `replaceConstraint` may open a transaction
   * inside the service's create+replace transaction, and the inner call simply
   * joins the outer one. Only the outermost scope commits or rolls back.
   */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already aborted; the original error is the one worth surfacing.
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Bugs
  // -------------------------------------------------------------------------

  createBug(input: CreateBugInput): Bug {
    const id = input.id ?? newId('bug');
    this.stmt(
      `INSERT INTO bugs (id, project_id, title, severity, status, subsystem, reproduction, expected, observed,
                         evidence, files, commits, created_at, updated_at, resolved_at, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      input.projectId,
      input.title,
      input.severity ?? 'medium',
      input.status ?? 'open',
      input.subsystem ?? null,
      input.reproduction ?? null,
      input.expected ?? null,
      input.observed ?? null,
      jsonArray(input.evidence),
      jsonArray(input.files),
      jsonArray(input.commits),
      input.now,
      input.now,
      input.taskId ?? null,
    );
    const bug = this.getBug(id)!;
    this.reindex('bug', bug.id, bug.projectId, bug.createdAt, bug.subsystem, bug.title, [
      bug.observed,
      bug.expected,
      bug.reproduction,
      ...bug.evidence,
    ]);
    return bug;
  }

  getBug(id: string): Bug | null {
    const row = this.stmt('SELECT * FROM bugs WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapBug(row) : null;
  }

  listBugs(
    projectId: string,
    options: { openOnly?: boolean; limit?: number; severities?: readonly Severity[] } = {},
  ): Bug[] {
    const limit = options.limit ?? 300;
    const clauses = ['project_id = ?'];
    const values: SqlValue[] = [projectId];
    if (options.openOnly) {
      clauses.push("status IN ('open', 'investigating', 'fix_claimed')");
    }
    if (options.severities && options.severities.length > 0) {
      clauses.push(`severity IN (${options.severities.map(() => '?').join(', ')})`);
      values.push(...options.severities);
    }
    values.push(limit);
    const rows = this.stmt(
      `SELECT * FROM bugs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ).all(...values) as RawRow[];
    return rows.map(mapBug);
  }

  findBugByTitle(projectId: string, title: string): Bug | null {
    const row = this.stmt(
      'SELECT * FROM bugs WHERE project_id = ? AND title = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1',
    ).get(projectId, title.trim()) as RawRow | undefined;
    return row ? mapBug(row) : null;
  }

  /** Bugs whose fix was claimed or verified by a particular task. */
  listBugsForTask(projectId: string, taskId: string): Bug[] {
    const rows = this.stmt(
      'SELECT * FROM bugs WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC',
    ).all(projectId, taskId) as RawRow[];
    return rows.map(mapBug);
  }

  updateBug(id: string, patch: BugPatch): Bug {
    const sets: string[] = ['updated_at = ?'];
    const values: SqlValue[] = [patch.now];
    const push = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.severity !== undefined) push('severity', patch.severity);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.subsystem !== undefined) push('subsystem', patch.subsystem);
    if (patch.reproduction !== undefined) push('reproduction', patch.reproduction);
    if (patch.expected !== undefined) push('expected', patch.expected);
    if (patch.observed !== undefined) push('observed', patch.observed);
    if (patch.evidence !== undefined) push('evidence', jsonArray(patch.evidence));
    if (patch.files !== undefined) push('files', jsonArray(patch.files));
    if (patch.commits !== undefined) push('commits', jsonArray(patch.commits));
    if (patch.resolvedAt !== undefined) push('resolved_at', patch.resolvedAt);
    if (patch.taskId !== undefined) push('task_id', patch.taskId);
    values.push(id);
    this.stmt(`UPDATE bugs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const bug = this.getBug(id);
    if (!bug) throw new Error(`Bug ${id} not found`);
    this.reindex('bug', bug.id, bug.projectId, bug.createdAt, bug.subsystem, bug.title, [
      bug.observed,
      bug.expected,
      bug.reproduction,
      ...bug.evidence,
    ]);
    return bug;
  }

  // -------------------------------------------------------------------------
  // Findings
  // -------------------------------------------------------------------------

  createFinding(input: CreateFindingInput): Finding {
    const id = input.id ?? newId('finding');
    this.stmt(
      `INSERT INTO findings (id, project_id, statement, evidence, confidence, subsystem, files, symbols, source,
                             created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.statement,
      jsonArray(input.evidence),
      input.confidence ?? 'suspected',
      input.subsystem ?? null,
      jsonArray(input.files),
      jsonArray(input.symbols),
      input.source ?? null,
      input.now,
      input.now,
    );
    const finding = this.getFinding(id)!;
    this.reindex('finding', finding.id, finding.projectId, finding.createdAt, finding.subsystem, finding.statement, [
      ...finding.evidence,
      ...finding.symbols,
    ]);
    return finding;
  }

  getFinding(id: string): Finding | null {
    const row = this.stmt('SELECT * FROM findings WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapFinding(row) : null;
  }

  listFindings(projectId: string, options: { limit?: number; minConfidence?: Confidence } = {}): Finding[] {
    const limit = options.limit ?? 400;
    const rows = this.stmt('SELECT * FROM findings WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(
      projectId,
      limit,
    ) as RawRow[];
    const findings = rows.map(mapFinding);
    if (!options.minConfidence) return findings;
    const floor = confidenceRank(options.minConfidence);
    return findings.filter((finding) => confidenceRank(finding.confidence) >= floor);
  }

  updateFinding(id: string, patch: FindingPatch): Finding {
    const sets: string[] = ['updated_at = ?'];
    const values: SqlValue[] = [patch.now];
    const push = (column: string, value: SqlValue): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.statement !== undefined) push('statement', patch.statement);
    if (patch.evidence !== undefined) push('evidence', jsonArray(patch.evidence));
    if (patch.confidence !== undefined) push('confidence', patch.confidence);
    if (patch.subsystem !== undefined) push('subsystem', patch.subsystem);
    if (patch.files !== undefined) push('files', jsonArray(patch.files));
    if (patch.symbols !== undefined) push('symbols', jsonArray(patch.symbols));
    values.push(id);
    this.stmt(`UPDATE findings SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const finding = this.getFinding(id);
    if (!finding) throw new Error(`Finding ${id} not found`);
    this.reindex('finding', finding.id, finding.projectId, finding.createdAt, finding.subsystem, finding.statement, [
      ...finding.evidence,
      ...finding.symbols,
    ]);
    return finding;
  }

  // -------------------------------------------------------------------------
  // Verifications
  // -------------------------------------------------------------------------

  createVerification(input: CreateVerificationInput): Verification {
    const id = input.id ?? newId('verification');
    this.stmt(
      `INSERT INTO verifications (id, project_id, task_id, method, command, result, evidence, requirement, bug_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.taskId ?? null,
      input.method,
      input.command ?? null,
      input.result,
      jsonArray(input.evidence),
      input.requirement ?? null,
      input.bugId ?? null,
      input.now,
    );
    const verification = this.getVerification(id)!;
    this.reindex('verification', verification.id, verification.projectId, verification.createdAt, null, verification.method, [
      verification.command,
      ...verification.evidence,
    ]);
    return verification;
  }

  getVerification(id: string): Verification | null {
    const row = this.stmt('SELECT * FROM verifications WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapVerification(row) : null;
  }

  listVerifications(projectId: string, options: { taskId?: string; limit?: number } = {}): Verification[] {
    const limit = options.limit ?? 200;
    const sql = options.taskId
      ? 'SELECT * FROM verifications WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM verifications WHERE project_id = ? ORDER BY created_at DESC LIMIT ?';
    const rows = (
      options.taskId
        ? this.stmt(sql).all(projectId, options.taskId, limit)
        : this.stmt(sql).all(projectId, limit)
    ) as RawRow[];
    return rows.map(mapVerification);
  }

  // -------------------------------------------------------------------------
  // Handoffs
  // -------------------------------------------------------------------------

  createHandoff(input: CreateHandoffInput): Handoff {
    const id = input.id ?? newId('handoff');
    this.stmt(
      `INSERT INTO handoffs (id, project_id, task_id, summary, work_attempted, work_completed, failures,
                             discoveries, blockers, unresolved, follow_up, subsystem, branch, head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.taskId ?? null,
      input.summary,
      input.workAttempted ?? null,
      input.workCompleted ?? null,
      jsonArray(input.failures),
      jsonArray(input.discoveries),
      jsonArray(input.blockers),
      jsonArray(input.unresolved),
      jsonArray(input.followUp),
      input.subsystem ?? null,
      input.branch ?? null,
      input.head ?? null,
      input.now,
    );
    const handoff = this.getHandoff(id)!;
    this.reindex('handoff', handoff.id, handoff.projectId, handoff.createdAt, handoff.subsystem, handoff.summary, [
      handoff.workAttempted,
      handoff.workCompleted,
      ...handoff.discoveries,
      ...handoff.blockers,
      ...handoff.unresolved,
      ...handoff.followUp,
    ]);
    return handoff;
  }

  getHandoff(id: string): Handoff | null {
    const row = this.stmt('SELECT * FROM handoffs WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapHandoff(row) : null;
  }

  listHandoffs(projectId: string, options: { limit?: number; taskId?: string } = {}): Handoff[] {
    const limit = options.limit ?? 20;
    const sql = options.taskId
      ? 'SELECT * FROM handoffs WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?';
    const rows = (
      options.taskId
        ? this.stmt(sql).all(projectId, options.taskId, limit)
        : this.stmt(sql).all(projectId, limit)
    ) as RawRow[];
    return rows.map(mapHandoff);
  }

  latestHandoff(projectId: string): Handoff | null {
    return this.listHandoffs(projectId, { limit: 1 })[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Activity log
  // -------------------------------------------------------------------------

  recordActivity(entry: {
    id?: string;
    projectId: string | null;
    kind: string;
    summary: string;
    payload?: Record<string, unknown>;
    source?: string | null;
    now: string;
  }): ActivityEntry {
    const id = entry.id ?? newId('activity');
    this.stmt(
      `INSERT INTO activity (id, project_id, kind, summary, payload, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      entry.projectId,
      entry.kind,
      entry.summary,
      JSON.stringify(entry.payload ?? {}),
      entry.source ?? null,
      entry.now,
    );
    this.pruneActivity(entry.projectId);
    return {
      id,
      projectId: entry.projectId,
      kind: entry.kind,
      summary: entry.summary,
      payload: entry.payload ?? {},
      source: entry.source ?? null,
      createdAt: entry.now,
    };
  }

  listActivity(projectId: string | null, limit = 20): ActivityEntry[] {
    const rows = (
      projectId
        ? this.stmt('SELECT * FROM activity WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(
            projectId,
            limit,
          )
        : this.stmt('SELECT * FROM activity ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
    ) as RawRow[];
    return rows.map((row) => ({
      id: String(row['id']),
      projectId: text(row['project_id']),
      kind: String(row['kind']),
      summary: String(row['summary']),
      payload: parseObject(row['payload']),
      source: text(row['source']),
      createdAt: String(row['created_at']),
    }));
  }

  /** Keep the audit log bounded; older entries are irrelevant to a one-pass brief. */
  private pruneActivity(projectId: string | null): void {
    if (projectId === null) return;
    this.stmt(
      `DELETE FROM activity
       WHERE project_id = ?
         AND id NOT IN (
           SELECT id FROM activity WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
    ).run(projectId, projectId, this.activityRetention);
  }

  // -------------------------------------------------------------------------
  // Full-text index
  // -------------------------------------------------------------------------

  /**
   * Replace the indexed text for one record. Called by every write above, so
   * the index cannot drift from the tables.
   *
   * `createdAt` is denormalised into the index so ranked search can return hit
   * metadata without a second lookup per kind.
   */
  reindex(
    kind: MemoryKind,
    refId: string,
    projectId: string,
    createdAt: string,
    subsystem: string | null,
    title: string,
    extra: readonly (string | null | undefined)[],
  ): void {
    const body = extra.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' \n ');
    this.stmt('DELETE FROM memory_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
    this.stmt(
      `INSERT INTO memory_fts (kind, ref_id, project_id, created_at, subsystem, title, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(kind, refId, projectId, createdAt, subsystem ?? '', title, body);
  }

  removeFromIndex(kind: MemoryKind, refId: string): void {
    this.stmt('DELETE FROM memory_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
  }

  /**
   * Ranked full-text search.
   *
   * Query text is folded into the same canonical terms used by ranking and
   * dedup, then expanded to the family's surface forms because the index keeps
   * original prose. Scores are normalised against the best hit so callers get a
   * scale-free 0..1 relevance that does not depend on corpus size.
   */
  searchMemory(query: MemoryQuery): MemoryHit[] {
    const terms = keywords(query.query);
    if (terms.length === 0) return [];
    const limit = query.limit ?? 20;
    const filters = ['memory_fts MATCH ?'];
    const values: SqlValue[] = [buildFtsQuery(terms)];
    if (query.projectId) {
      filters.push('project_id = ?');
      values.push(query.projectId);
    }
    if (query.kinds && query.kinds.length > 0) {
      filters.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
      values.push(...query.kinds);
    }
    values.push(limit);

    const rows = this.stmt(
      `SELECT kind, ref_id, project_id, subsystem, title, body, created_at,
              -bm25(memory_fts, 0, 0, 0, 0, ${FTS_TITLE_WEIGHT}, ${FTS_BODY_WEIGHT}) AS rank
       FROM memory_fts
       WHERE ${filters.join(' AND ')}
       ORDER BY rank DESC
       LIMIT ?`,
    ).all(...values) as RawRow[];

    if (rows.length === 0) return [];
    const best = Math.max(...rows.map((row) => Number(row['rank'] ?? 0))) || 1;
    return rows.map((row) => ({
      kind: String(row['kind']) as MemoryKind,
      id: String(row['ref_id']),
      projectId: String(row['project_id']),
      title: String(row['title'] ?? ''),
      body: typeof row['body'] === 'string' ? row['body'] : '',
      subsystem: text(row['subsystem']),
      status: null,
      createdAt: String(row['created_at'] ?? ''),
      score: Math.max(0, Math.min(1, Number(row['rank'] ?? 0) / best)),
    }));
  }

  /** Total number of indexed records, used by `master_status` and diagnostics. */
  indexedCount(projectId?: string): number {
    const row = (
      projectId
        ? this.stmt('SELECT COUNT(*) AS count FROM memory_fts WHERE project_id = ?').get(projectId)
        : this.stmt('SELECT COUNT(*) AS count FROM memory_fts').get()
    ) as RawRow | undefined;
    return Number(row?.['count'] ?? 0);
  }

  // -------------------------------------------------------------------------
  // Candidate loading for the relevance engine
  // -------------------------------------------------------------------------

  /**
   * Project the project's memory into `MemoryItem`s.
   *
   * Every collection is bounded and read in a single query per kind, so a
   * call costs a handful of indexed reads regardless of project size.
   * Engineering memory for one project is small by nature; ranking then happens
   * in memory where it is deterministic and testable.
   */
  loadMemoryItems(projectId: string, limits: { perKind?: number } = {}): MemoryItem[] {
    const perKind = limits.perKind ?? 400;
    const items: MemoryItem[] = [];

    for (const task of this.listTasks(projectId, { limit: perKind })) {
      items.push({
        kind: 'task',
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        body: [task.description, ...task.blockers.map((b) => `blocker: ${b}`)].filter(Boolean).join(' '),
        subsystem: task.subsystem,
        files: task.affectedFiles,
        symbols: [],
        status: task.status,
        priority: task.priority,
        severity: null,
        confidence: null,
        verification: task.verificationStatus,
        createdAt: task.updatedAt,
        taskId: task.id,
        head: task.head,
        branch: task.branch,
        terms: keywords([task.title, task.description ?? '', task.subsystem ?? '', ...task.affectedFiles].join(' ')),
        raw: task,
      });
    }

    for (const decision of this.listDecisions(projectId, { limit: perKind })) {
      items.push({
        kind: 'decision',
        id: decision.id,
        projectId: decision.projectId,
        title: decision.statement,
        body: [decision.rationale, ...decision.alternatives].filter(Boolean).join(' '),
        subsystem: decision.subsystem,
        files: decision.files,
        symbols: [],
        status: decision.status,
        priority: null,
        severity: null,
        confidence: null,
        verification: null,
        createdAt: decision.updatedAt,
        taskId: null,
        head: null,
        branch: null,
        terms: keywords([decision.statement, decision.rationale ?? '', decision.subsystem ?? ''].join(' ')),
        raw: decision,
      });
    }

    for (const constraint of this.listConstraints(projectId, { limit: perKind })) {
      items.push({
        kind: 'constraint',
        id: constraint.id,
        projectId: constraint.projectId,
        title: constraint.statement,
        body: '',
        subsystem: constraint.subsystem,
        files: constraint.files,
        symbols: [],
        status: constraint.active ? 'active' : 'inactive',
        priority: null,
        severity: constraint.severity,
        confidence: null,
        verification: null,
        createdAt: constraint.updatedAt,
        taskId: null,
        head: null,
        branch: null,
        terms: keywords([constraint.statement, constraint.subsystem ?? ''].join(' ')),
        raw: constraint,
      });
    }

    for (const bug of this.listBugs(projectId, { limit: perKind })) {
      items.push({
        kind: 'bug',
        id: bug.id,
        projectId: bug.projectId,
        title: bug.title,
        body: [bug.observed, bug.expected, bug.reproduction].filter(Boolean).join(' '),
        subsystem: bug.subsystem,
        files: bug.files,
        symbols: [],
        status: bug.status,
        priority: null,
        severity: bug.severity,
        confidence: null,
        verification: null,
        createdAt: bug.updatedAt,
        taskId: bug.taskId,
        head: null,
        branch: null,
        terms: keywords(
          [bug.title, bug.observed ?? '', bug.expected ?? '', bug.reproduction ?? '', bug.subsystem ?? ''].join(' '),
        ),
        raw: bug,
      });
    }

    for (const finding of this.listFindings(projectId, { limit: perKind })) {
      items.push({
        kind: 'finding',
        id: finding.id,
        projectId: finding.projectId,
        title: finding.statement,
        body: [...finding.evidence, ...finding.symbols].join(' '),
        subsystem: finding.subsystem,
        files: finding.files,
        symbols: finding.symbols,
        status: finding.confidence,
        priority: null,
        severity: null,
        confidence: finding.confidence,
        verification: null,
        createdAt: finding.updatedAt,
        taskId: null,
        head: null,
        branch: null,
        terms: keywords(
          [finding.statement, ...finding.symbols, ...finding.evidence, finding.subsystem ?? ''].join(' '),
        ),
        raw: finding,
      });
    }

    for (const verification of this.listVerifications(projectId, { limit: perKind })) {
      items.push({
        kind: 'verification',
        id: verification.id,
        projectId: verification.projectId,
        title: verification.method,
        body: [verification.command, ...verification.evidence].filter(Boolean).join(' '),
        subsystem: null,
        files: [],
        symbols: [],
        status: verification.result,
        priority: null,
        severity: null,
        confidence: null,
        verification: null,
        createdAt: verification.createdAt,
        taskId: verification.taskId,
        head: null,
        branch: null,
        terms: keywords([verification.method, verification.command ?? '', ...verification.evidence].join(' ')),
        raw: verification,
      });
    }

    for (const handoff of this.listHandoffs(projectId, { limit: Math.min(perKind, 50) })) {
      items.push({
        kind: 'handoff',
        id: handoff.id,
        projectId: handoff.projectId,
        title: handoff.summary,
        body: [
          handoff.workCompleted,
          handoff.workAttempted,
          ...handoff.discoveries,
          ...handoff.failures,
          ...handoff.unresolved,
          ...handoff.followUp,
        ]
          .filter(Boolean)
          .join(' '),
        subsystem: handoff.subsystem,
        files: [],
        symbols: [],
        status: null,
        priority: null,
        severity: null,
        confidence: null,
        verification: null,
        createdAt: handoff.createdAt,
        taskId: handoff.taskId,
        head: handoff.head,
        branch: handoff.branch,
        terms: keywords(
          [
            handoff.summary,
            handoff.workCompleted ?? '',
            handoff.workAttempted ?? '',
            ...handoff.discoveries,
            ...handoff.blockers,
            ...handoff.unresolved,
            handoff.subsystem ?? '',
          ].join(' '),
        ),
        raw: handoff,
      });
    }

    return items;
  }

  /** Distinct subsystems seen anywhere in the project's memory. */
  knownSubsystems(projectId: string): string[] {
    const rows = this.stmt(
      `SELECT subsystem, COUNT(*) AS count FROM (
         SELECT subsystem FROM tasks WHERE project_id = ? AND subsystem IS NOT NULL
         UNION ALL SELECT subsystem FROM decisions WHERE project_id = ? AND subsystem IS NOT NULL
         UNION ALL SELECT subsystem FROM constraints WHERE project_id = ? AND subsystem IS NOT NULL
         UNION ALL SELECT subsystem FROM bugs WHERE project_id = ? AND subsystem IS NOT NULL
         UNION ALL SELECT subsystem FROM findings WHERE project_id = ? AND subsystem IS NOT NULL
         UNION ALL SELECT subsystem FROM handoffs WHERE project_id = ? AND subsystem IS NOT NULL
       ) GROUP BY subsystem ORDER BY count DESC, subsystem`,
    ).all(projectId, projectId, projectId, projectId, projectId, projectId) as RawRow[];
    return rows.map((row) => String(row['subsystem']));
  }

  /** Fixture/diagnostic helper: the textual body currently indexed for a record. */
  indexedBody(kind: MemoryKind, refId: string): string | null {
    const row = this.stmt('SELECT title, body FROM memory_fts WHERE kind = ? AND ref_id = ? LIMIT 1').get(
      kind,
      refId,
    ) as RawRow | undefined;
    if (!row) return null;
    return truncate(`${String(row['title'])} ${String(row['body'] ?? '')}`.trim(), 2000);
  }

  close(): void {
    this.statementCache.clear();
    this.db.close();
  }
}

/**
 * Build an FTS5 MATCH expression from canonical retrieval terms.
 *
 * Each term expands to its shared terminology family (for example `ownership`
 * also searches `own`, `owner`, …) because the index keeps the original prose.
 * The stored documents are never rewritten, so search output stays verbatim.
 */
export function buildFtsQuery(terms: readonly string[]): string {
  const cleaned: string[] = [];
  for (const term of terms.slice(0, 24)) {
    for (const variant of termVariants(term)) {
      const value = variant.replace(/["*()]/g, '').trim();
      if (value.length > 0 && !cleaned.includes(value)) cleaned.push(value);
    }
  }
  if (cleaned.length === 0) return '""';
  return cleaned.map((term) => `"${term}"`).join(' OR ');
}

export type { CommitInfo };
