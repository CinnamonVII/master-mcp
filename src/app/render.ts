/**
 * Brief renderer.
 *
 * The brief is plain sectioned text, not nested JSON: an agent reading it spends
 * far fewer tokens on structure than on punctuation, and diffs stay readable.
 *
 * Sections are ordered so that everything needed to start work safely appears
 * before anything that is merely useful. A token budget then trims the least
 * important material — lowest-priority sections first, then their tail items —
 * so a brief never silently exceeds its budget.
 */
import type { Brief, BriefWarning } from './assembler.ts';
import type { StatusReport } from './status.ts';
import { isEstablished } from '../domain/vocabulary.ts';
import { approxTokens } from '../util/text.ts';

export interface RenderOptions {
  /** Soft cap on approximate tokens. Defaults to 2000. */
  maxTokens?: number;
}

interface Section {
  title: string;
  /** 0 = never dropped, 3 = dropped first. */
  priority: number;
  /** Lines kept as long as the section exists. */
  header: string[];
  /**
   * Droppable units, removed from the tail first when over budget. A unit may
   * contain several lines (a grouped record), so trimming never orphans a
   * heading from its content.
   */
  items: string[];
}

const DEFAULT_MAX_TOKENS = 2000;

/** `deep` and reverse-engineering briefs legitimately need more room. */
export function defaultMaxTokens(brief: Brief): number {
  return brief.task.mode === 'deep' || brief.reverseEngineering?.enabled ? 3000 : DEFAULT_MAX_TOKENS;
}

function warningWeight(level: BriefWarning['level']): number {
  return level === 'critical' ? 3 : level === 'warning' ? 2 : 1;
}

function warningsSection(brief: Brief): Section | null {
  if (brief.warnings.length === 0) return null;
  const ordered = [...brief.warnings].sort((a, b) => warningWeight(b.level) - warningWeight(a.level));
  return {
    title: 'WARNINGS',
    priority: ordered.some((warning) => warning.level === 'critical') ? 0 : 1,
    header: [],
    items: ordered.map((warning) => `[${warning.level.toUpperCase()}] ${warning.text}`),
  };
}

function projectSection(brief: Brief): Section {
  const { project } = brief;
  const status: string[] = [`branch ${project.branch ?? 'unknown'}`];
  status.push(project.headShort ? `HEAD ${project.headShort}` : 'HEAD unknown');
  if (!project.gitAvailable) status.push('git metadata unavailable');
  else if (project.dirty) {
    status.push(`dirty: ${project.changedFileCount} modified / ${project.untrackedFileCount} untracked`);
  } else status.push('clean');

  const header: string[] = [`${project.name} (${project.slug}) — phase: ${project.phase ?? 'not recorded'}`];
  header.push(`repo ${project.repositoryPath ?? 'unknown'} · ${status.join(' · ')}`);
  if (project.goal) header.push(`goal: ${project.goal}`);
  if (project.headSubject) header.push(`latest commit: ${project.headSubject}`);
  if (project.registeredNow) header.push('note: registered by this call — no engineering memory stored yet');
  return { title: 'PROJECT', priority: 0, header, items: [] };
}

function taskSection(brief: Brief): Section {
  const { task } = brief;
  const header: string[] = [task.text];

  const facts: string[] = [`type: ${task.type} (inferred, ${task.typeConfidence})`];
  facts.push(
    task.subsystem
      ? `subsystem: ${task.subsystem} (inferred, ${task.subsystemConfidence})`
      : 'subsystem: unknown',
  );
  if (task.taskId) {
    facts.push(
      `task ${task.taskId}${task.status ? ` [${task.status}${task.priority ? `/${task.priority}` : ''}]` : ''}`,
    );
  }
  header.push(facts.join(' · '));

  if (task.affectedFiles.length > 0) header.push(`declared files: ${task.affectedFiles.join(', ')}`);
  if (task.likelyComponents.length > 0) {
    header.push(`components (inferred): ${task.likelyComponents.slice(0, 4).join(', ')}`);
  }
  if (task.inferredFiles.length > 0) {
    header.push(`files (inferred from recent commits): ${task.inferredFiles.slice(0, 4).join(', ')}`);
  }
  for (const note of task.notes.slice(0, 2)) header.push(`note: ${note}`);
  return { title: 'TASK', priority: 0, header, items: [] };
}

function constraintsSection(brief: Brief): Section | null {
  if (brief.constraints.length === 0) return null;
  const critical = brief.constraints.some(
    (constraint) => constraint.severity === 'critical' || constraint.severity === 'high',
  );
  return {
    title: critical ? 'CRITICAL CONSTRAINTS' : 'CONSTRAINTS',
    priority: 0,
    header: [],
    items: brief.constraints.map((constraint) => {
      const scope = constraint.subsystem ? ` — ${constraint.subsystem}` : ' — project-wide';
      return `- [${constraint.severity}] ${constraint.statement}${scope} (${constraint.id})`;
    }),
  };
}

function reverseEngineeringSection(brief: Brief): Section | null {
  const re = brief.reverseEngineering;
  if (!re?.enabled) return null;
  const groups: string[] = [];

  if (re.established.length > 0) {
    const lines = ['established (runtime evidence on record):'];
    for (const finding of re.established) {
      lines.push(`- ${finding.statement} [${finding.confidence}, ${finding.id}, ${finding.age}]`);
    }
    groups.push(lines.join('\n'));
  }
  if (re.open.length > 0) {
    const lines = ['unverified (do not treat as fact):'];
    for (const finding of re.open) {
      const next = finding.next ? ` → next: ${finding.next}` : '';
      lines.push(`- ${finding.statement} [${finding.confidence}, ${finding.id}, ${finding.age}${next}]`);
    }
    groups.push(lines.join('\n'));
  }
  if (re.promotion.length > 0) {
    groups.push(['to promote a finding:', ...re.promotion.map((rule) => `- ${rule}`)].join('\n'));
  }
  return { title: 'REVERSE ENGINEERING', priority: 1, header: [], items: groups };
}

/** One grouped record per history entry, so trimming never splits a record. */
function historySection(brief: Brief): Section | null {
  const groups: string[] = [];

  if (brief.bugs.length > 0) {
    const lines = ['bugs:'];
    for (const bug of brief.bugs) {
      lines.push(`- [${bug.severity}/${bug.status}, ${bug.age}] ${bug.title} (${bug.id})`);
      if (bug.detail) lines.push(`    ${bug.detail}`);
      if (bug.files.length > 0) lines.push(`    files: ${bug.files.slice(0, 3).join(', ')}`);
    }
    groups.push(lines.join('\n'));
  }
  if (brief.decisions.length > 0) {
    const lines = ['decisions:'];
    for (const decision of brief.decisions) {
      lines.push(`- ${decision.statement} (${decision.id}, ${decision.age})`);
      if (decision.rationale) lines.push(`    why: ${decision.rationale}`);
    }
    groups.push(lines.join('\n'));
  }
  if (brief.findings.length > 0) {
    // Unverified findings must not read as facts, in any kind of task.
    const anyUnverified = brief.findings.some((finding) => !isEstablished(finding.confidence));
    const lines = [anyUnverified ? 'findings (unverified entries are not facts):' : 'findings:'];
    for (const finding of brief.findings) {
      const symbols = finding.symbols.length > 0 ? ` · symbols: ${finding.symbols.join(', ')}` : '';
      lines.push(`- ${finding.statement} [${finding.confidence}, ${finding.id}, ${finding.age}]${symbols}`);
    }
    groups.push(lines.join('\n'));
  }
  if (brief.attempts.length > 0) {
    const lines = ['previous work:'];
    for (const attempt of brief.attempts) {
      lines.push(`- ${attempt.summary} (${attempt.id}, ${attempt.age})`);
      if (attempt.completed) lines.push(`    completed: ${attempt.completed}`);
      for (const failure of attempt.failures.slice(0, 2)) lines.push(`    failed: ${failure}`);
      for (const followUp of attempt.followUp.slice(0, 2)) lines.push(`    follow-up: ${followUp}`);
    }
    groups.push(lines.join('\n'));
  }
  if (brief.verifications.length > 0) {
    const lines = ['verification history:'];
    for (const verification of brief.verifications) {
      // Only repeat the command when it adds information (method is often the
      // command itself).
      const command = verification.command && verification.command !== verification.method
        ? ` (${verification.command})`
        : '';
      lines.push(`- ${verification.method}${command} → ${verification.result} [${verification.age}, ${verification.id}]`);
    }
    groups.push(lines.join('\n'));
  }
  if (brief.recentCommits.length > 0) {
    const lines = ['recent commits:'];
    for (const commit of brief.recentCommits) {
      lines.push(`- ${commit.shortHash} ${commit.subject} (${commit.ago})`);
    }
    groups.push(lines.join('\n'));
  }

  if (groups.length === 0) return null;
  return { title: 'RELEVANT HISTORY', priority: 2, header: [], items: groups };
}

function likelyFilesSection(brief: Brief): Section | null {
  if (brief.likelyFiles.length === 0) return null;
  const uncommitted = new Set(brief.uncommittedFiles);
  return {
    title: 'LIKELY FILES',
    priority: 1,
    header: [],
    items: brief.likelyFiles.map((file) => `- ${file}${uncommitted.has(file) ? ' (uncommitted)' : ''}`),
  };
}

function riskSection(brief: Brief): Section {
  return {
    title: 'KNOWN RISK',
    priority: 1,
    header: [`level: ${brief.risk.level}`],
    items: brief.risk.reasons.map((reason) => `- ${reason}`),
  };
}

function approachSection(brief: Brief): Section {
  return {
    title: 'RECOMMENDED APPROACH',
    priority: 1,
    header: [],
    items: brief.approach.map(
      (step, index) => `${index + 1}. ${step.text}${step.source === 'template' ? ' (general practice)' : ''}`,
    ),
  };
}

function verificationSection(brief: Brief): Section {
  const plan = brief.verificationPlan;
  const groups: string[] = [];

  // Commands are the part an agent has to actually run, so they stay in the
  // always-rendered header; the softer groups are grouped records like history.
  const header: string[] = [];
  if (plan.commands.length > 0) {
    header.push('run:');
    for (const command of plan.commands) header.push(`- ${command}`);
  } else {
    header.push('commands: none configured (.mcp/master-mcp.yaml → verification.test_command)');
  }
  if (plan.requirements.length > 0) {
    groups.push(['must confirm:', ...plan.requirements.map((requirement) => `- ${requirement}`)].join('\n'));
  }
  if (plan.manualChecks.length > 0) {
    groups.push(['manual checks:', ...plan.manualChecks.map((check) => `- ${check}`)].join('\n'));
  }
  if (plan.regressionAreas.length > 0) {
    groups.push(`regression areas: ${plan.regressionAreas.join(', ')}`);
  }
  return { title: 'VERIFICATION', priority: 0, header, items: groups };
}

function followUpSection(brief: Brief): Section | null {
  if (brief.followUps.length === 0) return null;
  return {
    title: 'OPEN FOLLOW-UPS',
    priority: 3,
    header: [],
    items: brief.followUps.map((task) => {
      const blockers = task.blockers.length > 0 ? ` · blocked: ${task.blockers[0] ?? ''}` : '';
      return `- [${task.priority}, ${task.status}] ${task.title} (${task.id})${blockers}`;
    }),
  };
}

function gapsSection(brief: Brief): Section | null {
  if (brief.gaps.length === 0) return null;
  return { title: 'MEMORY GAPS', priority: 3, header: [], items: brief.gaps.map((gap) => `- ${gap}`) };
}

function nextActionSection(brief: Brief): Section {
  const header: string[] = [brief.nextAction];
  // Close the loop: the design target is one call before and one after work.
  header.push(
    brief.task.taskId
      ? `When finished: master_complete with task_id ${brief.task.taskId} (summary, files changed, tests run, results).`
      : 'When finished: master_complete with the task title, summary, files changed and test results.',
  );
  return { title: 'NEXT ACTION', priority: 0, header, items: [] };
}

function buildSections(brief: Brief): Section[] {
  return [
    projectSection(brief),
    taskSection(brief),
    warningsSection(brief),
    constraintsSection(brief),
    reverseEngineeringSection(brief),
    historySection(brief),
    likelyFilesSection(brief),
    riskSection(brief),
    approachSection(brief),
    verificationSection(brief),
    followUpSection(brief),
    gapsSection(brief),
    nextActionSection(brief),
  ].filter((section): section is Section => section !== null);
}

function renderSection(section: Section): string {
  return [section.title, ...section.header, ...section.items].join('\n');
}

function renderSections(sections: readonly Section[]): string {
  return sections.map(renderSection).join('\n\n');
}

/**
 * Render the project-wide status report.
 *
 * Deliberately shorter than a brief: status is for "where does this stand?",
 * not for starting work.
 */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  const push = (...values: string[]): void => {
    lines.push(...values);
  };

  if (!report.registered) {
    push('PROJECT');
    push(`no project registered for ${report.project.repositoryPath ?? 'the current directory'}`);
    if (report.project.branch || report.project.head) {
      push(`detected repository state: branch ${report.project.branch ?? 'unknown'} · HEAD ${(report.project.head ?? '').slice(0, 8) || 'unknown'}`);
    }
    if (report.knownProjects.length > 0) {
      push('', 'KNOWN PROJECTS', ...report.knownProjects.map((slug) => `- ${slug}`));
    }
    push(
      '',
      'NEXT ACTION',
      'Call master_context with your task to register this repository and get a working brief.',
    );
    if (report.warnings.length > 0) {
      push('', 'WARNINGS', ...report.warnings.map((warning) => `- ${warning.text}`));
    }
    return `${lines.join('\n')}\n`;
  }

  const project = report.project;
  const status: string[] = [`branch ${project.branch ?? 'unknown'}`];
  status.push(project.head ? `HEAD ${project.head.slice(0, 8)}` : 'HEAD unknown');
  if (!project.gitAvailable) status.push('git metadata unavailable');
  else if (project.dirty) status.push(`dirty: ${project.changedFileCount} uncommitted`);
  else status.push('clean');

  push('PROJECT');
  push(`${project.name ?? project.slug} (${project.slug}) — phase: ${project.phase ?? 'not recorded'}`);
  push(`repo ${project.repositoryPath ?? 'unknown'} · ${status.join(' · ')}`);
  if (project.goal) push(`goal: ${project.goal}`);
  if (project.headSubject) push(`latest commit: ${project.headSubject}`);

  const counts = Object.entries(report.memoryCounts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
  push('', 'MEMORY', counts.length > 0 ? counts : 'empty');

  if (report.activeWork.length > 0) {
    push('', 'ACTIVE WORK');
    for (const task of report.activeWork) {
      const subsystem = task.subsystem ? ` · ${task.subsystem}` : '';
      push(
        `- [${task.status}, ${task.priority}] ${task.title} (${task.id})${subsystem} · updated ${task.updatedAgo} · verification: ${task.verificationStatus}`,
      );
    }
  }

  if (report.blockers.length > 0) {
    push('', 'BLOCKERS');
    for (const blocker of report.blockers) {
      push(`- ${blocker.title} (${blocker.taskId}): ${blocker.blockers.join('; ')}`);
    }
  }

  if (report.criticalBugs.length > 0) {
    push('', 'OPEN BUGS');
    for (const bug of report.criticalBugs) {
      push(`- [${bug.severity}/${bug.status}, ${bug.age}] ${bug.title} (${bug.id})`);
      if (bug.detail) push(`    ${bug.detail}`);
    }
  }

  if (report.todo.length > 0) {
    push('', 'QUEUED');
    for (const task of report.todo) {
      push(`- [${task.priority}] ${task.title} (${task.id}) · updated ${task.updatedAgo}`);
    }
  }

  if (report.latestHandoff) {
    const handoff = report.latestHandoff;
    push('', 'LATEST HANDOFF');
    push(`${handoff.summary} (${handoff.id}, ${handoff.age})`);
    if (handoff.completed) push(`completed: ${handoff.completed}`);
    for (const failure of handoff.failures) push(`failed: ${failure}`);
    for (const followUp of handoff.followUp) push(`follow-up: ${followUp}`);
  }

  if (report.nextTask) {
    push('', 'MOST IMPORTANT NEXT TASK');
    push(`[${report.nextTask.status}, ${report.nextTask.priority}] ${report.nextTask.title} (${report.nextTask.id})`);
    push(`reason: ${report.nextTask.reason}`);
    push(`Get its full brief with master_context(task="${report.nextTask.title}").`);
  }

  if (report.recentActivity.length > 0) {
    push('', 'RECENT ACTIVITY');
    for (const entry of report.recentActivity) push(`- ${entry.kind}: ${entry.summary} (${entry.age})`);
  }

  if (report.warnings.length > 0) {
    push('', 'WARNINGS');
    for (const warning of report.warnings) push(`- [${warning.level.toUpperCase()}] ${warning.text}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render the brief as text, trimming to fit the token budget.
 *
 * Trimming order is deterministic: the lowest-priority section loses its last
 * item, then the next, until the budget is met; a section that loses all its
 * items is removed entirely. Priority-0 sections are never dropped — the brief
 * will slightly exceed the budget rather than hide a critical constraint, the
 * verification plan, or the next action.
 */
export function renderBrief(brief: Brief, options: RenderOptions = {}): string {
  const budget = options.maxTokens ?? defaultMaxTokens(brief);
  let sections = buildSections(brief);

  if (approxTokens(renderSections(sections)) <= budget) return `${renderSections(sections)}\n`;

  const trimmable = sections
    .filter((section) => section.priority > 0 && section.items.length > 0)
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));

  for (const section of trimmable) {
    while (section.items.length > 0 && approxTokens(renderSections(sections)) > budget) {
      section.items.pop();
    }
    if (approxTokens(renderSections(sections)) <= budget) break;
  }

  // Still over budget: drop whole low-priority sections, headings included.
  for (const section of [...sections].filter((s) => s.priority > 0).sort((a, b) => b.priority - a.priority)) {
    if (approxTokens(renderSections(sections)) <= budget) break;
    sections = sections.filter((candidate) => candidate !== section);
  }

  return `${renderSections(sections)}\n`;
}
