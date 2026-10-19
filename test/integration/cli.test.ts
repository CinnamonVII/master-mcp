/**
 * CLI tests.
 *
 * Most tests drive `runCli` in-process with captured output — fast and exact —
 * and one test spawns the real binary to prove the process boundary works:
 * `MASTER_MCP_DB` is honoured, exit codes survive, and context → complete →
 * context behaves the same way an agent would experience it.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli, type CliIo } from '../../src/cli/cli.ts';
import { VERSION } from '../../src/version.ts';
import { harness, tempDir, writeFiles } from '../helpers/harness.ts';

const CONFIG = [
  'project: concurrent-studios',
  'goal: Ship the offer system',
  'phase: implementation',
  'subsystems:',
  '  - industry-offer',
  'verification:',
  '  test_command: npm test',
  '',
].join('\n');

const OFFER_FILE = 'src/industry/offer.ts';

interface Captured {
  stdout: string;
  stderr: string;
  code: number;
}

async function cli(cwd: string, args: readonly string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd,
  };
  const code = await runCli(args, io);
  return { stdout, stderr, code };
}

describe('CLI', () => {
  it('reports help, version and unknown commands with the right exit codes', async () => {
    const h = harness('cli');
    try {
      const usage = await cli(h.dir, []);
      assert.equal(usage.code, 0);
      assert.match(usage.stdout, /^master-mcp — one-pass project intelligence/);
      assert.match(usage.stdout, /Usage: master-mcp <command> \[options\]/);

      const help = await cli(h.dir, ['help']);
      assert.equal(help.code, 0);
      assert.equal(help.stdout, usage.stdout);

      const version = await cli(h.dir, ['version']);
      assert.equal(version.code, 0);
      assert.equal(version.stdout.trim(), VERSION);

      const unknown = await cli(h.dir, ['frobnicate']);
      assert.equal(unknown.code, 2);
      assert.match(unknown.stderr, /Unknown command "frobnicate"/);
    } finally {
      h.cleanup();
    }
  });

  it('documents every command through --help', async () => {
    const h = harness('cli');
    try {
      for (const command of ['context', 'complete', 'status', 'search', 'record', 'export', 'import', 'mcp', 'doctor']) {
        const result = await cli(h.dir, [command, '--help']);
        assert.equal(result.code, 0, `${command} --help must succeed`);
        assert.match(result.stdout, /Usage/, `${command} --help shows usage`);
        assert.ok(
          result.stdout.includes(`master-mcp ${command}`),
          `${command} --help mentions its own name:\n${result.stdout}`,
        );
        assert.equal(result.stderr, '');
      }
    } finally {
      h.cleanup();
    }
  });

  it('exits 2 for missing arguments, unknown flags and invalid values', async () => {
    const h = harness('cli');
    try {
      const cases: Array<{ args: string[]; pattern: RegExp }> = [
        { args: ['context'], pattern: /requires a task/ },
        { args: ['complete'], pattern: /requires --summary/ },
        { args: ['search'], pattern: /requires a query/ },
        { args: ['record'], pattern: /requires --kind/ },
        { args: ['import'], pattern: /requires a path to a JSON snapshot/ },
        { args: ['status', '--nope'], pattern: /unknown flag --nope/ },
        { args: ['context', 'Fix the check', '--mode', 'turbo'], pattern: /Unknown mode "turbo"/ },
      ];
      for (const { args, pattern } of cases) {
        const result = await cli(h.dir, args);
        assert.equal(result.code, 2, `${args.join(' ')} must be a usage error`);
        assert.match(result.stderr, pattern, `stderr for: ${args.join(' ')}`);
        assert.equal(result.stdout, '');
      }
    } finally {
      h.cleanup();
    }
  });

  it('runs the one-pass cycle and offers machine-readable output', async () => {
    const h = harness('cli');
    const db = join(tempDir('cli-db'), 'memory.sqlite');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG, [OFFER_FILE]: 'export function isEligible() { return true; }\n' });
      const base = ['--db', db];

      const context = await cli(h.dir, ['context', 'Fix the offer ownership check', '--file', OFFER_FILE, ...base]);
      assert.equal(context.code, 0);
      assert.match(context.stdout, /NEXT ACTION/);
      assert.match(context.stdout, /concurrent-studios/);

      const complete = await cli(h.dir, [
        'complete',
        '--task',
        'Fix the offer ownership check',
        '--summary',
        'Ownership now comes from the offer record.',
        '--files',
        OFFER_FILE,
        '--test',
        'npm test => pass',
        ...base,
      ]);
      assert.equal(complete.code, 0);
      assert.match(complete.stdout, /^RECORDED/);
      assert.match(complete.stdout, /→ verified_done \(verification: verified\)/);

      const again = await cli(h.dir, ['context', 'Fix the offer ownership check', ...base]);
      assert.match(again.stdout, /previous work:/);

      const asJson = await cli(h.dir, ['context', 'Fix the offer ownership check', '--json', ...base]);
      const parsed = JSON.parse(asJson.stdout) as { taskId: string; brief: { project: { slug: string } } };
      assert.match(parsed.taskId, /^tsk_/);
      assert.equal(parsed.brief.project.slug, 'concurrent-studios');

      const decision = await cli(h.dir, [
        'record',
        '--kind',
        'decision',
        '--body',
        'Eligibility lives in the offer predicate',
        '--rationale',
        'One source of truth prevents UI drift.',
        ...base,
      ]);
      assert.equal(decision.code, 0);
      assert.match(decision.stdout, /Recorded decision dec_/);

      const search = await cli(h.dir, ['search', 'eligibility predicate', '--kind', 'decision', ...base]);
      assert.equal(search.code, 0);
      assert.match(search.stdout, /\[decision\] Eligibility lives in the offer predicate/);

      const searchJson = await cli(h.dir, ['search', 'eligibility predicate', '--json', ...base]);
      const hits = JSON.parse(searchJson.stdout) as Array<{ kind: string }>;
      assert.equal(hits[0]?.kind, 'decision');

      const status = await cli(h.dir, ['status', '--json', ...base]);
      const report = JSON.parse(status.stdout) as { registered: boolean };
      assert.equal(report.registered, true);

      const doctor = await cli(h.dir, ['doctor', '--json', ...base]);
      const info = JSON.parse(doctor.stdout) as { databasePath: string; projects: Array<{ slug: string }> };
      assert.equal(info.databasePath, db);
      assert.deepEqual(
        info.projects.map((project) => project.slug),
        ['concurrent-studios'],
      );
    } finally {
      h.cleanup();
    }
  });

  it('exports to a file and imports it into another database', async () => {
    const h = harness('cli');
    const root = tempDir('cli-backup');
    const db = join(root, 'source.sqlite');
    const otherDb = join(root, 'target.sqlite');
    const snapshotFile = join(root, 'backup.json');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG });
      await cli(h.dir, ['context', 'Fix the offer ownership check', '--db', db]);

      const exported = await cli(h.dir, ['export', '--format', 'json', '--out', snapshotFile, '--db', db]);
      assert.equal(exported.code, 0);
      assert.match(exported.stdout, /Wrote json export \(\d+ bytes\) to /);
      assert.ok(existsSync(snapshotFile));

      const markdown = await cli(h.dir, ['export', '--db', db]);
      assert.equal(markdown.code, 0);
      assert.match(markdown.stdout, /^# /);
      assert.match(markdown.stdout, /## Tasks/);

      const imported = await cli(h.dir, ['import', snapshotFile, '--db', otherDb, '--json']);
      assert.equal(imported.code, 0);
      const report = JSON.parse(imported.stdout) as { projectSlug: string; written: Record<string, number> };
      assert.equal(report.projectSlug, 'concurrent-studios');
      assert.equal(report.written['tasks'], 1);

      const briefOnTarget = await cli(h.dir, [
        'context',
        'Fix the offer ownership check',
        '--project',
        'concurrent-studios',
        '--db',
        otherDb,
      ]);
      assert.equal(briefOnTarget.code, 0);
      assert.match(briefOnTarget.stdout, /NEXT ACTION/);

      const junk = join(root, 'junk.json');
      writeFileSync(junk, 'this is not json{', 'utf8');
      const invalidJson = await cli(h.dir, ['import', junk, '--db', otherDb]);
      assert.equal(invalidJson.code, 1);
      assert.match(invalidJson.stderr, /is not valid JSON/);

      const wrongShape = join(root, 'wrong-shape.json');
      writeFileSync(wrongShape, JSON.stringify({ hello: 'world' }), 'utf8');
      const invalidSnapshot = await cli(h.dir, ['import', wrongShape, '--db', otherDb]);
      assert.equal(invalidSnapshot.code, 1);
      assert.match(invalidSnapshot.stderr, /is not a master-mcp snapshot/);
    } finally {
      h.cleanup();
    }
  });

  it('the real binary honours MASTER_MCP_DB across a context → complete → context cycle', () => {
    const h = harness('cli');
    const home = tempDir('cli-home');
    const db = join(tempDir('cli-spawn-db'), 'spawn.sqlite');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG, [OFFER_FILE]: 'export function isEligible() { return true; }\n' });
      const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
      const run = (args: readonly string[]): { stdout: string; status: number | null } => {
        const result = execFileSync('node', [entry, ...args], {
          cwd: h.dir,
          encoding: 'utf8',
          env: { ...process.env, MASTER_MCP_DB: db, MASTER_MCP_HOME: home },
        });
        return { stdout: result, status: 0 };
      };

      const task = 'Fix the offer ownership check';
      const first = run(['context', task, '--file', OFFER_FILE]);
      assert.match(first.stdout, /NEXT ACTION/);

      const completed = run([
        'complete',
        '--task',
        task,
        '--summary',
        'Ownership now comes from the offer record.',
        '--test',
        'npm test => pass',
      ]);
      assert.match(completed.stdout, /→ verified_done/);

      const second = run(['context', task]);
      assert.match(second.stdout, /previous work:/);
      assert.match(second.stdout, /Ownership now comes from the offer record/);

      const doctor = run(['doctor', '--json']);
      assert.match(doctor.stdout, new RegExp(db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      assert.ok(existsSync(db), 'the database is exactly where MASTER_MCP_DB pointed');
      assert.deepEqual(readdirSync(home), [], 'MASTER_MCP_HOME was never touched');
    } finally {
      h.cleanup();
    }
  });
});
