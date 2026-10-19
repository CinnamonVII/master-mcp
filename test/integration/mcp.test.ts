/**
 * MCP surface tests.
 *
 * The MCP server is the interface coding agents actually talk to, so these
 * tests go through a real SDK client over the in-memory transport: the tool
 * list is exactly the six documented tools, annotations tell the truth about
 * what each tool does, every tool runs end to end against real memory, and a
 * bad call comes back as readable text rather than a broken protocol stream.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MasterMcpService } from '../../src/app/service.ts';
import { createServer, SERVER_NAME } from '../../src/mcp/server.ts';
import { harness, writeFiles } from '../helpers/harness.ts';

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

const TOOL_NAMES = [
  'master_complete',
  'master_context',
  'master_export',
  'master_record',
  'master_search',
  'master_status',
] as const;

interface Linked {
  client: Client;
  close(): Promise<void>;
}

async function connect(service: MasterMcpService): Promise<Linked> {
  const server = createServer({ service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'master-mcp-test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  assert.ok(first && first.type === 'text' && typeof first.text === 'string', 'expected a text result');
  return first.text;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe('MCP server', () => {
  it('exposes exactly the six documented tools with honest annotations', async () => {
    const h = harness('mcp');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG, [OFFER_FILE]: 'export function isEligible() { return true; }\n' });
      await h.with(async (service) => {
        const link = await connect(service);
        try {
          const { tools } = await link.client.listTools();
          assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES]);

          for (const tool of tools) {
            assert.ok(tool.title && tool.title.length > 0, `${tool.name} has a title`);
            assert.ok((tool.description ?? '').length > 40, `${tool.name} describes itself`);
            assert.ok(tool.inputSchema, `${tool.name} declares an input schema`);
            assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} never destroys`);
            assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} stays inside the project`);
          }

          const byName = new Map(tools.map((tool) => [tool.name, tool]));
          for (const name of ['master_search', 'master_status', 'master_export']) {
            assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} is read-only`);
          }
          for (const name of ['master_context', 'master_complete', 'master_record']) {
            assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, `${name} writes memory`);
          }

          assert.equal(link.client.getServerVersion()?.name, SERVER_NAME);
          assert.match(link.client.getInstructions() ?? '', /master_context once at the start/);
        } finally {
          await link.close();
        }
      });
    } finally {
      h.cleanup();
    }
  });

  it('runs context → complete → record → search → status → export through the client', async () => {
    const h = harness('mcp');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG, [OFFER_FILE]: 'export function isEligible() { return true; }\n' });
      await h.with(async (service) => {
        const link = await connect(service);
        try {
          const context = await call(link.client, 'master_context', {
            task: 'Fix the offer ownership check',
            affected_files: [OFFER_FILE],
          });
          assert.ok(!context.isError);
          const brief = textOf(context);
          assert.match(brief, /concurrent-studios/);
          assert.match(brief, /NEXT ACTION/);
          assert.match(brief, /TASK/);

          const complete = await call(link.client, 'master_complete', {
            summary: 'Ownership now comes from the offer record instead of the UI state.',
            task: 'Fix the offer ownership check',
            files_changed: [OFFER_FILE],
            tests_run: [{ command: 'npm test', result: 'pass', evidence: ['24 passing'] }],
          });
          assert.ok(!complete.isError);
          const recorded = textOf(complete);
          assert.match(recorded, /^RECORDED/);
          assert.match(recorded, /task tsk_[a-z0-9]+ → verified_done \(verification: verified\)/);
          assert.match(recorded, /handoff: hnd_[a-z0-9]+/);

          const decision = await call(link.client, 'master_record', {
            kind: 'decision',
            body: 'Eligibility lives in the offer predicate',
            rationale: 'One source of truth prevents UI drift.',
            subsystem: 'industry-offer',
          });
          assert.ok(!decision.isError);
          assert.match(textOf(decision), /Recorded decision dec_[a-z0-9]+/);

          const search = await call(link.client, 'master_search', { query: 'eligibility predicate' });
          assert.ok(!search.isError);
          const hits = textOf(search);
          assert.match(hits, /SEARCH "eligibility predicate"/);
          assert.match(hits, /\[decision\] Eligibility lives in the offer predicate/);

          const status = await call(link.client, 'master_status', {});
          assert.ok(!status.isError);
          assert.match(textOf(status), /concurrent-studios/);

          const exported = await call(link.client, 'master_export', { format: 'json' });
          assert.ok(!exported.isError);
          const snapshot = JSON.parse(textOf(exported)) as { project: { slug: string }; tasks: unknown[]; handoffs: unknown[] };
          assert.equal(snapshot.project.slug, 'concurrent-studios');
          assert.equal(snapshot.tasks.length, 1);
          assert.equal(snapshot.handoffs.length, 1);
        } finally {
          await link.close();
        }
      });
    } finally {
      h.cleanup();
    }
  });

  it('returns readable text for invalid calls and keeps the session usable', async () => {
    const h = harness('mcp');
    try {
      writeFiles(h.dir, { '.mcp/master-mcp.yaml': CONFIG });
      await h.with(async (service) => {
        const link = await connect(service);
        try {
          const blankQuery = await call(link.client, 'master_search', { query: '   ' });
          assert.equal(blankQuery.isError, true, 'a blank query is an error result, not a protocol failure');
          assert.match(textOf(blankQuery), /query/i);

          const blankBody = await call(link.client, 'master_record', { kind: 'decision', body: '   ' });
          assert.equal(blankBody.isError, true);
          assert.match(textOf(blankBody), /body/i);

          const unknownProject = await call(link.client, 'master_export', { project: 'no-such-project' });
          assert.equal(unknownProject.isError, true);
          assert.match(textOf(unknownProject), /no-such-project/);

          // The connection survives failed calls.
          const context = await call(link.client, 'master_context', { task: 'Fix the offer ownership check' });
          assert.ok(!context.isError);
          assert.match(textOf(context), /NEXT ACTION/);
        } finally {
          await link.close();
        }
      });
    } finally {
      h.cleanup();
    }
  });
});
