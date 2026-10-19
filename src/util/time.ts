/** Clock abstraction so tests can make recency and ordering deterministic. */
export interface Clock {
  now(): Date;
  /** Milliseconds since the epoch. */
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** A clock frozen at a fixed instant, advanceable by tests. */
export function fixedClock(start: string | Date = '2026-01-01T00:00:00.000Z'): Clock & { advance(ms: number): void; set(iso: string): void } {
  let current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    nowMs: () => current.getTime(),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(iso: string) {
      current = new Date(iso);
    },
  };
}

/** Current time as an ISO-8601 string (the storage format for every timestamp). */
export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function ageInDays(iso: string | null | undefined, clock: Clock): number | null {
  const date = parseIso(iso);
  if (!date) return null;
  return Math.max(0, (clock.nowMs() - date.getTime()) / 86_400_000);
}

/** Exponential decay with a configurable half-life, in [0, 1]. */
export function recencyScore(iso: string | null | undefined, clock: Clock, halfLifeDays: number): number {
  const age = ageInDays(iso, clock);
  if (age === null) return 0;
  if (halfLifeDays <= 0) return 1;
  return Math.pow(0.5, age / halfLifeDays);
}

/** Human-friendly relative age such as "3d ago" or "just now". */
export function humanAge(iso: string | null | undefined, clock: Clock): string {
  const age = ageInDays(iso, clock);
  if (age === null) return 'unknown age';
  if (age < 1 / 24) return 'just now';
  if (age < 1) return `${Math.round(age * 24)}h ago`;
  if (age < 30) return `${Math.round(age)}d ago`;
  if (age < 365) return `${Math.round(age / 30)}mo ago`;
  return `${(age / 365).toFixed(1)}y ago`;
}

