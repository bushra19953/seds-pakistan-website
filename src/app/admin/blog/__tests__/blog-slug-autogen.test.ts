/**
 * @jest-environment node
 *
 * Source guards for the empty-slug fix, in the established style of
 * blog-delete-unification.test.ts in this directory.
 *
 * The admin create and edit pages write to Firestore through the client
 * SDK (they never call POST /api/blogs), so the slug resolution has to
 * live in their payload construction itself. These guards pin that both
 * pages resolve the slug through the shared helper
 * (src/lib/blog-slug.ts) and that the old verbatim writes - the ones
 * that stored null / '' for a post whose slug field was left empty -
 * do not come back.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('blog slug autogen: every write path resolves through the shared helper', () => {
  it('admin create page derives the slug instead of storing null for an empty field', () => {
    const src = readSrc('src/app/admin/blog/new/page.tsx');

    expect(src).toContain('resolveBlogSlug(values.slug, values.title)');
    expect(src).not.toContain('slug: toNullIfEmpty(values.slug)');
  });

  it('admin edit page derives the slug instead of writing the empty field back', () => {
    const src = readSrc('src/app/admin/blog/edit/page.tsx');

    expect(src).toContain('resolveBlogSlug(');
    expect(src).not.toContain("slug: values.slug?.trim() || ''");
  });

  it('REST create resolves through the same helper (single derivation)', () => {
    const src = readSrc('src/app/api/blogs/route.ts');

    expect(src).toContain('resolveBlogSlug(slug, title)');
    expect(src).not.toContain("slug: slug || title.toLowerCase()");
  });

  it('REST update resolves the slug instead of spreading the body verbatim', () => {
    const src = readSrc('src/app/api/admin/blogs/[id]/route.ts');

    const start = src.indexOf('export async function PUT');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('export async function DELETE', start);
    const handler = src.slice(start, end === -1 ? undefined : end);

    expect(handler).toContain('resolveBlogSlug(');
  });
});
