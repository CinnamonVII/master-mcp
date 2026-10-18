/**
 * Read-only git metadata adapter.
 *
 * This is deliberately shallow: a handful of plumbing commands with timeouts.
 * It never mutates the repository (no add/commit/checkout/reset), never walks
 * the working tree itself, and degrades to `error` when git is unavailable so a
 * brief can still be produced.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { CommitInfo, RepositoryObservation } from '../domain/models.ts';
import { normalizeRemoteUrl } from '../util/ids.ts';
import { log } from '../util/log.ts';

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CHANGED_FILES = 200;
const MAX_RECENT_FILES = 60;
const MAX_FILES_PER_COMMIT = 40;
const FIELD_SEPARATOR = '\u001f';
const FIELD_SEPARATOR_FORMAT = '%x1f';
/**
 * Each commit record starts with a NUL byte. A separator is needed because
 * `--name-only` lists a commit's files on the following lines, and a commit
 * that changed no files emits none: any separator that can appear inside a
 * path would let the next commit's header be read as a file. NUL cannot appear
 * in a path, so the split is unambiguous.
 */
const RECORD_MARKER = '\0';
const LOG_FORMAT = `%x00%H${FIELD_SEPARATOR_FORMAT}%h${FIELD_SEPARATOR_FORMAT}%an${FIELD_SEPARATOR_FORMAT}%aI${FIELD_SEPARATOR_FORMAT}%s`;
const HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Run a git command with args passed as an array (never through a shell). */
export async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolvePromise) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
          resolvePromise({ ok: false, stdout: stdout ?? '', stderr: stderr ?? String(error.message), code });
          return;
        }
        resolvePromise({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
      },
    );
  });
}

export interface GitProbe {
  /** True when `path` is inside a git work tree. */
  isRepo: boolean;
  /** Absolute repository root, when `path` is inside a work tree. */
  root: string | null;
  error: string | null;
}

/**
 * Determine whether a path is inside a git work tree. Costs one git call and
 * never inspects the file system contents.
 */
export async function probeRepository(path: string): Promise<GitProbe> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    return { isRepo: false, root: null, error: `path does not exist: ${absolute}` };
  }
  const result = await runGit(['rev-parse', '--show-toplevel'], absolute, 3000);
  if (!result.ok) {
    const message = result.stderr.trim().split('\n')[0] ?? 'not a git repository';
    return { isRepo: false, root: null, error: message };
  }
  const root = result.stdout.trim();
  return { isRepo: root.length > 0, root: root.length > 0 ? root : null, error: null };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface ParsedStatus {
  changed: string[];
  untracked: string[];
  dirty: boolean;
}

/** Parse `git status --porcelain=v1 -z` output. */
function parseStatus(stdout: string): ParsedStatus {
  const changed: string[] = [];
  const untracked: string[] = [];
  const entries = stdout.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 3) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const file = entry.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
      continue;
    }
    changed.push(file);
    // Rename/copy records are followed by the original path as its own entry.
    if (x === 'R' || x === 'C') index += 1;
  }
  return {
    changed: changed.slice(0, MAX_CHANGED_FILES),
    untracked: untracked.slice(0, MAX_CHANGED_FILES),
    dirty: changed.length > 0 || untracked.length > 0,
  };
}

interface ParsedLog {
  commits: CommitInfo[];
  recentFiles: string[];
}

/**
 * Parse `git log --pretty=format:%x00<fields> --name-only` output.
 *
 * A record is `<header>\n<file>\n...`; commits that changed no files (or only
 * files git lists as empty) yield just the header, which is why the record
 * boundary must be NUL rather than a newline.
 */
function parseLog(stdout: string): ParsedLog {
  const commits: CommitInfo[] = [];
  const recentFiles: string[] = [];
  const seenFiles = new Set<string>();

  for (const record of stdout.split(RECORD_MARKER)) {
    if (!record) continue;
    const lines = record.split('\n');
    const header = (lines.shift() ?? '').trim();
    if (!header) continue;
    const [hash = '', shortHash = '', author = '', date = '', ...subjectParts] = header.split(FIELD_SEPARATOR);
    if (!HASH_PATTERN.test(hash)) continue;
    const files = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, MAX_FILES_PER_COMMIT);
    commits.push({
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      author,
      date,
      subject: subjectParts.join(FIELD_SEPARATOR),
      files,
    });
    for (const file of files) {
      if (seenFiles.has(file) || recentFiles.length >= MAX_RECENT_FILES) continue;
      seenFiles.add(file);
      recentFiles.push(file);
    }
  }
  return { commits, recentFiles };
}

export interface ObserveOptions {
  /** Number of recent commits to read. Clamped to keep the call cheap. */
  recentCommits?: number;
  timeoutMs?: number;
}

/**
 * Collect the lightweight repository state used for ranking and conflict checks.
 * Five or six git calls, run in parallel where they do not depend on each other.
 */
export async function observeRepository(path: string, options: ObserveOptions = {}): Promise<RepositoryObservation> {
  const start = resolve(path);
  const commitCount = Math.min(Math.max(options.recentCommits ?? 10, 1), 100);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const probe = await probeRepository(start);
  const root = probe.root ?? (isDirectory(start) ? start : start);

  if (!probe.isRepo || !probe.root) {
    log.debug('repository is not a git work tree', { path: start, error: probe.error });
    return {
      root,
      name: basename(root) || root,
      remoteUrl: null,
      branch: null,
      head: null,
      headSubject: null,
      unborn: false,
      dirty: false,
      changedFiles: [],
      untrackedFiles: [],
      commits: [],
      recentlyChangedFiles: [],
      error: probe.error ?? 'not a git repository',
    };
  }

  const gitRoot = probe.root;
  const [remote, branch, head] = await Promise.all([
    runGit(['config', '--get', 'remote.origin.url'], gitRoot, timeout),
    runGit(['symbolic-ref', '--short', '-q', 'HEAD'], gitRoot, timeout),
    runGit(['rev-parse', 'HEAD'], gitRoot, timeout),
  ]);

  const unborn = !head.ok;
  const [status, logResult, headSubject] = await Promise.all([
    runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], gitRoot, timeout),
    unborn
      ? Promise.resolve<GitRunResult>({ ok: true, stdout: '', stderr: '', code: 0 })
      : runGit(['log', `-n${commitCount}`, `--pretty=format:${LOG_FORMAT}`, '--name-only'], gitRoot, timeout),
    unborn
      ? Promise.resolve<GitRunResult>({ ok: true, stdout: '', stderr: '', code: 0 })
      : runGit(['log', '-1', '--pretty=format:%s'], gitRoot, timeout),
  ]);

  const parsedStatus = status.ok ? parseStatus(status.stdout) : { changed: [], untracked: [], dirty: false };
  const parsedLog = logResult.ok ? parseLog(logResult.stdout) : { commits: [], recentFiles: [] };

  const detached = !branch.ok;
  return {
    root: gitRoot,
    name: basename(gitRoot) || gitRoot,
    remoteUrl: remote.ok ? normalizeRemoteUrl(remote.stdout.trim()) : null,
    branch: detached ? (unborn ? null : 'detached') : branch.stdout.trim(),
    head: unborn ? null : head.stdout.trim(),
    headSubject: headSubject.ok ? headSubject.stdout.trim() : null,
    unborn,
    dirty: parsedStatus.dirty,
    changedFiles: parsedStatus.changed,
    untrackedFiles: parsedStatus.untracked,
    commits: parsedLog.commits,
    recentlyChangedFiles: parsedLog.recentFiles,
    error: null,
  };
}

/** True when `ancestor` is reachable from `descendant`. Null when unknown. */
export async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean | null> {
  if (!ancestor || !descendant) return null;
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], root, 3000);
  if (result.ok) return true;
  // Exit code 1 means "not an ancestor"; anything else is an error (e.g. unknown object).
  return result.code === 1 ? false : null;
}

/** Number of commits on `to` that are not on `from`. Null when unknown. */
export async function countCommitsBetween(root: string, from: string, to: string): Promise<number | null> {
  if (!from || !to) return null;
  const result = await runGit(['rev-list', '--count', `${from}..${to}`], root, 3000);
  if (!result.ok) return null;
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Short hash for display; tolerant of nulls. */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return 'unknown';
  return hash.slice(0, 8);
}
