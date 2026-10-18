#!/usr/bin/env node
/**
 * Entry point.
 *
 * Starts the MCP stdio server when asked explicitly (`master-mcp mcp`) or when
 * launched with no arguments and a non-interactive stdin — which is how MCP
 * clients invoke a server binary. Anything else goes to the CLI.
 */
import { runCli } from './cli/cli.ts';
import { log } from './util/log.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const invokedAsServer = argv[0] === 'mcp' || argv[0] === 'serve';
  const noArgs = argv.length === 0;
  const nonInteractive = !process.stdin.isTTY;

  if (invokedAsServer || (noArgs && nonInteractive)) {
    const { runStdioServer } = await import('./mcp/server.ts');
    await runStdioServer();
    return;
  }

  const code = await runCli(argv);
  process.exitCode = code;
}

main().catch((error: unknown) => {
  log.error('fatal', { error: String(error) });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
