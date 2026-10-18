/**
 * Git adapter tests.
 *
 * The adapter is read-only by design, so the tests check both what it reads and
 * that it changes nothing. The log parser has a dedicated regression test: a
 * commit with no changed files must not swallow the next commit's header as one
 * of its own files.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { countCommitsBetween, isAncestor, observeRepository, probeRepository, shortHash } from '../../src/repo/git.ts';
import { commitAll, git, gitAvailable, harness, initGitRepo, writeFiles } from '../helpers/harness.ts';

const hasGit = gitAvailable();
if (!hasGit) process.stderr.write('git is unavailable: skipping git adapter tests\n');

describe('observeRepository', () => {
  it('reads branch, head, subject and recent commits', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      const head = initGitRepo(h.dir, [
        { message: 'feat: add the offer predicate', files: { 'src/industry/offer.ts': 'export const ok = true;\n' } },
        { message: 'test: cover the predicate', files: { 'tests/offer.test.js': 'assert(true);\n' } },
      ]).at(-1);
      const observation = await observeRepository(h.dir, { recentCommits: 10 });

      assert.equal(observation.error, null);
      assert.equal(observation.branch, 'main');
      assert.equal(observation.head, head);
      assert.equal(observation.headSubject, 'test: cover the predicate');
      assert.equal(observation.dirty, false);
      assert.deepEqual(observation.commits.map((commit) => commit.subject), [
        'test: cover the predicate',
        'feat: add the offer predicate',
      ]);
      // Files are attached to the commit that changed them, newest first.
      assert.deepEqual(observation.commits[0]?.files, ['tests/offer.test.js']);
      assert.deepEqual(observation.commits[1]?.files, ['src/industry/offer.ts']);
      assert.deepEqual(observation.recentlyChangedFiles, ['tests/offer.test.js', 'src/industry/offer.ts']);
    } finally {
      h.cleanup();
    }
  });

  it('does not attribute a following commit to a commit that changed no files', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      initGitRepo(h.dir, [
        { message: 'feat: real work', files: { 'src/real.ts': 'export {};\n' } },
        { message: 'chore: empty commit' },
        { message: 'feat: later work', files: { 'src/later.ts': 'export {};\n', 'src/more.ts': 'export {};\n' } },
      ]);
      const observation = await observeRepository(h.dir, { recentCommits: 10 });
      assert.equal(observation.commits.length, 3);
      assert.deepEqual(observation.commits[0]?.files, ['src/later.ts', 'src/more.ts']);
      assert.deepEqual(observation.commits[1]?.files, [], 'the empty commit must have no files');
      assert.deepEqual(observation.commits[2]?.files, ['src/real.ts']);
      // The regression produced a bogus entry like "- .mcp/ma (unknown age)".
      assert.deepEqual(observation.recentlyChangedFiles, ['src/later.ts', 'src/more.ts', 'src/real.ts']);
    } finally {
      h.cleanup();
    }
  });

  it('reports modified and untracked files without changing them', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      initGitRepo(h.dir, [{ message: 'feat: base', files: { 'src/base.ts': 'export const base = 1;\n' } }]);
      writeFiles(h.dir, { 'src/base.ts': 'export const base = 2;\n', 'src/new.ts': 'export {};\n' });
      const observation = await observeRepository(h.dir);

      assert.equal(observation.dirty, true);
      assert.deepEqual(observation.changedFiles, ['src/base.ts']);
      assert.deepEqual(observation.untrackedFiles, ['src/new.ts']);
      // Read-only: the working tree and index are exactly as they were left.
      assert.equal(git(h.dir, ['status', '--porcelain=v1']).trim().split('\n').length, 2);
      assert.match(git(h.dir, ['diff', '--cached']), /^$/);
    } finally {
      h.cleanup();
    }
  });

  it('bounds the number of commits it reads', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'a.txt': 'a\n' } }]);
      for (let index = 0; index < 5; index += 1) commitAll(h.dir, { message: `commit ${index}` });
      const observation = await observeRepository(h.dir, { recentCommits: 3 });
      assert.equal(observation.commits.length, 3);
    } finally {
      h.cleanup();
    }
  });

  it('handles an unborn repository', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      git(h.dir, ['init', '-b', 'main']);
      const observation = await observeRepository(h.dir);
      assert.equal(observation.error, null);
      assert.equal(observation.unborn, true);
      assert.equal(observation.head, null);
      assert.deepEqual(observation.commits, []);
    } finally {
      h.cleanup();
    }
  });

  it('degrades gracefully outside a work tree', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      const elsewhere = join(h.dir, 'plain');
      mkdirSync(elsewhere, { recursive: true });
      const observation = await observeRepository(elsewhere);
      assert.ok(observation.error);
      assert.deepEqual(observation.commits, []);
    } finally {
      h.cleanup();
    }
  });

  it('normalises the remote url into a project name', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'a.txt': 'a\n' } }]);
      git(h.dir, ['remote', 'add', 'origin', 'git@github.com:Concurrent-Studios/game-dev-tycoon.git']);
      const observation = await observeRepository(h.dir);
      assert.equal(observation.remoteUrl, 'github.com/concurrent-studios/game-dev-tycoon');
    } finally {
      h.cleanup();
    }
  });
});

describe('probeRepository', () => {
  it('finds the repository root from a subdirectory', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      initGitRepo(h.dir, [{ message: 'initial', files: { 'src/deep/file.ts': 'export {};\n' } }]);
      const probe = await probeRepository(join(h.dir, 'src', 'deep'));
      assert.equal(probe.isRepo, true);
      assert.equal(probe.root, h.dir);
    } finally {
      h.cleanup();
    }
  });

  it('reports a missing path instead of throwing', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      const probe = await probeRepository(join(h.dir, 'does-not-exist'));
      assert.equal(probe.isRepo, false);
      assert.match(probe.error ?? '', /does not exist/);
    } finally {
      h.cleanup();
    }
  });
});

describe('history relations', () => {
  it('detects ancestry between two commits', { skip: !hasGit }, async () => {
    const h = harness('git-test');
    try {
      const first = initGitRepo(h.dir, [{ message: 'first', files: { 'a.txt': 'a\n' } }])[0]!;
      const second = commitAll(h.dir, { message: 'second', files: { 'b.txt': 'b\n' } });
      assert.equal(await isAncestor(h.dir, first, second), true);
      assert.equal(await isAncestor(h.dir, second, first), false);
      assert.equal(await isAncestor(h.dir, 'not-a-hash', second), null);
      assert.equal(await countCommitsBetween(h.dir, first, second), 1);
    } finally {
      h.cleanup();
    }
  });

  it('shortens hashes safely', () => {
    assert.equal(shortHash('0123456789abcdef'), '01234567');
    assert.equal(shortHash(null), 'unknown');
  });
});
