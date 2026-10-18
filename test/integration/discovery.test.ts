/**
 * Project discovery tests.
 *
 * Discovery has to work without configuration, from any subdirectory, for
 * several repositories in one database, and it must never write to a
 * repository. These tests run the real service against real directories.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { gitAvailable, harness, initGitRepo, writeFiles } from '../helpers/harness.ts';

const hasGit = gitAvailable();

describe('auto-discovery', () => {
  it('registers an unconfigured repository from the working directory', async () => {
    const h = harness('discovery');
    try {
      await h.with(async (service) => {
        const result = await service.context({ task: 'Investigate the build' });
        const brief = result.brief;
        assert.equal(brief.project.registeredNow, true);
        assert.equal(brief.project.discoverySource, 'created');
        assert.equal(brief.project.repositoryPath, h.dir);
        assert.match(result.text, /note: registered by this call/);
        assert.equal(result.projectSlug, brief.project.slug);
      });
    } finally {
      h.cleanup();
    }
  });

  it('names an unconfigured project after its directory', async () => {
    const h = harness('discovery');
    try {
      await h.with(async (service) => {
        const result = await service.context({ task: 'Investigate the build' });
        assert.equal(result.projectSlug, 'repo');
        assert.equal(result.brief.project.name, 'repo');
      });
    } finally {
      h.cleanup();
    }
  });

  it('reuses the registered project on the next call', async () => {
    const h = harness('discovery');
    try {
      await h.with(async (service) => {
        const first = await service.context({ task: 'Investigate the build' });
        const second = await service.context({ task: 'Investigate the build again' });
        assert.equal(first.projectSlug, second.projectSlug);
        assert.equal(second.brief.project.registeredNow, false);
      });
    } finally {
      h.cleanup();
    }
  });

  it('applies the config file when the repository has one', async () => {
    const h = harness('discovery');
    try {
      writeFiles(h.dir, {
        '.mcp/master-mcp.yaml': [
          'project: concurrent-studios',
          'goal: Ship the offer system',
          'phase: implementation',
          'subsystems:',
          '  - industry-offer',
          'verification:',
          '  test_command: npm test',
          '',
        ].join('\n'),
      });
      await h.with(async (service) => {
        const result = await service.context({ task: 'Fix the ownership check in the industry-offer' });
        assert.equal(result.projectSlug, 'concurrent-studios');
        assert.equal(result.brief.project.goal, 'Ship the offer system');
        assert.equal(result.brief.project.phase, 'implementation');
        assert.equal(result.brief.task.subsystem, 'industry-offer');
        assert.deepEqual(result.brief.verificationPlan.commands, ['npm test']);
      });
    } finally {
      h.cleanup();
    }
  });

  it('is idempotent about the config: a second call attaches no second repository', async () => {
    const h = harness('discovery');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': 'project: concurrent-studios\ngoal: Ship it\n' });
      await h.with(async (service) => {
        const first = await service.context({ task: 'First task' });
        const before = service.describe();
        const second = await service.context({ task: 'Second task' });
        const after = service.describe();
        assert.equal(first.projectSlug, 'concurrent-studios');
        assert.equal(second.projectSlug, 'concurrent-studios');
        assert.equal(after.projects.length, 1);
        assert.equal(after.projects[0]?.repositories, 1);
        assert.equal(before.projects[0]?.repositories, 1);
      });
    } finally {
      h.cleanup();
    }
  });

  it('finds the repository root from a nested working directory', { skip: !hasGit }, async () => {
    const h = harness('discovery');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'src/feature/main.ts': 'export {};\n' } }]);
      const nested = join(h.dir, 'src', 'feature');
      await h.with(
        async (service) => {
          const result = await service.context({ task: 'Fix the feature' });
          assert.equal(result.brief.project.repositoryPath, h.dir);
          assert.equal(result.brief.project.branch, 'main');
        },
        { cwd: nested },
      );
    } finally {
      h.cleanup();
    }
  });

  it('reports the discovery source when a path is supplied explicitly', async () => {
    const h = harness('discovery');
    try {
      const elsewhere = join(h.dir, '..', `${h.dir.split('/').pop()}-other`);
      writeFiles(elsewhere, { 'readme.md': 'other repo\n' });
      try {
        await h.with(async (service) => {
          // The first call registers the path; the second reports how it was found.
          await service.context({ task: 'Fix the docs', repositoryPath: elsewhere });
          const result = await service.context({ task: 'Fix the docs again', repositoryPath: elsewhere });
          assert.equal(result.brief.project.discoverySource, 'repository_path');
          assert.equal(result.brief.project.repositoryPath, elsewhere);
        });
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(elsewhere, { recursive: true, force: true });
      }
    } finally {
      h.cleanup();
    }
  });

  it('exposes several repositories in one database without mixing their memory', { skip: !hasGit }, async () => {
    const first = harness('discovery-a');
    const second = harness('discovery-b');
    try {
      initGitRepo(first.dir, [{ message: 'initial', files: { 'a.ts': 'export {};\n' } }]);
      initGitRepo(second.dir, [{ message: 'initial', files: { 'b.ts': 'export {};\n' } }]);

      // Two repositories, one database file.
      let firstSlug = '';
      await first.with(async (service) => {
        firstSlug = (await service.context({ task: 'Fix the alpha ownership check' })).projectSlug;
      });
      await second.with(
        async (service) => {
          const result = await service.context({ task: 'Fix the beta ownership check' });
          const described = service.describe();
          assert.equal(described.projects.length, 2, 'both repositories must be registered');
          // Same directory name, different repositories: the slugs must differ.
          assert.notEqual(result.projectSlug, firstSlug);
          // The second project's brief must not contain the first project's task.
          assert.ok(!result.text.includes('Fix the alpha ownership check'));
          assert.equal(described.projects.find((project) => project.slug === result.projectSlug)?.repositories, 1);
        },
        { dbPath: first.dbPath },
      );

      // The first project still has exactly its own memory.
      await first.with(async (service) => {
        const status = await service.status({});
        assert.equal(status.report.registered, true);
        assert.equal(status.report.project.repositoryPath, first.dir);
        assert.equal(status.report.memoryCounts['task'], 1);
      });
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it('rejects an unknown project name in a read-only call', async () => {
    const h = harness('discovery');
    try {
      await h.with(async (service) => {
        await assert.rejects(
          () => service.context({ task: 'Fix it', project: 'ghost-project', mode: 'read_only' }),
          /Unknown project "ghost-project"/,
        );
      });
    } finally {
      h.cleanup();
    }
  });

  it('accepts a near miss of a registered project name', async () => {
    const h = harness('discovery');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': 'project: concurrent-studios\n' });
      await h.with(async (service) => {
        await service.context({ task: 'First task' });
        const result = await service.context({ task: 'Second task', project: 'concurrent studio' });
        assert.equal(result.projectSlug, 'concurrent-studios');
      });
    } finally {
      h.cleanup();
    }
  });

  it('records config warnings on the brief instead of failing', async () => {
    const h = harness('discovery');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': 'project: [unclosed\n' });
      await h.with(async (service) => {
        const result = await service.context({ task: 'Fix it' });
        assert.ok(result.brief.warnings.some((warning) => /invalid YAML/.test(warning.text)));
        assert.equal(result.brief.project.registeredNow, true);
      });
    } finally {
      h.cleanup();
    }
  });

  it('keeps a path-based mapping stable when the same repository is used twice', async () => {
    const h = harness('discovery');
    try {
      await h.with(async (service) => {
        const first = await service.context({ task: 'Task one', repositoryPath: h.dir });
        const second = await service.context({ task: 'Task two', repositoryPath: h.dir });
        assert.equal(first.projectSlug, second.projectSlug);
        assert.equal(second.brief.project.discoverySource, 'repository_path');
      });
    } finally {
      h.cleanup();
    }
  });
});
