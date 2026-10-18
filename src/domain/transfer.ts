/**
 * Portable project snapshot.
 *
 * This is the on-disk backup format produced by `master_export` /
 * `master-mcp export` and consumed by `master-mcp import`. It is a superset of
 * the stored data with no derived fields, so a restore is lossless.
 */
import type {
  Bug,
  Constraint,
  Decision,
  Finding,
  Handoff,
  Project,
  Repository,
  Task,
  Verification,
} from './models.ts';

export const SNAPSHOT_FORMAT_VERSION = 1;

export interface ProjectSnapshot {
  formatVersion: number;
  /** Identifier of the producing tool and version, for diagnostics. */
  generator: string;
  exportedAt: string;
  project: Project;
  repositories: Repository[];
  tasks: Task[];
  decisions: Decision[];
  constraints: Constraint[];
  bugs: Bug[];
  findings: Finding[];
  verifications: Verification[];
  handoffs: Handoff[];
}

export type SnapshotCollection =
  | 'repositories'
  | 'tasks'
  | 'decisions'
  | 'constraints'
  | 'bugs'
  | 'findings'
  | 'verifications'
  | 'handoffs';

export interface RestoreReport {
  projectId: string;
  projectSlug: string;
  mode: 'merge' | 'replace';
  /** Records written per collection. */
  written: Record<string, number>;
  /** Ids that had to be re-issued because they were taken by another project. */
  remappedIds: Array<{ kind: string; from: string; to: string }>;
}

/** Validate an unknown value as a snapshot, returning a reason when invalid. */
export function validateSnapshot(value: unknown): { ok: true; snapshot: ProjectSnapshot } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'expected a JSON object at the top level' };
  }
  const candidate = value as Partial<ProjectSnapshot>;
  if (typeof candidate.formatVersion !== 'number') {
    return { ok: false, reason: 'missing numeric "formatVersion"' };
  }
  if (candidate.formatVersion > SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `formatVersion ${candidate.formatVersion} is newer than this build supports (${SNAPSHOT_FORMAT_VERSION})`,
    };
  }
  const project = candidate.project as Project | undefined;
  if (!project || typeof project.slug !== 'string' || typeof project.id !== 'string') {
    return { ok: false, reason: 'missing project.id or project.slug' };
  }
  const collections: SnapshotCollection[] = [
    'repositories',
    'tasks',
    'decisions',
    'constraints',
    'bugs',
    'findings',
    'verifications',
    'handoffs',
  ];
  for (const collection of collections) {
    const value = (candidate as Record<string, unknown>)[collection];
    if (value !== undefined && !Array.isArray(value)) {
      return { ok: false, reason: `"${collection}" must be an array when present` };
    }
  }
  return {
    ok: true,
    snapshot: {
      formatVersion: candidate.formatVersion,
      generator: typeof candidate.generator === 'string' ? candidate.generator : 'unknown',
      exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : new Date(0).toISOString(),
      project,
      repositories: (candidate.repositories ?? []) as Repository[],
      tasks: (candidate.tasks ?? []) as Task[],
      decisions: (candidate.decisions ?? []) as Decision[],
      constraints: (candidate.constraints ?? []) as Constraint[],
      bugs: (candidate.bugs ?? []) as Bug[],
      findings: (candidate.findings ?? []) as Finding[],
      verifications: (candidate.verifications ?? []) as Verification[],
      handoffs: (candidate.handoffs ?? []) as Handoff[],
    },
  };
}
