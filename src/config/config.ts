/**
 * Optional local configuration: `<repo>/.mcp/master-mcp.yaml`.
 *
 * Configuration is a hint, never a requirement: a missing or malformed file
 * produces warnings on the brief and the call still succeeds.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProjectConfig } from '../domain/models.ts';
import { slugify } from '../util/ids.ts';

export const CONFIG_RELATIVE_PATH = '.mcp/master-mcp.yaml';

export const DEFAULT_CONFIG: ProjectConfig = {
  project: null,
  name: null,
  goal: null,
  phase: null,
  description: null,
  importantPaths: [],
  subsystems: [],
  verification: { testCommand: null, lintCommand: null, buildCommand: null, extraChecks: [] },
  context: { recentCommits: 10, maxBriefTokens: 2000, maxBriefTokensSet: false },
  sourcePath: null,
  warnings: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read either snake_case or camelCase spellings of the same key. */
function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return null;
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return out.length === value.length ? out.map((item) => item.trim()) : null;
}

function asString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** Interpret a parsed YAML document as a project config, collecting warnings. */
export function interpretConfig(document: unknown, sourcePath: string | null): ProjectConfig {
  const config: ProjectConfig = {
    ...DEFAULT_CONFIG,
    // Nested defaults are copied so an explicit value in one file can never
    // leak into the defaults used by the next load.
    verification: { ...DEFAULT_CONFIG.verification },
    context: { ...DEFAULT_CONFIG.context },
    sourcePath,
    warnings: [],
  };
  if (document === null || document === undefined) return config;
  if (!isRecord(document)) {
    config.warnings.push(`${sourcePath ?? 'config'}: expected a YAML mapping at the top level; ignoring file.`);
    return config;
  }

  const project = asString(pick(document, 'project', 'project_slug', 'slug'));
  if (project) config.project = slugify(project);
  config.name = asString(pick(document, 'name')) ?? null;
  config.goal = asString(pick(document, 'goal')) ?? null;
  config.phase = asString(pick(document, 'phase', 'current_phase')) ?? null;
  config.description = asString(pick(document, 'description')) ?? null;

  const importantPaths = asStringArray(pick(document, 'important_paths', 'importantPaths'));
  if (importantPaths === null) {
    config.warnings.push(`${sourcePath ?? 'config'}: "important_paths" must be a list of strings; ignoring it.`);
  } else {
    config.importantPaths = importantPaths;
  }

  const subsystems = asStringArray(pick(document, 'subsystems'));
  if (subsystems === null) {
    config.warnings.push(`${sourcePath ?? 'config'}: "subsystems" must be a list of strings; ignoring it.`);
  } else {
    config.subsystems = subsystems;
  }

  const verification = pick(document, 'verification');
  if (verification !== undefined) {
    if (!isRecord(verification)) {
      config.warnings.push(`${sourcePath ?? 'config'}: "verification" must be a mapping; ignoring it.`);
    } else {
      config.verification = {
        testCommand: asString(pick(verification, 'test_command', 'testCommand', 'test')) ?? null,
        lintCommand: asString(pick(verification, 'lint_command', 'lintCommand', 'lint')) ?? null,
        buildCommand: asString(pick(verification, 'build_command', 'buildCommand', 'build')) ?? null,
        extraChecks: asStringArray(pick(verification, 'extra_checks', 'extraChecks')) ?? [],
      };
    }
  }

  const context = pick(document, 'context');
  if (context !== undefined) {
    if (!isRecord(context)) {
      config.warnings.push(`${sourcePath ?? 'config'}: "context" must be a mapping; ignoring it.`);
    } else {
      const recentCommits = asPositiveInt(pick(context, 'recent_commits', 'recentCommits'));
      const maxBriefTokens = asPositiveInt(pick(context, 'max_brief_tokens', 'maxBriefTokens'));
      if (recentCommits !== undefined) config.context.recentCommits = Math.min(recentCommits, 100);
      if (maxBriefTokens !== undefined) {
        config.context.maxBriefTokens = Math.min(Math.max(maxBriefTokens, 400), 12000);
        config.context.maxBriefTokensSet = true;
      }
    }
  }

  return config;
}

export interface LoadConfigResult {
  config: ProjectConfig;
  /** First existing config file found while walking up from the start directory. */
  found: boolean;
}

/**
 * Load configuration by walking up from `startDir`.
 *
 * Walking up means a call made from `repo/src/feature` still finds
 * `repo/.mcp/master-mcp.yaml`, which matters because agents run shell commands
 * from arbitrary subdirectories.
 */
export function loadProjectConfig(startDir: string, stopAt?: string | null): LoadConfigResult {
  const visited: string[] = [];
  const stop = stopAt ? resolve(stopAt) : null;
  let current = resolve(startDir);
  const seen = new Set<string>();

  while (!seen.has(current)) {
    seen.add(current);
    const candidate = join(current, CONFIG_RELATIVE_PATH);
    if (existsSync(candidate)) {
      try {
        if (!statSync(candidate).isFile()) break;
        const raw = readFileSync(candidate, 'utf8');
        let document: unknown;
        try {
          document = parseYaml(raw);
        } catch (error) {
          return {
            config: {
              ...DEFAULT_CONFIG,
              sourcePath: candidate,
              warnings: [`${candidate}: invalid YAML (${(error as Error).message.split('\n')[0]}); using defaults.`],
            },
            found: true,
          };
        }
        return { config: interpretConfig(document, candidate), found: true };
      } catch (error) {
        return {
          config: {
            ...DEFAULT_CONFIG,
            sourcePath: candidate,
            warnings: [`${candidate}: could not be read (${(error as Error).message}); using defaults.`],
          },
          found: true,
        };
      }
    }
    visited.push(current);
    if (stop && current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { config: { ...DEFAULT_CONFIG }, found: false };
}
