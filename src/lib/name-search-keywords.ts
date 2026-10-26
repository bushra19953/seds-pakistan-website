/**
 * Name-search keywords index (directory defect fix, option (c)).
 *
 * The admin directory name search must be a bounded server-side query,
 * not a scan of a doc-id window: a holder whose document id sorts past
 * the window was silently invisible to name search (see
 * DIRECTORY_SEARCH_DEFECT_2026-10-25.md). The index field
 * `nameSearchKeywords` on the users doc makes the search an
 * `array-contains` equality per query term - bounded by the match
 * count, exact at any directory size. The Supabase adapter translates
 * the same `array-contains` clause to jsonb containment, so both read
 * arms of /api/admin/users use the identical scheme.
 *
 * Scheme: the display name is lowercased and split into tokens on
 * non-alphanumerics. For each token, the index holds the full token
 * plus every prefix of length >= 2, so a query term matches when it
 * is a prefix of a name token (the directory's scoring loop then
 * re-scores the candidates in memory, unchanged). The full name's
 * tokens are also indexed as one joined token-free list - no
 * substring (infix) matching: "uzaif" does not find "Huzaifah".
 * That is the documented recall bound of option (c).
 *
 * This module has zero imports, mirroring role-catalog.ts, so client
 * write paths, server routes and tests can all share it.
 */

export const NAME_SEARCH_KEYWORDS_FIELD = 'nameSearchKeywords';

/** Smallest prefix indexed / queryable: 1-char terms stay window-scored. */
export const NAME_SEARCH_MIN_PREFIX = 2;

/** Hard cap so a pathological name cannot bloat the doc. */
const MAX_KEYWORDS = 120;

export function nameSearchTokens(rawName: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const tok of String(rawName || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok) seen.add(tok);
  }
  return [...seen];
}

/**
 * The keyword set stored on the users doc for a display name.
 * Deterministic order: tokens in name order, each followed by its
 * prefixes in length order, deduplicated.
 */
export function buildNameSearchKeywords(rawName: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };
  for (const tok of nameSearchTokens(rawName)) {
    push(tok);
    for (let len = NAME_SEARCH_MIN_PREFIX; len < tok.length; len++) {
      push(tok.slice(0, len));
      if (out.length >= MAX_KEYWORDS) return out;
    }
    if (out.length >= MAX_KEYWORDS) return out;
  }
  return out;
}

/**
 * The single keyword a query term resolves to, or null when the term
 * cannot use the index (email terms, terms shorter than the minimum
 * prefix). Terms are matched verbatim against the stored prefixes, so
 * the term is used exactly as the index stored it: lowercased, with
 * non-alphanumerics stripped (a token never contains them).
 */
export function nameSearchKeywordForTerm(term: string | null | undefined): string | null {
  const raw = String(term || '').toLowerCase();
  if (raw.includes('@')) return null; // email terms use the email probe
  const clean = raw.replace(/[^a-z0-9]+/g, '');
  if (clean.length < NAME_SEARCH_MIN_PREFIX) return null;
  return clean;
}

/** True when a fetched doc's stored index actually contains the keyword. */
export function docHasNameKeyword(
  data: Record<string, any> | null | undefined,
  keyword: string,
): boolean {
  const arr = (data as any)?.[NAME_SEARCH_KEYWORDS_FIELD];
  return Array.isArray(arr) && arr.includes(keyword);
}
