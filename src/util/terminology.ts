/**
 * One deterministic vocabulary for semantic retrieval.
 *
 * Ranking, full-text query construction and near-duplicate detection all fold
 * terms through this module, so the same word family always compares equal no
 * matter which code path sees it first. The rules are intentionally small and
 * explicit: light plural handling plus engineering abbreviations and the
 * morphology agents actually type. No stemming library, embeddings or network.
 */

/**
 * Lowercase and singularise a token without folding aliases.
 *
 * This is also the canonical form for literal identifiers and path segments,
 * where "api" and "interface" are different names, not synonyms.
 */
export function singularizeTerm(token: string): string {
  let t = token.toLowerCase();
  if (t.length > 3 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 3 && t.endsWith('ses')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) t = t.slice(0, -1);
  return t;
}

interface TerminologyFamily {
  /** The single term stored in ranking, dedup and search term sets. */
  canonical: string;
  /** Other surface forms that mean the same thing for retrieval. */
  variants: readonly string[];
}

/**
 * The complete synonym/morphology table. Add to this list rather than growing
 * local maps in the ranking or dedup callers.
 */
const TERMINOLOGY_FAMILIES: readonly TerminologyFamily[] = [
  { canonical: 'technology', variants: ['tech', 'techs', 'technologies'] },
  { canonical: 'ownership', variants: ['own', 'owns', 'owned', 'owning', 'owner', 'owners'] },
  { canonical: 'database', variants: ['db', 'dbs', 'datasource', 'datasources'] },
  { canonical: 'configuration', variants: ['config', 'configs', 'cfg', 'cfgs'] },
  { canonical: 'authentication', variants: ['auth', 'authn'] },
  { canonical: 'authorization', variants: ['authz'] },
  { canonical: 'repository', variants: ['repo', 'repos', 'repositories'] },
  { canonical: 'performance', variants: ['perf'] },
  { canonical: 'implementation', variants: ['impl', 'implement', 'implements', 'implemented', 'implementing'] },
  { canonical: 'dependency', variants: ['dep', 'deps', 'dependencies'] },
  { canonical: 'environment', variants: ['env', 'envs', 'environments'] },
  { canonical: 'documentation', variants: ['doc', 'docs', 'documented'] },
  { canonical: 'specification', variants: ['spec', 'specs', 'specifications'] },
  { canonical: 'interface', variants: ['ui', 'uis', 'api', 'apis', 'interfaces'] },
];

const CANONICAL_BY_VARIANT = new Map<string, string>();
const VARIANTS_BY_CANONICAL = new Map<string, readonly string[]>();

for (const family of TERMINOLOGY_FAMILIES) {
  const variants = [...new Set([family.canonical, ...family.variants].map((term) => term.toLowerCase()))];
  VARIANTS_BY_CANONICAL.set(family.canonical, variants);
  for (const variant of variants) CANONICAL_BY_VARIANT.set(variant, family.canonical);
}

/**
 * Fold one token to its canonical retrieval term.
 *
 * Exact aliases win before singularisation, so `deps` and `configs` do not lose
 * their family while `technologies` still lands on `technology`.
 */
export function canonicalTerm(token: string): string {
  const lower = token.toLowerCase();
  const singular = singularizeTerm(lower);
  return CANONICAL_BY_VARIANT.get(lower) ?? CANONICAL_BY_VARIANT.get(singular) ?? singular;
}

/**
 * Every surface form that should match a canonical term in full-text search.
 *
 * The FTS index stores the original prose, so a query for `ownership` expands
 * to `own`, `owner`, etc. for this call only; stored text is never rewritten.
 */
export function termVariants(term: string): readonly string[] {
  const canonical = canonicalTerm(term);
  return VARIANTS_BY_CANONICAL.get(canonical) ?? [canonical];
}
