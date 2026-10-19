/**
 * Domain models.
 *
 * Every persisted record carries the metadata needed to judge freshness
 * (`createdAt`, `source`) and relevance (`subsystem`, files). Nothing here
 * knows about SQLite, git or MCP.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'implementation_done'
  | 'verified_done'
  | 'blocked'
  | 'cancelled';

export type VerificationStatus = 'none' | 'claimed' | 'partial' | 'verified' | 'failed';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type BugStatus = 'open' | 'investigating' | 'fix_claimed' | 'fixed_verified' | 'wontfix';

/**
 * Reverse-engineering confidence ladder. Ordered from weakest to strongest so
 * comparisons are a simple index lookup, which keeps promotion rules explicit.
 */
export type Confidence =
  | 'hypothesis'
  | 'suspected'
  | 'statically_supported'
  | 'runtime_observed'
  | 'runtime_confirmed';

export type VerificationResult = 'pass' | 'fail' | 'partial' | 'unknown';

/** Coarse classification of what kind of work a task represents. */
export type TaskType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'investigation'
  | 'performance'
  | 'test'
  | 'docs'
  | 'maintenance'
  | 'unknown';

export type MemoryKind =
  | 'task'
  | 'decision'
  | 'constraint'
  | 'bug'
  | 'finding'
  | 'verification'
  | 'handoff';

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  goal: string | null;
  phase: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

/** A repository known to belong to a project. A project may have several. */
export interface Repository {
  id: number;
  projectId: string;
  path: string;
  name: string;
  remoteUrl: string | null;
  isPrimary: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  lastBranch: string | null;
  lastHead: string | null;
  lastHeadAt: string | null;
  lastDirty: boolean | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: Priority;
  status: TaskStatus;
  subsystem: string | null;
  affectedFiles: string[];
  /** Ids of tasks that must land first. */
  dependencies: string[];
  /** Free-text blockers describing why work cannot proceed. */
  blockers: string[];
  verificationRequirements: string[];
  verificationStatus: VerificationStatus;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  head: string | null;
  branch: string | null;
}

export interface Decision {
  id: string;
  projectId: string;
  statement: string;
  rationale: string | null;
  subsystem: string | null;
  alternatives: string[];
  source: string | null;
  files: string[];
  commits: string[];
  status: 'active' | 'superseded';
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Constraint {
  id: string;
  projectId: string;
  statement: string;
  subsystem: string | null;
  severity: Severity;
  files: string[];
  source: string | null;
  active: boolean;
  /** Constraint that replaced (and deactivated) this one, when one did. */
  replacedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Bug {
  id: string;
  projectId: string;
  title: string;
  severity: Severity;
  status: BugStatus;
  subsystem: string | null;
  reproduction: string | null;
  expected: string | null;
  observed: string | null;
  evidence: string[];
  files: string[];
  commits: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /**
   * Task whose completion claimed this fix. Used to re-check a `fix_claimed`
   * bug when later passes on the same task produce bug-specific evidence.
   */
  taskId: string | null;
}

export interface Finding {
  id: string;
  projectId: string;
  statement: string;
  evidence: string[];
  confidence: Confidence;
  subsystem: string | null;
  files: string[];
  symbols: string[];
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Verification {
  id: string;
  projectId: string;
  taskId: string | null;
  method: string;
  command: string | null;
  result: VerificationResult;
  evidence: string[];
  /** Declared task requirement this evidence was matched against, when any. */
  requirement: string | null;
  /** Bug this evidence was accepted as proving fixed, when any. */
  bugId: string | null;
  createdAt: string;
}

export interface Handoff {
  id: string;
  projectId: string;
  taskId: string | null;
  summary: string;
  workAttempted: string | null;
  workCompleted: string | null;
  failures: string[];
  discoveries: string[];
  blockers: string[];
  unresolved: string[];
  followUp: string[];
  subsystem: string | null;
  branch: string | null;
  head: string | null;
  createdAt: string;
}

/** Append-only audit trail of state changes made through the service layer. */
export interface ActivityEntry {
  id: string;
  projectId: string | null;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  source: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Repository observation (produced by the git adapter, not stored verbatim)
// ---------------------------------------------------------------------------

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

export interface RepositoryObservation {
  /** Absolute, normalised repository root. */
  root: string;
  name: string;
  remoteUrl: string | null;
  branch: string | null;
  head: string | null;
  headSubject: string | null;
  /** True when the repository has no commits yet. */
  unborn: boolean;
  dirty: boolean;
  changedFiles: string[];
  untrackedFiles: string[];
  commits: CommitInfo[];
  /** Files touched by the most recent commits, most recent first. */
  recentlyChangedFiles: string[];
  /** Populated when git is unavailable; the brief still works without it. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Search + relevance
// ---------------------------------------------------------------------------

/**
 * Uniform view over any stored memory record, used by full-text search and by
 * the relevance engine's FTS overlay.
 */
export interface MemoryHit {
  kind: MemoryKind;
  id: string;
  projectId: string;
  title: string;
  body: string;
  subsystem: string | null;
  status: string | null;
  createdAt: string;
  /** Search rank, when the hit came from a ranked query. Higher is better. */
  score?: number;
}

/** Any memory record, kept as a union so rendering can stay type-safe. */
export type AnyMemoryRecord =
  | Task
  | Decision
  | Constraint
  | Bug
  | Finding
  | Verification
  | Handoff;

/**
 * Storage-neutral projection of a memory record, built once per call and fed
 * to the relevance engine. `terms` is pre-tokenised searchable text so scoring
 * never re-tokenises the same record twice.
 */
export interface MemoryItem {
  kind: MemoryKind;
  id: string;
  projectId: string;
  /** Short, human label: a bug title, a decision statement, a handoff summary. */
  title: string;
  /** Supporting prose included in the rendered brief when the item is selected. */
  body: string;
  subsystem: string | null;
  files: string[];
  symbols: string[];
  status: string | null;
  priority: Priority | null;
  severity: Severity | null;
  confidence: Confidence | null;
  verification: VerificationStatus | null;
  /**
   * Effective freshness timestamp: `updatedAt ?? createdAt` for records that
   * carry an update time, creation time for immutable history (handoffs). Used
   * for both the recency signal and the deterministic tie-break.
   */
  createdAt: string;
  /** Id of the task this record belongs to, when it belongs to one. */
  taskId: string | null;
  /** Repository HEAD recorded with this item, when it recorded one. */
  head: string | null;
  branch: string | null;
  /** Pre-tokenised text (title + body + symbols) used by the scorer. */
  terms: string[];
  raw: AnyMemoryRecord;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  /** Project slug declared by `.mcp/master-mcp.yaml`. */
  project: string | null;
  name: string | null;
  goal: string | null;
  phase: string | null;
  description: string | null;
  importantPaths: string[];
  subsystems: string[];
  verification: {
    testCommand: string | null;
    lintCommand: string | null;
    buildCommand: string | null;
    extraChecks: string[];
  };
  context: {
    recentCommits: number;
    maxBriefTokens: number;
    /**
     * True when `context.max_brief_tokens` was set explicitly in the config
     * file. Automatic mode limits (deep/re) only apply when it was not.
     */
    maxBriefTokensSet: boolean;
  };
  /** Absolute path of the config file, when one was loaded. */
  sourcePath: string | null;
  /** Parse/validation problems; the brief reports these rather than failing. */
  warnings: string[];
}
