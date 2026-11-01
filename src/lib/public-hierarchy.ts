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
 *  - publicDirectoryOptIn is NOT an inclusion gate for this chart
 *    (founder rules-of-power decision, 2026-10-30): appointed
 *    office-holders are published on the org chart regardless of
 *    the flag. The flag keeps governing ONLY the general member
 *    directory, whose surfaces resolve it through
 *    src/lib/privacy.ts — a helper this module does not use. The
 *    chart lists office-holders only (plain members never appear
 *    here), so not gating on the flag here cannot publish a plain
 *    member anywhere;
 *  - a person appears only when they HOLD a role: a catalog or legacy
 *    role at spec level 6 or above, a custom role (the
 *    chapter deputy roles are custom slugs), or the Founder by UID.
 *    Plain members (spec levels 7 and 8) are not listed — this is
 *    an org chart, not the member directory;
 *  - a person ALSO appears for each custom-role GRANT they hold.
 *    Grants made through the admin AUTHORITY dialog never land in
 *    the user record's role field: POST /api/admin/roles/assign →
 *    assignRole (src/lib/server/role-writes.ts) keeps the primary
 *    on roles/{uid} as the holder's catalog role (member_basic for
 *    most appointees) and appends the custom slug to
 *    roles/{uid}.additionalRoles (contracts 2.1: custom roles never
 *    occupy the primary slot). The role key on the user record alone
 *    therefore cannot see a deputy appointee at all — the 2026-10-30
 *    defect that hid all 16 deputy appointees from this feed. The
 *    grants are merged here from the roles docs the route reads,
 *    under exactly the same inclusion gates as base holdings, one
 *    entry per held role, deduped on identical person+title pairs.
 *    Catalog slugs inside additionalRoles ARE merged (F1): a catalog
 *    seat that lives only as a grant — the Founder's
 *    chapter_president seat is the production case — does NOT
 *    surface through the user record, so skipping it left the IST
 *    section with no president and the renderer crowning
 *    members[0]. Double-publish is still impossible: a grant whose
 *    slug equals the base slug is skipped, and a grant whose
 *    resolved title equals an entry already emitted for the person
 *    collapses on the person+title dedupe. Levels 7 and 8 (plain
 *    members) are never merged as entries, base or grant (F3);
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
 * Parent edges (for the visual org chart): each section also
 * carries `parents`, child member index -> parent member index,
 * derived ONLY from data: a custom role's registry definition names
 * its parent catalog role (parentRoleKey), and an edge is emitted
 * when exactly one entry in the same section holds that role.
 * Vacant parents, co-held parents (co-chairs) and parents seated in
 * another section produce no edge — the chart renders those deputies
 * in a level band rather than inventing a reporting line. Catalog
 * officers carry no person-to-person edge at all: their place in the
 * tree comes from the rank ordering below, expressed as levels.
 *
 * Ordering (F2): National first; chapters with IST Chapter first,
 * then by chapter name; inside a section, spec level ascending
 * (0 = root first); within a level, catalog XP descending, then
 * name ascending. Custom (deputy) entries carry no catalog XP and
 * sort by name within level 5.
 *
 * Titles come from the platform's ONE display function
 * (getRoleDisplayName in src/lib/roles.ts): catalog titles from the
 * role catalog, custom titles from the role registry definition
 * (`name` is the title of record), with the humanised-slug floor for
 * a custom slug whose definition is missing — never the raw slug.
 */

import {
  HIERARCHY_CHART_MAX_LEVEL,
  HIERARCHY_DEPUTY_PARENTS,
  HIERARCHY_VISUAL_LEVEL,
  normalizeRoleSlug,
  normalizeToCanonical,
  scopeOf,
  xpOf,
  type CatalogRoleKey,
} from './role-catalog';
import { isCustomRoleSlug, toCustomRoleDefinition } from './custom-roles';
import { getRoleDisplayName } from './roles';
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
  /**
   * Carried on the input because source records hold it; the chart
   * never gates on it (founder decision 2026-10-30 — see module doc).
   */
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
  /**
   * Visual tree level per the bylaws rank spec table
   * (HIERARCHY_VISUAL_LEVEL, F5): 0 = root. The renderer picks a
   * section's root as its lowest-level present entry (F1), never
   * members[0] by position, and bands officers by level (F2).
   */
  level: number;
}

export interface PublicHierarchySection {
  /** 'national', a chapter id, or 'unassigned'. */
  id: string;
  /** 'National', the chapter's name, or 'Chapter not yet assigned'. */
  name: string;
  members: PublicHierarchyPerson[];
  /**
   * Data-derived parent edges for the visual org chart, as
   * child member index -> parent member index within this section.
   * An edge exists ONLY where the data supports it: a custom role's
   * registry definition names its parent role (parentRoleKey), and
   * exactly one entry in the same section holds that role. When the
   * parent role is vacant, held by more than one person (co-chairs),
   * or held in another section, NO edge is emitted — the chart
   * places that deputy in a level band instead of inventing a
   * reporting line. Omitted entirely when a section has no edges.
   * Person objects keep their 7 output keys (id, name, roleTitle,
   * photoURL, profilePath, isCustomRole, level); only the internal
   * sort/identity fields are stripped.
   */
  parents?: Record<string, number>;
}

export interface PublicHierarchyPayload {
  sections: PublicHierarchySection[];
}

export interface PublicHierarchySource {
  users: RawHierarchyUser[];
  chapters: RawHierarchyChapter[];
  /** Role registry docs (roleDefinitions), keyed by normalised slug. */
  roleDefinitions: ReadonlyMap<string, Record<string, unknown>>;
  /**
   * Per-user custom-role grants: the stored additionalRoles values
   * from roles/{uid}, keyed by uid. Raw unknown values on purpose —
   * the route whitelists exactly this one field off each roles doc
   * (no contact data exists on roles docs, and none is read), and
   * the projection sanitises the array before trusting it.
   */
  additionalRolesByUid: ReadonlyMap<string, unknown>;
}

const NATIONAL_SECTION_ID = 'national';
const UNASSIGNED_SECTION_ID = 'unassigned';
const IST_CHAPTER_ID = 'seds-ist-chapter';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface PlacedPerson extends PublicHierarchyPerson {
  /** Catalog XP for sorting within a level; -1 for custom entries
   *  (no catalog XP), so deputies sort by name within level 5.
   *  Internal — stripped before output. */
  xp: number;
  /** Canonical catalog key of this entry's role (or the custom slug
   *  for a custom entry): the identity other entries' parentRoleKey
   *  is matched against. Internal — stripped before output. */
  identityKey: string | null;
  /** For custom entries, the parent catalog role named by the role
   *  definition; null for catalog entries and definition-less
   *  customs. Internal — stripped before output. */
  parentRoleKey: string | null;
}

/**
 * F1 root rule: a section's root is its lowest-level PRESENT entry
 * per the spec table — never members[0] by position. Ties (same
 * level) keep feed order: the first entry at the lowest level wins,
 * which the feed already orders by XP desc, then name asc (F2).
 * Returns -1 for an empty section. The /hierarchy renderer uses
 * this for both the tree apex and the collapsed summary card.
 */
export function rootMemberIndex(
  members: ReadonlyArray<{ level: number }>
): number {
  let best = -1;
  for (let i = 0; i < members.length; i++) {
    if (best === -1 || members[i].level < members[best].level) best = i;
  }
  return best;
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
    // publicDirectoryOptIn is deliberately NOT a gate here (founder
    // rules-of-power decision, 2026-10-30): appointed office-holders
    // are published on the org chart regardless of the flag; the
    // flag governs only the general member directory.

    const name = asString(user.displayName).trim();
    if (!name) continue; // vacant seat in the admin chart; not a public entry

    // The stored role key: displayRole mirrors role on the user doc;
    // the admin hierarchy reads displayRole first, so this does too.
    const roleKey = asString(user.displayRole).trim() || asString(user.role).trim();
    const slug = normalizeRoleSlug(roleKey);
    const canonical = roleKey ? normalizeToCanonical(roleKey) : null;
    const custom = isCustomRoleSlug(slug);
    const founder = isFounderUid(user.id);

    // Grants held by this user (roles/{uid}.additionalRoles, the
    // AUTHORITY dialog's store). Custom slugs merge, and catalog
    // slugs merge too (F1) — a catalog seat held only as a grant
    // is a real holding. Sanitised here: string entries only,
    // normalised, deduped, never a repeat of the base holding, and
    // never an unresolvable token. A custom slug keeps no catalog
    // identity; a catalog slug resolves to its canonical key.
    const grantSlugs: Array<{
      slug: string;
      canonical: CatalogRoleKey | null;
      custom: boolean;
    }> = [];
    const rawGrants = source.additionalRolesByUid.get(user.id);
    if (Array.isArray(rawGrants)) {
      const seenGrants = new Set<string>();
      for (const raw of rawGrants) {
        const grantSlug = normalizeRoleSlug(asString(raw).trim());
        if (!grantSlug || grantSlug === slug || seenGrants.has(grantSlug)) {
          continue;
        }
        const grantCustom = isCustomRoleSlug(grantSlug);
        const grantCanonical = grantCustom
          ? null
          : normalizeToCanonical(grantSlug);
        if (!grantCustom && grantCanonical === null) continue;
        seenGrants.add(grantSlug);
        grantSlugs.push({
          slug: grantSlug,
          canonical: grantCanonical,
          custom: grantCustom,
        });
      }
    }

    // Levels 7 and 8 (plain members) are never base holdings (F3);
    // the Founder and custom (deputy) primaries always are.
    const baseLevel =
      canonical === null ? -1 : HIERARCHY_VISUAL_LEVEL[canonical];
    const isBaseHolder =
      founder ||
      custom ||
      (canonical !== null && baseLevel <= HIERARCHY_CHART_MAX_LEVEL);
    if (!isBaseHolder && grantSlugs.length === 0) continue;

    // One entry per held role, deduped on identical person+title
    // pairs (a grant whose resolved title equals an entry already
    // emitted for this person — e.g. the Founder title — collapses).
    const emittedTitles = new Set<string>();
    const placeEntry = (
      entryRoleKey: string,
      entryCanonical: CatalogRoleKey | null,
      entryCustom: boolean,
      entrySlug: string,
      founderEntry: boolean
    ): void => {
      // Visual level per the spec table (F5): the Founder sits at
      // level 0 whatever the stored role string says; catalog
      // entries take their spec level; custom entries are deputies
      // at level 5. Above the chart cutoff (F3) an entry never
      // appears — checked before the title dedupe so a skipped
      // plain-member entry cannot shadow a later grant with the
      // same title.
      const level = founderEntry
        ? 0
        : entryCanonical
          ? HIERARCHY_VISUAL_LEVEL[entryCanonical]
          : 5;
      if (!founderEntry && level > HIERARCHY_CHART_MAX_LEVEL) return;

      // The founder override in the display function applies to the
      // founder's PRIMARY entry only: a grant entry held by the
      // Founder shows its own office title, or the IST president
      // seat would collapse into the founder card on the
      // person+title dedupe below and F1 would silently fail for
      // exactly the production case. For non-founder holders the
      // uid is irrelevant to the display function, so passing
      // undefined for every grant entry changes nothing else.
      const roleTitle = getRoleDisplayName(
        entryRoleKey,
        founderEntry ? user.id : undefined,
        source.roleDefinitions
      );
      if (emittedTitles.has(roleTitle)) return;
      emittedTitles.add(roleTitle);

      // Within-level sort key (F2): catalog XP of the displayed
      // identity — the Founder sorts at founder_patron XP 35
      // whatever the stored role string says; custom entries have
      // no catalog XP and tie at -1, so they sort by name.
      const xp = founderEntry
        ? xpOf('founder_patron')
        : entryCanonical
          ? xpOf(entryCanonical)
          : -1;

      // The custom role's registry definition, when one exists: it
      // carries the chapter the role was created for and the parent
      // role the visual chart derives its one honest edge type from.
      // The spec table's parent wins over the definition (F5); the
      // definition is the fallback for customs the spec does not list.
      const defDoc = entryCustom
        ? source.roleDefinitions.get(entrySlug)
        : undefined;
      const def = defDoc ? toCustomRoleDefinition(entrySlug, defDoc) : null;
      const specParent = entryCustom
        ? HIERARCHY_DEPUTY_PARENTS[entrySlug]
        : undefined;

      const person: PlacedPerson = {
        id: user.id,
        name,
        roleTitle,
        photoURL: asString(user.photoURL).trim() || null,
        profilePath: `/profile/unified/${user.id}`,
        isCustomRole: entryCustom,
        level,
        xp,
        identityKey: founderEntry
          ? 'founder_patron'
          : entryCanonical ?? (entryCustom ? entrySlug : null),
        parentRoleKey: specParent ?? def?.parentRoleKey ?? null,
      };

      const scope = entryCanonical ? scopeOf(entryCanonical) : null;
      if (founderEntry || scope === 'global' || scope === 'national') {
        national.push(person);
        return;
      }

      let chapterId = asString(user.chapterId).trim();
      if (!chapterId && entryCustom) {
        // A chapter deputy whose profile has no chapter yet still
        // belongs to the chapter the role itself was created for.
        if (def?.chapterId) chapterId = def.chapterId;
      }

      if (chapterId) {
        const list = byChapter.get(chapterId);
        if (list) list.push(person);
        else byChapter.set(chapterId, [person]);
      } else {
        unassigned.push(person);
      }
    };

    if (isBaseHolder) placeEntry(roleKey, canonical, custom, slug, founder);
    for (const grant of grantSlugs) {
      // A custom grant has no catalog identity of its own; a
      // catalog grant carries its canonical key, so it places,
      // levels and parents exactly like a primary holding (F1).
      placeEntry(grant.slug, grant.canonical, grant.custom, grant.slug, false);
    }
  }

  // F2: spec level ascending, then catalog XP descending, then
  // name ascending. No other key participates.
  const byLevelXpName = (a: PlacedPerson, b: PlacedPerson): number =>
    a.level - b.level ||
    b.xp - a.xp ||
    a.name.localeCompare(b.name);

  /**
   * Sort a section's entries, derive its parent edges from the
   * sorted positions, and strip the internal fields. An edge is
   * emitted only when a custom entry's definition-named parent role
   * is held by exactly one entry in the same section — vacant,
   * co-held and cross-section parents produce no edge, so the chart
   * never draws a reporting line the data does not support.
   */
  const finalize = (
    list: PlacedPerson[]
  ): Pick<PublicHierarchySection, 'members' | 'parents'> => {
    const sorted = [...list].sort(byLevelXpName);
    const parents: Record<string, number> = {};
    sorted.forEach((entry, i) => {
      if (!entry.parentRoleKey) return;
      const matches: number[] = [];
      sorted.forEach((candidate, j) => {
        if (j !== i && candidate.identityKey === entry.parentRoleKey) {
          matches.push(j);
        }
      });
      if (matches.length === 1) parents[String(i)] = matches[0];
    });
    const members = sorted.map(
      ({
        xp: _xp,
        identityKey: _key,
        parentRoleKey: _parent,
        ...person
      }) => person
    );
    return Object.keys(parents).length > 0 ? { members, parents } : { members };
  };

  const sections: PublicHierarchySection[] = [];
  if (national.length > 0) {
    sections.push({
      id: NATIONAL_SECTION_ID,
      name: 'National',
      ...finalize(national),
    });
  }

  const chapterSections: PublicHierarchySection[] = [...byChapter.entries()].map(
    ([chapterId, members]) => ({
      id: chapterId,
      name: chapterNames.get(chapterId) || chapterId,
      ...finalize(members),
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
      ...finalize(unassigned),
    });
  }

  return { sections };
}
