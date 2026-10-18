/**
 * Deterministic text utilities.
 *
 * These power relevance scoring, search query building and file-path matching.
 * They are intentionally pure and dependency free so ranking stays reproducible
 * and testable: the same input always produces the same score.
 */

/** Common English words that carry no retrieval signal. Kept small and explicit. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
  'into', 'onto', 'over', 'under', 'about', 'as', 'it', 'its', 'we', 'you', 'they',
  'he', 'she', 'them', 'his', 'her', 'their', 'our', 'your', 'my', 'me', 'us',
  'not', 'no', 'nor', 'so', 'too', 'very', 'just', 'also', 'there', 'here', 'when',
  'where', 'which', 'who', 'whom', 'what', 'why', 'how', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'up', 'down',
  'out', 'off', 'again', 'once', 'during', 'before', 'after', 'above', 'below', 'between',
  'because', 'while', 'until', 'per', 'via', 'please', 'need', 'needs', 'want', 'make',
  'makes', 'made', 'get', 'gets', 'got', 'use', 'uses', 'used', 'using', 'work', 'works',
  'working', 'let', 'lets', 'see', 'seen', 'look', 'looks', 'like', 'well', 'still',
]);

/** Path segments that appear in nearly every repository and carry no signal. */
const GENERIC_PATH_SEGMENTS = new Set([
  'src', 'lib', 'libs', 'app', 'apps', 'dist', 'build', 'out', 'bin', 'node_modules',
  'test', 'tests', 'spec', 'specs', '__tests__', 'testdata', 'fixtures', 'index',
  'main', 'mod', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'internal', 'pkg', 'packages', 'core', 'common', 'shared', 'utils', 'util', 'helpers',
  'public', 'assets', 'static', 'docs', 'doc', 'examples', 'vendor', 'third_party',
]);

const MIN_TERM_LENGTH = 2;

/**
 * Split a string into raw words, breaking camelCase, PascalCase, snake_case,
 * kebab-case, dotted and slashed identifiers, plus digit boundaries
 * ("F30", "issue42" -> "issue", "42").
 */
export function splitWords(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const chunk of input.split(/[^A-Za-z0-9_]+/)) {
    if (!chunk) continue;
    for (const part of chunk.split('_')) {
      if (!part) continue;
      // Break camelCase / PascalCase / letter-digit boundaries.
      const pieces = part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+|[A-Z]/g);
      if (pieces) out.push(...pieces);
    }
  }
  return out;
}

/**
 * Lowercase, singularise lightly and drop noise. Used as the canonical form for
 * both indexing-time and query-time term matching, so the two always agree.
 */
export function normalizeTerm(token: string): string {
  let t = token.toLowerCase();
  if (t.length > 3 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 3 && t.endsWith('ses')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) t = t.slice(0, -1);
  return t;
}

/** Tokenise text into normalised, de-duplicated terms with occurrence counts. */
export function termCounts(input: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of splitWords(input)) {
    const term = normalizeTerm(word);
    if (term.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

/** Normalised unique terms, ordered by first appearance (stable for rendering). */
export function keywords(input: string): string[] {
  return [...termCounts(input).keys()];
}

/** True when a term looks like a code identifier rather than prose vocabulary. */
export function isIdentifierLike(raw: string): boolean {
  return (
    /[a-z][A-Z]/.test(raw) ||
    raw.includes('_') ||
    raw.includes('.') ||
    raw.includes('/') ||
    raw.includes('()') ||
    /^[A-Z]{2,}/.test(raw)
  );
}

/** Split a repository-relative path into meaningful, normalised tokens. */
export function pathTokens(path: string): string[] {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .flatMap((segment) => {
      const dot = segment.lastIndexOf('.');
      const base = dot > 0 ? segment.slice(0, dot) : segment;
      return splitWords(base);
    })
    .map(normalizeTerm)
    .filter((token) => token.length >= MIN_TERM_LENGTH && !STOPWORDS.has(token));
  return [...new Set(segments)];
}

/** Directory segments of a path, excluding the basename and generic noise. */
function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .slice(0, -1)
    .map((segment) => normalizeTerm(segment))
    .filter((segment) => segment.length >= MIN_TERM_LENGTH && !GENERIC_PATH_SEGMENTS.has(segment));
}

/** Normalise a path for comparison: forward slashes, no leading "./" or trailing "/". */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p;
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Path affinity in [0, 1].
 *
 * Used to score how strongly a memory record's files relate to the files a task
 * touches. Total ordering is: identical path > same basename > shared directory
 * segments > shared filename tokens.
 */
export function pathAffinity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return 1;

  // Suffix containment: "src/x/y.ts" vs "y.ts" or "x/y.ts".
  if (na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`)) return 0.9;

  const baseA = basename(na);
  const baseB = basename(nb);
  let score = 0;
  if (baseA === baseB) score = 0.8;
  else {
    const tokensA = new Set(pathTokens(baseA));
    const tokensB = new Set(pathTokens(baseB));
    if (tokensA.size > 0 && tokensB.size > 0) {
      let shared = 0;
      for (const token of tokensA) if (tokensB.has(token)) shared += 1;
      score = Math.max(score, 0.5 * (shared / Math.max(tokensA.size, tokensB.size)));
    }
  }

  const dirsA = new Set(pathSegments(na));
  const dirsB = new Set(pathSegments(nb));
  if (dirsA.size > 0 && dirsB.size > 0) {
    let shared = 0;
    for (const dir of dirsA) if (dirsB.has(dir)) shared += 1;
    if (shared > 0) score = Math.max(score, Math.min(0.55, 0.3 + 0.15 * shared));
  }
  return Math.min(1, score);
}

/** Best affinity between one path and a list of reference paths. */
export function bestPathAffinity(path: string, references: readonly string[]): number {
  let best = 0;
  for (const ref of references) best = Math.max(best, pathAffinity(path, ref));
  return best;
}

/** Overlap of two token sets as a Jaccard-style ratio in [0, 1]. */
export function setOverlap<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Coverage-weighted overlap: how much of the *query* set is covered by the
 * candidate. Rewards records that mention many task terms without penalising
 * them for being verbose, which Jaccard does.
 */
export function queryCoverage(query: ReadonlySet<string>, candidate: ReadonlySet<string>): number {
  if (query.size === 0 || candidate.size === 0) return 0;
  let shared = 0;
  for (const term of query) if (candidate.has(term)) shared += 1;
  return shared / query.size;
}

/** Truncate text on a word boundary, appending an ellipsis when cut. */
export function truncate(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, Math.max(0, maxLength - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > maxLength * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Cheap token estimate used for budgeting the rendered brief. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Collapse whitespace and strip a trailing period, for list rendering. */
export function tidy(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

/** Format a compact bullet list, or an empty string when there is nothing to show. */
export function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

/** Case-insensitive substring test that tolerates undefined haystacks. */
export function containsIgnoreCase(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Nearest match from a list of candidates for a free-text term, or undefined. */
export function closestMatch(term: string, candidates: readonly string[]): string | undefined {
  const needle = normalizeTerm(term);
  if (!needle) return undefined;
  let best: { value: string; score: number } | undefined;
  for (const candidate of candidates) {
    const tokens = keywords(candidate);
    if (tokens.length === 0) continue;
    let score = 0;
    for (const token of tokens) {
      if (token === needle) score += 1;
      else if (token.startsWith(needle) || needle.startsWith(token)) score += 0.5;
    }
    score /= Math.sqrt(tokens.length);
    if (score > 0 && (!best || score > best.score)) best = { value: candidate, score };
  }
  return best?.value;
}
