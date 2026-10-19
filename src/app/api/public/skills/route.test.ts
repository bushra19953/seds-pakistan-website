/**
 * @jest-environment node
 */
import {
  legacySkillSeeds,
  ensureSkillsSeeded,
  __resetSkillsSeedGuard,
  GET,
} from './route';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

jest.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: any, init?: any) => ({ __body: body, __init: init }),
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(),
  getDb: jest.fn(),
}));

const adminInitMock = ensureAdminInitialized as jest.Mock;
const getDbMock = getDb as jest.Mock;

interface SetCall {
  docId: string;
  data: any;
}

function makeDb(opts: { emptyProbe: boolean; existingItems?: any[]; failOnSet?: boolean }) {
  const sets: SetCall[] = [];
  const probes: number[] = [];
  const collectionCalls: string[] = [];
  const db = {
    collection: jest.fn((name: string) => {
      collectionCalls.push(name);
      return {
        limit: jest.fn(() => ({
          get: jest.fn(async () => {
            probes.push(1);
            return { empty: opts.emptyProbe, docs: [] };
          }),
        })),
        get: jest.fn(async () => ({
          docs: (opts.existingItems || []).map((it) => ({
            id: it.id,
            data: () => it,
          })),
        })),
        doc: jest.fn((docId: string) => ({
          set: jest.fn(async (data: any) => {
            if (opts.failOnSet) throw new Error('firestore down');
            sets.push({ docId, data });
          }),
        })),
      };
    }),
  };
  return { db, sets, probes, collectionCalls };
}

function makeRequest(params = '') {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as any;
}

beforeEach(() => {
  __resetSkillsSeedGuard();
  adminInitMock.mockReset().mockReturnValue(true);
  getDbMock.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.log as jest.Mock).mockRestore();
  (console.error as jest.Mock).mockRestore();
});

describe('legacySkillSeeds', () => {
  it('returns exactly 18 skills with unique slugs, all active', () => {
    const seeds = legacySkillSeeds();
    expect(seeds).toHaveLength(18);
    const slugs = seeds.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(18);
    for (const s of seeds) {
      expect(s.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(s.status).toBe('active');
      expect(s.category).toBeTruthy();
    }
  });

  it('slugifies names with parentheses correctly', () => {
    const seeds = legacySkillSeeds();
    const cfd = seeds.find((s) => s.name === 'Computational Fluid Dynamics (CFD)');
    expect(cfd?.slug).toBe('computational-fluid-dynamics-cfd');
  });
});

describe('ensureSkillsSeeded', () => {
  it('seeds all 18 skills when the collection is empty', async () => {
    const { db, sets } = makeDb({ emptyProbe: true });
    const result = await ensureSkillsSeeded(db);
    expect(result).toEqual({ seeded: true, created: 18 });
    expect(sets).toHaveLength(18);
    const docIds = sets.map((s) => s.docId).sort();
    const expectedSlugs = legacySkillSeeds().map((s) => s.slug).sort();
    expect(docIds).toEqual(expectedSlugs);
    expect(sets[0].data).toEqual(
      expect.objectContaining({ name: expect.any(String), slug: sets[0].docId, status: 'active' })
    );
  });

  it('does not seed when the collection already has documents', async () => {
    const { db, sets, probes } = makeDb({ emptyProbe: false });
    const result = await ensureSkillsSeeded(db);
    expect(result).toEqual({ seeded: false, created: 0 });
    expect(sets).toHaveLength(0);
    expect(probes).toHaveLength(1);
  });

  it('probes at most once per instance: the second call skips the probe entirely', async () => {
    const { db, probes } = makeDb({ emptyProbe: true });
    await ensureSkillsSeeded(db);
    const result = await ensureSkillsSeeded(db);
    expect(result).toEqual({ seeded: false, created: 0 });
    expect(probes).toHaveLength(1);
  });

  it('retries on a later request when the seed fails, and never throws', async () => {
    const { db, sets } = makeDb({ emptyProbe: true, failOnSet: true });
    const first = await ensureSkillsSeeded(db);
    expect(first).toEqual({ seeded: false, created: 0 });
    expect(sets).toHaveLength(0);
    const second = await ensureSkillsSeeded(db);
    expect(second).toEqual({ seeded: false, created: 0 });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('auto-seeds before reading when the collection is empty', async () => {
    const { db, sets } = makeDb({ emptyProbe: true, existingItems: [] });
    getDbMock.mockReturnValue(db);
    const res: any = await GET(makeRequest());
    expect(sets).toHaveLength(18);
    expect(res.__body.items).toEqual([]);
    expect(res.__init).toBeUndefined();
  });

  it('does not seed when the collection already has documents', async () => {
    const existingItems = [
      { id: 'programming', name: 'Programming', slug: 'programming', status: 'active' },
      { id: 'soldering', name: 'Soldering', slug: 'soldering', status: 'active' },
    ];
    const { db, sets } = makeDb({ emptyProbe: false, existingItems });
    getDbMock.mockReturnValue(db);
    const res: any = await GET(makeRequest('status=active'));
    expect(sets).toHaveLength(0);
    expect(res.__body.items).toHaveLength(2);
  });

  it('still returns items when the seed fails mid-request', async () => {
    const existingItems = [{ id: 'programming', name: 'Programming', slug: 'programming', status: 'active' }];
    const { db, sets } = makeDb({ emptyProbe: true, existingItems, failOnSet: true });
    getDbMock.mockReturnValue(db);
    const res: any = await GET(makeRequest());
    expect(sets).toHaveLength(0);
    expect(res.__body.items).toHaveLength(1);
    expect(res.__body.error).toBeUndefined();
  });

  it('returns 500 when Firebase Admin is not initialized', async () => {
    adminInitMock.mockReturnValue(false);
    const res: any = await GET(makeRequest());
    expect(res.__init).toEqual({ status: 500 });
    expect(res.__body.error).toBeTruthy();
  });
});
