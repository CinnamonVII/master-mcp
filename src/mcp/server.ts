/**
 * MCP interface.
 *
 * Exactly six tools, each mapping onto one application-service call. The surface
 * is intentionally small: `master_context` before work and `master_complete`
 * after it are the normal path, and the other four exist for the cases the brief
 * cannot cover (historical detail, no-task overview, explicit recording, backup).
 *
 * Handlers stay thin — validation, one service call, one text result. All
 * business rules live in `src/app`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { MasterMcpService } from '../app/service.ts';
import type { ServiceOptions } from '../app/service.ts';
import { errorMessage } from '../util/errors.ts';
import { log } from '../util/log.ts';
import { VERSION } from '../version.ts';

export const SERVER_NAME = 'master-mcp';

/**
 * Agent-facing usage guidance. Clients surface this at session start, which is
 * what makes the one-pass workflow discoverable without extra calls.
 */
export const SERVER_INSTRUCTIONS = [
  'master-mcp is a project brain for coding agents. Call master_context once at the start of a task to get project',
  'identity, task interpretation, critical constraints, relevant history, risks, verification requirements and a',
  'single recommended next action — no extra calls needed. Do the work with your normal filesystem/git/shell tools',
  '(master-mcp never edits code, runs tests or commits), then call master_complete once to persist the result.',
  'Verification is requirement-aware: partial coverage stays implementation_done, and bugs become fixed_verified only',
  'with bug-specific evidence. Use master_search only for unusual historical detail, master_status when no task exists',
  'yet, and master_record to store a durable engineering fact (decision, constraint, bug, finding, todo).',
].join(' ');

const verificationItemSchema = z.object({
  method: z.string().optional().describe('What was checked, e.g. "unit tests" or "manual walkthrough".'),
  command: z.string().optional().describe('The exact command that was run, when one was run.'),
  result: z.enum(['pass', 'fail', 'partial', 'unknown']).optional().describe('Outcome of this check.'),
  evidence: z.array(z.string()).optional().describe('Concrete observations: output lines, exit codes, paths.'),
});

const discoverySchema = z.union([
  z.string().describe('A bare statement, recorded at confidence "suspected" and evidence-free.'),
  z.object({
    statement: z.string(),
    confidence: z
      .enum(['hypothesis', 'suspected', 'statically_supported', 'runtime_observed', 'runtime_confirmed'])
      .optional()
      .describe('Claims above statically_supported require evidence; the server downgrades unsupported claims.'),
    evidence: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
  }),
]);

const followUpSchema = z.union([
  z.string(),
  z.object({
    title: z.string(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    subsystem: z.string().optional(),
    description: z.string().optional(),
  }),
]);

const bugSchema = z.union([
  z.string(),
  z.object({
    title: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    subsystem: z.string().optional(),
    reproduction: z.string().optional(),
    expected: z.string().optional(),
    observed: z.string().optional(),
    evidence: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
  }),
]);

const testRunSchema = z.union([
  z
    .string()
    .describe('A description of a check. Without a result it is recorded as an unknown-outcome claim, not a pass.'),
  z.object({
    command: z.string().optional(),
    method: z.string().optional(),
    result: z.enum(['pass', 'fail', 'partial', 'unknown']).optional(),
    evidence: z.array(z.string()).optional(),
  }),
]);

export interface CreateServerOptions extends ServiceOptions {
  /** Override the service, mainly for tests. */
  service?: MasterMcpService;
}

/** Build the MCP server with all six tools registered. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const service = options.service ?? MasterMcpService.open(options);
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /** Wrap a handler so failures reach the agent as readable text, never a crash. */
  const guard =
    <T>(name: string, handler: (args: T) => Promise<string> | string) =>
    async (args: T): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
      try {
        const text = await handler(args);
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        log.error(`tool ${name} failed`, { error: String(error) });
        return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
      }
    };

  server.registerTool(
    'master_context',
    {
      title: 'One-pass project + task brief',
      description:
        'Start here. Give the coding task and master-mcp identifies the project and repository, ranks the stored ' +
        'engineering memory that is relevant to it, reports critical constraints, known bugs, previous attempts, ' +
        'likely files, risks and the verification plan, then ends with one recommended next action. ' +
        'The response is a single engineering brief sufficient to begin work — do not call other master-mcp tools first.',
      inputSchema: {
        task: z.string().describe('The coding task, in a sentence. E.g. "Fix the incorrect ownership check in the offer UI".'),
        project: z.string().optional().describe('Project slug or name. Usually unnecessary: it is inferred from the repository.'),
        repository_path: z.string().optional().describe('Path inside the repository. Defaults to the server working directory.'),
        affected_files: z.array(z.string()).optional().describe('Files you already know are involved; they seed ranking.'),
        mode: z
          .enum(['auto', 'read_only', 'deep', 're'])
          .optional()
          .describe('auto (default): normal pass. read_only: nothing is written. deep: wider history. re: reverse-engineering framing.'),
        refresh: z.boolean().optional().describe('Re-read repository metadata even if HEAD looks unchanged.'),
        max_tokens: z
          .number()
          .int()
          .min(400)
          .max(12000)
          .optional()
          .describe('Override the brief token budget for this call (default 2000; deep 4000; re 3000).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard('master_context', async (args) => {
      const result = await service.context({
        task: args.task,
        project: args.project ?? null,
        repositoryPath: args.repository_path ?? null,
        affectedFiles: args.affected_files ?? null,
        mode: args.mode ?? null,
        refresh: args.refresh ?? null,
        maxTokens: args.max_tokens ?? null,
      });
      return result.text;
    }),
  );

  server.registerTool(
    'master_complete',
    {
      title: 'Record the result of a work pass',
      description:
        'Call once after finishing work. Records the outcome into persistent project memory: task state, verification ' +
        'history, findings, bugs, follow-ups and a handoff for the next agent. ' +
        'Verification is judged against the task\'s declared requirements (or, when it declares none, the configured ' +
        'test/lint/build commands): only full coverage is `verified`; partial coverage stays `implementation_done`. ' +
        'A bug is `fixed_verified` only with bug-specific evidence — evidence that names the bug, matches its title, or ' +
        'satisfies one of the task\'s regression requirements; anything else is `fix_claimed`.',
      inputSchema: {
        summary: z.string().describe('What was actually done, in one or two sentences.'),
        project: z.string().optional(),
        repository_path: z.string().optional(),
        task_id: z.string().optional().describe('Task id from master_context, when you have it.'),
        task: z.string().optional().describe('Task title, when you do not have an id.'),
        files_changed: z.array(z.string()).optional(),
        commits: z.array(z.string()).optional(),
        tests_run: z.array(testRunSchema).optional().describe('Checks performed. A passing result needs a command or evidence to count.'),
        verification: z.array(verificationItemSchema).optional().describe('Structured verification records.'),
        results: z.array(z.string()).optional().describe('Free-text results. Recorded as claims, never as verification.'),
        discoveries: z.array(discoverySchema).optional().describe('Durable facts learned. Support runtime claims with evidence.'),
        unresolved: z.array(z.string()).optional().describe('Open questions; each becomes a dependent follow-up task.'),
        blockers: z.array(z.string()).optional().describe('Anything that stopped the work. Blocks the task.'),
        follow_up: z.array(followUpSchema).optional().describe('Work that should happen next; becomes dependent tasks.'),
        bugs_found: z.array(bugSchema).optional(),
        bugs_resolved: z.array(z.string()).optional().describe('Bug ids or exact titles. Marked fix_claimed unless the evidence is specific to the bug.'),
        subsystems: z.array(z.string()).optional(),
        status: z
          .enum(['todo', 'in_progress', 'implementation_done', 'verified_done', 'blocked', 'cancelled'])
          .optional()
          .describe('Explicit override. verified_done is refused without passing evidence.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard('master_complete', async (args) => {
      const result = await service.complete({
        summary: args.summary,
        project: args.project ?? null,
        repositoryPath: args.repository_path ?? null,
        taskId: args.task_id ?? null,
        task: args.task ?? null,
        filesChanged: args.files_changed ?? null,
        commits: args.commits ?? null,
        testsRun: args.tests_run ?? null,
        verification: args.verification ?? null,
        results: args.results ?? null,
        discoveries: args.discoveries ?? null,
        unresolved: args.unresolved ?? null,
        blockers: args.blockers ?? null,
        followUp: args.follow_up ?? null,
        bugsFound: args.bugs_found ?? null,
        bugsResolved: args.bugs_resolved ?? null,
        subsystems: args.subsystems ?? null,
        status: args.status ?? null,
      });
      const notes = result.notes.length > 0 ? `\nNOTES\n${result.notes.map((note) => `- ${note}`).join('\n')}\n` : '';
      return `${result.text}${notes}`;
    }),
  );

  server.registerTool(
    'master_search',
    {
      title: 'Search stored engineering memory',
      description:
        'Full-text search over stored decisions, constraints, bugs, findings, tasks, verifications and handoffs. ' +
        'Use only when master_context did not already answer a historical question ("why was X removed?").',
      inputSchema: {
        query: z.string().describe('What you are looking for, in natural language.'),
        project: z.string().optional(),
        kinds: z
          .array(z.enum(['task', 'decision', 'constraint', 'bug', 'finding', 'verification', 'handoff']))
          .optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard('master_search', (args) => {
      const result = service.search({
        query: args.query,
        project: args.project ?? null,
        kinds: args.kinds ?? null,
        limit: args.limit ?? null,
      });
      return result.text;
    }),
  );

  server.registerTool(
    'master_status',
    {
      title: 'Compact project overview',
      description:
        'Where does this project stand? Project phase and goal, repository state, active work, blockers, open bugs, ' +
        'the latest handoff and the most important next task. Use when you have no specific task yet.',
      inputSchema: {
        project: z.string().optional(),
        repository_path: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard('master_status', async (args) => {
      const result = await service.status({
        project: args.project ?? null,
        repositoryPath: args.repository_path ?? null,
      });
      return result.text;
    }),
  );

  server.registerTool(
    'master_record',
    {
      title: 'Record one durable engineering fact',
      description:
        'Escape hatch for explicitly recording a decision, constraint, bug, finding/hypothesis, todo, handoff or ' +
        'verification outside the normal work cycle. Prefer master_complete: it records the same kinds of facts ' +
        'together with task state and evidence. Decisions and constraints can be retired here: ' +
        'record a decision with supersedes=<decision id> to replace an active one, or a constraint with ' +
        'replaces=<constraint id> (replaced by the new record) or deactivate=<constraint id> (retired with the body ' +
        'as the reason). Superseded and inactive records stay searchable and exportable.',
      inputSchema: {
        kind: z
          .enum(['decision', 'constraint', 'bug', 'finding', 'hypothesis', 'todo', 'handoff', 'verification'])
          .describe('What kind of record this is.'),
        body: z.string().describe('The statement, title or description itself.'),
        project: z.string().optional(),
        repository_path: z.string().optional(),
        subsystem: z.string().optional().describe('Subsystem this belongs to; used for relevance matching.'),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Constraints and bugs.'),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Todos.'),
        confidence: z
          .enum(['hypothesis', 'suspected', 'statically_supported', 'runtime_observed', 'runtime_confirmed'])
          .optional()
          .describe('Findings. Levels above statically_supported require evidence.'),
        rationale: z.string().optional().describe('Decisions: why. Todos: extra description. Handoffs: what was completed.'),
        alternatives: z.array(z.string()).optional().describe('Decisions: alternatives considered. Handoffs: blockers.'),
        files: z.array(z.string()).optional(),
        symbols: z.array(z.string()).optional().describe('Findings: functions, addresses or other symbols involved.'),
        evidence: z.array(z.string()).optional(),
        reproduction: z.string().optional().describe('Bugs only.'),
        expected: z.string().optional().describe('Bugs only.'),
        observed: z.string().optional().describe('Bugs only.'),
        commits: z.array(z.string()).optional(),
        verification_requirements: z.array(z.string()).optional().describe('Todos only.'),
        follow_up: z.array(z.string()).optional().describe('Handoffs only: work that should happen next.'),
        task_id: z.string().optional().describe('Handoffs and verifications only.'),
        command: z.string().optional().describe('Verifications only.'),
        method: z.string().optional().describe('Verifications only.'),
        result: z.enum(['pass', 'fail', 'partial', 'unknown']).optional().describe('Verifications only.'),
        supersedes: z.string().optional().describe('Decisions only: id of the active decision this one supersedes.'),
        replaces: z.string().optional().describe('Constraints only: id of the active constraint this one replaces.'),
        deactivate: z.string().optional().describe('Constraints only: id of an active constraint to retire, with the body as the reason.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard('master_record', (args) =>
      service.record({
        kind: args.kind,
        body: args.body,
        project: args.project ?? null,
        repositoryPath: args.repository_path ?? null,
        subsystem: args.subsystem ?? null,
        severity: args.severity ?? null,
        priority: args.priority ?? null,
        confidence: args.confidence ?? null,
        rationale: args.rationale ?? null,
        alternatives: args.alternatives ?? null,
        files: args.files ?? null,
        symbols: args.symbols ?? null,
        evidence: args.evidence ?? null,
        reproduction: args.reproduction ?? null,
        expected: args.expected ?? null,
        observed: args.observed ?? null,
        commits: args.commits ?? null,
        verificationRequirements: args.verification_requirements ?? null,
        followUp: args.follow_up ?? null,
        taskId: args.task_id ?? null,
        command: args.command ?? null,
        method: args.method ?? null,
        result: args.result ?? null,
        supersedes: args.supersedes ?? null,
        replaces: args.replaces ?? null,
        deactivate: args.deactivate ?? null,
      }).text,
    ),
  );

  server.registerTool(
    'master_export',
    {
      title: 'Export project memory',
      description:
        'Full, human-readable (markdown) or lossless (json) dump of a project\'s stored memory, for backup, review or ' +
        'handing to another machine. Import the json form with `master-mcp import`.',
      inputSchema: {
        project: z.string().optional().describe('Project slug or name; inferred from the repository when omitted.'),
        repository_path: z.string().optional(),
        format: z.enum(['markdown', 'json']).optional().describe('Defaults to markdown.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard('master_export', (args) => service.exportProject({
      project: args.project ?? null,
      repositoryPath: args.repository_path ?? null,
      format: args.format ?? null,
    }).text),
  );

  return server;
}

/** Run the server over stdio (the transport MCP clients use). */
export async function runStdioServer(options: CreateServerOptions = {}): Promise<void> {
  const server = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('master-mcp MCP server running on stdio');
}
