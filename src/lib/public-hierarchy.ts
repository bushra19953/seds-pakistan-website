/**
 * Public hierarchy projection (founder order 2026-10-30).
 *
 * Turns the platform's role truth — the same user records and role
 * registry the admin org chart (/admin/hierarchy) renders — into the
 * small, public-safe payload behind GET /api/public/hierarchy and the
 * /hierarchy page: chapter by chapter, who holds which role, with a
 * link to each person's public profile.
 *
 * PRIVACY (hard rule): the input types below are the whole contract.
 * They carry NO contact fields — no email, no phone, no WhatsApp —
 * because the route whitelists exactly these fields off the raw user
 * docs before anything reaches this module, and the projection below
 * copies only name / role title / chapter name / avatar / profile id
 * into the payload. The 2026-10-28 contact gating cannot leak through
 * this page because contact data never enters it.
 *
 * Inclusion mirrors the admin chart, narrowed to role-holders:
 *  - departed / erased records stay off the chart (admin parity);
 *  - an explicit publicDirectoryOptIn === false always wins and the
 *    person is not published (the platform privacy contract: an
 *    explicit stored boolean beats every default);
 *  - a person appears only when they HOLD a role: a catalog or legacy
 *    role other than the member_basic floor, a custom role (the
 *    chapter deputy roles are custom slugs), or the Founder by UID.
 *    Plain members are not listed — this is an org chart, not the
 *    member directory;
 *  - a record with no usable display name is a vacant seat in the
 *    admin chart; it is not a public entry and is omitted.
 *
 * Placement:
 *  - global / national-scope roles (and the Founder) form the
 *    "National" section at the top;
 *  - everyone else is grouped by chapter: the user's chapterId, or —
 *    for a custom role whose holder has not set a chapter yet — the
 *    chapter stored on the role definition itself (the deputy roles
 *    are chapter roles by definition);
 *  - chapter-scoped role-holders with no chapter anywhere land in a
 *    closing "Chapter not yet assigned" section rather than being
 *    silently dropped.
 *
 * Ordering: National first; chapters with IST Chapter first, then by
 * chapter name; inside a chapter, the chapter president, then chapter
 * executives, then the remaining role-holders (deputies included),
 * each band ordered by catalog rank, then by name.
 *
 * Titles come from the platform's ONE display function
 * (getRoleDisplayName in src/lib/roles.ts): catalog titles from the
 * role catalog, custom titles from the role registry definition
 * (`name` is the title of record), with the humanised-slug floor for
 * a custom slug whose definition is missing — never the raw slug.
 */

import {
  normalizeRoleSlug,
  normalizeToCanonical,
  rankOf,
  rankValue,
  scopeOf,
} from './role-catalog';
import { isCustomRoleSlug, toCustomRoleDefinition } from './custom-roles';
import { getRoleDisplayName, isChapterExecutive } from './roles';
import { isFounderUid } from '@/config/founder';

/** The ONLY user fields the public hierarchy may read. No contact data. */
export interface RawHierarchyUser {
  id: string;
  displayName?: unknown;
  photoURL?: unknown;
  role?: unknown;
  displayRole?: unknown;
  chapterId?: unknown;
  memberStatus?: unknown;
  publicDirectoryOptIn?: unknown;
}

export interface RawHierarchyChapter {
  id: string;
  name?: unknown;
  title?: unknown;
}

export interface PublicHierarchyPerson {
  id: string;
  name: string;
  roleTitle: string;
  photoURL: string | null;
  profilePath: string;
  isCustomRole: boolean;
}

export interface PublicHierarchySection {
  /** 'national', a chapter id, or 'unassigned'. */
  id: string;
  /** 'National', the chapter's name, or 'Chapter not yet assigned'. */
  name: string;
  members: PublicHierarchyPerson[];
}

export interface PublicHierarchyPayload {
  sections: PublicHierarchySection[];
}

export interface PublicHierarchySource {
  users: RawHierarchyUser[];
  chapters: RawHierarchyChapter[];
  /** Role registry docs (roleDefinitions), keyed by normalised slug. */
  roleDefinitions: ReadonlyMap<string, Record<string, unknown>>;
}

const NATIONAL_SECTION_ID = 'national';
const UNASSIGNED_SECTION_ID = 'unassigned';
const IST_CHAPTER_ID = 'seds-ist-chapter';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface PlacedPerson extends PublicHierarchyPerson {
  sortGroup: number;
  sortRank: number;
}

export function buildPublicHierarchy(
  source: PublicHierarchySource
): PublicHierarchyPayload {
  const chapterNames = new Map<string, string>();
  for (const chapter of source.chapters) {
    const name =
      asString(chapter.name).trim() || asString(chapter.title).trim() || chapter.id;
    chapterNames.set(chapter.id, name);
  }

  const national: PlacedPerson[] = [];
  const byChapter = new Map<string, PlacedPerson[]>();
  const unassigned: PlacedPerson[] = [];

  for (const user of source.users) {
    // Departed and erased members are off the chart (admin parity).
    if (user.memberStatus === 'departed' || user.memberStatus === 'erased') {
      continue;
    }
    // An explicit public opt-out always wins.
    if (user.publicDirectoryOptIn === false) continue;

    const name = asString(user.displayName).trim();
    if (!name) continue; // vacant seat in the admin chart; not a public entry

    // The stored role key: displayRole mirrors role on the user doc;
    // the admin hierarchy reads displayRole first, so this does too.
    const roleKey = asString(user.displayRole).trim() || asString(user.role).trim();
    const slug = normalizeRoleSlug(roleKey);
    const canonical = roleKey ? normalizeToCanonical(roleKey) : null;
    const custom = isCustomRoleSlug(slug);
    const founder = isFounderUid(user.id);

    const isHolder =
      founder || custom || (canonical !== null && canonical !== 'member_basic');
    if (!isHolder) continue;

    // Ordering follows the DISPLAYED identity: the Founder displays as
    // founder_patron by UID whatever the stored role string says, so
    // the Founder also sorts at founder_patron rank.
    const rankKey = founder ? 'founder_patron' : canonical;
    const person: PlacedPerson = {
      id: user.id,
      name,
      roleTitle: getRoleDisplayName(roleKey, user.id, source.roleDefinitions),
      photoURL: asString(user.photoURL).trim() || null,
      profilePath: `/profile/unified/${user.id}`,
      isCustomRole: custom,
      sortGroup: 2,
      sortRank: rankKey ? rankValue(rankOf(rankKey)) : -1,
    };

    const scope = canonical ? scopeOf(canonical) : null;
    if (founder || scope === 'global' || scope === 'national') {
      person.sortGroup = 0;
      national.push(person);
      continue;
    }

    let chapterId = asString(user.chapterId).trim();
    if (!chapterId && custom) {
      // A chapter deputy whose profile has no chapter yet still
      // belongs to the chapter the role itself was created for.
      const defDoc = source.roleDefinitions.get(slug);
      const def = defDoc ? toCustomRoleDefinition(slug, defDoc) : null;
      if (def?.chapterId) chapterId = def.chapterId;
    }

    if (chapterId) {
      if (canonical === 'chapter_president') person.sortGroup = 0;
      else if (canonical && isChapterExecutive(canonical)) person.sortGroup = 1;
      const list = byChapter.get(chapterId);
      if (list) list.push(person);
      else byChapter.set(chapterId, [person]);
    } else {
      unassigned.push(person);
    }
  }

  const byBandRankName = (a: PlacedPerson, b: PlacedPerson): number =>
    a.sortGroup - b.sortGroup ||
    b.sortRank - a.sortRank ||
    a.name.localeCompare(b.name);

  const strip = (list: PlacedPerson[]): PublicHierarchyPerson[] =>
    list
      .sort(byBandRankName)
      .map(({ sortGroup: _group, sortRank: _rank, ...person }) => person);

  const sections: PublicHierarchySection[] = [];
  if (national.length > 0) {
    sections.push({
      id: NATIONAL_SECTION_ID,
      name: 'National',
      members: strip(national),
    });
  }

  const chapterSections: PublicHierarchySection[] = [...byChapter.entries()].map(
    ([chapterId, members]) => ({
      id: chapterId,
      name: chapterNames.get(chapterId) || chapterId,
      members: strip(members),
    })
  );
  chapterSections.sort((a, b) => {
    const aIst = a.id === IST_CHAPTER_ID || a.name === 'IST Chapter' ? 0 : 1;
    const bIst = b.id === IST_CHAPTER_ID || b.name === 'IST Chapter' ? 0 : 1;
    return aIst - bIst || a.name.localeCompare(b.name);
  });
  sections.push(...chapterSections);

  if (unassigned.length > 0) {
    sections.push({
      id: UNASSIGNED_SECTION_ID,
      name: 'Chapter not yet assigned',
      members: strip(unassigned),
    });
  }

  return { sections };
}
