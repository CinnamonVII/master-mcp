/**
 * CLI.
 *
 * The same application layer as the MCP tools, shaped for a terminal. Commands
 * mirror the one-pass workflow (`context`, `complete`) rather than the internal
 * database operations, plus `export`/`import` because the database must not be
 * the only recovery path.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MasterMcpService } from '../app/service.ts';
import type { BugInput, FollowUpInput, TestRunInput, VerificationInput } from '../app/service.ts';
import type { ProjectSnapshot } from '../domain/transfer.ts';
import { validateSnapshot } from '../domain/transfer.ts';
import { errorMessage, MasterMcpError } from '../util/errors.ts';
import { VERSION } from '../version.ts';
import {
  flagBool,
  flagList,
  flagString,
  parseArgs,
  splitList,
  splitVerification,
  type FlagSpec,
  type ParsedArgs,
} from './args.ts';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
};

const USAGE = `master-mcp — one-pass project intelligence for coding agents

Usage: master-mcp <command> [options]

One-pass workflow
  context <task>             Engineering brief for a task (the main entry point)
  complete                   Record the result of a work pass

Overview and memory
  status                     Compact project overview
  search <query>             Full-text search over stored memory
  record                     Record one decision/constraint/bug/finding/todo/verification/handoff

Backup
  export [project]           Export project memory (--format markdown|json)
  import <file>              Import a previously exported JSON snapshot

Server
  mcp                        Run the MCP server over stdio (also the no-arg default)
  doctor                     Show database location, schema version and known projects
  help                       Show this help

Common options
  --project <slug>           Target project (usually inferred)
  --repo <path>              Repository path (defaults to the working directory)
  --json                     Machine-readable output
  --db <path>                Override the database file
  -h, --help                 Show help

Examples
  master-mcp context "Fix the incorrect ownership check in the industry-offer UI"
  master-mcp context "Continue runtime validation of discovered managers" --mode re
  master-mcp complete --task "Fix ownership check" --summary "Replaced UI-derived check" \\
      --files src/industry/offer.ts --test "npm test => pass"
  master-mcp search "why was UI ownership inference removed"
  master-mcp status
  master-mcp export concurrent-studios --format markdown --out backup.md
`;

const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'project', aliases: ['p'] },
  { name: 'repo', aliases: ['repository'] },
  { name: 'db' },
  { name: 'json' , boolean: true },
  { name: 'help', aliases: ['h'], boolean: true },
];

const CONTEXT_FLAGS: FlagSpec[] = [
  ...GLOBAL_FLAGS,
  { name: 'file', aliases: ['files', 'f'] },
  { name: 'mode' },
  { name: 'refresh', boolean: true },
];

const COMPLETE_FLAGS: FlagSpec[] = [
  ...GLOBAL_FLAGS,
  { name: 'task' },
  { name: 'task-id' },
  { name: 'summary', aliases: ['s'] },
  { name: 'files', aliases: ['files-changed'] },
  { name: 'commit' },
  { name: 'test' },
  { name: 'test-result' },
  { name: 'evidence' },
  { name: 'result' },
  { name: 'discovery' },
  { name: 'discovery-confidence' },
  { name: 'unresolved' },
  { name: 'blocker' },
  { name: 'follow-up' },
  { name: 'bug-found' },
  { name: 'bug-resolved' },
  { name: 'subsystem' },
  { name: 'status' },
];

const SEARCH_FLAGS: FlagSpec[] = [...GLOBAL_FLAGS, { name: 'kind' }, { name: 'limit' }];

const RECORD_FLAGS: FlagSpec[] = [
  ...GLOBAL_FLAGS,
  { name: 'kind' },
  { name: 'body', aliases: ['b'] },
  { name: 'subsystem' },
  { name: 'severity' },
  { name: 'priority' },
  { name: 'confidence' },
  { name: 'rationale' },
  { name: 'alternative', aliases: ['alternatives'] },
  { name: 'file', aliases: ['files'] },
  { name: 'symbol' },
  { name: 'evidence' },
  { name: 'reproduction' },
  { name: 'expected' },
  { name: 'observed' },
  { name: 'commit' },
  { name: 'requirement', aliases: ['requirements'] },
  { name: 'follow-up' },
  { name: 'task-id' },
  { name: 'command' },
  { name: 'method' },
  { name: 'result' },
];

const EXPORT_FLAGS: FlagSpec[] = [...GLOBAL_FLAGS, { name: 'format' }, { name: 'out', aliases: ['o'] }];
const IMPORT_FLAGS: FlagSpec[] = [...GLOBAL_FLAGS, { name: 'file', aliases: ['f'] }, { name: 'mode' }];
/** The server speaks MCP on stdio, so it takes no output flags. */
const MCP_FLAGS: FlagSpec[] = [
  { name: 'db' },
  { name: 'help', aliases: ['h'], boolean: true },
];

const COMMON_HELP = [
  'Common options',
  '  --project <slug>   Target project (usually inferred)',
  '  --repo <path>      Repository path (defaults to the working directory)',
  '  --db <path>        Override the database file',
  '  --json             Machine-readable output',
  '  -h, --help         Show this help',
].join('\n');

interface CommandHelp {
  summary: string;
  usage: string;
  options?: string[];
}

/** Per-command help, printed by `master-mcp <command> --help`. */
const COMMAND_HELP: Record<string, CommandHelp> = {
  context: {
    summary: 'Engineering brief for a task — the main entry point.',
    usage: 'master-mcp context "<task>" [options]',
    options: [
      '  --file <path>      Affected file; repeatable, comma-separated allowed',
      '  --mode <mode>      auto | read_only | deep | re (default: auto)',
      '  --refresh          Re-read repository metadata instead of the cached state',
    ],
  },
  complete: {
    summary: 'Record the result of a work pass: evidence, task state, follow-ups.',
    usage: 'master-mcp complete --summary "<what was done>" [options]',
    options: [
      '  --task-id <id>     Task id from the brief (preferred)',
      '  --task "<title>"   Match or create a task by title instead',
      '  --files <a,b>      Files changed',
      '  --test "<cmd> => <result>"  Command that was run; repeatable',
      '  --test-result <r>  pass | fail | partial | unknown — default for entries without a result',
      '  --result <check>   Non-command check performed; repeatable',
      '  --evidence <text>  Concrete observation backing the summary; repeatable',
      '  --discovery <text> Durable finding; repeatable',
      '  --commit <sha>     Commit this pass produced; repeatable',
      '  --unresolved <t>   Something left unfinished; repeatable',
      '  --blocker <text>   Blocker hit; repeatable',
      '  --follow-up <text> Work for the next pass; repeatable',
      '  --bug-found <t>    Bug discovered here; repeatable',
      '  --bug-resolved <id>  Bug fixed here; repeatable',
      '  --subsystem <name> Subsystem this work belongs to',
      '  --status <status>  todo | in_progress | implementation_done | verified_done | blocked | cancelled',
    ],
  },
  status: {
    summary: 'Compact project overview: active work, blockers, bugs, next task.',
    usage: 'master-mcp status [options]',
  },
  search: {
    summary: 'Full-text search over stored memory.',
    usage: 'master-mcp search "<query>" [options]',
    options: [
      '  --kind <kind>      Limit to a kind: task | decision | constraint | bug | finding | verification | handoff',
      '  --limit <n>        Maximum hits (default 10)',
    ],
  },
  record: {
    summary: 'Record one decision, constraint, bug, finding, todo, handoff or verification.',
    usage: 'master-mcp record --kind <kind> --body "<text>" [options]',
    options: [
      '  --subsystem <name> Subsystem this belongs to',
      '  --severity <level> critical | high | medium | low (constraints, bugs)',
      '  --priority <p>     P0 | P1 | P2 | P3 (todos)',
      '  --confidence <c>   hypothesis | suspected | statically_supported | runtime_observed | runtime_confirmed (findings)',
      '  --rationale <text> Decisions: why. Todos: extra description. Handoffs: what was completed',
      '  --alternative <t>  Alternatives considered (decisions) / blockers (handoffs); repeatable',
      '  --file <path>      File involved; repeatable',
      '  --symbol <name>    Symbol or address involved; repeatable',
      '  --evidence <text>  Evidence for a finding or verification; repeatable',
      '  --reproduction <t> Bugs: how to reproduce',
      '  --expected <text>  Bugs: expected behaviour',
      '  --observed <text>  Bugs: observed behaviour',
      '  --commit <sha>     Related commit; repeatable',
      '  --requirement <t>  Todos: verification requirement; repeatable',
      '  --follow-up <t>    Handoffs: work for the next pass; repeatable',
      '  --task-id <id>     Handoffs and verifications: the task this attaches to',
      '  --command <cmd>    Verifications: exact command run',
      '  --method <text>    Verifications: what was checked',
      '  --result <r>       Verifications: pass | fail | partial | unknown',
    ],
  },
  export: {
    summary: 'Export project memory as markdown or JSON.',
    usage: 'master-mcp export [project] [options]',
    options: [
      '  --format <fmt>     markdown | json (default: markdown)',
      '  --out <path>       Write to a file instead of stdout',
    ],
  },
  import: {
    summary: 'Import a JSON snapshot produced by `export --format json`.',
    usage: 'master-mcp import <file.json> [options]',
    options: ['  --mode <mode>      merge | replace (default: merge)'],
  },
  mcp: {
    summary: 'Run the MCP server over stdio (also the default when run with no arguments).',
    usage: 'master-mcp mcp [--db <path>]',
  },
  doctor: {
    summary: 'Show database location, schema version and known projects.',
    usage: 'master-mcp doctor [options]',
  },
};

function renderCommandHelp(command: string): string {
  const help = COMMAND_HELP[command];
  if (!help) return USAGE;
  const lines = [`${command} — ${help.summary}`, '', 'Usage', `  ${help.usage}`];
  if (help.options && help.options.length > 0) lines.push('', 'Options', ...help.options);
  lines.push('', COMMON_HELP);
  return `${lines.join('\n')}\n`;
}

/** Print per-command help when `-h/--help` was parsed, and report whether it did. */
function helpRequested(command: string, parsed: ParsedArgs, io: CliIo): boolean {
  if (!flagBool(parsed, 'help')) return false;
  io.stdout(renderCommandHelp(command));
  return true;
}

/**
 * Run the CLI. Returns the process exit code: 0 success, 1 error, 2 usage.
 * Never throws, so `src/index.ts` stays trivial.
 */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  try {
    switch (command) {
      case 'mcp':
      case 'serve':
        return await runServer(rest, io);
      case 'context':
        return await runContext(rest, io);
      case 'complete':
        return await runComplete(rest, io);
      case 'status':
        return await runStatus(rest, io);
      case 'search':
        return await runSearch(rest, io);
      case 'record':
        return await runRecord(rest, io);
      case 'export':
        return await runExport(rest, io);
      case 'import':
        return await runImport(rest, io);
      case 'doctor':
        return await runDoctor(rest, io);
      default:
        io.stderr(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    if (error instanceof MasterMcpError && error.hint) io.stderr(`Hint: ${error.hint}\n`);
    return error instanceof MasterMcpError && error.code === 'USAGE' ? 2 : 1;
  }
}

interface CommonOptions {
  dbPath?: string;
  cwd: string;
  project?: string;
  repositoryPath?: string;
  json: boolean;
}

function commonOptions(parsed: ParsedArgs, io: CliIo): CommonOptions {
  const dbPath = flagString(parsed, 'db');
  const project = flagString(parsed, 'project');
  const repositoryPath = flagString(parsed, 'repo');
  return {
    ...(dbPath ? { dbPath } : {}),
    cwd: io.cwd,
    ...(project ? { project } : {}),
    ...(repositoryPath ? { repositoryPath } : {}),
    json: flagBool(parsed, 'json'),
  };
}

function withService<T>(options: CommonOptions, fn: (service: MasterMcpService) => T): T {
  const service = MasterMcpService.open({
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
    cwd: options.cwd,
  });
  try {
    return fn(service);
  } finally {
    service.close();
  }
}

async function withServiceAsync<T>(
  options: CommonOptions,
  fn: (service: MasterMcpService) => Promise<T>,
): Promise<T> {
  const service = MasterMcpService.open({
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
    cwd: options.cwd,
  });
  try {
    return await fn(service);
  } finally {
    service.close();
  }
}

function parseOrReport(
  argv: readonly string[],
  specs: readonly FlagSpec[],
  io: CliIo,
): { ok: true; parsed: ParsedArgs } | { ok: false; code: number } {
  const result = parseArgs(argv, specs);
  if (!result.ok) {
    io.stderr(`Error: ${result.error}\n`);
    return { ok: false, code: 2 };
  }
  return { ok: true, parsed: result.parsed };
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runServer(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, MCP_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const parsed = parsedResult.parsed;
  if (helpRequested('mcp', parsed, io)) return 0;
  const dbPath = flagString(parsed, 'db');
  // Imported lazily so the CLI does not pay for the MCP SDK unless it serves.
  const { runStdioServer } = await import('../mcp/server.ts');
  await runStdioServer(dbPath ? { dbPath } : {});
  return 0;
}

async function runContext(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, CONTEXT_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const { parsed } = parsedResult;
  if (helpRequested('context', parsed, io)) return 0;

  const taskFromPositional = parsed.positionals.join(' ').trim();
  const task = taskFromPositional || flagString(parsed, 'task') || '';
  if (!task) {
    io.stderr('Error: context requires a task, e.g. master-mcp context "Fix the ownership check"\n');
    return 2;
  }

  const options = commonOptions(parsed, io);
  const mode = flagString(parsed, 'mode');
  const affectedFiles = [...flagList(parsed, 'file').flatMap(splitList)];

  const result = await withServiceAsync(options, (service) =>
    service.context({
      task,
      project: options.project ?? null,
      repositoryPath: options.repositoryPath ?? null,
      affectedFiles,
      mode: mode ?? null,
      refresh: flagBool(parsed, 'refresh'),
    }),
  );

  if (options.json) printJson(io, { ...result, brief: result.brief });
  else io.stdout(result.text);
  return 0;
}

async function runComplete(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, COMPLETE_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const { parsed } = parsedResult;
  if (helpRequested('complete', parsed, io)) return 0;

  const summary =
    flagString(parsed, 'summary') ?? (parsed.positionals.join(' ').trim() || '');
  if (!summary) {
    io.stderr('Error: complete requires --summary "what was done"\n');
    return 2;
  }

  const options = commonOptions(parsed, io);
  const defaultResult = flagString(parsed, 'test-result');
  const testsRun: TestRunInput[] = flagList(parsed, 'test').map((value) => {
    const { command, result } = splitVerification(value);
    return { command, result: result ?? defaultResult ?? 'unknown' };
  });

  const verification: VerificationInput[] = flagList(parsed, 'result').map((value) => ({
    method: value,
    result: defaultResult ?? 'unknown',
  }));

  const discoveryConfidence = flagString(parsed, 'discovery-confidence');
  const discoveries: Array<string | { statement: string; confidence?: string; evidence?: string[] }> = [
    ...flagList(parsed, 'discovery').map((statement) =>
      discoveryConfidence ? { statement, confidence: discoveryConfidence } : statement,
    ),
  ];

  const followUp: Array<string | FollowUpInput> = flagList(parsed, 'follow-up');
  const bugsFound: Array<string | BugInput> = flagList(parsed, 'bug-found');
  const subsystemFlag = flagString(parsed, 'subsystem');

  const result = await withServiceAsync(options, (service) =>
    service.complete({
      summary,
      project: options.project ?? null,
      repositoryPath: options.repositoryPath ?? null,
      taskId: flagString(parsed, 'task-id') ?? null,
      task: flagString(parsed, 'task') ?? null,
      filesChanged: splitList(flagString(parsed, 'files')),
      commits: flagList(parsed, 'commit'),
      testsRun,
      verification,
      results: flagList(parsed, 'evidence'),
      discoveries,
      unresolved: flagList(parsed, 'unresolved'),
      blockers: flagList(parsed, 'blocker'),
      followUp,
      bugsFound,
      bugsResolved: flagList(parsed, 'bug-resolved'),
      subsystems: subsystemFlag ? [subsystemFlag] : [],
      status: flagString(parsed, 'status') ?? null,
    }),
  );

  if (options.json) printJson(io, result);
  else {
    io.stdout(result.text);
    if (result.notes.length > 0) {
      io.stdout(`NOTES\n${result.notes.map((note) => `- ${note}`).join('\n')}\n`);
    }
  }
  return 0;
}

async function runStatus(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, GLOBAL_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const { parsed } = parsedResult;
  if (helpRequested('status', parsed, io)) return 0;
  const options = commonOptions(parsed, io);

  const result = await withServiceAsync(options, (service) =>
    service.status({
      project: options.project ?? null,
      repositoryPath: options.repositoryPath ?? null,
    }),
  );
  if (options.json) printJson(io, result.report);
  else io.stdout(result.text);
  return 0;
}

async function runSearch(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, SEARCH_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const { parsed } = parsedResult;
  if (helpRequested('search', parsed, io)) return 0;

  const query = parsed.positionals.join(' ').trim();
  if (!query) {
    io.stderr('Error: search requires a query\n');
    return 2;
  }
  const options = commonOptions(parsed, io);
  const limitRaw = flagString(parsed, 'limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const result = withService(options, (service) =>
    service.search({
      query,
      project: options.project ?? null,
      kinds: flagList(parsed, 'kind'),
      limit: Number.isFinite(limit) ? (limit ?? null) : null,
    }),
  );

  if (options.json) printJson(io, result.hits);
  else io.stdout(result.text);
  return 0;
}

async function runRecord(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, RECORD_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const { parsed } = parsedResult;
  if (helpRequested('record', parsed, io)) return 0;

  const kind = flagString(parsed, 'kind') ?? parsed.positionals[0] ?? '';
  const positionalBody = parsed.positionals.slice(flagString(parsed, 'kind') ? 0 : 1).join(' ').trim();
  const body = flagString(parsed, 'body') ?? positionalBody;
  if (!kind || !body) {
    io.stderr(
      'Error: record requires --kind <decision|constraint|bug|finding|hypothesis|todo|handoff|verification> and --body "..."\n',
    );
    return 2;
  }
  const options = commonOptions(parsed, io);

  const result = withService(options, (service) =>
    service.record({
      kind,
      body,
      project: options.project ?? null,
      repositoryPath: options.repositoryPath ?? null,
      subsystem: flagString(parsed, 'subsystem') ?? null,
      severity: flagString(parsed, 'severity') ?? null,
      priority: flagString(parsed, 'priority') ?? null,
      confidence: flagString(parsed, 'confidence') ?? null,
      rationale: flagString(parsed, 'rationale') ?? null,
      alternatives: flagList(parsed, 'alternative'),
      files: [...flagList(parsed, 'file').flatMap(splitList), ...flagList(parsed, 'symbol')],
      evidence: flagList(parsed, 'evidence'),
      reproduction: flagString(parsed, 'reproduction') ?? null,
      expected: flagString(parsed, 'expected') ?? null,
      observed: flagString(parsed, 'observed') ?? null,
      commits: flagList(parsed, 'commit'),
      verificationRequirements: flagList(parsed, 'requirement'),
      followUp: flagList(parsed, 'follow-up'),
      taskId: flagString(parsed, 'task-id') ?? null,
      command: flagString(parsed, 'command') ?? null,
      method: flagString(parsed, 'method') ?? null,
      result: flagString(parsed, 'result') ?? null,
    }),
  );

  if (options.json) printJson(io, result);
  else io.stdout(result.text);
  return 0;
}

async function runExport(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, EXPORT_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const { parsed } = parsedResult;
  if (helpRequested('export', parsed, io)) return 0;
  const options = commonOptions(parsed, io);

  const result = withService(options, (service) =>
    service.exportProject({
      project: options.project ?? parsed.positionals[0] ?? null,
      repositoryPath: options.repositoryPath ?? null,
      format: flagString(parsed, 'format') ?? 'markdown',
    }),
  );

  const out = flagString(parsed, 'out');
  if (out) {
    writeFileSync(out, result.text, 'utf8');
    io.stdout(`Wrote ${result.format} export (${result.text.length} bytes) to ${out}\n`);
  } else {
    io.stdout(result.text);
  }
  return 0;
}

async function runImport(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, IMPORT_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  const { parsed } = parsedResult;
  if (helpRequested('import', parsed, io)) return 0;

  const file = parsed.positionals[0] ?? flagString(parsed, 'file');
  if (!file) {
    io.stderr('Error: import requires a path to a JSON snapshot\n');
    return 2;
  }
  const raw = readFileSync(file, 'utf8');
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    io.stderr(`Error: ${file} is not valid JSON: ${(error as Error).message}\n`);
    return 1;
  }

  const validation = validateSnapshot(document);
  if (!validation.ok) {
    io.stderr(`Error: ${file} is not a master-mcp snapshot: ${validation.reason}\n`);
    return 1;
  }

  const modeRaw = flagString(parsed, 'mode') ?? 'merge';
  if (modeRaw !== 'merge' && modeRaw !== 'replace') {
    io.stderr(`Error: --mode must be "merge" or "replace" (got "${modeRaw}")\n`);
    return 2;
  }

  const options = commonOptions(parsed, io);
  const report = withService(options, (service) => service.importSnapshot(validation.snapshot, { mode: modeRaw }));

  if (options.json) printJson(io, report);
  else {
    const lines = [
      `IMPORTED ${validation.snapshot.project.slug} (${modeRaw})`,
      ...Object.entries(report.written).map(([collection, count]) => `- ${collection}: ${count}`),
    ];
    if (report.remappedIds.length > 0) {
      lines.push(`remapped ids: ${report.remappedIds.length} (ids already used by another project)`);
    }
    io.stdout(`${lines.join('\n')}\n`);
  }
  return 0;
}

async function runDoctor(argv: readonly string[], io: CliIo): Promise<number> {
  const parsedResult = parseOrReport(argv, GLOBAL_FLAGS, io);
  if (!parsedResult.ok) return parsedResult.code;
  if (helpRequested('doctor', parsedResult.parsed, io)) return 0;
  const options = commonOptions(parsedResult.parsed, io);

  const info = withService(options, (service) => service.describe());
  if (options.json) {
    printJson(io, info);
    return 0;
  }
  const lines = [
    'MASTER-MCP',
    `version: ${VERSION}`,
    `database: ${info.databasePath}`,
    `schema version: ${info.schemaVersion}`,
    `projects: ${info.projects.length}`,
  ];
  for (const project of info.projects) {
    lines.push(
      `- ${project.slug} (${project.name}): ${project.repositories} repositor${project.repositories === 1 ? 'y' : 'ies'}, ${project.memoryRecords} memory records`,
    );
  }
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
