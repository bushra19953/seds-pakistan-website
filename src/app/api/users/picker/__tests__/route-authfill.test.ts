/**
 * @jest-environment node
 *
 * Auth email fill for GET /api/users/picker (root-cause fix,
 * 2026-10-27).
 *
 * Root cause: the row builders took a row's email ONLY from the
 * user profile doc's `email` field, but most live profile docs do
 * not carry that field at all (143 of 246 do; of 77 verified
 * members, 57 have no email in their doc). Their addresses exist
 * only in Firebase Auth, so email search — the founder's standing
 * lookup rule — found almost nobody while name search worked.
 *
 * The fix fills a MISSING row email from Firebase Auth (bulk
 * getUsers) inside both cached row builders. These tests pin:
 *
 *  1. A user whose doc lacks email but whose Auth record has one IS
 *     matched by q=<that email>, in the Firestore loader path AND
 *     in the Supa loader path.
 *  2. A non-privileged caller still receives NO email key for that
 *     same user, while still finding them by email (matching stays
 *     ungated; serialization stays gated — byte-identical payload).
 *  3. Precedence: a CONTACT-record email, when present, is NOT
 *     overridden by a differing Auth email. The contact record is
 *     the profile's stated address; Auth only fills gaps. The Auth
 *     address of such a user must NOT match q either.
 *  4. Auth lookup failure leaves the route working with contact
 *     emails only (200s, contact-email users still findable, gap
 *     users simply unmatched by email — never an error).
 *
 * Contact-gating update (2026-10-28): row emails no longer come
 * from the user doc at all (the fixtures below carry no doc email).
 * The first fill source is the gated contact record, served here
 * through the mocked doorway (mockContactEmails); Firebase Auth
 * remains the fallback fill, with the same precedence the doc
 * email used to have now held by the contact email.
 *
 * Auth is mocked at the codebase's existing admin seam
 * ('firebase-admin/auth' getAuth, the same seam the webhooks route
 * and verifySession use, mocked the same way as
 * webhooks/dispatch fresh-signup tests). Zero live reads.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

// ---------------------------------------------------------------------------
// Auth seam mock ('firebase-admin/auth')
// ---------------------------------------------------------------------------

const mockAuthState = {
  records: {} as Record<string, string>,
  fail: false,
  calls: [] as number[],
  requested: [] as string[],
};

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUsers: async (identifiers: Array<{ uid: string }>) => {
      mockAuthState.calls.push(identifiers.length);
      mockAuthState.requested.push(...identifiers.map((i) => i.uid));
      if (mockAuthState.fail) throw new Error('mock auth unavailable');
      return {
        users: identifiers
          .filter((i) => mockAuthState.records[i.uid])
          .map((i) => ({ uid: i.uid, email: mockAuthState.records[i.uid] })),
        notFound: [] as any[],
      };
    },
  }),
}));

// ---------------------------------------------------------------------------
// Caller auth + Firestore mock
// ---------------------------------------------------------------------------

const state = {
  authResult: { authenticated: false } as any,
};

const FS_CH = 'authfill-fs';
const FAIL_CH = 'authfill-fail';

// Gated contact records for the fixtures (mocked doorway below).
// The user docs themselves carry NO email field at all.
const mockContactEmails: Record<string, string> = {
  'u-doc': 'doc.person@sedsmail.example',
  'u-plain': 'plain@sedsmail.example',
  'u-fdoc': 'fail.doc@sedsmail.example',
  'u-sdoc': 'supa.doc@sedsmail.example',
};

jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    getUserContacts: async (_db: any, uids: string[]) => {
      const map = new Map<string, any>();
      for (const uid of uids) {
        const email = mockContactEmails[uid];
        if (email) map.set(uid, { email, email_lowercase: email.toLowerCase() });
      }
      return map;
    },
  };
});

const userRows: Row[] = [
  // No contact email; Auth has one. The root-cause case.
  { id: 'u-gap', data: { displayName: 'Gap Person', role: 'member', chapterId: FS_CH } },
  // Contact email present AND differs from the Auth email. Precedence case.
  { id: 'u-doc', data: { displayName: 'Doc Person', role: 'member', chapterId: FS_CH } },
  // Control: same email in the contact record and Auth.
  { id: 'u-plain', data: { displayName: 'Plain Person', role: 'member', chapterId: FS_CH } },
  // Failure-chapter pair (separate chapter so its rows build under
  // the failing-Auth flag without touching the cached FS build).
  { id: 'u-fgap', data: { displayName: 'Fail Gap', role: 'member', chapterId: FAIL_CH } },
  { id: 'u-fdoc', data: { displayName: 'Fail Doc', role: 'member', chapterId: FAIL_CH } },
];

const roleRows: Row[] = [];

function makeUsersChain(filters: Array<[string, any]> = []): any {
  const chain: any = {
    where: (f: string, _op: string, v: any) => makeUsersChain([...filters, [f, v]]),
    get: async () => {
      const matched = userRows.filter((r) => filters.every(([f, v]) => r.data[f] === v));
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })),
        size: matched.length,
        empty: matched.length === 0,
      };
    },
  };
  return chain;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') return makeUsersChain();
    if (name === 'roles') {
      return {
        where: (_f: string, _op: string, values: string[]) => ({
          get: async () => {
            const matched = roleRows.filter((r) => values.includes(r.id));
            return {
              docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })),
              size: matched.length,
              empty: matched.length === 0,
            };
          },
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

// ---------------------------------------------------------------------------
// Supa adapter mock (same shape as route-supa-flagon)
// ---------------------------------------------------------------------------

const SUPA_CH = 'authfill-supa';

const supaUserRows: Row[] = [
  { id: 'u-sgap', data: { displayName: 'Supa Gap', role: 'member', chapterId: SUPA_CH } },
  { id: 'u-sdoc', data: { displayName: 'Supa Doc', role: 'member', chapterId: SUPA_CH } },
];

const supaRoleRows: Row[] = [];

function applyWhere(rows: Row[], where: any[] | undefined): Row[] {
  if (!where) return rows;
  return rows.filter((r) =>
    where.every(([field, op, value]: any[]) => {
      if ((field === '__name__' || field === 'id') && op === 'in') return (value as string[]).includes(r.id);
      if (op === '==') return r.data[field] === value;
      return true;
    }),
  );
}

const mockAdapter = {
  getDoc: async () => null,
  listDocs: async (collection: string, options: any) => {
    const rows = collection === 'users' ? supaUserRows : supaRoleRows;
    const matched = applyWhere(rows, options?.where);
    const limited = options?.limit !== undefined ? matched.slice(0, options.limit) : matched;
    return limited.map((r) => ({ id: r.id, ...r.data }));
  },
  countDocs: async () => 0,
  setDoc: async () => ({}),
  updateDoc: async () => ({}),
  deleteDoc: async () => undefined,
};

import {
  setUsersSupaAdapterForTests,
  resetUsersSupaAdapterForTests,
} from '@/lib/supa-seams/users-directory';

import { GET } from '@/app/api/users/picker/route';

function req(qs = '') {
  return new NextRequest(`http://localhost/api/users/picker${qs}`);
}

function asCaller(role: string) {
  state.authResult = { authenticated: true, user: { userId: 'u-caller', role } };
}

beforeEach(() => {
  asCaller('member');
  mockAuthState.fail = false;
  mockAuthState.records = {
    'u-gap': 'gap.person@sedsmail.example',
    'u-doc': 'auth.person@sedsmail.example',
    'u-plain': 'plain@sedsmail.example',
    'u-fgap': 'fail.gap@sedsmail.example',
    'u-fdoc': 'fail.doc@sedsmail.example',
    'u-sgap': 'supa.gap@sedsmail.example',
    'u-sdoc': 'supa.doc@sedsmail.example',
  };
});

afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetUsersSupaAdapterForTests();
});

describe('Firestore loader: Auth fills contact-email gaps', () => {
  it('1a. privileged caller finds the gap user by their Auth email and sees it', async () => {
    asCaller('chapter_president');
    const body = await (await GET(req(`?chapterId=${FS_CH}&q=gap.person@sedsmail.example`))).json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].uid).toBe('u-gap');
    expect(body.users[0].email).toBe('gap.person@sedsmail.example');
  });

  it('1b. only gap users are requested from Auth, in chunks of at most 100', async () => {
    // The FS build happened in 1a; the cache means no new Auth call
    // here, so assert over the calls recorded so far.
    expect(mockAuthState.calls.length).toBeGreaterThan(0);
    for (const n of mockAuthState.calls) expect(n).toBeLessThanOrEqual(100);
    expect(mockAuthState.requested).toContain('u-gap');
    // Contact-email users are never gap-fill candidates.
    expect(mockAuthState.requested).not.toContain('u-doc');
    expect(mockAuthState.requested).not.toContain('u-plain');
  });

  it('2. non-privileged caller finds the gap user by Auth email but receives NO email key', async () => {
    asCaller('member');
    const body = await (await GET(req(`?chapterId=${FS_CH}&q=gap.person@sedsmail.example`))).json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].uid).toBe('u-gap');
    expect(body.users[0]).not.toHaveProperty('email');
    expect(Object.keys(body.users[0]).sort()).toEqual(
      ['additionalRoles', 'chapterId', 'displayName', 'isOnVacation', 'photoURL', 'role', 'uid'].sort(),
    );
  });

  it('3. contact email wins over a differing Auth email, for value and for matching', async () => {
    asCaller('chapter_president');
    const byDoc = await (await GET(req(`?chapterId=${FS_CH}&q=doc.person@sedsmail.example`))).json();
    expect(byDoc.users).toHaveLength(1);
    expect(byDoc.users[0].uid).toBe('u-doc');
    expect(byDoc.users[0].email).toBe('doc.person@sedsmail.example');

    const byAuth = await (await GET(req(`?chapterId=${FS_CH}&q=auth.person@sedsmail.example`))).json();
    expect(byAuth.users).toHaveLength(0);
  });
});

describe('Auth lookup failure degrades to contact emails only', () => {
  beforeEach(() => {
    mockAuthState.fail = true;
  });

  it('4. route still answers 200; contact-email user findable; gap user listed but unmatched by email', async () => {
    asCaller('chapter_president');
    const byDocRes = await GET(req(`?chapterId=${FAIL_CH}&q=fail.doc@sedsmail.example`));
    expect(byDocRes.status).toBe(200);
    const byDoc = await byDocRes.json();
    expect(byDoc.users.map((u: any) => u.uid)).toEqual(['u-fdoc']);

    const byGap = await (await GET(req(`?chapterId=${FAIL_CH}&q=fail.gap@sedsmail.example`))).json();
    expect(byGap.users).toHaveLength(0);

    const all = await (await GET(req(`?chapterId=${FAIL_CH}`))).json();
    expect(all.users.map((u: any) => u.uid).sort()).toEqual(['u-fdoc', 'u-fgap']);
    const fgap = all.users.find((u: any) => u.uid === 'u-fgap');
    expect(fgap.email).toBeNull();
  });
});

describe('Supa loader: Auth fills contact-email gaps', () => {
  beforeEach(() => {
    process.env.SUPA_SURFACES = 'users';
    setUsersSupaAdapterForTests(mockAdapter as any);
  });

  afterEach(() => {
    resetUsersSupaAdapterForTests();
    delete process.env.SUPA_SURFACES;
  });

  it('1c. privileged caller finds the Supa gap user by their Auth email and sees it', async () => {
    asCaller('chapter_president');
    const body = await (await GET(req(`?chapterId=${SUPA_CH}&q=supa.gap@sedsmail.example`))).json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].uid).toBe('u-sgap');
    expect(body.users[0].email).toBe('supa.gap@sedsmail.example');
  });

  it('2b. non-privileged caller finds the Supa gap user by Auth email but receives NO email key', async () => {
    asCaller('member');
    const body = await (await GET(req(`?chapterId=${SUPA_CH}&q=supa.gap@sedsmail.example`))).json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].uid).toBe('u-sgap');
    expect(body.users[0]).not.toHaveProperty('email');
  });
});
