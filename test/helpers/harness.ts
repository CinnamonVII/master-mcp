/**
 * Test harness.
 *
 * Every test runs inside its own temporary directory with its own SQLite file
 * and a frozen clock, so assertions never depend on the developer's machine,
 * on wall-clock timing, or on a shared database. Git is exercised for real
 * where a test needs repository metadata — master-mcp only ever reads it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MasterMcpService } from '../../src/app/service.ts';
import type { Clock } from '../../src/util/time.ts';
import { fixedClock } from '../../src/util/time.ts';
import type { Brief } from '../../src/app/assembler.ts';

export type TestClock = Clock & { advance(ms: number): void; set(iso: string): void };

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export function tempDir(prefix = 'master-mcp-test'): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** Write a tree of files, creating parent directories as needed. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run git in `cwd`, returning stdout. Throws when git fails. */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' });
}

/** Run git, returning stdout or null when the command fails. */
export function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export interface CommitSpec {
  message: string;
  /** Files added or overwritten by this commit. */
  files?: Readonly<Record<string, string>>;
  /** Pin author/committer dates to keep ordering deterministic. */
  date?: string | null;
}

/** Initialise a repository with a deterministic identity and optional commits. */
export function initGitRepo(dir: string, commits: readonly CommitSpec[] = []): string[] {
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return commits.map((commit) => commitAll(dir, commit));
}

/** Stage and commit everything currently in the tree; returns the new hash. */
export function commitAll(dir: string, spec: CommitSpec): string {
  if (spec.files) writeFiles(dir, spec.files);
  git(dir, ['add', '-A']);
  const env = spec.date
    ? { GIT_AUTHOR_DATE: spec.date, GIT_COMMITTER_DATE: spec.date }
    : undefined;
  execFileSync('git', ['commit', '-m', spec.message, '--allow-empty'], {
    cwd: dir,
    encoding: 'utf8',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface Harness {
  /** Repository / working directory used by most tests. */
  dir: string;
  /** Database file used by every service opened from this harness. */
  dbPath: string;
  clock: TestClock;
  /** Open one service instance. Close it when the test is done with it. */
  open(options?: OpenOptions): MasterMcpService;
  /** Open a service, run `fn`, and always close it. */
  with<T>(fn: (service: MasterMcpService) => T | Promise<T>, options?: OpenOptions): Promise<T>;
  cleanup(): void;
}

export interface OpenOptions {
  cwd?: string | null;
  dbPath?: string | null;
  clock?: TestClock | null;
}

export function harness(prefix = 'master-mcp-test'): Harness {
  const root = tempDir(prefix);
  const dir = join(root, 'repo');
  const dbPath = join(root, 'memory.sqlite');
  const clock = fixedClock('2026-03-01T09:00:00.000Z');
  mkdirSync(dir, { recursive: true });

  return {
    dir,
    dbPath,
    clock,
    open(options: OpenOptions = {}): MasterMcpService {
      return MasterMcpService.open({
        dbPath: options.dbPath ?? dbPath,
        cwd: options.cwd ?? dir,
        clock: options.clock ?? clock,
      });
    },
    async with<T>(fn: (service: MasterMcpService) => T | Promise<T>, options: OpenOptions = {}): Promise<T> {
      const service = this.open(options);
      try {
        return await fn(service);
      } finally {
        service.close();
      }
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Read a service result's text and fail loudly on an unexpected shape. */
export function lines(text: string): string[] {
  return text.split('\n');
}

/** Extract one section from a rendered brief (sections are blank-line separated). */
export function section(text: string, title: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(title);
  if (start === -1) return '';
  const blank = lines.indexOf('', start + 1);
  const end = blank === -1 ? lines.length : blank;
  return lines.slice(start + 1, end).join('\n');
}

/** True when a rendered brief contains a section with this title. */
export function hasSection(text: string, title: string): boolean {
  return text.split('\n').includes(title);
}

// ---------------------------------------------------------------------------
// Brief fixtures (for render tests that must not touch a database)
// ---------------------------------------------------------------------------

/** A minimal but complete brief, overridable field by field. */
export function sampleBrief(overrides: Partial<Brief> = {}): Brief {
  const base: Brief = {
    generatedAt: '2026-03-01T09:00:00.000Z',
    project: {
      slug: 'sample-project',
      name: 'Sample Project',
      goal: 'Ship a working thing.',
      phase: 'implementation',
      branch: 'main',
      head: '0'.repeat(40),
      headShort: '0000000',
      headSubject: 'initial commit',
      dirty: false,
      changedFileCount: 0,
      untrackedFileCount: 0,
      repositoryPath: '/tmp/sample-project',
      repositoryName: 'sample-project',
      discoverySource: 'cwd',
      registeredNow: false,
      gitAvailable: true,
    },
    task: {
      text: 'Fix the ownership check',
      taskId: 'tsk_fixture',
      status: 'in_progress',
      priority: 'P2',
      type: 'bugfix',
      typeConfidence: 'medium',
      subsystem: 'ownership',
      subsystemConfidence: 'medium',
      likelyComponents: [],
      affectedFiles: [],
      inferredFiles: [],
      notes: [],
      mode: 'auto',
      interpretability: 'medium',
    },
    constraints: [],
    bugs: [],
    decisions: [],
    findings: [],
    attempts: [],
    verifications: [],
    likelyFiles: [],
    uncommittedFiles: [],
    recentCommits: [],
    recentlyChangedFiles: [],
    risk: { level: 'low', reasons: ['No elevated risk signals are recorded for this task.'] },
    approach: [{ text: 'Reproduce the defect before editing.', source: 'template' }],
    verificationPlan: {
      commands: ['npm test'],
      requirements: [],
      manualChecks: [],
      regressionAreas: [],
      unknown: false,
    },
    nextAction: 'Start by inspecting src/ownership.ts.',
    followUps: [],
    gaps: [],
    warnings: [],
    reverseEngineering: null,
    stats: { memoryConsidered: 0, memorySelected: 0, countsByKind: {} },
  };
  return { ...base, ...overrides };
}
