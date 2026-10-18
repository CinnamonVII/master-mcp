/**
 * Argument parser tests.
 *
 * The parser is hand-written, so its contract is pinned here: value flags,
 * `--flag=value`, short aliases, repeats, booleans, `--` literals and the
 * error cases the CLI turns into exit code 2.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  flagBool,
  flagList,
  flagString,
  parseArgs,
  splitList,
  splitVerification,
  type FlagSpec,
} from '../../src/cli/args.ts';

const SPECS: FlagSpec[] = [
  { name: 'project', aliases: ['p'] },
  { name: 'file', aliases: ['files', 'f'] },
  { name: 'refresh', boolean: true },
];

function parse(argv: string[]): ReturnType<typeof parseArgs> {
  return parseArgs(argv, SPECS);
}

describe('parseArgs', () => {
  it('reads a flag value given as a separate argument', () => {
    const result = parse(['--project', 'concurrent-studios']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(flagString(result.parsed, 'project'), 'concurrent-studios');
  });

  it('reads --flag=value', () => {
    const result = parse(['--project=concurrent-studios']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(flagString(result.parsed, 'project'), 'concurrent-studios');
  });

  it('resolves aliases onto the canonical name', () => {
    const result = parse(['-p', 'other', '-f', 'src/a.ts']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(flagString(result.parsed, 'project'), 'other');
    assert.deepEqual(flagList(result.parsed, 'file'), ['src/a.ts']);
  });

  it('collects repeated flags in order', () => {
    const result = parse(['--file', 'a.ts', '--file', 'b.ts', '-f', 'c.ts']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(flagList(result.parsed, 'file'), ['a.ts', 'b.ts', 'c.ts']);
  });

  it('treats boolean flags as true and does not consume the next token', () => {
    const result = parse(['--refresh', 'task text']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(flagBool(result.parsed, 'refresh'), true);
    assert.deepEqual(result.parsed.positionals, ['task text']);
  });

  it('keeps tokens after -- as positionals', () => {
    const result = parse(['--', '--project']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.parsed.positionals, ['--project']);
    assert.equal(flagString(result.parsed, 'project'), undefined);
  });

  it('rejects unknown flags', () => {
    const result = parse(['--nope']);
    assert.deepEqual(result, { ok: false, error: 'unknown flag --nope' });
  });

  it('rejects a value flag with no value', () => {
    const result = parse(['--project']);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /requires a value/);
  });

  it('returns the last value for a repeated string flag', () => {
    const result = parse(['--project', 'a', '--project', 'b']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(flagString(result.parsed, 'project'), 'b');
  });

  it('does not treat a negative number as a flag', () => {
    const result = parse(['-1']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.parsed.positionals, ['-1']);
  });
});

describe('splitList', () => {
  it('splits, trims and drops empty entries', () => {
    assert.deepEqual(splitList('a.ts, b.ts ,, c.ts,'), ['a.ts', 'b.ts', 'c.ts']);
  });

  it('returns an empty array for undefined', () => {
    assert.deepEqual(splitList(undefined), []);
  });
});

describe('splitVerification', () => {
  it('splits a command from its result', () => {
    assert.deepEqual(splitVerification('npm test => pass'), { command: 'npm test', result: 'pass' });
  });

  it('leaves the result undefined when absent, so callers choose the default', () => {
    assert.deepEqual(splitVerification('npm test'), { command: 'npm test', result: undefined });
  });

  it('uses the last arrow so commands containing => survive', () => {
    assert.deepEqual(splitVerification('sh -c "a => b" => fail'), {
      command: 'sh -c "a => b"',
      result: 'fail',
    });
  });
});
