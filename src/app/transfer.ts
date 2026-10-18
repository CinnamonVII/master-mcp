/**
 * Human-readable export.
 *
 * The database must never be the only recovery path, so this renders a complete
 * project snapshot as Markdown that a person can read without master-mcp, and
 * the JSON form restores losslessly via `importSnapshot`.
 */
import type { ProjectSnapshot } from '../domain/transfer.ts';
import { CONFIDENCE_CRITERIA } from '../domain/vocabulary.ts';

function heading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '_none recorded_' : items.map((item) => `- ${item}`).join('\n');
}

function field(label: string, value: string | null | undefined): string | null {
  return value && value.length > 0 ? `**${label}:** ${value}` : null;
}

function timestamp(value: string | null | undefined): string {
  return value ?? 'unknown';
}

/** Render a snapshot as Markdown, newest activity first within each section. */
export function exportMarkdown(snapshot: ProjectSnapshot): string {
  const out: string[] = [];
  const project = snapshot.project;

  out.push(heading(1, `${project.name} (${project.slug})`));
  const header: string[] = [];
  const push = (line: string | null): void => {
    if (line) header.push(`- ${line}`);
  };
  push(field('Phase', project.phase));
  push(field('Goal', project.goal));
  push(field('Description', project.description));
  push(`Project id: ${project.id}`);
  push(`Created: ${timestamp(project.createdAt)}`);
  push(`Last updated: ${timestamp(project.updatedAt)}`);
  push(`Last accessed: ${timestamp(project.lastAccessedAt)}`);
  push(`Exported: ${snapshot.exportedAt} (format v${snapshot.formatVersion} by ${snapshot.generator})`);
  out.push(header.join('\n'));

  out.push(heading(2, 'Repositories'));
  out.push(
    list(
      snapshot.repositories.map((repository) => {
        const relative = [
          `\`${repository.path}\``,
          repository.remoteUrl ? `remote ${repository.remoteUrl}` : null,
          repository.isPrimary ? 'primary' : null,
          repository.lastBranch ? `branch ${repository.lastBranch}` : null,
          repository.lastHead ? `HEAD ${repository.lastHead.slice(0, 8)}` : null,
        ].filter((part): part is string => part !== null);
        return relative.join(' · ');
      }),
    ),
  );

  out.push(heading(2, 'Constraints'));
  out.push(
    list(
      snapshot.constraints.map((constraint) => {
        const scope = constraint.subsystem ? ` _(${constraint.subsystem})_` : '';
        const state = constraint.active ? '' : ' **[inactive]**';
        return `**${constraint.severity}** — ${constraint.statement}${scope}${state} \`${constraint.id}\``;
      }),
    ),
  );

  out.push(heading(2, 'Decisions'));
  out.push(
    list(
      snapshot.decisions.map((decision) => {
        const parts = [`${decision.statement} \`${decision.id}\``];
        if (decision.rationale) parts.push(`  - why: ${decision.rationale}`);
        if (decision.alternatives.length > 0) parts.push(`  - considered: ${decision.alternatives.join('; ')}`);
        if (decision.subsystem) parts.push(`  - subsystem: ${decision.subsystem}`);
        if (decision.status === 'superseded') parts.push(`  - superseded by ${decision.supersededBy ?? 'unknown'}`);
        return parts.join('\n');
      }),
    ),
  );

  out.push(heading(2, 'Known bugs'));
  out.push(
    list(
      snapshot.bugs.map((bug) => {
        const parts = [`**${bug.severity}** / ${bug.status} — ${bug.title} \`${bug.id}\``];
        if (bug.observed) parts.push(`  - observed: ${bug.observed}`);
        if (bug.expected) parts.push(`  - expected: ${bug.expected}`);
        if (bug.reproduction) parts.push(`  - reproduction: ${bug.reproduction}`);
        if (bug.evidence.length > 0) parts.push(`  - evidence: ${bug.evidence.join('; ')}`);
        if (bug.files.length > 0) parts.push(`  - files: ${bug.files.join(', ')}`);
        return parts.join('\n');
      }),
    ),
  );

  out.push(heading(2, 'Findings'));
  out.push(
    list(
      snapshot.findings.map((finding) => {
        const parts = [`**${finding.confidence}** — ${finding.statement} \`${finding.id}\``];
        if (finding.symbols.length > 0) parts.push(`  - symbols: ${finding.symbols.join(', ')}`);
        if (finding.files.length > 0) parts.push(`  - files: ${finding.files.join(', ')}`);
        if (finding.evidence.length > 0) parts.push(`  - evidence: ${finding.evidence.join('; ')}`);
        parts.push(`  - meaning: ${CONFIDENCE_CRITERIA[finding.confidence]}`);
        return parts.join('\n');
      }),
    ),
  );

  out.push(heading(2, 'Tasks'));
  out.push(
    list(
      snapshot.tasks.map((task) => {
        const parts = [`**${task.priority}** / ${task.status} — ${task.title} \`${task.id}\``];
        if (task.subsystem) parts.push(`  - subsystem: ${task.subsystem}`);
        if (task.affectedFiles.length > 0) parts.push(`  - files: ${task.affectedFiles.join(', ')}`);
        parts.push(`  - verification: ${task.verificationStatus}`);
        if (task.verificationRequirements.length > 0) {
          parts.push(`  - requirements: ${task.verificationRequirements.join('; ')}`);
        }
        if (task.blockers.length > 0) parts.push(`  - blockers: ${task.blockers.join('; ')}`);
        if (task.dependencies.length > 0) parts.push(`  - depends on: ${task.dependencies.join(', ')}`);
        return parts.join('\n');
      }),
    ),
  );

  out.push(heading(2, 'Verification history'));
  out.push(
    list(
      snapshot.verifications.map((verification) => {
        const command = verification.command ? ` (\`${verification.command}\`)` : '';
        const task = verification.taskId ? ` for ${verification.taskId}` : '';
        const evidence = verification.evidence.length > 0 ? ` — ${verification.evidence.join('; ')}` : '';
        return `${verification.result}: ${verification.method}${command}${task} · ${verification.createdAt} \`${verification.id}\`${evidence}`;
      }),
    ),
  );

  out.push(heading(2, 'Handoffs'));
  out.push(
    list(
      snapshot.handoffs.map((handoff) => {
        const parts = [`${handoff.summary} \`${handoff.id}\` · ${handoff.createdAt}`];
        if (handoff.workCompleted) parts.push(`  - completed: ${handoff.workCompleted}`);
        if (handoff.workAttempted) parts.push(`  - attempted: ${handoff.workAttempted}`);
        if (handoff.failures.length > 0) parts.push(`  - failures: ${handoff.failures.join('; ')}`);
        if (handoff.blockers.length > 0) parts.push(`  - blockers: ${handoff.blockers.join('; ')}`);
        if (handoff.unresolved.length > 0) parts.push(`  - unresolved: ${handoff.unresolved.join('; ')}`);
        if (handoff.followUp.length > 0) parts.push(`  - follow-up: ${handoff.followUp.join('; ')}`);
        if (handoff.head) parts.push(`  - head: ${handoff.head}`);
        return parts.join('\n');
      }),
    ),
  );

  return `${out.join('\n\n')}\n`;
}
