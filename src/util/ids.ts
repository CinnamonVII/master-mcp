import { randomBytes } from 'node:crypto';

/** Identifier prefixes, one per stored entity kind. */
export const ID_PREFIX = {
  project: 'prj',
  task: 'tsk',
  decision: 'dec',
  constraint: 'con',
  bug: 'bug',
  finding: 'fnd',
  verification: 'ver',
  handoff: 'hnd',
  activity: 'act',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/**
 * Generate a short, sortable, collision-resistant id such as `tsk_lz4k9m2x`.
 *
 * The time prefix keeps ids roughly ordered by creation which makes exported
 * JSON and audit logs pleasant to read; the random suffix avoids collisions
 * when many records are created in the same millisecond.
 */
export function newId(kind: IdKind, now: number = Date.now()): string {
  const time = Math.floor(now / 1000).toString(36);
  const rand = randomBytes(4).toString('hex').slice(0, 6);
  return `${ID_PREFIX[kind]}_${time}${rand}`;
}

/** True when `value` looks like an id issued by this server for the given kind. */
export function isIdOfKind(value: string, kind: IdKind): boolean {
  return new RegExp(`^${ID_PREFIX[kind]}_[a-z0-9]+$`).test(value);
}

/**
 * Convert arbitrary text into a stable slug usable as a project identifier.
 * Deterministic: the same input always yields the same slug.
 */
export function slugify(input: string, fallback = 'project'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

/**
 * Derive a project slug from a repository path or remote URL.
 * `git@github.com:acme/concurrent-studios.git` -> `concurrent-studios`
 * `/home/dev/projects/concurrent-studios` -> `concurrent-studios`
 */
export function projectSlugFromLocation(location: string): string {
  const trimmed = location.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const last = trimmed.split(/[/:]/).filter(Boolean).pop() ?? trimmed;
  return slugify(last);
}

/** Normalise a git remote URL so equivalent remotes compare equal. */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let value = url.trim();
  // scp-like syntax: git@github.com:owner/repo.git
  const scp = /^([a-zA-Z0-9_.-]+)@([^/:]+):(.+)$/.exec(value);
  if (scp?.[2] && scp[3]) value = `${scp[2]}/${scp[3]}`;
  value = value
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return value || null;
}
