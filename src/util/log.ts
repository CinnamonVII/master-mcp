/**
 * Debug logging.
 *
 * stdout is reserved for the MCP protocol, so all diagnostics go to stderr and
 * only when MASTER_MCP_DEBUG is set. Silence by default keeps tool output and
 * CLI output clean.
 */
const enabled = (() => {
  const value = process.env['MASTER_MCP_DEBUG'];
  return value === '1' || value === 'true' || value === 'yes';
})();

function emit(level: string, message: string, detail?: unknown): void {
  if (!enabled) return;
  const suffix = detail === undefined ? '' : ` ${safeJson(detail)}`;
  process.stderr.write(`[master-mcp] ${level} ${message}${suffix}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => emit('debug', message, detail),
  info: (message: string, detail?: unknown) => emit('info', message, detail),
  warn: (message: string, detail?: unknown) => emit('warn', message, detail),
  error: (message: string, detail?: unknown) => emit('error', message, detail),
};

export function isDebugEnabled(): boolean {
  return enabled;
}
