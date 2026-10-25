/**
 * Identity parity fixtures (Supabase migration, identity cluster).
 *
 * ONE logical fixture, expressed TWICE:
 *   - as Firestore documents (seeded into the CountingFirestore fake,
 *     feeding the EXISTING production loader path in
 *     src/lib/server/permissions.ts / identity-cache.ts), and
 *   - as `fs_*` table rows (id / firebase_uid / parent_path / data
 *     jsonb), built by `fsRowsFor()` below, feeding the
 *     reader-under-test.
 *
 * The fs_* row shape replicates `rowFor()` in
 * ~/workspace/supabase-migration/migrate_db.js exactly:
 *   segments = doc path split on '/'; for a top-level doc the path is
 *   `<collection>/<id>`, so parent_path is the collection name;
 *   firebase_uid is set ONLY when a `users` segment is present (for
 *   the top-level `users` collection the doc id IS the uid); every
 *   other collection's row carries firebase_uid = null. `data` is the
 *   document body verbatim (jsonb). `migrated_at` is a DB default in
 *   the real tables; fixtures carry a fixed stamp so a reader that
 *   leaks it into its output fails parity visibly.
 *
 * Edge-case selection is driven by
 * ~/workspace/permissions_audit/FOUNDER_ACCESS_MAP_2026-10-25.md;
 * each fixture names the FD finding(s) it covers in `covers`.
 *
 * UIDs are synthetic parity uids on purpose: the bundle a reader
 * returns contains NO uid, so parity must hold for any uid key.
 * The chapter id is the real one named in the task/fixtures
 * (`seds-ist-chapter`).
 */

export const PARITY_CHAPTER_ID = 'seds-ist-chapter';

/** Fixed clock for every parity load: both sides stamp
 * IdentityBundle.loadedAt from Date.now(), so strict deep equality
 * (loadedAt included) requires one frozen instant. */
export const PARITY_FIXED_NOW = 1_730_000_000_000;

const MIGRATED_AT = '2026-10-25T00:00:00.000Z';

export type PermissionCollection = 'roleDefinitions' | 'permissions';

export interface PermissionDocFixture {
  collection: PermissionCollection;
  slug: string;
  /** The stored document body, or null when the doc does NOT exist. */
  doc: Record<string, unknown> | null;
}

export interface IdentityParityFixture {
  id: string;
  /** FD finding(s) / root cause from FOUNDER_ACCESS_MAP this covers. */
  covers: string;
  uid: string;
  /** roles/{uid} body, or null when the roles doc does NOT exist. */
  rolesDoc: Record<string, unknown> | null;
  /** users/{uid} body, or null when the users doc does NOT exist. */
  usersDoc: Record<string, unknown> | null;
  permissionDocs: PermissionDocFixture[];
  /**
   * Pinned resolveIdentityForAuth() outcome for side A (the real
   * derivation over the real bundle). Because the parity suite proves
   * the side-B bundle deep-equals the side-A bundle, this outcome is
   * inherited by any reader that passes parity.
   */
  expectedAuth: { role: string; isBanned: boolean };
}

const FOUNDER_ADDITIONALS = ['president_national', 'chapter_president'];

export const IDENTITY_PARITY_FIXTURES: IdentityParityFixture[] = [
  {
    // Task fixture 1 (base variant). FD §1/RC-1: founder recognition
    // at most layers rides on this roles-doc STRING. The extra
    // users-doc fields (displayName etc.) pin the projection: a
    // reader that leaks non-projected fields fails deep equality.
    id: 'founder-no-scope',
    covers: 'FD §1 power map + RC-1 (founder_patron string, additionalRoles president_national/chapter_president); FD-02/FD-03 (permissions/founder_patron doc present, _scope ABSENT)',
    uid: 'uid-founder-parity',
    rolesDoc: {
      role: 'founder_patron',
      additionalRoles: [...FOUNDER_ADDITIONALS],
      chapterId: PARITY_CHAPTER_ID,
    },
    usersDoc: {
      role: 'founder_patron',
      displayRole: 'founder_patron',
      additionalRoles: [...FOUNDER_ADDITIONALS],
      chapterId: PARITY_CHAPTER_ID,
      isBanned: false,
      displayName: 'Founder Parity (not projected)',
      email: 'founder-parity@example.com',
    },
    permissionDocs: [
      {
        collection: 'permissions',
        slug: 'founder_patron',
        doc: { canManagePermissions: true, canManageRoles: true, canManageUsers: true },
      },
      {
        collection: 'roleDefinitions',
        slug: 'founder_patron',
        // Array representation, deliberately DIFFERENT from the
        // boolean-map representation in permissions/ above: both
        // tiers must round-trip verbatim, in their own shape.
        doc: { name: 'Founder Patron', permissions: ['canManagePermissions', 'canManageRoles'] },
      },
    ],
    expectedAuth: { role: 'founder_patron', isBanned: false },
  },
  {
    // Task fixture 1 (demotion variant). FD-20: a mutable
    // permissions/{founder_patron}._scope === 'chapter' demotes the
    // founder to chapter scope in resolveEffectiveScope. The bundle
    // is IDENTICAL to founder-no-scope (the _scope lives only in the
    // permission-doc entry); the entry must carry _scope verbatim.
    id: 'founder-scope-chapter',
    covers: 'FD-20 (permissions/founder_patron._scope === "chapter" demotion path)',
    uid: 'uid-founder-scope',
    rolesDoc: {
      role: 'founder_patron',
      additionalRoles: [...FOUNDER_ADDITIONALS],
      chapterId: PARITY_CHAPTER_ID,
    },
    usersDoc: {
      role: 'founder_patron',
      displayRole: 'founder_patron',
      additionalRoles: [...FOUNDER_ADDITIONALS],
      chapterId: PARITY_CHAPTER_ID,
      isBanned: false,
    },
    permissionDocs: [
      {
        collection: 'permissions',
        slug: 'founder_patron',
        doc: { canManagePermissions: true, canManageRoles: true, _scope: 'chapter' },
      },
    ],
    expectedAuth: { role: 'founder_patron', isBanned: false },
  },
  {
    // Task fixture 2 + 7 (officer half). No additionalRoles key at
    // all -> the projection must surface `undefined`, not [] or null.
    // The roleDefinitions grant is deliberately NARROWER than the
    // role-string's static-config default: the doc, not the string
    // default, is what a reader returns.
    id: 'officer-national-vice-president',
    covers: 'Task fixture 2 (officer, no additionalRoles); task fixture 7 (roleDefinitions/national_vice_president grants differ from the static role-string default)',
    uid: 'uid-officer',
    rolesDoc: { role: 'national_vice_president', chapterId: PARITY_CHAPTER_ID },
    usersDoc: { chapterId: PARITY_CHAPTER_ID, isBanned: false, displayName: 'Officer Parity' },
    permissionDocs: [
      {
        collection: 'roleDefinitions',
        slug: 'national_vice_president',
        doc: { name: 'National Vice President', permissions: ['canViewAnalytics'] },
      },
      {
        collection: 'permissions',
        slug: 'national_vice_president',
        doc: { canManageTasks: false, canViewAnalytics: true },
      },
    ],
    expectedAuth: { role: 'national_vice_president', isBanned: false },
  },
  {
    // Task fixture 3a. Empty additionalRoles array (present, empty)
    // is a different stored shape from an absent key (fixture 2).
    id: 'member-basic',
    covers: 'Task fixture 3a (member_basic primary, empty additionalRoles array)',
    uid: 'uid-member-basic',
    rolesDoc: { role: 'member_basic', additionalRoles: [], chapterId: PARITY_CHAPTER_ID },
    usersDoc: {
      role: 'member_basic',
      displayRole: 'member_basic',
      additionalRoles: [],
      chapterId: PARITY_CHAPTER_ID,
      isBanned: false,
    },
    permissionDocs: [
      {
        collection: 'roleDefinitions',
        slug: 'member_basic',
        doc: { name: 'Basic Member', permissions: [] },
      },
    ],
    expectedAuth: { role: 'member_basic', isBanned: false },
  },
  {
    // Task fixture 3b. FD-04/FD-06: 'member' primary is the Full
    // Member / electorate definition. Its permissions/member doc
    // grants canManageTasks:true, which the static config does NOT
    // grant the role string (fixture 7: doc wins, verbatim).
    id: 'full-member',
    covers: 'FD-04/FD-06 (primary "member" == Full Member electorate definition); task fixture 7 (permissions/member doc grant differs from static default)',
    uid: 'uid-full-member',
    rolesDoc: { role: 'member', chapterId: PARITY_CHAPTER_ID },
    usersDoc: { role: 'member', displayRole: 'member', chapterId: PARITY_CHAPTER_ID, isBanned: false },
    permissionDocs: [
      { collection: 'permissions', slug: 'member', doc: { canManageTasks: true } },
    ],
    expectedAuth: { role: 'member', isBanned: false },
  },
  {
    // Task fixture 4 (primary half). A custom_ primary is returned
    // VERBATIM (never floored to member_basic, contracts 4.4). The
    // roles doc also carries the grant-expiry pair
    // (expiresAt/expiresRoleKey), which the projection must carry
    // untouched. permissions/custom_* deliberately contains
    // canManageRoles:true — the Reserved-Powers strip happens in
    // hasServerPermission, NOT in the doc entry; a reader that
    // strips it fails parity.
    id: 'custom-primary',
    covers: 'Task fixture 4 (custom_* primary, verbatim not floored); contracts 2.2 expiry pair projection; SEC-03 reserved-key strip is downstream, not in the entry',
    uid: 'uid-custom-primary',
    rolesDoc: {
      role: 'custom_poster_team_lead',
      additionalRoles: [],
      chapterId: PARITY_CHAPTER_ID,
      expiresAt: '2027-01-01T00:00:00.000Z',
      expiresRoleKey: 'custom_poster_team_lead',
    },
    usersDoc: { chapterId: PARITY_CHAPTER_ID, isBanned: false },
    permissionDocs: [
      {
        collection: 'roleDefinitions',
        slug: 'custom_poster_team_lead',
        doc: { isCustom: true, name: 'Poster Team Lead', permissions: ['canManageTasks'] },
      },
      {
        collection: 'permissions',
        slug: 'custom_poster_team_lead',
        doc: { canManageTasks: true, canManageRoles: true },
      },
    ],
    expectedAuth: { role: 'custom_poster_team_lead', isBanned: false },
  },
  {
    // Task fixture 4 (cap half). additionalRoles holds custom_ slugs
    // at indexes 0,1,2,3. The live RULES unroll honors custom_ only
    // and is capped at indexes 0-2 (FOUNDER map RC-2/RP-14), but the
    // identity BUNDLE is not the unroll: loadIdentityBundle projects
    // the array verbatim, all four entries. This fixture exposes
    // exactly where the cap bites — downstream of the reader. A
    // Supabase reader that truncates to 3 (or filters) fails here.
    id: 'custom-additionals-index-0-to-3',
    covers: 'RC-2/RP-14 + "custom-role grants at additionalRoles index 3+ are denied" (rules unroll cap 0-2); bundle itself must preserve all 4 verbatim',
    uid: 'uid-custom-additionals',
    rolesDoc: {
      role: 'member_basic',
      additionalRoles: ['custom_alpha', 'custom_beta', 'custom_gamma', 'custom_delta'],
      chapterId: PARITY_CHAPTER_ID,
    },
    usersDoc: { chapterId: PARITY_CHAPTER_ID, isBanned: false },
    permissionDocs: [
      {
        collection: 'roleDefinitions',
        slug: 'custom_delta', // the index-3 slug
        doc: { isCustom: true, name: 'Delta (index 3)', permissions: ['canManageEvents'] },
      },
    ],
    expectedAuth: { role: 'member_basic', isBanned: false },
  },
  {
    // Task fixture 5. NON-custom entries beyond index 0: the bundle
    // preserves them verbatim, and every downstream resolver in the
    // map IGNORES them (rules unroll is custom_-only; server office
    // resolvers read primary only — RC-2/RP-14, FD-11 mechanism).
    // The fixture proves both halves at bundle level: present in the
    // data, conferring nothing in expectedAuth (primary stays
    // member_basic; no customRoles are implied by this data).
    id: 'noncustom-additionals-beyond-index-0',
    covers: 'RC-2/RP-14, FD-11 mechanism (additionalRoles honored almost nowhere; non-custom entries beyond index 0 ignored downstream, preserved verbatim in the bundle)',
    uid: 'uid-noncustom-additionals',
    rolesDoc: {
      role: 'member_basic',
      additionalRoles: ['chapter_president', 'president_national', 'national_vice_president'],
      chapterId: PARITY_CHAPTER_ID,
    },
    usersDoc: {
      role: 'member_basic',
      additionalRoles: ['chapter_president', 'president_national', 'national_vice_president'],
      chapterId: PARITY_CHAPTER_ID,
      isBanned: false,
    },
    permissionDocs: [],
    expectedAuth: { role: 'member_basic', isBanned: false },
  },
  {
    // Task fixture 6a. Users doc MISSING: the load does NOT throw.
    // bundle.users is the exists:false projection (isBanned:false),
    // and the roles doc still supplies the primary.
    id: 'no-users-doc',
    covers: 'Task fixture 6 (no users doc); failure-semantics: missing doc is data, not an error (identity-cache §2.4)',
    uid: 'uid-no-users-doc',
    rolesDoc: { role: 'chapter_president', chapterId: PARITY_CHAPTER_ID },
    usersDoc: null,
    permissionDocs: [
      {
        collection: 'roleDefinitions',
        slug: 'chapter_president',
        doc: { name: 'Chapter President', permissions: ['canManageTasks'] },
      },
    ],
    expectedAuth: { role: 'chapter_president', isBanned: false },
  },
  {
    // Task fixture 6b. Roles doc MISSING: the users mirror supplies
    // primary (role, then displayRole) AND additionalRoles; expiry
    // fields project as undefined (they exist only on roles docs).
    id: 'no-roles-doc',
    covers: 'Task fixture 6 (users doc but no roles doc); roles-first/users-fallback derivation (permissions.ts recordFromBundle)',
    uid: 'uid-no-roles-doc',
    rolesDoc: null,
    usersDoc: {
      role: 'member',
      displayRole: 'member',
      additionalRoles: ['custom_from_users_mirror'],
      chapterId: PARITY_CHAPTER_ID,
      isBanned: false,
    },
    permissionDocs: [],
    expectedAuth: { role: 'member', isBanned: false },
  },
  {
    // Task fixture 6c. Identity docs exist; EVERY permission doc
    // for the primary is missing -> entries are
    // { exists:false, data:undefined }, which IS cached as data.
    id: 'no-permission-doc',
    covers: 'Task fixture 6 (roles/users docs but no permissions doc); identity-cache §2.4 negative caching (exists:false is data)',
    uid: 'uid-no-permission-doc',
    rolesDoc: { role: 'member_basic', chapterId: PARITY_CHAPTER_ID },
    usersDoc: { chapterId: PARITY_CHAPTER_ID, isBanned: false },
    permissionDocs: [
      { collection: 'permissions', slug: 'member_basic', doc: null },
      { collection: 'roleDefinitions', slug: 'member_basic', doc: null },
    ],
    expectedAuth: { role: 'member_basic', isBanned: false },
  },
  {
    // Task fixture 6d. Permission doc PRESENT BUT EMPTY: exists:true
    // with data {} — observably different from fixture 6c's
    // exists:false/undefined, and a reader must not conflate them.
    id: 'permission-doc-empty',
    covers: 'Task fixture 6 (permissions doc present but empty {} vs missing)',
    uid: 'uid-permission-empty',
    rolesDoc: { role: 'member_basic', chapterId: PARITY_CHAPTER_ID },
    usersDoc: { chapterId: PARITY_CHAPTER_ID, isBanned: false },
    permissionDocs: [
      { collection: 'permissions', slug: 'member_basic', doc: {} },
    ],
    expectedAuth: { role: 'member_basic', isBanned: false },
  },
  {
    // Task fixture 6 (extreme). NEITHER doc exists: still no throw;
    // both projections are exists:false. resolveIdentityForAuth
    // floors the empty stored token via normalizeUserRole('') to
    // member_basic (pinned as observed side-A behavior).
    id: 'no-docs-at-all',
    covers: 'Task fixture 6 (no users doc AND no roles doc); auth leg derives from an all-missing bundle without throwing',
    uid: 'uid-ghost',
    rolesDoc: null,
    usersDoc: null,
    permissionDocs: [],
    expectedAuth: { role: 'member_basic', isBanned: false },
  },
  {
    // Task fixture 7 (founder half). The founder_patron STRING on a
    // uid that is NOT the founder uid. Its roles/users docs are
    // byte-identical to founder-no-scope's, so its bundle must be
    // deep-equal to the founder's: the bundle carries the string and
    // NO uid-derived founder marker. Root power is isFounderUid
    // (src/config/founder.ts), downstream of any reader (map §1:
    // "Root power on this platform is a UID, not a role string").
    id: 'founder-string-on-other-uid',
    covers: 'FD §1/RC-1 (founder recognition by role-string vs UID must be visible: identical docs on a non-founder uid produce an identical bundle)',
    uid: 'uid-not-the-founder',
    rolesDoc: {
      role: 'founder_patron',
      additionalRoles: [...FOUNDER_ADDITIONALS],
      chapterId: PARITY_CHAPTER_ID,
    },
    usersDoc: {
      role: 'founder_patron',
      displayRole: 'founder_patron',
      additionalRoles: [...FOUNDER_ADDITIONALS],
      chapterId: PARITY_CHAPTER_ID,
      isBanned: false,
      displayName: 'Founder Parity (not projected)',
      email: 'founder-parity@example.com',
    },
    permissionDocs: [],
    expectedAuth: { role: 'founder_patron', isBanned: false },
  },
  {
    // Extra (auth-leg pin). isBanned projects ONLY from
    // users.isBanned === true, and resolveIdentityForAuth surfaces
    // it while the role still derives normally. Covered by the
    // integration suite at route level; pinned here at bundle level
    // so a Supabase reader cannot drop the flag.
    id: 'banned-member',
    covers: 'FOUNDER map §0/auth leg (isBanned === true projection drives the Account Banned outcome)',
    uid: 'uid-banned',
    rolesDoc: { role: 'member', chapterId: PARITY_CHAPTER_ID },
    usersDoc: { chapterId: PARITY_CHAPTER_ID, isBanned: true },
    permissionDocs: [],
    expectedAuth: { role: 'member', isBanned: true },
  },
];

/* ------------------------------------------------------------------ */
/* fs_* row expression (migrate_db.js rowFor, replicated)              */
/* ------------------------------------------------------------------ */

export interface FsRow {
  table: string;
  id: string;
  firebase_uid: string | null;
  parent_path: string | null;
  data: Record<string, unknown>;
  migrated_at: string;
}

function fsTableFor(collection: string): string {
  return `fs_${collection.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function rowFor(collection: string, id: string, data: Record<string, unknown>): FsRow {
  // doc.ref.path for a top-level doc is `<collection>/<id>`:
  // parent_path is the segment before the id; firebase_uid is set
  // only via a `users` segment (top-level users: the id itself).
  return {
    table: fsTableFor(collection),
    id,
    firebase_uid: collection === 'users' ? id : null,
    parent_path: collection,
    data,
    migrated_at: MIGRATED_AT,
  };
}

/** Every fs_* row the fixture's present docs land as. A missing doc
 * is the ABSENCE of its row — there is no tombstone row shape. */
export function fsRowsFor(fixture: IdentityParityFixture): FsRow[] {
  const rows: FsRow[] = [];
  if (fixture.rolesDoc) rows.push(rowFor('roles', fixture.uid, fixture.rolesDoc));
  if (fixture.usersDoc) rows.push(rowFor('users', fixture.uid, fixture.usersDoc));
  for (const perm of fixture.permissionDocs) {
    if (perm.doc) rows.push(rowFor(perm.collection, perm.slug, perm.doc));
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Independently-stated expected outputs (the spec, not the code)    */
/* ------------------------------------------------------------------ */

import type { IdentityBundle, PermissionDocEntry } from '../../identity-cache';

/**
 * The IdentityBundle loadIdentityBundle MUST produce for a fixture,
 * stated directly from the projection rules in permissions.ts:
 * roles projects {role, additionalRoles, expiresAt, expiresRoleKey,
 * chapterId}, users projects {role, displayRole, additionalRoles,
 * isBanned === true, chapterId}; a missing doc projects exists:false
 * with every field undefined except isBanned:false. Nothing else
 * from the stored docs may appear.
 */
export function expectedBundleFor(fixture: IdentityParityFixture): IdentityBundle {
  const slice = (v: unknown): unknown => (Array.isArray(v) ? [...v] : v);
  const r = fixture.rolesDoc;
  const u = fixture.usersDoc;
  return {
    roles: {
      exists: r !== null,
      role: r?.role,
      additionalRoles: slice(r?.additionalRoles),
      expiresAt: r?.expiresAt,
      expiresRoleKey: r?.expiresRoleKey,
      chapterId: r?.chapterId,
    },
    users: {
      exists: u !== null,
      role: u?.role,
      displayRole: u?.displayRole,
      additionalRoles: slice(u?.additionalRoles),
      isBanned: u?.isBanned === true,
      chapterId: u?.chapterId,
    },
    loadedAt: PARITY_FIXED_NOW,
  };
}

export function expectedPermissionEntryFor(perm: PermissionDocFixture): PermissionDocEntry {
  return perm.doc
    ? { exists: true, data: { ...perm.doc } }
    : { exists: false, data: undefined };
}
