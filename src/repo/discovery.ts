/**
 * Project discovery.
 *
 * Resolves which project a call is about and which repository it is standing in,
 * using (in order): an explicit project, the supplied repository path, the
 * current working directory, the git root, `.mcp/master-mcp.yaml`, known
 * repository mappings, and finally a git remote match. A previously unknown
 * project is registered automatically so the first call already works.
 */
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Project, Repository, RepositoryObservation } from '../domain/models.ts';
import type { Store } from '../store/store.ts';
import type { Clock } from '../util/time.ts';
import { isoNow } from '../util/time.ts';
import { normalizeRemoteUrl, projectSlugFromLocation, slugify } from '../util/ids.ts';
import { probeRepository, observeRepository } from './git.ts';
import type { ObserveOptions } from './git.ts';
import { loadProjectConfig } from '../config/config.ts';
import type { ProjectConfig } from '../domain/models.ts';
import { log } from '../util/log.ts';
import { closestMatch } from '../util/text.ts';

export type DiscoverySource =
  | 'explicit'
  | 'repository_path'
  | 'cwd'
  | 'config'
  | 'remote'
  | 'directory'
  | 'created';

export interface DiscoveryInput {
  store: Store;
  clock: Clock;
  /** Project slug, name or id supplied by the caller. */
  project?: string | null;
  /** Repository path supplied by the caller. */
  repositoryPath?: string | null;
  /** Directory the call is being made from (CLI/MCP process working directory). */
  cwd?: string | null;
  /** When false, discovery will not create projects or repositories. */
  allowCreate: boolean;
  /** Git observation options (recent commit count). */
  observe?: ObserveOptions;
  /** Skip the "unchanged" fast path and re-read repository metadata. */
  refresh?: boolean;
}

export interface DiscoveryResult {
  project: Project;
  repository: Repository | null;
  /** Absolute path of the repository this call concerns. */
  repositoryPath: string | null;
  observation: RepositoryObservation | null;
  config: ProjectConfig;
  /** How the project was identified. */
  source: DiscoverySource;
  /** True when this call registered a new project. */
  createdProject: boolean;
  /** True when this call attached a new repository to the project. */
  createdRepository: boolean;
  warnings: string[];
}

/** Resolve a caller-supplied path to an absolute path, following symlinks when it exists. */
export function normalizeUserPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * First free slug for a newly registered project.
 *
 * Two repositories can legitimately share a directory name ("api", "app"), and
 * they belong to different projects unless their remote matches; the slug has
 * to be disambiguated rather than colliding with an existing row.
 */
function uniqueSlug(store: Store, slug: string): string {
  if (!store.getProjectBySlug(slug)) return slug;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!store.getProjectBySlug(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

function findProjectByReference(store: Store, reference: string): Project | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  return (
    store.getProject(trimmed) ??
    store.getProjectBySlug(slugify(trimmed)) ??
    store.getProjectBySlug(trimmed) ??
    findProjectByName(store, trimmed) ??
    findProjectByFuzzyName(store, trimmed)
  );
}

function findProjectByName(store: Store, name: string): Project | null {
  const needle = name.trim().toLowerCase();
  return store.listProjects().find((project) => project.name.toLowerCase() === needle) ?? null;
}

/** Tolerate near misses such as "concurrent studios" for "concurrent-studios". */
function findProjectByFuzzyName(store: Store, name: string): Project | null {
  const projects = store.listProjects();
  if (projects.length === 0) return null;
  const match = closestMatch(name, projects.map((project) => `${project.slug} ${project.name}`));
  if (!match) return null;
  const matchedSlug = match.split(' ')[0] ?? '';
  return projects.find((project) => project.slug === matchedSlug) ?? null;
}

/** Choose a human name and slug for a project being discovered for the first time. */
function inferIdentity(input: {  config: ProjectConfig;
  observation: RepositoryObservation | null;
  repositoryPath: string | null;
}): { name: string; slug: string } {
  const remoteName = input.observation?.remoteUrl
    ? projectSlugFromLocation(input.observation.remoteUrl)
    : null;
  const directoryName = input.observation?.name ?? (input.repositoryPath ? basename(input.repositoryPath) : null);
  const slug = input.config.project ?? remoteName ?? (directoryName ? slugify(directoryName) : 'project');
  const name = input.config.name ?? input.config.project ?? remoteName ?? directoryName ?? slug;
  return { name, slug };
}

function attachRepository(input: {
  store: Store;
  project: Project;
  repositoryPath: string;
  observation: RepositoryObservation | null;
  now: string;
  warnings: string[];
}): { repository: Repository; created: boolean } {
  const existing = input.store.getRepositoryByPath(input.repositoryPath);
  if (existing && existing.projectId !== input.project.id) {
    const otherProject = input.store.getProject(existing.projectId);
    input.warnings.push(
      `Repository ${input.repositoryPath} is already registered to project "${otherProject?.slug ?? existing.projectId}"; ` +
        `using it for "${input.project.slug}" as well.`,
    );
  }
  const isPrimary = input.store.listRepositories(input.project.id).length === 0;
  const repository = input.store.upsertRepository({
    projectId: input.project.id,
    path: input.repositoryPath,
    name: input.observation?.name ?? basename(input.repositoryPath),
    remoteUrl: input.observation?.remoteUrl ?? null,
    isPrimary: existing?.isPrimary ?? isPrimary,
    now: input.now,
  });
  return { repository, created: !existing };
}

/** Record a repository row even when git is unavailable, so path mapping still works. */
async function observeMaybe(
  repositoryPath: string,
  options: ObserveOptions | undefined,
): Promise<RepositoryObservation | null> {
  try {
    return await observeRepository(repositoryPath, options);
  } catch (error) {
    log.warn('repository observation failed', { path: repositoryPath, error: String(error) });
    return null;
  }
}

/**
 * Resolve the project, repository and configuration for a single call.
 *
 * Returns a project even for a brand new repository: the agent's first call
 * must not fail just because nothing has been recorded yet.
 */
export async function discoverProject(input: DiscoveryInput): Promise<DiscoveryResult> {
  const store = input.store;
  const clock = input.clock;
  const now = isoNow(clock);
  const warnings: string[] = [];
  const observeOptions: ObserveOptions = { ...input.observe };
  if (input.refresh) observeOptions.timeoutMs = observeOptions.timeoutMs ?? 5000;

  const explicitPath = input.repositoryPath ? normalizeUserPath(input.repositoryPath) : null;
  const cwdPath = input.cwd ? normalizeUserPath(input.cwd) : process.cwd();
  const startingPath = explicitPath ?? cwdPath;
  const source: DiscoverySource = explicitPath ? 'repository_path' : 'cwd';

  // ---- 1. Explicit project -------------------------------------------------
  if (input.project) {
    const project = findProjectByReference(store, input.project);
    if (!project) {
      if (!input.allowCreate) {
        throw Object.assign(new Error(`Unknown project "${input.project}"`), {
          code: 'NOT_FOUND',
          hint: 'Register it with a writable call (mode != read_only) or pass repository_path.',
        });
      }
      const slug = uniqueSlug(store, slugify(input.project));
      const created = store.createProject({ slug, name: input.project, now });
      const observation = await observeMaybe(startingPath, observeOptions);
      const { repository } = attachRepository({
        store,
        project: created,
        repositoryPath: observation?.root ?? startingPath,
        observation,
        now,
        warnings,
      });
      const config = await loadConfigFor(startingPath, observation);
      warnings.push(...config.warnings);
      return {
        project: created,
        repository,
        repositoryPath: repository.path,
        observation,
        config: { ...config },
        source: 'created',
        createdProject: true,
        createdRepository: true,
        warnings,
      };
    }
    return finish({
      store,
      clock,
      project,
      observation: await observeMaybe(startingPath, observeOptions),
      configWarnings: warnings,
      startingPath,
      allowCreate: input.allowCreate,
      source: 'explicit',
      now,
      observeOptions,
    });
  }

  // ---- 2. Known repository mapping by path --------------------------------
  const mappedByPath = store.findRepositoryForPath(startingPath);
  if (mappedByPath) {
    const project = store.getProject(mappedByPath.projectId);
    if (project) {
      return finish({
        store,
        clock,
        project,
        observation: await observeMaybe(mappedByPath.path, observeOptions),
        configWarnings: warnings,
        startingPath,
        allowCreate: input.allowCreate,
        source,
        now,
        observeOptions,
      });
    }
  }

  // ---- 3. Git root + remote, then config, then directory name -------------
  const probe = await probeRepository(startingPath);
  const repositoryPath = probe.root ?? startingPath;

  const mappedByRoot = store.getRepositoryByPath(repositoryPath);
  if (mappedByRoot) {
    const project = store.getProject(mappedByRoot.projectId);
    if (project) {
      return finish({
        store,
        clock,
        project,
        observation: await observeMaybe(repositoryPath, observeOptions),
        configWarnings: warnings,
        startingPath,
        allowCreate: input.allowCreate,
        source,
        now,
        observeOptions,
      });
    }
  }

  const observation = await observeMaybe(repositoryPath, observeOptions);
  const normalizedRemote = normalizeRemoteUrl(observation?.remoteUrl);
  if (normalizedRemote) {
    const remoteMatch = store
      .listRepositories()
      .find((repository) => normalizeRemoteUrl(repository.remoteUrl) === normalizedRemote);
    if (remoteMatch) {
      const project = store.getProject(remoteMatch.projectId);
      if (project) {
        const result = await finish({
          store,
          clock,
          project,
          observation,
          configWarnings: warnings,
          startingPath,
          allowCreate: input.allowCreate,
          source: 'remote',
          now,
          observeOptions,
        });
        if (result.repository?.path !== repositoryPath && input.allowCreate) {
          // The same remote was checked out at a second path; register it.
          attachRepository({
            store,
            project,
            repositoryPath,
            observation,
            now,
            warnings: result.warnings,
          });
        }
        return result;
      }
    }
  }

  const config = await loadConfigFor(startingPath, observation);
  if (config.project) {
    const byConfig = store.getProjectBySlug(config.project);
    if (byConfig) {
      return finish({
        store,
        clock,
        project: byConfig,
        observation,
        configWarnings: warnings,
        startingPath,
        allowCreate: input.allowCreate,
        source: 'config',
        now,
        observeOptions,
      });
    }
    if (!input.allowCreate) {
      throw Object.assign(new Error(`Project "${config.project}" referenced by ${config.sourcePath} is not registered.`), {
        code: 'NOT_FOUND',
        hint: 'Run a writable call to register it, or drop mode=read_only.',
      });
    }
  }

  // ---- 4. Auto-register ---------------------------------------------------
  if (!input.allowCreate) {
    throw Object.assign(
      new Error(`No registered project matches ${startingPath}.`),
      { code: 'NOT_FOUND', hint: 'Run a writable call to register it, or pass "project".' },
    );
  }

  const identity = inferIdentity({ config, observation, repositoryPath });
  const project = store.createProject({
    slug: uniqueSlug(store, identity.slug),
    name: identity.name,
    description: observation?.remoteUrl ?? null,
    goal: config.goal,
    phase: config.phase,
    now,
  });
  warnings.push(...config.warnings);
  const { repository } = attachRepository({
    store,
    project,
    repositoryPath,
    observation,
    now,
    warnings,
  });
  return {
    project,
    repository,
    repositoryPath: repository.path,
    observation,
    config,
    source: 'created',
    createdProject: true,
    createdRepository: true,
    warnings,
  };
}

async function loadConfigFor(startingPath: string, observation: RepositoryObservation | null): Promise<ProjectConfig> {
  const stopAt = observation?.root && startingPath.startsWith(observation.root) ? observation.root : startingPath;
  const loaded = loadProjectConfig(startingPath, stopAt);
  return loaded.config;
}

/**
 * Shared tail for the "project already known" branches: load config, ensure the
 * repository is attached, and return.
 */
async function finish(input: {
  store: Store;
  clock: Clock;
  project: Project;
  observation: RepositoryObservation | null;
  configWarnings: string[];
  startingPath: string;
  allowCreate: boolean;
  source: DiscoverySource;
  now: string;
  observeOptions: ObserveOptions | undefined;
}): Promise<DiscoveryResult> {
  const warnings = [...input.configWarnings];
  const repositoryPath = input.observation?.root ?? input.startingPath;
  const existing = input.store.findRepositoryForPath(repositoryPath);
  let repository: Repository | null = existing ?? null;
  let createdRepository = false;

  if (input.allowCreate && (!existing || existing.projectId !== input.project.id)) {
    const attached = attachRepository({
      store: input.store,
      project: input.project,
      repositoryPath,
      observation: input.observation,
      now: input.now,
      warnings,
    });
    repository = attached.repository;
    createdRepository = attached.created;
  }

  const config = await loadConfigFor(input.startingPath, input.observation);
  warnings.push(...config.warnings);

  // Config may declare the project identity; fill in gaps that were never recorded.
  if (input.allowCreate) {
    const patch: { goal?: string; phase?: string; name?: string; now: string } = { now: input.now };
    if (!input.project.goal && config.goal) patch.goal = config.goal;
    if (!input.project.phase && config.phase) patch.phase = config.phase;
    if (config.name && input.project.name !== config.name && input.project.name === input.project.slug) {
      patch.name = config.name;
    }
    if (Object.keys(patch).length > 1) input.store.updateProject(input.project.id, patch);
  }

  return {
    project: input.store.getProject(input.project.id) ?? input.project,
    repository,
    repositoryPath,
    observation: input.observation,
    config,
    source: input.source,
    createdProject: false,
    createdRepository,
    warnings,
  };
}
