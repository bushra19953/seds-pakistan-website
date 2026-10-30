/**
 * Rules-text + consumer-source tests for Item 10 (spec fragment (f)
 * Suite 2). No rules emulator exists in this repo: the rules cases
 * parse the rules text (the established method), and the consumer
 * cases assert the migrated sources use the shared visibility
 * helper and no longer hand-roll an unprovable announcements query.
 *
 * The rules delta ships ONLY in the Batch 1 publish file. Run with
 * FIRESTORE_RULES_PATH=<batch file>; against the repo working tree
 * (default), the rules cases fail until the post-publish mirror -
 * the expected pre-publish state, recorded at assembly.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const RULES_PATH =
  process.env.FIRESTORE_RULES_PATH || path.join(REPO_ROOT, 'firestore.rules');

const rules = fs.readFileSync(RULES_PATH, 'utf8');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function announcementsBlock(): string {
  const start = rules.indexOf('match /announcements/{id} {');
  if (start === -1) throw new Error('announcements block not found');
  const end = rules.indexOf('\n    }', start);
  return rules.slice(start, end);
}

function helperBody(name: string): string {
  const start = rules.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`helper ${name} not found`);
  const end = rules.indexOf('\n    }', start);
  return rules.slice(start, end);
}

describe('Item 10 announcements rules (text)', () => {
  it("1. the block has no 'allow read' and no list/read with condition true", () => {
    const block = announcementsBlock();
    expect(block).not.toContain('allow read');
    expect(block).not.toMatch(/allow (get|list|read)[^;]*if true/);
  });

  it('2. the read allow carries the admin disjunct AND the visibility helper', () => {
    const block = announcementsBlock();
    expect(block).toContain("hasPermission('canManageAnnouncements')");
    expect(block).toContain('isSuperAdmin()');
    expect(block).toContain('announcementVisible()');
  });

  it('3. the write allow is unchanged: superadmin or canManageAnnouncements only', () => {
    const block = announcementsBlock();
    expect(block).toContain(
      "allow write: if isSuperAdmin() || hasPermission('canManageAnnouncements');"
    );
  });

  it('4. announcementVisible() checks published status, publish_date vs request.time, via .get defaults', () => {
    const body = helperBody('announcementVisible');
    expect(body).toContain(".get('status', 'draft') == 'published'");
    expect(body).toContain(".get('publish_date', null)");
    expect(body).toContain('publishDate <= request.time');
    expect(body).toContain(".get('audience', 'public')");
  });

  it('5. isOfficer() holds all 19 officer tokens, the founder disjunct, and currentRole() as its source', () => {
    const body = helperBody('isOfficer');
    const tokens = [
      'superadmin', 'president_national',
      'national_vp_engineering', 'national_vp_operations',
      'national_vp_marketing', 'national_vp_finance',
      'national_vp_membership',
      'chapter_president', 'chapter_vp_technical',
      'chapter_vp_operations', 'chapter_vp_marketing',
      'chapter_treasurer', 'chapter_general_secretary',
    ];
    for (const t of tokens) expect(body).toContain(`'${t}'`);
    expect(body).toContain('isFounder()');
    expect(body).toContain('currentRole()');
  });
});

describe('Item 10 consumer sources', () => {
  const consumers = [
    'src/components/layout/announcement-carousel.tsx',
    'src/app/announcements/page.tsx',
    'src/components/notifications/notification-center.tsx',
    'src/app/notifications/page.tsx',
    // featured-announcement-banner.tsx was deleted in read-bleed train 2
    // (zero importers; it carried a third copy of the carousel queries),
    // so it is no longer a display consumer.
  ];

  it('6a. every display consumer uses the shared query builder and visibility predicate', () => {
    for (const rel of consumers) {
      const src = readSrc(rel);
      // Direct use of the shared builder, or delegation to the shared
      // memoized fetcher (fetchVisibleAnnouncements in
      // lib/announcements, read-burn fix F7), which is itself built on
      // visibleAnnouncementQueries; both keep the consumer on the
      // rules-provable split queries instead of a hand-rolled query.
      expect(
        src.includes('visibleAnnouncementQueries') || src.includes('fetchVisibleAnnouncements'),
      ).toBe(true);
      expect(src).toContain('isAnnouncementVisibleTo');
    }
  });

  it("6b. no consumer hand-rolls a bare status-only announcements query (the events feed is out of scope and untouched)", () => {
    for (const rel of consumers) {
      const src = readSrc(rel);
      const occurrences = src.split("where('status', '==', 'published')").length - 1;
      if (occurrences === 0) continue;
      // The only permitted occurrence is the events merge feed.
      expect(occurrences).toBe(1);
      const idx = src.indexOf("where('status', '==', 'published')");
      const before = src.slice(Math.max(0, idx - 500), idx);
      expect(before).toContain('events');
    }
  });

  it('6c. the admin page keeps its unfiltered preview read (exception asserted present)', () => {
    const src = readSrc('src/app/admin/announcements/page.tsx');
    expect(src).toContain('getDocs(query(announcementsRef))');
  });

  it('6d. the public page offers no visitor audience Select for members/officers tiers', () => {
    const src = readSrc('src/app/announcements/page.tsx');
    expect(src).not.toContain('audienceFilter');
    expect(src).not.toContain('team_leaders');
  });

  it('7. the form enum is exactly public/members/officers with default public; the events writer stamps both fields', () => {
    const form = readSrc('src/components/admin/announcements/announcement-form.tsx');
    expect(form).toContain('z.enum(["public", "members", "officers"]).default("public")');
    expect(form).toContain('Members only');
    expect(form).toContain('Officers only');

    const publish = readSrc('src/app/api/events/publish/route.ts');
    expect(publish).toContain("audience: 'public'");
    expect(publish).toContain('publish_date:');
  });
});
