/**
 * Snapshot read/write.
 *
 * Kept in the store layer because it is the only other place that owns SQL:
 * a faithful restore must preserve ids and timestamps, which the normal typed
 * accessors deliberately do not expose.
 */
import type { Store } from './store.ts';
import type { ProjectSnapshot, RestoreReport } from '../domain/transfer.ts';
import { SNAPSHOT_FORMAT_VERSION } from '../domain/transfer.ts';
import { newId } from '../util/ids.ts';

/** Generous read bound: an export is a full dump, not a ranked query. */
const EXPORT_LIMIT = 100_000;

export function readSnapshot(
  store: Store,
  project: import('../domain/models.ts').Project,
  exportedAt: string,
): ProjectSnapshot {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    generator: 'master-mcp',
    exportedAt,
    project,
    repositories: store.listRepositories(project.id),
    tasks: store.listTasks(project.id, { limit: EXPORT_LIMIT }),
    decisions: store.listDecisions(project.id, { activeOnly: false, limit: EXPORT_LIMIT }),
    constraints: store.listConstraints(project.id, { activeOnly: false, limit: EXPORT_LIMIT }),
    bugs: store.listBugs(project.id, { limit: EXPORT_LIMIT }),
    findings: store.listFindings(project.id, { limit: EXPORT_LIMIT }),
    verifications: store.listVerifications(project.id, { limit: EXPORT_LIMIT }),
    handoffs: store.listHandoffs(project.id, { limit: EXPORT_LIMIT }),
  };
}

type SqlValue = string | number | bigint | null | Uint8Array;

const int = (value: boolean | null | undefined): SqlValue => (value === null || value === undefined ? null : value ? 1 : 0);
const arr = (value: readonly string[] | null | undefined): string => JSON.stringify(value ?? []);

export interface RestoreOptions {
  /** `merge` upserts; `replace` clears the target project's memory first. */
  mode: 'merge' | 'replace';
  /** Timestamp recorded for any row missing one. */
  now: string;
}

/**
 * Write a snapshot back into a database.
 *
 * The target project is resolved by slug: restoring into a fresh database keeps
 * the original ids, while restoring into a database that already has the project
 * merges into it. Ids that are already taken by a *different* project are
 * re-issued and reported, so an import can never silently move another
 * project's records.
 */
export function writeSnapshot(store: Store, snapshot: ProjectSnapshot, options: RestoreOptions): RestoreReport {
  const db = store.raw();
  const remappedIds: RestoreReport['remappedIds'] = [];
  const written: Record<string, number> = {};

  const existingBySlug = store.getProjectBySlug(snapshot.project.slug);
  const targetProjectId = existingBySlug?.id ?? snapshot.project.id;
  const replacement = existingBySlug && existingBySlug.id !== snapshot.project.id;
  if (replacement) {
    remappedIds.push({ kind: 'project', from: snapshot.project.id, to: existingBySlug.id });
  }

  // Task ids are the only ids referenced by other records, so collisions there
  // must cascade into dependencies, verifications and handoffs.
  const taskIdMap = new Map<string, string>();
  for (const task of snapshot.tasks) {
    const existing = store.getTask(task.id);
    if (existing && existing.projectId !== targetProjectId) {
      const replacementId = newId('task');
      taskIdMap.set(task.id, replacementId);
      remappedIds.push({ kind: 'task', from: task.id, to: replacementId });
    }
  }
  const mapTask = (id: string | null | undefined): string | null => {
    if (!id) return null;
    return taskIdMap.get(id) ?? id;
  };

  // Every other record id is referenced only within its own collection (a
  // task dependency is the exception, handled above), but an id owned by a
  // different project must still be re-issued: `INSERT OR REPLACE` would
  // otherwise move that project's record to the imported one.
  const idTakenElsewhere = (table: string, id: string): boolean => {
    const row = db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as
      | { project_id: string }
      | undefined;
    return row !== undefined && row.project_id !== targetProjectId;
  };
  const collectRemap = (
    table: 'decisions' | 'constraints' | 'bugs' | 'findings' | 'verifications' | 'handoffs',
    kind: 'decision' | 'constraint' | 'bug' | 'finding' | 'verification' | 'handoff',
    ids: readonly string[],
  ): Map<string, string> => {
    const map = new Map<string, string>();
    for (const id of new Set(ids)) {
      if (!idTakenElsewhere(table, id)) continue;
      const replacementId = newId(kind);
      map.set(id, replacementId);
      remappedIds.push({ kind, from: id, to: replacementId });
    }
    return map;
  };
  const decisionIdMap = collectRemap('decisions', 'decision', snapshot.decisions.map((row) => row.id));
  const constraintIdMap = collectRemap('constraints', 'constraint', snapshot.constraints.map((row) => row.id));
  const bugIdMap = collectRemap('bugs', 'bug', snapshot.bugs.map((row) => row.id));
  const findingIdMap = collectRemap('findings', 'finding', snapshot.findings.map((row) => row.id));
  const verificationIdMap = collectRemap('verifications', 'verification', snapshot.verifications.map((row) => row.id));
  const handoffIdMap = collectRemap('handoffs', 'handoff', snapshot.handoffs.map((row) => row.id));

  db.exec('BEGIN');
  try {
    if (options.mode === 'replace' && existingBySlug) {
      for (const table of [
        'verifications',
        'handoffs',
        'tasks',
        'decisions',
        'constraints',
        'bugs',
        'findings',
        'repositories',
      ]) {
        db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(targetProjectId);
      }
    }

    if (existingBySlug) {
      db.prepare(
        `UPDATE projects SET name = ?, description = ?, goal = ?, phase = ?, updated_at = ?, last_accessed_at = ?
         WHERE id = ?`,
      ).run(
        snapshot.project.name,
        snapshot.project.description,
        snapshot.project.goal,
        snapshot.project.phase,
        snapshot.project.updatedAt ?? options.now,
        snapshot.project.lastAccessedAt ?? options.now,
        targetProjectId,
      );
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO projects (id, slug, name, description, goal, phase, created_at, updated_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        targetProjectId,
        snapshot.project.slug,
        snapshot.project.name,
        snapshot.project.description,
        snapshot.project.goal,
        snapshot.project.phase,
        snapshot.project.createdAt ?? options.now,
        snapshot.project.updatedAt ?? options.now,
        snapshot.project.lastAccessedAt ?? options.now,
      );
    }
    written['project'] = 1;

    const repositoryStatement = db.prepare(
      `INSERT OR REPLACE INTO repositories (project_id, path, name, remote_url, is_primary, created_at, last_seen_at,
                                           last_branch, last_head, last_head_at, last_dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['repositories'] = 0;
    for (const repository of snapshot.repositories) {
      repositoryStatement.run(
        targetProjectId,
        repository.path,
        repository.name,
        repository.remoteUrl,
        int(repository.isPrimary),
        repository.createdAt ?? options.now,
        repository.lastSeenAt,
        repository.lastBranch,
        repository.lastHead,
        repository.lastHeadAt,
        int(repository.lastDirty),
      );
      written['repositories'] = (written['repositories'] ?? 0) + 1;
    }

    const taskStatement = db.prepare(
      `INSERT OR REPLACE INTO tasks (id, project_id, title, description, priority, status, subsystem, affected_files,
                                     dependencies, blockers, verification_requirements, verification_status, source,
                                     created_at, updated_at, completed_at, head, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['tasks'] = 0;
    for (const task of snapshot.tasks) {
      const id = taskIdMap.get(task.id) ?? task.id;
      taskStatement.run(
        id,
        targetProjectId,
        task.title,
        task.description,
        task.priority,
        task.status,
        task.subsystem,
        arr(task.affectedFiles),
        arr(task.dependencies.map((dependency) => mapTask(dependency) ?? dependency)),
        arr(task.blockers),
        arr(task.verificationRequirements),
        task.verificationStatus,
        task.source,
        task.createdAt ?? options.now,
        task.updatedAt ?? options.now,
        task.completedAt,
        task.head,
        task.branch,
      );
      written['tasks'] = (written['tasks'] ?? 0) + 1;
    }

    const decisionStatement = db.prepare(
      `INSERT OR REPLACE INTO decisions (id, project_id, statement, rationale, subsystem, alternatives, source, files,
                                         commits, status, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['decisions'] = 0;
    for (const decision of snapshot.decisions) {
      decisionStatement.run(
        decisionIdMap.get(decision.id) ?? decision.id,
        targetProjectId,
        decision.statement,
        decision.rationale,
        decision.subsystem,
        arr(decision.alternatives),
        decision.source,
        arr(decision.files),
        arr(decision.commits),
        decision.status,
        decision.supersededBy ? (decisionIdMap.get(decision.supersededBy) ?? decision.supersededBy) : null,
        decision.createdAt ?? options.now,
        decision.updatedAt ?? options.now,
      );
      written['decisions'] = (written['decisions'] ?? 0) + 1;
    }

    const constraintStatement = db.prepare(
      `INSERT OR REPLACE INTO constraints (id, project_id, statement, subsystem, severity, files, source, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['constraints'] = 0;
    for (const constraint of snapshot.constraints) {
      constraintStatement.run(
        constraintIdMap.get(constraint.id) ?? constraint.id,
        targetProjectId,
        constraint.statement,
        constraint.subsystem,
        constraint.severity,
        arr(constraint.files),
        constraint.source,
        int(constraint.active),
        constraint.createdAt ?? options.now,
        constraint.updatedAt ?? options.now,
      );
      written['constraints'] = (written['constraints'] ?? 0) + 1;
    }

    const bugStatement = db.prepare(
      `INSERT OR REPLACE INTO bugs (id, project_id, title, severity, status, subsystem, reproduction, expected, observed,
                                    evidence, files, commits, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['bugs'] = 0;
    for (const bug of snapshot.bugs) {
      bugStatement.run(
        bugIdMap.get(bug.id) ?? bug.id,
        targetProjectId,
        bug.title,
        bug.severity,
        bug.status,
        bug.subsystem,
        bug.reproduction,
        bug.expected,
        bug.observed,
        arr(bug.evidence),
        arr(bug.files),
        arr(bug.commits),
        bug.createdAt ?? options.now,
        bug.updatedAt ?? options.now,
        bug.resolvedAt,
      );
      written['bugs'] = (written['bugs'] ?? 0) + 1;
    }

    const findingStatement = db.prepare(
      `INSERT OR REPLACE INTO findings (id, project_id, statement, evidence, confidence, subsystem, files, symbols, source,
                                        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['findings'] = 0;
    for (const finding of snapshot.findings) {
      findingStatement.run(
        findingIdMap.get(finding.id) ?? finding.id,
        targetProjectId,
        finding.statement,
        arr(finding.evidence),
        finding.confidence,
        finding.subsystem,
        arr(finding.files),
        arr(finding.symbols),
        finding.source,
        finding.createdAt ?? options.now,
        finding.updatedAt ?? options.now,
      );
      written['findings'] = (written['findings'] ?? 0) + 1;
    }

    const verificationStatement = db.prepare(
      `INSERT OR REPLACE INTO verifications (id, project_id, task_id, method, command, result, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['verifications'] = 0;
    for (const verification of snapshot.verifications) {
      verificationStatement.run(
        verificationIdMap.get(verification.id) ?? verification.id,
        targetProjectId,
        mapTask(verification.taskId),
        verification.method,
        verification.command,
        verification.result,
        arr(verification.evidence),
        verification.createdAt ?? options.now,
      );
      written['verifications'] = (written['verifications'] ?? 0) + 1;
    }

    const handoffStatement = db.prepare(
      `INSERT OR REPLACE INTO handoffs (id, project_id, task_id, summary, work_attempted, work_completed, failures,
                                        discoveries, blockers, unresolved, follow_up, subsystem, branch, head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    written['handoffs'] = 0;
    for (const handoff of snapshot.handoffs) {
      handoffStatement.run(
        handoffIdMap.get(handoff.id) ?? handoff.id,
        targetProjectId,
        mapTask(handoff.taskId),
        handoff.summary,
        handoff.workAttempted,
        handoff.workCompleted,
        arr(handoff.failures),
        arr(handoff.discoveries),
        arr(handoff.blockers),
        arr(handoff.unresolved),
        arr(handoff.followUp),
        handoff.subsystem,
        handoff.branch,
        handoff.head,
        handoff.createdAt ?? options.now,
      );
      written['handoffs'] = (written['handoffs'] ?? 0) + 1;
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  reindexProject(store, targetProjectId);

  return {
    projectId: targetProjectId,
    projectSlug: snapshot.project.slug,
    mode: options.mode,
    written,
    remappedIds,
  };
}

/** Rebuild the full-text index for one project from the restored tables. */
export function reindexProject(store: Store, projectId: string): void {
  const db = store.raw();
  db.prepare('DELETE FROM memory_fts WHERE project_id = ?').run(projectId);
  const insert = db.prepare(
    `INSERT INTO memory_fts (kind, ref_id, project_id, created_at, subsystem, title, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const collect = (rows: Array<Record<string, SqlValue>>): void => {
    for (const row of rows) {
      insert.run(
        row['kind'] ?? null,
        row['ref_id'] ?? null,
        projectId,
        row['created_at'] ?? '',
        row['subsystem'] ?? '',
        row['title'] ?? '',
        row['body'] ?? '',
      );
    }
  };

  collect(db.prepare(
    `SELECT 'task' AS kind, id AS ref_id, updated_at AS created_at, subsystem, title,
            COALESCE(description, '') || ' ' || COALESCE(affected_files, '') || ' ' || COALESCE(blockers, '') AS body
     FROM tasks WHERE project_id = ?`,
  ).all(projectId) as Array<Record<string, SqlValue>>);

  collect(db.prepare(
    `SELECT 'decision' AS kind, id AS ref_id, created_at, subsystem, statement AS title,
            COALESCE(rationale, '') || ' ' || COALESCE(alternatives, '') AS body
     FROM decisions WHERE project_id = ?`,
  ).all(projectId) as Array<Record<string, SqlValue>>);

  collect(db.prepare(
    `SELECT 'constraint' AS kind, id AS ref_id, created_at, subsystem, statement AS title, '' AS body
     FROM constraints WHERE project_id = ?`,
  ).all(projectId) as Array<Record<string, SqlValue>>);

  collect(db.prepare(
    `SELECT 'bug' AS kind, id AS ref_id, created_at, subsystem, title,
            COALESCE(observed, '') || ' ' || COALESCE(expected, '') || ' ' || COALESCE(reproduction, '') || ' ' || COALESCE(evidence, '') AS body
     FROM bugs WHERE project_id = ?`,
  ).all(projectId) as Array<Record<string, SqlValue>>);

  collect(db.prepare(
    `SELECT 'finding' AS kind, id AS ref_id, created_at, subsystem, statement AS title,
            COALESCE(evidence, '') || ' ' || COALESCE(symbols, '') AS body
     FROM findings WHERE project_id = ?`,
  ).all(projectId) as Array<Record<string, SqlValue>>);

  collect(db.prepare(
    `SELECT 'verification' AS kind, id AS ref_id, created_at, NULL AS subsystem, method AS title,
            COALESCE(command, '') || ' ' || COALESCE(evidence, '') AS body
     FROM verifications WHERE project_id = ?`,
  ).all(projectId) as Array<Record<string, SqlValue>>);

  collect(db.prepare(
    `SELECT 'handoff' AS kind, id AS ref_id, created_at, subsystem, summary AS title,
            COALESCE(work_completed, '') || ' ' || COALESCE(work_attempted, '') || ' ' || COALESCE(discoveries, '') ||
            ' ' || COALESCE(blockers, '') || ' ' || COALESCE(unresolved, '') || ' ' || COALESCE(follow_up, '') AS body
     FROM handoffs WHERE project_id = ?`,
  ).all(projectId) as Array<Record<string, SqlValue>>);
}

