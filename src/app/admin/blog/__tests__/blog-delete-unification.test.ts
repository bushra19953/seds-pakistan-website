/**
 * @jest-environment node
 *
 * Issue 11 source guards: one blog delete, implemented once.
 *
 * - The edit page's Delete Post must go through the canonical REST
 *   DELETE handler (flag + status flip), never a direct SDK write of
 *   the deleted flag (which left published posts publicly servable).
 * - The REST handler's canonical write stays pinned.
 * - The unauthenticated single-post readers (slug API route and the
 *   server-side slug fetcher behind /blog/[slug]) must carry the
 *   published + not-deleted guard, and the /blog/post page must treat
 *   a soft-deleted post as not found.
 *
 * Source-text assertions in the established style of
 * __tests__/announcements-rules.test.ts (no rules emulator / renderer
 * is needed for these structural claims).
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('Issue 11 blog delete unification', () => {
  it('edit page deletes through the REST endpoint, not an SDK flag write', () => {
    const src = readSrc('src/app/admin/blog/edit/page.tsx');

    const start = src.indexOf('const handleDelete');
    expect(start).toBeGreaterThan(-1);
    const deleteFn = src.slice(start, src.indexOf('if (isLoading || blogLoading)', start));

    expect(deleteFn).toContain('`/api/admin/blogs/${blogId}`');
    expect(deleteFn).toContain("method: 'DELETE'");
    expect(deleteFn).toContain('Authorization');
    expect(deleteFn).not.toContain('updateDoc');

    // No flag-only delete write remains anywhere in the edit page.
    expect(src).not.toContain('deletedAt: serverTimestamp()');
  });

  it('REST DELETE keeps the canonical write: flag + archived + timestamp', () => {
    const src = readSrc('src/app/api/admin/blogs/[id]/route.ts');
    const start = src.indexOf('export async function DELETE');
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start);

    expect(handler).toContain('deleted: true');
    expect(handler).toContain("status: 'archived'");
    expect(handler).toContain('deletedAt: new Date()');
  });

  it('slug API route guards both lookup branches on published + not deleted', () => {
    const src = readSrc('src/app/api/blogs/[slug]/route.ts');
    expect(src).toContain("data.status === 'published' && data.deleted !== true");
    // Applied on the slug-query branch and the document-ID fallback.
    expect(src.match(/isPublicBlogPost\(data\)/g)?.length).toBe(2);
  });

  it('server slug fetcher behind /blog/[slug] carries the same guard', () => {
    const src = readSrc('src/lib/server/blog-server.ts');
    expect(src).toContain("data.status === 'published' && data.deleted !== true");
    expect(src.match(/isPublicBlogPost\(data\)/g)?.length).toBe(2);
  });

  it('/blog/post page treats a soft-deleted post as not found', () => {
    const src = readSrc('src/app/blog/post/page.tsx');
    expect(src).toContain('!(blog as any).deleted');
  });
});
