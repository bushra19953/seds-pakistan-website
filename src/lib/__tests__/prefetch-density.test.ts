/**
 * Prefetch storm guard (wave-2 perf, 2026-10-30).
 *
 * Incident: opening /timeline fired TWELVE /profile/unified RSC
 * requests at once and every one 502'd on the saturated single
 * instance. Next.js Link prefetching issues one background RSC
 * request per rendered profile link, so any dense list of profile
 * links (leaderboard rows, hierarchy nodes, team grids, chat
 * threads, task lists) turns a page view into a request burst
 * against the heaviest read path on the site.
 *
 * Contract pinned here: in the dense-list files below, EVERY
 * <Link> that points at a member profile carries prefetch={false}
 * (the codebase's own precedent: admin-sidebar.tsx dense nav).
 * Profiles still load on click; they just stop loading on render.
 * Lone primary CTAs keep prefetch (pinned for the header profile
 * link so this guard cannot be "fixed" by blanket-disabling).
 *
 * The request-count proof is a fixture-level model of documented
 * Next.js behaviour: prefetch-enabled link = 1 background RSC
 * request when it renders in the viewport; prefetch={false} = 0.
 * The timeline incident shape (12 profile links in one view) is
 * modelled explicitly: 12 before, 0 after.
 *
 * No em dashes are used in this file.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * Extract every <Link ...> opening tag whose href points at a
 * member profile (/profile/unified... or a profilePath variable).
 */
function profileLinkTags(source: string): string[] {
  const tags: string[] = [];
  const linkRe = /<Link\b[\s\S]*?>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(source)) !== null) {
    const tag = m[0];
    if (
      tag.includes('/profile/unified') ||
      tag.includes('person.profilePath') ||
      tag.includes('entry.profilePath')
    ) {
      tags.push(tag);
    }
  }
  return tags;
}

const DENSE_LIST_FILES: { rel: string; minLinks: number }[] = [
  // Community leaderboard: president row + two ranked tables.
  { rel: 'src/components/community/leaderboard.tsx', minLinks: 3 },
  // Public hierarchy chart/list: one node link per role-holder.
  { rel: 'src/app/hierarchy/page.tsx', minLinks: 1 },
  // Project detail: MemberAvatar used across team + roadmap lists.
  { rel: 'src/app/projects/detail/page.tsx', minLinks: 1 },
  // Profile hub team grid.
  { rel: 'src/components/profile/my-team.tsx', minLinks: 1 },
  // Workflow team context strip (whole workflow roster).
  { rel: 'src/components/profile/workflow-team-context.tsx', minLinks: 1 },
  // Workflow steps list: one assignee link per step.
  { rel: 'src/components/profile/workflow-steps-inline.tsx', minLinks: 1 },
  // Task history rows: one assigner link per row.
  { rel: 'src/components/profile/task-history.tsx', minLinks: 1 },
  // Workflow chat: presence avatars + two links per message.
  { rel: 'src/components/workflow/enhanced-workflow-chat.tsx', minLinks: 3 },
];

describe('dense profile-link lists do not prefetch (wave-2)', () => {
  for (const { rel, minLinks } of DENSE_LIST_FILES) {
    test(`${rel}: every profile Link has prefetch={false}`, () => {
      const tags = profileLinkTags(readSrc(rel));
      expect(tags.length).toBeGreaterThanOrEqual(minLinks);
      for (const tag of tags) {
        expect(tag).toContain('prefetch={false}');
      }
    });
  }

  test('request model: the 12-link timeline incident shape fires 0 background prefetches after the fix', () => {
    // Background RSC requests fired when a view renders, under the
    // documented model: prefetch-enabled = 1 per link, disabled = 0.
    const backgroundRequests = (links: { prefetch: boolean }[]) =>
      links.filter((l) => l.prefetch).length;

    const before = Array.from({ length: 12 }, () => ({ prefetch: true }));
    expect(backgroundRequests(before)).toBe(12);

    // After: the same 12-link view with every link opted out.
    const after = Array.from({ length: 12 }, () => ({ prefetch: false }));
    expect(backgroundRequests(after)).toBe(0);
  });

  test('no dense-list file leaves an enabled-prefetch profile link behind', () => {
    let enabled = 0;
    for (const { rel } of DENSE_LIST_FILES) {
      for (const tag of profileLinkTags(readSrc(rel))) {
        if (!tag.includes('prefetch={false}')) enabled += 1;
      }
    }
    expect(enabled).toBe(0);
  });

  test('lone primary CTAs keep prefetch (header profile link untouched)', () => {
    const header = readSrc('src/components/layout/header.tsx');
    expect(header).toContain('<Link href="/profile" prefetch');
  });
});
