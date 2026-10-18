/**
 * Brief renderer tests.
 *
 * Rendering is where token cost is decided, so these tests cover section
 * structure, the honesty of the verification section, budget trimming order and
 * the unregistered-project status report — all on fixtures, with no database.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { StatusReport } from '../../src/app/status.ts';
import { defaultMaxTokens, renderBrief, renderStatus } from '../../src/app/render.ts';
import { approxTokens } from '../../src/util/text.ts';
import { sampleBrief, hasSection, section } from '../helpers/harness.ts';

describe('renderBrief', () => {
  it('renders every section in a fixed order', () => {
    const brief = sampleBrief({
      bugs: [
        {
          id: 'bug_1',
          title: 'Ownership check passes for unverified offers',
          severity: 'high',
          status: 'open',
          detail: 'observed on the offers screen',
          files: ['src/industry/offer.ts'],
          age: '2d ago',
        },
      ],
      decisions: [{ id: 'dec_1', statement: 'Eligibility lives in the predicate', rationale: 'One source of truth', subsystem: 'industry-offer', age: '3d ago' }],
      findings: [{ id: 'fnd_1', statement: 'The UI infers ownership', confidence: 'suspected', evidenceCount: 0, symbols: [], age: '1d ago' }],
      likelyFiles: ['src/industry/offer.ts'],
      constraints: [{ id: 'con_1', statement: 'Never infer ownership in the UI', severity: 'critical', subsystem: 'industry-offer', reason: 'Caused a regression' }],
    });

    const text = renderBrief(brief);
    const order = ['PROJECT', 'TASK', 'CRITICAL CONSTRAINTS', 'RELEVANT HISTORY', 'LIKELY FILES', 'KNOWN RISK', 'RECOMMENDED APPROACH', 'VERIFICATION', 'NEXT ACTION'];
    const titles = text.split('\n');
    const positions = order.map((title) => titles.indexOf(title));
    for (const [index, position] of positions.entries()) {
      assert.ok(position > -1, `missing section ${order[index]}`);
    }
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'sections must appear in priority order');
    assert.match(text, /^- \[high\/open, 2d ago\] Ownership check passes/m);
  });

  it('puts verification commands under a run: header and keeps groups intact', () => {
    const text = renderBrief(
      sampleBrief({
        verificationPlan: {
          commands: ['npm test', 'npm run lint'],
          requirements: ['The original report no longer reproduces.'],
          manualChecks: ['Exercise the touched code path directly.'],
          regressionAreas: ['industry-offer'],
          unknown: false,
        },
      }),
    );
    const block = section(text, 'VERIFICATION');
    assert.match(block, /^run:\n- npm test\n- npm run lint/m);
    assert.match(block, /must confirm:\n- The original report no longer reproduces\./);
    assert.match(block, /manual checks:\n- Exercise the touched code path directly\./);
    assert.match(block, /regression areas: industry-offer/);
    // Commands must never be listed as something to merely confirm.
    assert.ok(!/must confirm:\n- npm test/.test(block));
  });

  it('names the exact config key when no verification command exists', () => {
    const text = renderBrief(
      sampleBrief({
        verificationPlan: { commands: [], requirements: [], manualChecks: [], regressionAreas: [], unknown: true },
      }),
    );
    assert.match(text, /commands: none configured \(\.mcp\/master-mcp\.yaml → verification\.test_command\)/);
  });

  it('labels findings as unverified when they are not facts', () => {
    const text = renderBrief(
      sampleBrief({ findings: [{ id: 'fnd_1', statement: 'The UI infers ownership', confidence: 'suspected', evidenceCount: 0, symbols: [], age: '1d ago' }] }),
    );
    assert.match(text, /findings \(unverified entries are not facts\):/);
  });

  it('does not claim reverse engineering for ordinary tasks with findings', () => {
    const text = renderBrief(
      sampleBrief({ findings: [{ id: 'fnd_1', statement: 'The UI infers ownership', confidence: 'runtime_confirmed', evidenceCount: 2, symbols: [], age: '1d ago' }] }),
    );
    assert.ok(!text.includes('REVERSE ENGINEERING'));
    assert.match(text, /^findings:$/m);
  });

  it('frames reverse-engineering briefs with promotion guidance', () => {
    const text = renderBrief(
      sampleBrief({
        task: { ...sampleBrief().task, mode: 're' },
        reverseEngineering: {
          enabled: true,
          established: [{ id: 'fnd_1', statement: 'The manager writes at 0x401000', confidence: 'runtime_observed', age: '1d ago' }],
          open: [{ id: 'fnd_2', statement: 'The pointer resolves lazily', confidence: 'suspected', next: 'runtime_observed', age: '2d ago' }],
          promotion: ['runtime_observed: Run the binary once and capture output to reach runtime observed.'],
        },
      }),
    );
    const block = section(text, 'REVERSE ENGINEERING');
    assert.match(block, /established \(runtime evidence on record\):/);
    assert.match(block, /unverified \(do not treat as fact\):/);
    assert.match(block, /→ next: runtime_observed/);
  });

  it('always ends with a single explicit next action plus the closing instruction', () => {
    const text = renderBrief(sampleBrief());
    const block = section(text, 'NEXT ACTION');
    assert.match(block, /Start by inspecting src\/ownership\.ts\./);
    assert.match(block, /When finished: master_complete with task_id tsk_fixture/);
  });

  it('omits empty optional sections entirely', () => {
    const text = renderBrief(sampleBrief());
    for (const title of ['WARNINGS', 'OPEN FOLLOW-UPS', 'MEMORY GAPS', 'RELEVANT HISTORY', 'LIKELY FILES']) {
      assert.ok(!hasSection(text, title), `expected no ${title} section`);
    }
  });

  it('trims low-priority sections before high-priority ones', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      id: `tsk_${index}`,
      title: `Follow-up task number ${index} with a reasonably long title to consume budget`,
      priority: 'P3',
      status: 'todo',
      blockers: [],
    }));
    const brief = sampleBrief({ followUps: many, gaps: ['A gap that can go.'] });
    const full = renderBrief(brief, { maxTokens: 100_000 });
    const trimmed = renderBrief(brief, { maxTokens: 600 });

    assert.ok(approxTokens(trimmed) < approxTokens(full));
    // Priority-0 material survives regardless of budget.
    for (const title of ['PROJECT', 'TASK', 'VERIFICATION', 'NEXT ACTION']) {
      assert.ok(hasSection(trimmed, title), `${title} must survive trimming`);
    }
    assert.ok(!trimmed.includes('Follow-up task number 79'));
  });

  it('keeps the verification commands when trimming hard', () => {
    const text = renderBrief(sampleBrief(), { maxTokens: 1 });
    assert.match(text, /^- npm test$/m);
  });

  it('gives reverse-engineering and deep briefs a larger default budget', () => {
    const plain = sampleBrief();
    const re = sampleBrief({ task: { ...plain.task, mode: 're' }, reverseEngineering: {
      enabled: true, established: [], open: [], promotion: [],
    } });
    assert.ok(defaultMaxTokens(re) > defaultMaxTokens(plain));
    assert.equal(defaultMaxTokens(plain), 2000);
  });
});

describe('renderStatus', () => {
  it('tells an unregistered project how to start', () => {
    const report: StatusReport = {
      registered: false,
      project: {
        slug: 'unknown',
        name: null,
        goal: null,
        phase: null,
        branch: 'main',
        head: 'a'.repeat(40),
        dirty: false,
        changedFileCount: 0,
        untrackedFileCount: 0,
        repositoryPath: '/tmp/nowhere',
        gitAvailable: true,
      },
      knownProjects: ['concurrent-studios'],
      memoryCounts: {},
      activeWork: [],
      blockers: [],
      criticalBugs: [],
      todo: [],
      latestHandoff: null,
      recentActivity: [],
      nextTask: null,
      warnings: [],
    };
    const text = renderStatus(report);
    assert.match(text, /no project registered for \/tmp\/nowhere/);
    assert.match(text, /KNOWN PROJECTS\n- concurrent-studios/);
    assert.match(text, /Call master_context with your task to register this repository/);
  });

  it('summarises registered project state', () => {
    const report: StatusReport = {
      registered: true,
      project: {
        slug: 'concurrent-studios',
        name: 'Concurrent Studios',
        goal: 'Ship the offer system',
        phase: 'implementation',
        branch: 'main',
        head: 'b'.repeat(40),
        dirty: true,
        changedFileCount: 2,
        untrackedFileCount: 1,
        repositoryPath: '/tmp/repo',
        gitAvailable: true,
      },
      knownProjects: [],
      memoryCounts: { task: 3, bug: 1 },
      activeWork: [
        { id: 'tsk_1', title: 'Fix the ownership check', status: 'in_progress', priority: 'P1', subsystem: 'industry-offer', verificationStatus: 'none', updatedAgo: '2h ago' },
      ],
      blockers: [],
      criticalBugs: [{ id: 'bug_1', title: 'Wrong ownership', severity: 'high', status: 'open', detail: 'seen on offers', age: '1d ago' }],
      todo: [],
      latestHandoff: { id: 'hnd_1', summary: 'Moved eligibility into the predicate', completed: 'Refactor', failures: [], followUp: ['Wire the UI copy'], age: '3h ago' },
      recentActivity: [],
      nextTask: { id: 'tsk_1', title: 'Fix the ownership check', status: 'in_progress', priority: 'P1', reason: 'highest-priority open task (P1)' },
      warnings: [],
    };
    const text = renderStatus(report);
    assert.match(text, /Concurrent Studios \(concurrent-studios\) — phase: implementation/);
    assert.match(text, /dirty: 2 uncommitted/);
    assert.match(text, /MEMORY\n3 task, 1 bug/);
    assert.match(text, /ACTIVE WORK/);
    assert.match(text, /OPEN BUGS/);
    assert.match(text, /LATEST HANDOFF[\s\S]*follow-up: Wire the UI copy/);
    assert.match(text, /MOST IMPORTANT NEXT TASK[\s\S]*reason: highest-priority open task \(P1\)/);
  });
});
