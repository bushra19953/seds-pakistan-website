/**
 * @jest-environment node
 *
 * Read-bleed train 2 regression: a picker cold build must perform
 * ZERO Firestore reads. The users/roles rows come from the Supa seam
 * (live since G2) and the contact-email fill comes from the contacts
 * mirror (fs_users_private_contact, via the real
 * src/lib/server/user-contact doorway with an injected mirror
 * client). Firestore is POISONED here: every entry point counts the
 * touch and throws a real (non-capability) error, so any Firestore
 * leg in the build either fails the response or moves the counter.
 *
 * Pins:
 *  1. A chapter build serves rows whose emails come from the mirror,
 *     with the Firestore touch counter at exactly 0.
 *  2. A uid the mirror does not hold yet degrades to "no email" for
 *     that row only (its Firestore fallback is poisoned) — the build
 *     still succeeds and mirrored rows keep their emails.
 *  3. Email search (q=<mirror email>) matches, for an
 *     unmask-privileged caller who also RECEIVES the email.
 *
 * On the pre-mirror code this suite fails by construction: the
 * contact fill ran a Firestore getAll over every uid, which here
 * throws, leaving every row emailless.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';
const OTHER = 'seds-other-chapter';

const supaUserRows: Row[] = [
  { id: 'u-ayesha', data: { displayName: 'Ayesha Khan', role: 'member', chapterId: IST } },
  { id: 'u-bilal', data: { displayName: 'Bilal Ahmed', role: 'member', chapterId: IST } },
  { id: 'u-zara', data: { displayName: 'Zara Sheikh', role: 'member', chapterId: IST } },
  { id: 'u-omar', data: { displayName: 'Omar Farooq', role: 'member', chapterId: OTHER } },
];

const supaRoleRows: Row[] = [
  { id: 'u-zara', data: { role: 'chair_design', additionalRoles: [] } },
];

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

// ---------------------------------------------------------------------------
// Poisoned Firestore: any touch is counted and throws a real error.
// ---------------------------------------------------------------------------

const firestoreTouches = { count: 0 };
function poisoned(): any {
  firestoreTouches.count += 1;
  throw new Error('POISONED_FIRESTORE');
}
const poisonChain: any = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'get' || prop === 'getAll') return poisoned;
      return () => poisonChain;
    },
  },
);
const mockDb = {
  collection: () => poisonChain,
  getAll: poisoned,
  doc: poisoned,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'u-caller', role: 'chapter_president' },
  })),
}));

// Auth email fill stays empty: every email asserted below must have
// come from the contacts mirror, not from Auth.
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUsers: async () => ({ users: [], notFound: [] }),
  }),
}));

import {
  setUsersSupaAdapterForTests,
  resetUsersSupaAdapterForTests,
} from '@/lib/supa-seams/users-directory';
import {
  setContactsMirrorClientForTests,
  resetContactsMirrorClientForTests,
} from '@/lib/server/user-contact';
import { GET } from '@/app/api/users/picker/route';

// Mirror fixtures: the whole IST chapter is mirrored (the
// post-backfill steady state the zero-touch pin describes); omar is
// NOT mirrored (his fallback leg is the poisoned Firestore, so he
// must degrade to a null email while the build still succeeds).
const mirrorRows: Record<string, Record<string, any>> = {
  'u-ayesha': { email: 'ayesha@mirror.example' },
  'u-bilal': { email: 'bilal@mirror.example' },
  'u-zara': { email: 'zara@mirror.example' },
};
const mirrorCalls = { selects: 0 };
const mockMirrorClient = {
  from: (_table: string) => ({
    select: (_cols: string) => ({
      in: async (_col: string, vals: string[]) => {
        mirrorCalls.selects += 1;
        return {
          data: vals
            .filter((v) => v in mirrorRows)
            .map((v) => ({ id: v, data: mirrorRows[v] })),
          error: null,
        };
      },
    }),
    upsert: async () => ({ error: null }),
    delete: () => ({ eq: async () => ({ error: null }) }),
  }),
};

function req(qs = '') {
  return new NextRequest(`http://localhost/api/users/picker${qs}`);
}

beforeEach(() => {
  process.env.SUPA_SURFACES = 'users';
  setUsersSupaAdapterForTests(mockAdapter as any);
  setContactsMirrorClientForTests(mockMirrorClient as any);
  firestoreTouches.count = 0;
  mirrorCalls.selects = 0;
});

afterAll(() => {
  delete process.env.SUPA_SURFACES;
  resetUsersSupaAdapterForTests();
  resetContactsMirrorClientForTests();
});

describe('picker cold build with Firestore poisoned', () => {
  it('serves a chapter build with mirror emails and zero Firestore touches', async () => {
    const res = await GET(req(`?chapterId=${IST}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    const byUid = Object.fromEntries(body.users.map((u: any) => [u.uid, u]));
    expect(byUid['u-ayesha'].email).toBe('ayesha@mirror.example');
    expect(byUid['u-bilal'].email).toBe('bilal@mirror.example');
    expect(mirrorCalls.selects).toBeGreaterThan(0);
    expect(firestoreTouches.count).toBe(0);
  });

  it('an unmirrored uid degrades to a null email; mirrored rows are unaffected', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(200);
    const body = await res.json();
    const byUid = Object.fromEntries(body.users.map((u: any) => [u.uid, u]));
    expect(byUid['u-omar'].email ?? null).toBeNull();
    expect(byUid['u-ayesha'].email).toBe('ayesha@mirror.example');
    // Zara's role came from the roles seam overlay, not Firestore.
    expect(byUid['u-zara'].role).toBe('chair_design');
  });

  it('email search matches on a mirror email', async () => {
    const body = await (await GET(req('?q=bilal@mirror.example'))).json();
    expect(body.users.map((u: any) => u.uid)).toEqual(['u-bilal']);
    expect(body.users[0].email).toBe('bilal@mirror.example');
  });
});
