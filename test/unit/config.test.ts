/**
 * Configuration tests.
 *
 * `.mcp/master-mcp.yaml` is optional and must never break a call: a malformed
 * file yields warnings and defaults, and both snake_case and camelCase keys are
 * accepted.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, interpretConfig, loadProjectConfig } from '../../src/config/config.ts';
import { harness, writeFiles } from '../helpers/harness.ts';

describe('interpretConfig', () => {
  it('returns defaults for an empty document', () => {
    const config = interpretConfig(null, null);
    assert.deepEqual(config, { ...DEFAULT_CONFIG, sourcePath: null, warnings: [] });
  });

  it('warns and falls back when the document is not a mapping', () => {
    const config = interpretConfig(['not', 'a', 'mapping'], 'cfg.yaml');
    assert.deepEqual(config.warnings, ['cfg.yaml: expected a YAML mapping at the top level; ignoring file.']);
    assert.equal(config.goal, null);
  });

  it('reads snake_case keys', () => {
    const config = interpretConfig(
      {
        project: 'Concurrent Studios',
        goal: 'Ship the offer system',
        phase: 'implementation',
        important_paths: ['src/', 'tests/'],
        subsystems: ['industry-offer'],
        verification: { test_command: 'npm test', extra_checks: ['npm run lint'] },
        context: { recent_commits: 25, max_brief_tokens: 3000 },
      },
      'cfg.yaml',
    );
    assert.equal(config.project, 'concurrent-studios');
    assert.equal(config.goal, 'Ship the offer system');
    assert.equal(config.phase, 'implementation');
    assert.deepEqual(config.importantPaths, ['src/', 'tests/']);
    assert.deepEqual(config.subsystems, ['industry-offer']);
    assert.equal(config.verification.testCommand, 'npm test');
    assert.deepEqual(config.verification.extraChecks, ['npm run lint']);
    assert.equal(config.context.recentCommits, 25);
    assert.equal(config.context.maxBriefTokens, 3000);
    assert.deepEqual(config.warnings, []);
  });

  it('accepts camelCase spellings too', () => {
    const config = interpretConfig(
      { importantPaths: ['src'], verification: { testCommand: 'npm t' }, context: { recentCommits: 5 } },
      'cfg.yaml',
    );
    assert.deepEqual(config.importantPaths, ['src']);
    assert.equal(config.verification.testCommand, 'npm t');
    assert.equal(config.context.recentCommits, 5);
  });

  it('warns about a mistyped list instead of silently dropping it', () => {
    const config = interpretConfig({ subsystems: 'industry-offer', important_paths: [1, 2] }, 'cfg.yaml');
    assert.deepEqual(config.subsystems, ['industry-offer']);
    assert.deepEqual(config.importantPaths, []);
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0] ?? '', /important_paths/);
  });

  it('warns about a mistyped verification block', () => {
    const config = interpretConfig({ verification: 'npm test' }, 'cfg.yaml');
    assert.equal(config.verification.testCommand, null);
    assert.match(config.warnings[0] ?? '', /verification/);
  });

  it('clamps token budget and commit count to sane bounds', () => {
    const config = interpretConfig({ context: { max_brief_tokens: 10, recent_commits: 5000 } }, null);
    assert.equal(config.context.maxBriefTokens, 400);
    assert.equal(config.context.recentCommits, 100);
    assert.equal(config.context.maxBriefTokensSet, true);
    assert.equal(interpretConfig({ context: { max_brief_tokens: 99_999 } }, null).context.maxBriefTokens, 12_000);
  });

  it('marks the token budget as explicit only when it was configured', () => {
    assert.equal(interpretConfig(null, null).context.maxBriefTokensSet, false);
    assert.equal(
      interpretConfig({ context: { max_brief_tokens: 5000 } }, null).context.maxBriefTokensSet,
      true,
    );
    assert.equal(interpretConfig({ context: { maxBriefTokens: 5000 } }, null).context.maxBriefTokensSet, true);

    // An explicit value in one file must not leak into the shared defaults used
    // by the next load.
    const fresh = interpretConfig({ goal: 'A different project' }, null);
    assert.equal(fresh.context.maxBriefTokensSet, false);
    assert.equal(fresh.context.maxBriefTokens, 2000);
  });

  it('ignores non-string scalars for string fields', () => {
    const config = interpretConfig({ goal: 42, phase: true }, null);
    assert.equal(config.goal, null);
    assert.equal(config.phase, null);
  });
});

describe('loadProjectConfig', () => {
  it('reports no file when none exists', () => {
    const h = harness('config-test');
    try {
      const result = loadProjectConfig(h.dir);
      assert.equal(result.found, false);
      assert.equal(result.config.sourcePath, null);
    } finally {
      h.cleanup();
    }
  });

  it('finds the config from a nested working directory', () => {
    const h = harness('config-test');
    try {
      writeFiles(h.dir, {
        '.mcp/master-mcp.yaml': 'project: nested-project\ngoal: Keep walking up.\n',
        'src/feature/deep/placeholder.txt': 'x',
      });
      const nested = `${h.dir}/src/feature/deep`;
      const result = loadProjectConfig(nested);
      assert.equal(result.found, true);
      assert.equal(result.config.project, 'nested-project');
      assert.equal(result.config.goal, 'Keep walking up.');
      assert.ok(result.config.sourcePath?.endsWith('.mcp/master-mcp.yaml'));
    } finally {
      h.cleanup();
    }
  });

  it('turns malformed YAML into a warning instead of an exception', () => {
    const h = harness('config-test');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': 'project: [unclosed\n  bad: : :\n' });
      const result = loadProjectConfig(h.dir);
      assert.equal(result.found, true);
      assert.equal(result.config.project, null);
      assert.equal(result.config.warnings.length, 1);
      assert.match(result.config.warnings[0] ?? '', /invalid YAML/);
      assert.match(result.config.warnings[0] ?? '', /using defaults/);
    } finally {
      h.cleanup();
    }
  });

  it('ignores a config file that contains a YAML scalar', () => {
    const h = harness('config-test');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': 'just-a-string\n' });
      const result = loadProjectConfig(h.dir);
      assert.equal(result.found, true);
      assert.match(result.config.warnings[0] ?? '', /expected a YAML mapping/);
    } finally {
      h.cleanup();
    }
  });
});
