/**
 * Minimal argument parser.
 *
 * Deliberately dependency free: the CLI surface is small and stable, and the
 * spec asks for boring reliability rather than a framework. Supports
 * `--flag value`, `--flag=value`, `-f value`, repeated flags, boolean flags and
 * `--` for trailing literal arguments.
 */

export type ArgValue = string | boolean;

export interface ParsedArgs {
  /** Positional arguments in order. */
  positionals: string[];
  /** Flags by name; repeated flags become arrays. */
  flags: Map<string, ArgValue | ArgValue[]>;
}

export interface FlagSpec {
  /** Canonical flag name without dashes. */
  name: string;
  /** Alternate spellings, including single-character short forms. */
  aliases?: string[];
  /** True when the flag takes no value. */
  boolean?: boolean;
}

export type ParseResult =
  | { ok: true; parsed: ParsedArgs }
  | { ok: false; error: string };

function canonical(name: string, specs: readonly FlagSpec[]): string | null {
  for (const spec of specs) {
    if (spec.name === name) return spec.name;
    if (spec.aliases?.includes(name)) return spec.name;
  }
  return null;
}

function isBoolean(spec: string, specs: readonly FlagSpec[]): boolean {
  return specs.find((candidate) => candidate.name === spec)?.boolean === true;
}

/** Parse an argument vector against a flag specification. */
export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParseResult {
  const positionals: string[] = [];
  const flags = new Map<string, ArgValue | ArgValue[]>();

  const assign = (name: string, value: ArgValue): void => {
    const existing = flags.get(name);
    if (existing === undefined) {
      flags.set(name, value);
      return;
    }
    if (Array.isArray(existing)) existing.push(value);
    else flags.set(name, [existing, value]);
  };

  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }

    if (token.startsWith('--') || (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token))) {
      const body = token.startsWith('--') ? token.slice(2) : token.slice(1);
      const eq = body.indexOf('=');
      const rawName = eq === -1 ? body : body.slice(0, eq);
      const name = canonical(rawName, specs);
      if (!name) return { ok: false, error: `unknown flag --${rawName}` };

      if (eq !== -1) {
        assign(name, body.slice(eq + 1));
        continue;
      }
      if (isBoolean(name, specs)) {
        assign(name, true);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined) return { ok: false, error: `flag --${rawName} requires a value` };
      assign(name, next);
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { ok: true, parsed: { positionals, flags } };
}

/** Single string value for a flag, or undefined. */
export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === 'string' ? last : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/** All values for a repeatable flag. */
export function flagList(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags.get(name);
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

/** True when a boolean flag was supplied. */
export function flagBool(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.flags.get(name);
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => item === true);
  return value === true;
}

/** Split a comma-separated flag into trimmed, non-empty values. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Split `"<command> => <result>"` verification syntax.
 *
 * `npm test => pass` yields both parts; a bare `npm test` yields the command
 * with an undefined result so the caller can apply its own default rather than
 * silently assuming success.
 */
export function splitVerification(value: string): { command: string; result: string | undefined } {
  const separatorIndex = value.lastIndexOf('=>');
  if (separatorIndex === -1) return { command: value.trim(), result: undefined };
  return {
    command: value.slice(0, separatorIndex).trim(),
    result: value.slice(separatorIndex + 2).trim() || undefined,
  };
}
