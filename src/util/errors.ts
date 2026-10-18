/**
 * Error types. Every failure surfaced to an agent or CLI user should be an
 * `MasterMcpError` carrying an actionable message, because the caller has no
 * other way to debug an MCP tool failure.
 */
export class MasterMcpError extends Error {
  readonly code: string;
  readonly hint: string | null;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'MasterMcpError';
    this.code = code;
    this.hint = hint ?? null;
  }

  toDisplay(): string {
    return this.hint ? `${this.code}: ${this.message}\nHint: ${this.hint}` : `${this.code}: ${this.message}`;
  }
}

export function configError(message: string, hint?: string): MasterMcpError {
  return new MasterMcpError('CONFIG_ERROR', message, hint);
}

export function notFoundError(message: string, hint?: string): MasterMcpError {
  return new MasterMcpError('NOT_FOUND', message, hint);
}

export function usageError(message: string, hint?: string): MasterMcpError {
  return new MasterMcpError('USAGE', message, hint);
}

/** Narrow an unknown thrown value into a printable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof MasterMcpError) return error.toDisplay();
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Collect non-fatal problems found during a call (malformed config, git absent). */
export class WarningCollector {
  private readonly warnings: string[] = [];

  add(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  addAll(messages: readonly string[]): void {
    for (const message of messages) this.add(message);
  }

  list(): string[] {
    return [...this.warnings];
  }

  get size(): number {
    return this.warnings.length;
  }
}
