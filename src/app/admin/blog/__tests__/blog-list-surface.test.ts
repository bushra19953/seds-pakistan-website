/**
 * Source-guard tests for the blog admin list surface (Known Issues 1 + 12).
 *
 * Issue 1: the list-page Delete fetched the nonexistent singular route
 * /api/admin/blog/<id> (only the plural /api/admin/blogs/[id] exists), and
 * its failure surfaced as a JSON parse error because the 404 body is HTML.
 *
 * Issue 12: the status filter cycle omitted `pending_review` (a status the
 * create/edit form can set), and archived posts — the REST DELETE terminal
 * state — were hidden by the list's deleted-flag filter under every filter
 * and could not be represented by the edit form's status enum, making the
 * archive a one-way door.
 *
 * These follow the repo's established source-guard style (see
 * src/lib/__tests__/announcements-rules.test.ts): read the consumer sources
 * and assert the wiring directly.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function listSrcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSrcFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('blog admin list — delete route (Issue 1)', () => {
  const list = readSrc('src/app/admin/blog/page.tsx');

  it('deletes through the plural /api/admin/blogs/[id] route', () => {
    expect(list).toContain('`/api/admin/blogs/${id}`');
    expect(list).toContain("method: 'DELETE'");
  });

  it('surfaces the server error with an HTTP-status fallback, not a bare res.json() throw', () => {
    expect(list).toContain('HTTP ${res.status}');
  });

  it('no file under src references the singular admin blog route', () => {
    const self = __filename;
    const offenders: string[] = [];
    for (const file of listSrcFiles(path.join(REPO_ROOT, 'src'))) {
      if (path.resolve(file) === path.resolve(self)) continue;
      const content = fs.readFileSync(file, 'utf8');
      // The plural path contains "/api/admin/blogs/" — the singular string
      // "/api/admin/blog/" (slash right after "blog") only matches the
      // nonexistent route.
      if (content.includes('/api/admin/blog/')) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('blog admin list — status vocabulary (Issue 12)', () => {
  const list = readSrc('src/app/admin/blog/page.tsx');
  const form = readSrc('src/components/admin/blog/blog-post-form.tsx');
  const edit = readSrc('src/app/admin/blog/edit/page.tsx');

  it('the filter cycle covers every status the form can set, plus archived', () => {
    expect(list).toContain("['all', 'published', 'pending_review', 'draft', 'archived']");
  });

  it('archived posts stay visible under the ARCHIVED filter despite the deleted flag', () => {
    expect(list).toContain("statusFilter === 'archived' && blog.status === 'archived'");
  });

  it('the form schema admits the full stored vocabulary, including archived', () => {
    expect(form).toContain("z.enum(['draft', 'pending_review', 'published', 'archived'])");
  });

  it('the Archived option is offered only when editing an already-archived post', () => {
    expect(form).toContain("initialData?.status === 'archived'");
    expect(form).toContain('<SelectItem value="archived">Archived</SelectItem>');
  });

  it('saving an archived post back to a live status clears the soft-delete flag', () => {
    expect(edit).toContain("blog?.deleted && values.status !== 'archived'");
    expect(edit).toContain('deleted: false');
  });
});
