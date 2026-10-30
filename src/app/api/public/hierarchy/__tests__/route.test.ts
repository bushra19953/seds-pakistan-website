/**
 * @jest-environment node
 *
 * GET /api/public/hierarchy — the public org-chart feed behind
 * /hierarchy (founder order 2026-10-30).
 *
 * Proven here, against a mocked Admin SDK (zero live reads), with
 * the Supabase seam forced off so the Firestore fallback serves:
 *  - the feed publishes ONLY the whitelisted projection (name, role
 *    title, chapter, avatar, profile path) even when the source user
 *    docs carry email, phone and WhatsApp fields — the full response
 *    body is scanned for email/phone-shaped strings;
 *  - grouping matches the page contract: National first, chapters
 *    IST-first, custom deputy roles titled from the registry;
 *  - a failed read is a loud 500 with no cache header and no fake
 *    empty sections — never a silently empty org chart.
 */
import { GET } from '../route';

// ─── In-memory fake of the Admin SDK surface the route uses ──────────
interface FakeState {
  users: Map<string, Record<string, any>>;
  roleDefinitions: Map<string, Record<string, any>>;
  chapters: Map<string, Record<string, any>>;
  roles: Map<string, Record<string, any>>;
  failReads: boolean;
}

const mockState: FakeState = {
  users: new Map(),
  roleDefinitions: new Map(),
  chapters: new Map(),
  roles: new Map(),
  failReads: false,
};

function fakeDb() {
  const collections: Record<string, Map<string, Record<string, any>>> = {
    users: mockState.users,
    roleDefinitions: mockState.roleDefinitions,
    chapters: mockState.chapters,
    roles: mockState.roles,
  };
  return {
    collection(name: string) {
      return {
        async get() {
          if (mockState.failReads) throw new Error('firestore unavailable');
          const map = collections[name] ?? new Map();
          return {
            docs: [...map.entries()].map(([id, data]) => ({
              id,
              data: () => data,
            })),
          };
        },
      };
    },
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => fakeDb(),
}));

// Force the Firestore path: seam flag off, no adapter.
jest.mock('@/lib/supa', () => ({
  useSupa: () => false,
}));

jest.mock('@/lib/supa-seams/users-directory', () => ({
  getUsersSupaAdapter: () => null,
  supaListAllUsers: jest.fn(async () => []),
}));

const IST = 'seds-ist-chapter';
const DEPUTY_SLUG = 'custom_chapter_vp_deputy_technical_systems';

function seed() {
  mockState.users.clear();
  mockState.roleDefinitions.clear();
  mockState.chapters.clear();
  mockState.roles.clear();
  mockState.failReads = false;

  mockState.chapters.set(IST, { name: 'IST Chapter' });
  mockState.chapters.set('seds-lums-chapter', { name: 'LUMS Chapter' });

  mockState.roleDefinitions.set(DEPUTY_SLUG, {
    isCustom: true,
    slug: DEPUTY_SLUG,
    name: 'Chapter VP Deputy - Technical Systems',
    parentRoleKey: 'chapter_vice_president',
    chapterId: IST,
    permissions: [],
    isActive: true,
  });

  mockState.users.set('u-prez', {
    displayName: 'Chapter Prez',
    role: 'chapter_president',
    displayRole: 'chapter_president',
    chapterId: IST,
    photoURL: 'https://example.com/prez.png',
    // Contact data on the source doc: must never reach the payload.
    email: 'prez.private@example.com',
    phoneNumber: '+92 321 5551234',
    whatsapp: '03215551234',
  });
  mockState.users.set('u-deputy', {
    displayName: 'The Deputy',
    role: DEPUTY_SLUG,
    displayRole: DEPUTY_SLUG,
    // chapter-blank holder: placed by the definition's chapter
    email: 'deputy.private@example.com',
  });
  mockState.users.set('u-nat', {
    displayName: 'Nat Prez',
    role: 'president_national',
    displayRole: 'president_national',
  });
  mockState.users.set('u-member', {
    displayName: 'Plain Member',
    role: 'member_basic',
    displayRole: 'member_basic',
    chapterId: IST,
    email: 'member.private@example.com',
  });
}

describe('GET /api/public/hierarchy', () => {
  beforeEach(seed);

  it('serves the grouped, whitelisted payload with the registry cache header', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=120, stale-while-revalidate=60'
    );

    const body = await res.json();
    expect(body.sections.map((s: any) => s.id)).toEqual(['national', IST]);

    const national = body.sections[0];
    expect(national.members).toHaveLength(1);
    expect(national.members[0]).toEqual({
      id: 'u-nat',
      name: 'Nat Prez',
      roleTitle: 'National President',
      photoURL: null,
      profilePath: '/profile/unified/u-nat',
      isCustomRole: false,
    });

    const ist = body.sections[1];
    expect(ist.name).toBe('IST Chapter');
    expect(ist.members.map((m: any) => m.id)).toEqual(['u-prez', 'u-deputy']);
    expect(ist.members[0].roleTitle).toBe('Chapter President');
    expect(ist.members[1].roleTitle).toBe('Chapter VP Deputy - Technical Systems');
    expect(ist.members[1].isCustomRole).toBe(true);

    // The plain member is not a role-holder and never appears.
    const allIds = body.sections.flatMap((s: any) => s.members.map((m: any) => m.id));
    expect(allIds).not.toContain('u-member');
  });

  it('never lets contact data reach the response body', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no email-shaped string
    expect(text).not.toMatch(/\+?\d[\d\s-]{7,}\d/); // no phone-shaped string
    expect(text).not.toContain('private@example');
    expect(text).not.toContain('whatsapp');
    expect(text).not.toContain('phoneNumber');
    expect(text).not.toContain('email');
  });

  it('merges AUTHORITY-dialog grants from roles/{uid}.additionalRoles into the feed', async () => {
    // The production case (2026-10-30): the appointee's user doc
    // keeps the member floor; the deputy grant lives ONLY as a
    // custom slug in additionalRoles on the roles doc.
    mockState.users.set('u-grantee', {
      displayName: 'The Grantee',
      role: 'member_basic',
      displayRole: 'member_basic',
      chapterId: IST,
      email: 'grantee.private@example.com',
    });
    mockState.roles.set('u-grantee', {
      role: 'member_basic',
      additionalRoles: [DEPUTY_SLUG],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const ist = body.sections.find((s: any) => s.id === IST);
    const grantee = ist?.members.find((m: any) => m.id === 'u-grantee');
    expect(grantee).toEqual({
      id: 'u-grantee',
      name: 'The Grantee',
      roleTitle: 'Chapter VP Deputy - Technical Systems',
      photoURL: null,
      profilePath: '/profile/unified/u-grantee',
      isCustomRole: true,
    });

    // The grant merge does not widen the payload: still contact-free.
    const text = JSON.stringify(body);
    expect(text).not.toContain('grantee.private@example.com');
    expect(text).not.toContain('additionalRoles');
  });

  it('fails loud (500, uncached, no sections) when the read throws', async () => {
    mockState.failReads = true;
    const res = await GET();
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBeNull();
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.sections).toBeUndefined();
  });
});
