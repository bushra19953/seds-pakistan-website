/**
 * @jest-environment node
 *
 * Defect: the legacy /blog/post?id= reader rendered hardcoded mock
 * data unrelated to the post it loaded — the Mission Control Consensus
 * Feed sidebar defaulted to a built-in mockActivities array (invented
 * people, invented validations), and ExploreFutureHorizons fell back
 * to three invented default horizons whenever the post had no horizons
 * data of its own. The page also spun on "Loading blog post..." forever
 * when no ?id was given.
 *
 * The page is a parameterized legacy reader (it loads the real post by
 * document id behind the published + not-deleted guard), so the fix
 * keeps the reader and removes every mock rendering from it.
 *
 * Source-text assertions in the established style of
 * src/app/admin/blog/__tests__/blog-delete-unification.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('/blog/post renders only real post data', () => {
  const src = readSrc('src/app/blog/post/page.tsx');

  it('no longer renders the Mission Control Consensus Feed anywhere', () => {
    expect(src).not.toContain('MissionControlConsensusFeed');
    expect(src).not.toContain('mission-control-consensus-feed');
  });

  it('the mock consensus feed component is removed from the tree', () => {
    expect(
      fs.existsSync(
        path.join(REPO_ROOT, 'src/components/blog/mission-control-consensus-feed.tsx')
      )
    ).toBe(false);
  });

  it('renders Future Horizons only when the post has real horizons data', () => {
    expect(src).toContain('horizons && horizons.length > 0');
    const gate = src.indexOf('horizons && horizons.length > 0');
    const horizonsRender = src.indexOf('<ExploreFutureHorizons');
    expect(horizonsRender).toBeGreaterThan(gate);
  });

  it('keeps loading the real post by id behind the published + not-deleted guard', () => {
    expect(src).toContain("searchParams.get('id')");
    expect(src).toContain("doc(firestore, 'blogs', postId)");
    expect(src).toContain('!(blog as any).deleted');
    expect(src).toContain("blog.status === 'published'");
  });

  it('shows Not Found when no id is given instead of loading forever', () => {
    expect(src).toContain('<BlogPostNotFound />');
  });
});
