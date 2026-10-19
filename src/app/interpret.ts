/**
 * Task interpretation.
 *
 * Turns a free-text task into a structured query. Everything produced here is
 * *inference*, never fact, and the brief labels it as such. The interpretation
 * exists to drive relevance selection, so it prefers recall (keep several
 * candidate subsystems) over false precision.
 */
import type { Project, Severity, TaskType } from '../domain/models.ts';
import type { ProjectConfig } from '../domain/models.ts';
import { keywords, isIdentifierLike, splitWords, normalizeTerm, pathTokens } from '../util/text.ts';
import { slugify } from '../util/ids.ts';

export type InferenceConfidence = 'high' | 'medium' | 'low';

export type ContextMode = 'auto' | 'read_only' | 'deep' | 're';

export const CONTEXT_MODES: readonly ContextMode[] = ['auto', 'read_only', 'deep', 're'];

export interface TaskInterpretation {
  /** The task text exactly as supplied. */
  text: string;
  taskType: TaskType;
  typeConfidence: InferenceConfidence;
  /** Subsystems the task most likely concerns, best first. */
  subsystems: string[];
  subsystemConfidence: InferenceConfidence;
  /** Human-readable component names derived from the task's own nouns. */
  likelyComponents: string[];
  /** Files supplied by the caller. Always trusted over inference. */
  affectedFiles: string[];
  /** Files inferred from repository metadata. */
  inferredFiles: string[];
  /** Normalised search terms for ranking. */
  terms: string[];
  /** Terms that look like code identifiers, which are high-signal matches. */
  identifierTerms: string[];
  /** True when the task needs the reverse-engineering framing. */
  reverseEngineering: boolean;
  mode: ContextMode;
  /** How searchable this task text is; low means the brief must lean on memory. */
  interpretability: InferenceConfidence;
  notes: string[];
}

const TYPE_PATTERNS: ReadonlyArray<{ type: TaskType; patterns: RegExp[] }> = [
  {
    type: 'bugfix',
    patterns: [
      /\bfix(e[ds]?|ing)?\b/i, /\bbug(s)?\b/i, /\bregress(ion|ed|es)?\b/i, /\bbroken\b/i,
      /\bincorrect(ly)?\b/i, /\bwrong\b/i, /\bfail(s|ed|ing|ure)?\b/i, /\bcrash(es|ed|ing)?\b/i,
      /\bnot (working|shown|appearing|visible)\b/i, /\bappears? (for|when)\b/i, /\bdefect\b/i, /\bissue\b/i,
    ],
  },
  {
    type: 'feature',
    patterns: [
      /\badd(ing|ed)?\b/i, /\bimplement(ing|ed|s)?\b/i, /\bfeature\b/i, /\bsupport for\b/i,
      /\bintroduce\b/i, /\bcreate\b/i, /\benable\b/i, /\bexpose\b/i, /\bbuild\b/i,
    ],
  },
  {
    type: 'refactor',
    patterns: [
      /\brefactor(ing|ed)?\b/i, /\bclean ?up\b/i, /\brestructur(e|ing)\b/i, /\brename\b/i,
      /\bextract\b/i, /\bsimplif(y|ying|ied)\b/i, /\bdeprecate\b/i, /\bmigrat(e|ing|ion)\b/i,
    ],
  },
  {
    type: 'investigation',
    patterns: [
      /\binvestigat(e|ing|ion)\b/i, /\bunderstand\b/i, /\bwhy\b/i, /\bfigure out\b/i, /\banaly(se|ze|sis)\b/i,
      /\brecon\b/i, /\bexplore\b/i, /\baudit\b/i, /\btrace\b/i, /\bmap(ping)?\b/i, /\bidentify\b/i,
      /\bvalidate\b/i, /\bconfirm\b/i, /\bverify\b/i, /\bdiscover\b/i, /\breverse[- ]engineer/i,
      /\bdecompile\b/i, /\bdisassembl/i, /\bsymbols?\b/i, /\baddress(es)?\b/i,
    ],
  },
  {
    type: 'performance',
    patterns: [/\bperf(ormance)?\b/i, /\bslow(er|ness)?\b/i, /\boptimi(s|z)e\b/i, /\bspeed\b/i, /\blatenc(y|ies)\b/i, /\bmemory (leak|usage)\b/i],
  },
  { type: 'test', patterns: [/\btest(s|ing|ed)?\b/i, /\bcoverage\b/i, /\bflaky\b/i, /\bfixture\b/i] },
  { type: 'docs', patterns: [/\bdoc(s|umentation)?\b/i, /\breadme\b/i, /\bchangelog\b/i, /\bcomment(s|ing)?\b/i] },
  {
    type: 'maintenance',
    patterns: [/\bupgrade\b/i, /\bbump\b/i, /\bconfig(ure|uration)?\b/i, /\bci\b/i, /\brelease\b/i, /\bversion\b/i, /\bdependency\b/i],
  },
];

/** Reverse-engineering vocabulary; presence flips the brief into RE framing. */
const RE_PATTERNS: readonly RegExp[] = [
  /\breverse[- ]engineer/i, /\bdecompil/i, /\bdisassembl/i, /\bbinary\b/i, /\bghidra\b/i, /\bida\b/i,
  /\bfrida\b/i, /\baddress(es)?\b/i, /\bsymbol(s)?\b/i, /\boffset(s)?\b/i, /\bruntime\b/i, /\bstruct\b/i,
  /\bfunction pointer\b/i, /\bhook(ing|ed)?\b/i, /\bmanagers?\b/i, /\bhypothes/i, /\binstrument/i,
  /\bmemory layout\b/i, /\bpseudocode\b/i, /\bsignature(s)?\b/i,
];

/** Classify the task type from its wording. First strong match wins. */
export function classifyTaskType(task: string): { type: TaskType; confidence: InferenceConfidence } {
  const scores = new Map<TaskType, number>();
  for (const { type, patterns } of TYPE_PATTERNS) {
    let score = 0;
    for (const pattern of patterns) {
      const matches = task.match(new RegExp(pattern.source, 'gi'));
      if (matches) score += matches.length;
    }
    if (score > 0) scores.set(type, score);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (!best) return { type: 'unknown', confidence: 'low' };
  const runnerUp = ranked[1];
  const confidence: InferenceConfidence = best[1] >= 3 && (!runnerUp || best[1] > runnerUp[1]) ? 'high' : best[1] >= 2 ? 'medium' : 'low';
  return { type: best[0], confidence };
}

export function isReverseEngineeringTask(task: string, projectPhase: string | null | undefined): boolean {
  if (projectPhase && /reverse|re\b|disassembl|decompil|binary|runtime validation|symbol/i.test(projectPhase)) return true;
  return RE_PATTERNS.some((pattern) => pattern.test(task));
}

/**
 * Infer which subsystems the task touches.
 *
 * Known subsystem names come from configuration and from memory already stored
 * for the project, so inference improves as the project's memory grows.
 */
export function inferSubsystems(
  task: string,
  knownSubsystems: readonly string[],
  taskTerms: readonly string[],
): { subsystems: string[]; confidence: InferenceConfidence } {
  const termSet = new Set(taskTerms);
  const scored: Array<{ name: string; score: number }> = [];

  for (const subsystem of knownSubsystems) {
    const parts = [...new Set([...splitWords(subsystem).map(normalizeTerm), ...pathTokens(subsystem)])].filter(
      (part) => part.length >= 3,
    );
    if (parts.length === 0) continue;
    let score = 0;
    // Whole-name match on a multi-word name is the strongest signal.
    if (task.toLowerCase().includes(subsystem.toLowerCase().replace(/[-_]+/g, ' '))) score += 1.5;
    else if (task.toLowerCase().includes(subsystem.toLowerCase())) score += 1.4;
    for (const part of parts) {
      if (termSet.has(part)) score += 1;
      else if ([...termSet].some((term) => term.startsWith(part) || part.startsWith(term))) score += 0.4;
    }
    // Require at least a partial word overlap; a single shared stop-ish word is noise.
    const normalisedScore = score / Math.sqrt(parts.length);
    if (normalisedScore >= 0.75) scored.push({ name: subsystem, score: normalisedScore });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const subsystems = scored.slice(0, 3).map((entry) => entry.name);
  const confidence: InferenceConfidence =
    subsystems.length === 0 ? 'low' : (scored[0]?.score ?? 0) >= 1.6 ? 'high' : 'medium';
  return { subsystems, confidence };
}

/** Directory- or filename-derived components, used when the caller lists files. */
function componentsFromFiles(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const segments = file.replace(/\\/g, '/').split('/').filter(Boolean);
    const directory = segments.length > 1 ? segments[segments.length - 2] : undefined;
    const name = segments[segments.length - 1] ?? file;
    const label = directory ? `${name} (in ${directory})` : name;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Words that describe the state of the code or the action requested, never a
 * component. Without this, "fix the incorrect ownership check" yields the
 * component "incorrect ownership".
 */
const COMPONENT_MODIFIER_STOP_WORDS = new Set([
  'incorrect', 'correct', 'right', 'wrong', 'broken', 'missing', 'invalid', 'valid',
  'current', 'existing', 'previous', 'recent', 'latest', 'next', 'last', 'first', 'same',
  'new', 'old', 'stale', 'actual', 'expected', 'unexpected', 'possible', 'potential',
  'simple', 'small', 'large', 'minor', 'major', 'critical', 'urgent', 'hidden', 'visible',
  'shown', 'appears', 'appearing', 'working', 'failing', 'failed', 'fixed', 'fixing',
  'update', 'updated', 'updating', 'change', 'changed', 'changing', 'ensure', 'handle',
  'handling', 'support', 'issue', 'issues', 'improve', 'improved', 'prevent', 'avoid',
  'remove', 'removed', 'adding', 'added', 'implement', 'implemented', 'should', 'could',
  'would', 'must', 'when', 'where', 'while', 'with', 'without', 'from', 'into', 'over',
]);

/** Noun phrases from the task text, used when no subsystem matches. */
function componentsFromTerms(task: string): string[] {
  const words = splitWords(task).filter((word) => word.length > 3);
  const joined = words.join(' ').toLowerCase();
  const candidates = [
    /([a-z]+) (ownership|eligibility|visibility|availability|permission|access)/g,
    /([a-z]+) (service|store|manager|controller|predicate|resolver|registry|panel|dialog|screen|view|model)/g,
  ];
  const out: string[] = [];
  for (const pattern of candidates) {
    for (const match of joined.matchAll(pattern)) {
      const head = match[1] ?? '';
      if (COMPONENT_MODIFIER_STOP_WORDS.has(head)) continue;
      const phrase = `${head} ${match[2] ?? ''}`.trim();
      if (phrase.length > 6 && !out.includes(phrase)) out.push(phrase);
    }
  }
  return out.slice(0, 5);
}

export interface InterpretTaskInput {
  task: string;
  project: Project;
  config: ProjectConfig;
  /** Subsystems already present in the project's memory. */
  knownSubsystems: readonly string[];
  /** Files the caller declared. */
  affectedFiles?: readonly string[];
  /** Files observed recently in the repository (used as a weak fallback). */
  recentlyChangedFiles?: readonly string[];
  mode?: ContextMode;
}

/** Raw tokens of the task text, before case/punctuation splitting. */
function rawTokens(input: string): string[] {
  return input.split(/[\s,;:()[\]{}"'`]+/).filter((token) => token.length > 0);
}

/** Produce the structured interpretation of a task. Pure and deterministic. */
export function interpretTask(input: InterpretTaskInput): TaskInterpretation {
  const task = input.task.trim();
  const notes: string[] = [];
  const affectedFiles = (input.affectedFiles ?? []).map((file) => file.replace(/\\/g, '/').trim()).filter(Boolean);

  const terms = keywords(task);
  // Identifiers only look like identifiers before splitting: `offerEligibility`
  // or `offer_eligibility` become separate words once tokenised, so they are
  // detected on the raw token and then contributed as their parts, which is the
  // form stored memory is indexed in.
  const identifierTerms = [
    ...new Set(
      rawTokens(task)
        .filter(isIdentifierLike)
        .flatMap((token) => splitWords(token))
        .map(normalizeTerm)
        .filter((term) => term.length >= 3),
    ),
  ];

  const { type, confidence: typeConfidence } = classifyTaskType(task);
  const knownSubsystems = [...new Set([...input.config.subsystems, ...input.knownSubsystems])];
  const { subsystems, confidence: subsystemConfidence } = inferSubsystems(task, knownSubsystems, terms);

  // Directory names of declared files are trustworthy subsystem hints.
  const fileDerivedSubsystems = keywords(affectedFiles.map((file) => file.split('/').slice(0, -1).join(' ')).join(' ')).filter(
    (term) => term.length >= 4,
  );
  let combinedSubsystems = subsystems;
  if (fileDerivedSubsystems.length > 0) {
    combinedSubsystems = [...new Set([...subsystems, ...fileDerivedSubsystems.filter((term) => term.length > 5)])].slice(0, 4);
  }

  const likelyComponents =
    affectedFiles.length > 0 ? componentsFromFiles(affectedFiles) : componentsFromTerms(task);
  if (affectedFiles.length === 0 && likelyComponents.length === 0) {
    notes.push('No affected files supplied and no component names recognised in the task text.');
  }
  if (subsystems.length === 0) {
    if (knownSubsystems.length === 0) {
      notes.push('Project memory records no subsystems yet, so subsystem inference is unavailable.');
    } else {
      notes.push('No stored subsystem name matched the task wording.');
    }
  }

  // An explicit `re` mode is the strongest signal that the caller is doing
  // reverse-engineering work, even when the task wording itself is neutral;
  // otherwise the task vocabulary (and project phase) decides.
  const reverseEngineering = input.mode === 're' || isReverseEngineeringTask(task, input.project.phase);
  const mode: ContextMode = input.mode && input.mode !== 'auto' ? input.mode : reverseEngineering ? 're' : 'auto';

  const inferredFiles =
    affectedFiles.length > 0
      ? []
      : (input.recentlyChangedFiles ?? [])
          .filter((file) => {
            const tokens = new Set(pathTokens(file));
            return terms.some((term) => tokens.has(term));
          })
          .slice(0, 8);

  const interpretability: InferenceConfidence =
    terms.length === 0 ? 'low' : terms.length < 3 ? 'low' : affectedFiles.length > 0 || combinedSubsystems.length > 0 ? 'high' : 'medium';
  if (terms.length < 3) {
    notes.push('Short task text: relevance relies mostly on severity, recency and subsystem hints.');
  }

  return {
    text: task,
    taskType: type,
    typeConfidence,
    subsystems: combinedSubsystems,
    subsystemConfidence,
    likelyComponents,
    affectedFiles,
    inferredFiles,
    terms,
    identifierTerms,
    reverseEngineering,
    mode,
    interpretability,
    notes,
  };
}

/** Risk assessment inputs gathered from memory and interpretation. */
export interface RiskSignals {
  /** True when a critical constraint applies to the matched subsystem. */
  hasCriticalConstraint: boolean;
  /** Highest-severity open bug touching the task. */
  worstOpenBug: Severity | null;
  /** Number of stored records that reference the matched subsystem. */
  relatedRecordCount: number;
  /** True when a previous attempt in this area failed. */
  previousFailure: boolean;
  /** True when the task type implies broad impact. */
  broadTaskType: boolean;
}

/** Derive the task risk level and the reasons behind it. */
export function assessRisk(signals: RiskSignals): { level: Severity; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (signals.hasCriticalConstraint) {
    score += 2;
    reasons.push('A critical constraint applies to this subsystem.');
  }
  if (signals.worstOpenBug === 'critical' || signals.worstOpenBug === 'high') {
    score += 2;
    reasons.push(`An open ${signals.worstOpenBug}-severity bug affects this area.`);
  } else if (signals.worstOpenBug) {
    score += 1;
    reasons.push('An open bug affects this area.');
  }
  if (signals.relatedRecordCount >= 5) {
    score += 2;
    reasons.push('This subsystem is referenced by many stored records, so the logic is reused.');
  } else if (signals.relatedRecordCount >= 2) {
    score += 1;
    reasons.push('This subsystem already has stored engineering history.');
  }
  if (signals.previousFailure) {
    score += 1;
    reasons.push('A previous attempt in this area did not succeed.');
  }
  if (signals.broadTaskType) {
    score += 1;
    reasons.push('The task type usually implies changed behaviour beyond a single file.');
  }
  if (reasons.length === 0) reasons.push('No elevated risk signals are recorded for this task.');

  const level: Severity = score >= 4 ? 'critical' : score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
  return { level, reasons };
}

/** Slug used when matching a task title against existing task records. */
export function taskIdentityKey(title: string): string {
  return slugify(title, 'task');
}
