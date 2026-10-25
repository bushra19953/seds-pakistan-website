/**
 * @jest-environment node
 *
 * GET /api/v1/chapters — Supa flag-state tests (APPS-3). Seam and
 * Firestore are mocked; zero live reads.
 *  OFF: Firestore only, seam never consulted for data.
 *  ON:  served from the seam with the byte-identical response shape.
 *  ON + seam error: falls back to Firestore.
 */

const seamHolder: { adapter: any } = { adapter: null };
const seamList = jest.fn();

jest.mock('@/lib/chapters-supa', () => ({
  resolveChaptersSupaAdapter: jest.fn(async () => seamHolder.adapter),
  listChaptersViaSupa: (...args: any[]) => seamList(...args),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  getAdminDiagnostics: () => ({}),
}));

import { GET } from '@/app/api/v1/chapters/route';

function firestoreDb(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    collection: () => ({
      get: async () => ({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) }),
    }),
  };
}

const FS_DOCS = [
  { id: 'seds-b', data: { name: 'Beta', slug: 'seds-b', city: 'Lahore', country: 'PK', logoUrl: null, isActive: true } },
  { id: 'seds-a', data: { name: 'Alpha', slug: 'seds-a' } },
];
const EXPECTED = {
  chapters: [
    { id: 'seds-a', name: 'Alpha', slug: 'seds-a', city: null, country: null, logoUrl: null, isActive: true },
    { id: 'seds-b', name: 'Beta', slug: 'seds-b', city: 'Lahore', country: 'PK', logoUrl: null, isActive: true },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  seamHolder.adapter = null;
  mockDbHolder.db = firestoreDb(FS_DOCS);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('flag OFF (adapter null): Firestore path, identical shape, seam list unused', async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(EXPECTED);
  expect(seamList).not.toHaveBeenCalled();
});

it('flag ON: served from the seam with the identical shape (sorted by name)', async () => {
  seamHolder.adapter = { marker: 'adapter' };
  seamList.mockResolvedValue(FS_DOCS.map((d) => ({ id: d.id, ...d.data })));
  mockDbHolder.db = firestoreDb([]); // would return empty if consulted
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(EXPECTED);
  expect(seamList).toHaveBeenCalledWith(seamHolder.adapter);
});

it('flag ON + seam error: falls back to Firestore', async () => {
  seamHolder.adapter = { marker: 'adapter' };
  seamList.mockRejectedValue(new Error('supa down'));
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(EXPECTED);
});
