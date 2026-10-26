/**
 * @jest-environment node
 *
 * HOTFIX (fix/supa-read-fallback): GET /api/announcements/visible must
 * serve the Firestore read when the Supabase selection comes back
 * EMPTY (the live failure: the adapter's data-field where clause
 * silently matches nothing in PostgREST, so the route returned a 200
 * with an empty list while Firestore holds published announcements).
 *
 *  - Supa empty   -> Firestore rows served (FAILS on the unmodified
 *                    tree: the route returns the empty Supa list).
 *  - Supa rows    -> served as-is, Firestore never consulted (guard).
 */

jest.mock('firebase/firestore', () => {
  class FakeTimestamp {
    private ms: number;
    constructor(ms: number) {
      this.ms = ms;
    }
    static fromMillis(ms: number) {
      return new FakeTimestamp(ms);
    }
    static fromDate(d: Date) {
      return new FakeTimestamp(d.getTime());
    }
    static now() {
      return new FakeTimestamp(Date.now());
    }
    toDate() {
      return new Date(this.ms);
    }
    toMillis() {
      return this.ms;
    }
    get seconds() {
      return Math.floor(this.ms / 1000);
    }
    get nanoseconds() {
      return (this.ms % 1000) * 1e6;
    }
  }
  return {
    Timestamp: FakeTimestamp,
    collection: jest.fn((_db: any, name: string) => ({
      _name: name,
      withConverter: (converter: any) => ({ _name: name, converter }),
    })),
    query: jest.fn((ref: any, ...constraints: any[]) => ({ ref, constraints })),
    where: jest.fn((field: string, op: string, value: any) => ({ field, op, value })),
    orderBy: jest.fn((field: string, dir: string) => ({ field, dir })),
    limit: jest.fn((n: number) => ({ n })),
    getDocs: jest.fn(async () => ({ docs: [] })),
  };
});

jest.mock('@/lib/roles', () => {
  const actual = jest.requireActual('@/lib/roles');
  return { ...actual, isSuperAdmin: () => false };
});

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { NextRequest } from 'next/server';
import { __setSupaAdapterForTests } from '@/lib/announcements-supa';
import type { SupaAdapter, SupaDoc } from '@/lib/supa/adapter';
import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET } from '../route';

const DAY_S = 24 * 3600;
const nowS = Math.floor(Date.now() / 1000);

function seedFirestore() {
  const db = createFakeDb();
  db.seed('announcements', 'fs-ann-1', {
    title: 'Firestore Public Announcement',
    content: 'served from Firestore',
    audience: 'public',
    status: 'published',
    isFeatured: false,
    priority: 0,
    ctaText: '',
    ctaLink: '',
    ctaExpiredText: '',
    expiresAt: null,
    publish_date: { _seconds: nowS - DAY_S, _nanoseconds: 0 },
    updated_at: { _seconds: nowS - 3600, _nanoseconds: 0 },
  });
  db.seed('announcements', 'fs-ann-draft', {
    title: 'Firestore Draft',
    content: 'never public',
    audience: 'public',
    status: 'draft',
    isFeatured: false,
    priority: 0,
    expiresAt: null,
    publish_date: { _seconds: nowS - DAY_S, _nanoseconds: 0 },
    updated_at: { _seconds: nowS - 3500, _nanoseconds: 0 },
  });
  return db;
}

function makeAdapter(docs: SupaDoc[]): SupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => docs),
    countDocs: jest.fn(async () => docs.length),
    setDoc: jest.fn(async () => ({}) as SupaDoc),
    updateDoc: jest.fn(async () => ({}) as SupaDoc),
    deleteDoc: jest.fn(async () => undefined),
  };
}

function req() {
  return new NextRequest('http://localhost/api/announcements/visible');
}

beforeEach(() => {
  process.env.SUPA_SURFACES = 'announcements';
  mockDbHolder.db = seedFirestore();
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  __setSupaAdapterForTests(undefined);
  mockDbHolder.db = null;
});

describe('GET /api/announcements/visible — Firestore fallback (hotfix)', () => {
  it('Supa selection empty: Firestore rows are served instead of an empty 200', async () => {
    __setSupaAdapterForTests(makeAdapter([]));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audienceValues).toEqual(['public', 'all']);
    const ids = body.announcements.map((d: any) => d.id);
    expect(ids).toEqual(['fs-ann-1']);
    expect(body.announcements[0].title).toBe('Firestore Public Announcement');
  });

  it('Supa rows present: served as-is, Firestore rows never leak in (guard)', async () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    __setSupaAdapterForTests(
      makeAdapter([
        {
          id: 'supa-ann-1',
          title: 'Supa Announcement',
          content: 'served from Supabase',
          audience: 'public',
          status: 'published',
          isFeatured: false,
          priority: 1,
          ctaText: '',
          ctaLink: '',
          ctaExpiredText: '',
          expiresAt: null,
          publish_date: iso(Date.now() - DAY_S * 1000),
          updated_at: iso(Date.now() - 60_000),
        } as SupaDoc,
      ]),
    );
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.announcements.map((d: any) => d.id);
    expect(ids).toEqual(['supa-ann-1']);
  });
});
