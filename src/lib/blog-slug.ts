/**
 * Slug resolution for blog posts.
 *
 * Root cause of the empty-slug defect: POST /api/blogs was the only write
 * path that derived a slug from the title. The admin form never calls it -
 * the create and edit pages write straight to Firestore through the client
 * SDK - and the REST update route spread the request body verbatim, so a
 * post saved with the form's slug field left empty was stored with an
 * empty (or null) slug and could never be opened publicly: every public
 * reader addresses posts by slug.
 *
 * These helpers are the single derivation every write path now shares.
 * deriveBlogSlug is byte-for-byte the expression POST /api/blogs has
 * always applied on create; do not "improve" it here without changing
 * every caller, or the paths diverge again.
 */

export function deriveBlogSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Resolve the slug a save must store:
 * - an explicitly provided slug wins (trimmed);
 * - otherwise the slug already stored on the record is kept, so saving a
 *   record can never strip a slug it already has;
 * - otherwise the slug is derived from the title, exactly as the REST
 *   create route does.
 *
 * Note on parity: POST /api/blogs previously kept a provided slug
 * untrimmed (`slug || derive(title)`). Trimming surrounding whitespace
 * from an explicitly provided slug is the one intentional tightening;
 * every non-empty slug value is otherwise preserved exactly.
 */
export function resolveBlogSlug(
  slug: string | null | undefined,
  title: string | null | undefined,
  existingSlug?: string | null,
): string {
  const provided = (slug ?? '').trim();
  if (provided) return provided;
  const existing = (existingSlug ?? '').trim();
  if (existing) return existing;
  return deriveBlogSlug((title ?? '').trim());
}
