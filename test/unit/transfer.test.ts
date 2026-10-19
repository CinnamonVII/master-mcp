/**
 * Portable snapshot tests.
 *
 * The snapshot format is the backup contract: it must reject anything it cannot
 * faithfully restore, and the Markdown rendering must remain a complete,
 * readable view of the same data.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SNAPSHOT_FORMAT_VERSION, validateSnapshot, type ProjectSnapshot } from '../../src/domain/transfer.ts';
import { exportMarkdown } from '../../src/app/transfer.ts';

function minimal(): Record<string, unknown> {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    generator: 'test',
    exportedAt: '2026-03-01T09:00:00.000Z',
    project: {
      id: 'prj_test',
      slug: 'test-project',
      name: 'Test Project',
      description: null,
      goal: null,
      phase: null,
      createdAt: '2026-03-01T09:00:00.000Z',
      updatedAt: '2026-03-01T09:00:00.000Z',
      lastAccessedAt: null,
    },
  };
}

describe('validateSnapshot', () => {
  it('accepts a minimal snapshot and fills absent collections with empty arrays', () => {
    const result = validateSnapshot(minimal());
    assert.ok(result.ok);
    assert.equal(result.snapshot.project.slug, 'test-project');
    assert.deepEqual(result.snapshot.tasks, []);
    assert.deepEqual(result.snapshot.handoffs, []);
    assert.equal(result.snapshot.generator, 'test');
  });

  it('rejects values that are not a snapshot object', () => {
    for (const value of [null, 'text', 42, ['array']]) {
      const result = validateSnapshot(value);
      assert.ok(!result.ok);
      assert.match(result.reason, /expected a JSON object/);
    }
  });

  it('rejects a missing or newer format version', () => {
    const missing = validateSnapshot({ ...minimal(), formatVersion: undefined });
    assert.ok(!missing.ok);
    assert.match(missing.reason, /formatVersion/);

    const newer = validateSnapshot({ ...minimal(), formatVersion: SNAPSHOT_FORMAT_VERSION + 1 });
    assert.ok(!newer.ok);
    assert.match(newer.reason, /newer than this build supports/);
  });

  it('rejects a snapshot without a project identity', () => {
    const noProject = validateSnapshot({ ...minimal(), project: undefined });
    assert.ok(!noProject.ok);
    assert.match(noProject.reason, /project\.id or project\.slug/);

    const noSlug = validateSnapshot({ ...minimal(), project: { id: 'prj_x' } });
    assert.ok(!noSlug.ok);
    assert.match(noSlug.reason, /project\.id or project\.slug/);
  });

  it('rejects a collection that is not an array', () => {
    const result = validateSnapshot({ ...minimal(), tasks: 'not-an-array' });
    assert.ok(!result.ok);
    assert.match(result.reason, /"tasks" must be an array/);
  });
});

describe('exportMarkdown', () => {
  it('renders every section, with explicit emptiness and finding meaning', () => {
    const validated = validateSnapshot({
      ...minimal(),
      project: { ...(minimal()['project'] as Record<string, unknown>), goal: 'Ship it', phase: 'implementation' },
      findings: [
        {
          id: 'fnd_1',
          projectId: 'prj_test',
          statement: 'isEligible decides ownership.',
          evidence: ['breakpoint at offer.ts:42'],
          confidence: 'runtime_observed',
          subsystem: 'industry-offer',
          files: ['src/industry/offer.ts'],
          symbols: ['isEligible'],
          source: null,
          createdAt: '2026-03-01T09:00:00.000Z',
          updatedAt: '2026-03-01T09:00:00.000Z',
        },
      ],
      tasks: [
        {
          id: 'tsk_1',
          projectId: 'prj_test',
          title: 'Fix the ownership check',
          description: null,
          priority: 'P1',
          status: 'in_progress',
          subsystem: 'industry-offer',
          affectedFiles: ['src/industry/offer.ts'],
          dependencies: [],
          blockers: [],
          verificationRequirements: [],
          verificationStatus: 'none',
          source: null,
          createdAt: '2026-03-01T09:00:00.000Z',
          updatedAt: '2026-03-01T09:00:00.000Z',
          completedAt: null,
          head: null,
          branch: null,
        },
      ],
    });
    assert.ok(validated.ok);
    const text = exportMarkdown(validated.snapshot as ProjectSnapshot);

    assert.match(text, /^# Test Project \(test-project\)/);
    assert.match(text, /\*\*Goal:\*\* Ship it/);
    for (const section of [
      'Repositories',
      'Constraints',
      'Decisions',
      'Known bugs',
      'Findings',
      'Tasks',
      'Verification history',
      'Handoffs',
    ]) {
      assert.ok(text.includes(`## ${section}`), `missing section ${section}`);
    }
    assert.match(text, /_none recorded_/, 'empty collections must say so rather than disappear');
    assert.match(text, /\*\*P1\*\* \/ in_progress — Fix the ownership check `tsk_1`/);
    assert.match(text, /\*\*runtime_observed\*\* — isEligible decides ownership\. `fnd_1`/);
    assert.match(text, /meaning: Seen once at runtime; not reproduced independently\./);
    assert.match(text, /Exported: 2026-03-01T09:00:00\.000Z \(format v1 by test\)/);
  });
});
