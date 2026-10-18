/**
 * Project-wide status.
 *
 * Answers "where does this project stand right now?" without a task. Like the
 * brief, it is assembled from ranked, capped selections rather than a dump.
 */
import type {
  Bug,
  MemoryItem,
  Project,
  Repository,
  RepositoryObservation,
  Task,
} from '../domain/models.ts';
import type { Clock } from '../util/time.ts';
import { humanAge } from '../util/time.ts';
import { truncate } from '../util/text.ts';
import { isOpenBug, priorityWeight, severityWeight } from '../domain/vocabulary.ts';
import { describeBug } from './ranking.ts';
import type { BriefWarning } from './assembler.ts';

export interface TaskLine {
  id: string;
  title: string;
  priority: string;
  status: string;
  subsystem: string | null;
  updatedAgo: string;
  verificationStatus: string;
  blockers: string[];
}

export interface BugLine {
  id: string;
  title: string;
  severity: string;
  status: string;
  detail: string;
  age: string;
}

export interface StatusReport {
  /** False when no project could be identified; the text explains what to do. */
  registered: boolean;
  project: {
    slug: string | null;
    name: string | null;
    phase: string | null;
    goal: string | null;
    branch: string | null;
    head: string | null;
    headSubject: string | null;
    dirty: boolean;
    changedFileCount: number;
    repositoryPath: string | null;
    gitAvailable: boolean;
  };
  /** Counts of stored memory by kind. */
  memoryCounts: Record<string, number>;
  activeWork: TaskLine[];
  todo: TaskLine[];
  criticalBugs: BugLine[];
  blockers: Array<{ taskId: string; title: string; blockers: string[] }>;
  latestHandoff: {
    id: string;
    summary: string;
    completed: string | null;
    age: string;
    head: string | null;
    failures: string[];
    followUp: string[];
  } | null;
  nextTask: (TaskLine & { reason: string }) | null;
  recentActivity: Array<{ kind: string; summary: string; age: string }>;
  warnings: BriefWarning[];
  /** Known projects, shown when nothing could be identified. */
  knownProjects: string[];
}

const STATUS_WEIGHT: Record<string, number> = {
  blocked: 1,
  in_progress: 0.8,
  implementation_done: 0.6,
  todo: 0.4,
  verified_done: 0,
  cancelled: 0,
};

function toTaskLine(task: Task, clock: Clock): TaskLine {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    status: task.status,
    subsystem: task.subsystem,
    updatedAgo: humanAge(task.updatedAt, clock),
    verificationStatus: task.verificationStatus,
    blockers: task.blockers,
  };
}

function toBugLine(bug: Bug, clock: Clock): BugLine {
  return {
    id: bug.id,
    title: bug.title,
    severity: bug.severity,
    status: bug.status,
    detail: describeBug(bug),
    age: humanAge(bug.updatedAt, clock),
  };
}

/**
 * Choose the single task that most deserves attention next.
 *
 * Priority dominates; among equals, work that is already blocked or in flight
 * beats work that has not started, and the longest-waiting task wins a tie.
 */
export function pickNextTask(tasks: readonly Task[], clock: Clock): (TaskLine & { reason: string }) | null {
  const candidates = tasks.filter((task) => task.status !== 'verified_done' && task.status !== 'cancelled');
  if (candidates.length === 0) return null;

  const scored = candidates.map((task) => ({
    task,
    score: priorityWeight(task.priority) * 1.0 + (STATUS_WEIGHT[task.status] ?? 0) * 0.5,
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.task.updatedAt !== b.task.updatedAt) return a.task.updatedAt.localeCompare(b.task.updatedAt);
    return a.task.id.localeCompare(b.task.id);
  });

  const winner = scored[0]!.task;
  const reason =
    winner.status === 'blocked'
      ? `${winner.priority} task is blocked and needs a decision`
      : winner.status === 'implementation_done'
        ? `${winner.priority} task is implemented but not verified`
        : winner.status === 'in_progress'
          ? `${winner.priority} task is already in progress`
          : `highest-priority open task (${winner.priority})`;
  return { ...toTaskLine(winner, clock), reason };
}

export interface BuildStatusInput {
  project: Project | null;
  repository: Repository | null;
  observation: RepositoryObservation | null;
  tasks: readonly Task[];
  items: readonly MemoryItem[];
  activity: Array<{ kind: string; summary: string; createdAt: string }>;
  /** HEAD recorded by the previous observation, for staleness reporting. */
  previousHead: string | null;
  headRelation: 'same' | 'advanced' | 'diverged' | 'unknown';
  clock: Clock;
  knownProjects: string[];
  warning?: string[];
}

/** Assemble the project-wide status report. Pure. */
export function buildStatus(input: BuildStatusInput): StatusReport {
  const clock = input.clock;
  const warnings: BriefWarning[] = [...(input.warning ?? []).map((text) => ({ level: 'warning' as const, text }))];

  if (!input.project) {
    return {
      registered: false,
      project: {
        slug: null,
        name: null,
        phase: null,
        goal: null,
        branch: input.observation?.branch ?? null,
        head: input.observation?.head ?? null,
        headSubject: input.observation?.headSubject ?? null,
        dirty: input.observation?.dirty ?? false,
        changedFileCount: input.observation?.changedFiles.length ?? 0,
        repositoryPath: input.observation?.root ?? input.repository?.path ?? null,
        gitAvailable: Boolean(input.observation && !input.observation.error),
      },
      memoryCounts: {},
      activeWork: [],
      todo: [],
      criticalBugs: [],
      blockers: [],
      latestHandoff: null,
      nextTask: null,
      recentActivity: [],
      warnings,
      knownProjects: input.knownProjects,
    };
  }

  const tasks = [...input.tasks];
  const activeTasks = tasks.filter(
    (task) => task.status === 'blocked' || task.status === 'in_progress' || task.status === 'implementation_done',
  );
  const todoTasks = tasks.filter((task) => task.status === 'todo');

  const bugs = input.items
    .filter((item) => item.kind === 'bug')
    .map((item) => item.raw as Bug)
    .filter((bug) => isOpenBug(bug.status))
    .sort((a, b) => {
      const delta = severityWeight(b.severity) - severityWeight(a.severity);
      if (delta !== 0) return delta;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 5);

  const latestHandoffItem = input.items
    .filter((item) => item.kind === 'handoff')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const handoff = latestHandoffItem?.raw as
    | (import('../domain/models.ts').Handoff | undefined)
    | undefined;

  const memoryCounts: Record<string, number> = {};
  for (const item of input.items) memoryCounts[item.kind] = (memoryCounts[item.kind] ?? 0) + 1;

  const previousHead = input.previousHead;
  const currentHead = input.observation?.head ?? null;
  if (previousHead && currentHead && previousHead !== currentHead) {
    warnings.push({
      level: 'warning',
      text:
        `Repository HEAD changed since the last recorded observation: ${previousHead.slice(0, 8)} → ` +
        `${currentHead.slice(0, 8)}${input.headRelation === 'diverged' ? ' (history diverged)' : ''}.`,
    });
  }
  if (handoff?.head && currentHead && handoff.head !== currentHead) {
    warnings.push({
      level: 'warning',
      text: `Latest handoff ${handoff.id} recorded HEAD ${handoff.head.slice(0, 8)}; repository is at ${currentHead.slice(0, 8)}.`,
    });
  }

  return {
    registered: true,
    project: {
      slug: input.project.slug,
      name: input.project.name,
      phase: input.project.phase,
      goal: input.project.goal,
      branch: input.observation?.branch ?? input.repository?.lastBranch ?? null,
      head: currentHead,
      headSubject: input.observation?.headSubject ?? null,
      dirty: input.observation?.dirty ?? false,
      changedFileCount:
        (input.observation?.changedFiles.length ?? 0) + (input.observation?.untrackedFiles.length ?? 0),
      repositoryPath: input.repository?.path ?? input.observation?.root ?? null,
      gitAvailable: Boolean(input.observation && !input.observation.error),
    },
    memoryCounts,
    activeWork: activeTasks
      .sort((a, b) => {
        const delta = (STATUS_WEIGHT[b.status] ?? 0) - (STATUS_WEIGHT[a.status] ?? 0);
        if (delta !== 0) return delta;
        return priorityWeight(b.priority) - priorityWeight(a.priority);
      })
      .slice(0, 8)
      .map((task) => toTaskLine(task, clock)),
    todo: todoTasks.slice(0, 5).map((task) => toTaskLine(task, clock)),
    criticalBugs: bugs.map((bug) => toBugLine(bug, clock)),
    blockers: activeTasks
      .filter((task) => task.blockers.length > 0)
      .slice(0, 5)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        blockers: task.blockers.map((blocker) => truncate(blocker, 160)),
      })),
    latestHandoff: handoff
      ? {
          id: handoff.id,
          summary: truncate(handoff.summary, 200),
          completed: handoff.workCompleted ? truncate(handoff.workCompleted, 200) : null,
          age: humanAge(handoff.createdAt, clock),
          head: handoff.head,
          failures: handoff.failures.slice(0, 3).map((failure) => truncate(failure, 160)),
          followUp: handoff.followUp.slice(0, 3).map((item) => truncate(item, 160)),
        }
      : null,
    nextTask: pickNextTask(tasks, clock),
    recentActivity: input.activity.slice(0, 6).map((entry) => ({
      kind: entry.kind,
      summary: truncate(entry.summary, 140),
      age: humanAge(entry.createdAt, clock),
    })),
    warnings,
    knownProjects: input.knownProjects,
  };
}
