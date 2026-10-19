# master-mcp

One-pass project intelligence for coding agents: one call before work, one call after.

A coding agent that opens a repository cold knows nothing about why the code is
the way it is. master-mcp keeps that knowledge — decisions, constraints, bugs,
findings, verification history, handoffs — in a local SQLite project brain and
serves it back as a single engineering brief:

- **`master_context("Fix the incorrect ownership check")`** — one call returns
  project identity, task interpretation, critical constraints, relevant history,
  likely files, risk level, an approach, a verification plan and one recommended
  next action.
- **`master_complete(...)`** — one call after the work records what was done,
  what was verified, what was learned, and hands the next pass a better starting
  point.

Everything else (`master_search`, `master_status`, `master_record`,
`master_export`) exists for the cases the brief cannot cover. Nothing edits
code, runs tests or commits: master-mcp observes git, remembers, and gets out
of the way.

## Why TypeScript

- The official MCP SDK (`@modelcontextprotocol/sdk`) is TypeScript-first, so the
  server uses the same tooling as the clients and the protocol types are exact.
- One runtime for everything: the server, the CLI and the test suite all run on
  Node with no Python/venv/bundler layer. Development runs the `.ts` sources
  directly through Node's native type stripping; `npm run build` emits plain
  JavaScript for installation.
- Storage is a single SQLite file via built-in `node:sqlite` — no native addon,
  no server process, no Docker.

## Requirements

- Node.js 22.13+ or 24+ (developed and tested on 26.8.1). The built server uses
  the built-in `node:sqlite`, which stopped needing a flag in Node 22.13/23.4.
- `git` on `PATH` for repository state. master-mcp still works without it, with
  a note in the brief.

## Install

```sh
git clone <this-repo> master-mcp
cd master-mcp
npm install
npm run build
npm link          # or: npm install -g .
master-mcp doctor
```

`doctor` prints the database path, schema version and known projects:

```
MASTER-MCP
version: 1.0.0
database: /home/you/.local/share/master-mcp/master-mcp.db
schema version: 1
projects: 0
```

## Quick start (CLI)

The transcript below is a real session against a throwaway repository (output
trimmed where marked with `...`; everything shown is verbatim). The project
declares itself through `.mcp/master-mcp.yaml`:

```yaml
project: offer-service
goal: >
  Make offer eligibility trustworthy for customers and support.
verification:
  test_command: npm test
```

First call, before any memory exists:

```
$ master-mcp context "Fix the incorrect ownership check in the industry-offer list" \
      --file src/industry/offer.ts
PROJECT
offer-service (offer-service) — phase: not recorded
repo /tmp/opencode/mm-e2e-final/offer-service · branch main · HEAD 86112ced · clean
goal: Make offer eligibility trustworthy for customers and support.
latest commit: feat(industry): add the offer model and eligibility check
note: registered by this call — no engineering memory stored yet

TASK
Fix the incorrect ownership check in the industry-offer list
type: bugfix (inferred, medium) · subsystem: industry (inferred, low) · task tsk_tn4pek4a9803 [in_progress/P2]
declared files: src/industry/offer.ts
...
MEMORY GAPS
- Project memory is empty: this brief is built from repository state alone.
...
NEXT ACTION
Start by inspecting src/industry/offer.ts, then tests/offer.test.ts.
When finished: master_complete with task_id tsk_tn4pek4a9803 (summary, files changed, tests run, results).
```

The agent reproduces the defect (`npm test` fails: an unrelated viewer can see
the offer), fixes `isEligible`, and records the pass:

```
$ master-mcp complete --task-id tsk_tn4pek4a9803 \
      --summary "Added the missing ownership check: isEligible now requires the viewer to be the offer owner, with a regression test for the unrelated-viewer case." \
      --files src/industry/offer.ts,tests/offer.test.ts \
      --test "npm test => pass" \
      --discovery "isEligible is the single decision point for offer visibility; every list route calls it." \
      --discovery-confidence statically_supported \
      --follow-up "Audit the support tooling for the same missing ownership check"
RECORDED
task tsk_tn4pek4a9803 → verified_done (verification: verified)
title: Fix the incorrect ownership check in the industry-offer list
files: src/industry/offer.ts, tests/offer.test.ts
handoff: hnd_tn4pf25d1b12

NEXT
master_context with a related task will now include this handoff. Task state: verified_done.
NOTES
- Finding "isEligible is the single decision point for offer…": statically_supported requires at least a file, symbol or evidence reference; downgraded to suspected.
```

The `NOTES` line shows the trust guard at work: the discovery is still stored,
but `statically_supported` needs a file, symbol or evidence reference, so it is
downgraded to `suspected` instead of being presented as a fact later. The
evidence-backed finding, plus a constraint, a bug and a decision, were recorded
with `master_record`.

The same call for the same task now returns the memory that matters:

```
$ master-mcp context "Fix the incorrect ownership check in the industry-offer list" \
      --file src/industry/offer.ts
PROJECT
offer-service (offer-service) — phase: not recorded
repo /tmp/opencode/mm-e2e-final/offer-service · branch main · HEAD 25398518 · clean
goal: Make offer eligibility trustworthy for customers and support.
latest commit: fix(industry): only the owner sees their offer (of 2)

TASK
Fix the incorrect ownership check in the industry-offer list
type: bugfix (inferred, medium) · subsystem: industry (inferred, high) · task tsk_tn4pek4a9803 [verified_done/P2]
declared files: src/industry/offer.ts
components (inferred): offer.ts (in industry)

CRITICAL CONSTRAINTS
- [critical] Offer visibility must always be derived from the offer record, never from UI or session state — industry (con_tn4pfga2847e)

RELEVANT HISTORY
bugs:
- [medium/open, just now] Support tooling still shows offers the viewer does not own (bug_tn4pfg3b543e)
    observed: Support agents can open offers owned by other users.
    files: src/industry/offer.ts
decisions:
- Offer visibility is decided by isEligible from the stored offer record (dec_tn4pfg5c8ae7, just now)
    why: One decision point keeps list, detail and support views consistent.
findings (unverified entries are not facts):
- isEligible is the single decision point for offer visibility. [statically_supported, fnd_tn4pfgf67bbe, just now]
- isEligible is the single decision point for offer visibility; every list route calls it. [suspected, fnd_tn4pf268b2c4, just now]
previous work:
- Added the missing ownership check: isEligible now requires the viewer to be the offer owner, with a regression test for the unrelated-viewer case. (hnd_tn4pf25d1b12, just now)
    completed: Added the missing ownership check: isEligible now requires the viewer to be the offer owner, with a regression test for the unrelated-viewer case.
    follow-up: Audit the support tooling for the same missing ownership check (tsk_tn4pf27c8c44)
verification history:
- npm test → pass [just now, ver_tn4pf2447281]
...

KNOWN RISK
level: critical
- A critical constraint applies to this subsystem.
- An open bug affects this area.
- This subsystem is referenced by many stored records, so the logic is reused.

OPEN FOLLOW-UPS
- [P2, todo] Audit the support tooling for the same missing ownership check (tsk_tn4pf27c8c44)

NEXT ACTION
Start by inspecting src/industry/offer.ts, then tests/offer.test.ts.
When finished: master_complete with task_id tsk_tn4pek4a9803 (summary, files changed, tests run, results).
```

The first brief was ~570 tokens, the remembered one ~960 — a brief, not a
database dump.

## MCP tools

The server exposes exactly six tools:

| Tool | Purpose |
| --- | --- |
| `master_context` | The one-pass brief for a task. Call this first. |
| `master_complete` | Record the result of the pass. Call once when done. |
| `master_record` | Escape hatch: store one decision, constraint, bug, finding, todo, handoff or verification. |
| `master_search` | Full-text search when the brief did not already answer a historical question. |
| `master_status` | Compact project overview when there is no task yet. |
| `master_export` | Markdown or lossless JSON dump for backup and review. |

`master_search`, `master_status` and `master_export` are declared read-only in
the MCP annotations; none of the six can modify your repository.

## Client configuration

Any MCP client that can launch a stdio server works; the server takes no
arguments and speaks MCP on stdin/stdout. Point the client at the built
`dist/index.js`.

### Claude Code — validated

```sh
claude mcp add master-mcp -- node /absolute/path/to/master-mcp/dist/index.js
claude mcp list
```

The list performs a health check; this build reports `✔ Connected`. The
equivalent `.mcp.json` entry is:

```json
{
  "mcpServers": {
    "master-mcp": { "command": "node", "args": ["/absolute/path/to/master-mcp/dist/index.js"] }
  }
}
```

### Codex — configuration validated

`codex mcp add master-mcp -- node /absolute/path/to/master-mcp/dist/index.js`
writes the following into `~/.codex/config.toml`, and `codex mcp list` shows the
registered server. A live model session was not exercised here.

```toml
[mcp_servers.master-mcp]
command = "node"
args = ["/absolute/path/to/master-mcp/dist/index.js"]
```

### OpenCode (V2) — validated

```sh
opencode mcp add master-mcp -- node /absolute/path/to/master-mcp/dist/index.js
opencode mcp list
```

This build reports `✓ master-mcp connected`. The generated `opencode.json`
entry is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "master-mcp": {
        "type": "local",
        "command": ["node", "/absolute/path/to/master-mcp/dist/index.js"]
      }
    }
  }
}
```

Clients spawn the server with their own environment, so set `MASTER_MCP_DB` in
the client's server configuration (for example `"env": {"MASTER_MCP_DB": "..."}`)
if you do not want the default database location.

## CLI

The CLI is the same application layer as the MCP tools:

```
master-mcp context <task>      Engineering brief (the main entry point)
master-mcp complete            Record the result of a work pass
master-mcp status              Compact project overview
master-mcp search <query>      Full-text search over stored memory
master-mcp record              Record one durable fact
master-mcp export [project]    Export memory (--format markdown|json, --out <file>)
master-mcp import <file>       Import a JSON snapshot (--mode merge|replace)
master-mcp mcp                 Run the MCP server over stdio
master-mcp doctor              Database location, schema version, projects
```

Common flags: `--project <slug>` (usually inferred), `--repo <path>` (defaults
to the working directory), `--json` for machine-readable output, `--db <path>`
to override the database, `-h/--help` on every command.

Exit codes: `0` success, `1` error, `2` usage error.

## Configuration

Everything is optional. `.mcp/master-mcp.yaml` is discovered by walking up from
the working directory, so commands run from `repo/src/feature` still find it:

```yaml
project: concurrent-studios

goal: >
  Expand Game Dev Tycoon with advanced studio-management systems.

phase: implementation
important_paths:
  - src/
  - tests/
subsystems:
  - industry-offer
  - technology-ownership
  - payment-service

verification:
  test_command: npm test
  lint_command: npm run lint
  build_command: npm run build
  extra_checks:
    - manual walkthrough of the offer dialog

context:
  recent_commits: 10
  max_brief_tokens: 2000
```

- `project` — slug used to group memory across repositories.
- `subsystems` — names the ranking engine can match against task wording; the
  more the brief knows, the better it ranks.
- `verification.*` — commands the brief puts in the verification plan.
- `context.recent_commits` (default 10, max 100) and
  `context.max_brief_tokens` (default 2000, range 400–12000) — brief size.

A malformed config produces a warning in the brief, never a crash.

## Trust model

master-mcp records what it can defend:

- A completion without passing evidence ends as `implementation_done` with
  verification `none`, `claimed` or `partial` — never `verified_done`.
- `verified_done` requires a passing command with a command line or evidence.
- A resolved bug becomes `fix_claimed` unless the resolution is verified, in
  which case it becomes `fixed_verified`.
- Findings carry a confidence ladder — `hypothesis`, `suspected`,
  `statically_supported`, `runtime_observed`, `runtime_confirmed` — and claims
  above `statically_supported` are downgraded unless evidence is recorded.
  Reverse-engineering briefs separate *established (runtime evidence on record)*
  from *unverified (do not treat as fact)*.
- Briefs warn when the repository moved past the last recorded observation, or
  when the branch changed since the cached handoff.

## Storage and backup

The database is one SQLite file (WAL mode, FTS5 index, versioned migrations):

1. `MASTER_MCP_DB` — full path (or `:memory:`)
2. `MASTER_MCP_HOME/master-mcp.db`
3. `XDG_DATA_HOME/master-mcp/master-mcp.db`
4. `~/.local/share/master-mcp/master-mcp.db`

Export is both a human document and a lossless backup:

```sh
master-mcp export --format markdown --out project.md
master-mcp export --format json --out backup.json
master-mcp import backup.json --mode merge     # upsert into the existing project
master-mcp import backup.json --mode replace   # clear the project's memory first
```

Import never silently moves another project's records: colliding ids are
re-issued and reported. The Markdown form is for reading; only the JSON form
restores.

## Non-goals

master-mcp is not a Git client, a code editor, a shell executor, a CI system, a
GitHub replacement, a task-management web app, a vector database, an LLM
wrapper, a cloud service or a multi-user platform. v1 is local, deterministic,
fast, persistent, low-token, auditable and boringly reliable.

## Development

```sh
npm run typecheck     # tsc --noEmit
npm test              # node --test over test/unit and test/integration
npm run test:unit
npm run test:integration
npm run check         # typecheck + tests + build
```

Tests run the TypeScript sources directly (Node native type stripping), use
temporary databases and real temporary git repositories, and require no
network. The suite includes an MCP client/server round trip over the official
SDK transport, a spawned-binary CLI cycle, persistence across restarts, and
export/import round trips.

Layout:

```
src/domain    models, vocabularies, snapshot format
src/store     SQLite schema, migrations, typed accessors, FTS, transfer
src/repo      git adapter and project discovery
src/config    .mcp/master-mcp.yaml loading
src/app       ranking, interpretation, brief assembly, service layer
src/mcp       the six MCP tools
src/cli       terminal interface and argument parsing
```

## License

MIT
