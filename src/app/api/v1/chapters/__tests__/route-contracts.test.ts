/**
 * @jest-environment node
 *
 * Route-level parity contract for GET /api/v1/chapters that the APPS-3
 * slice suite (supa-flag.test.ts) leaves UNPINNED:
 *  - Flag ON + the adapter returns an EMPTY list: the route answers
 *    200 { chapters: [] } from the seam and does NOT fall back to
 *    Firestore. Empty is an answer, not an error (supa-flag pins the
 *    populated ON list and the error fallback, not the empty case).
 *    This distinction is what makes a flag flip safe on a chapter-less
 *    environment and dangerous if inverted.
 *
 * Uses the REAL chapters seam with its test adapter injection. On the
 * base tree the seam module does not exist; the contract skips with
 * that reason and activates on the merged tree.
 */

import * as fs from 'fs';
import * as path from 'path';

const SEAM_WIRED =
  fs.existsSync(path.join(process.cwd(), 'src/lib/chapters-supa.ts')) &&
  fs
    .readFileSync(
      path.join(process.cwd(), 'src/app/api/v1/chapters/route.ts'),
      'utf8',
    )
    .includes('chapters-supa');

const seam: any = SEAM_WIRED ? require('@/lib/chapters-supa') : null;
const testFlag = SEAM_WIRED ? test : test.skip;

const mockDbHolder: { db: unknown; getCalls: number } = { db: null, getCalls: 0 };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  getAdminDiagnostics: () => ({}),
}));

import { GET } from '@/app/api/v1/chapters/route';

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

function firestoreDb() {
  return {
    collection: () => ({
      get: async () => {
        mockDbHolder.getCalls += 1;
        return {
          docs: [
            { id: 'seds-a', data: () => ({ name: 'Alpha', slug: 'seds-a', isActive: true }) },
          ],
        };
      },
    }),
  };
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  seam?.__resetChaptersSupaAdapterForTests();
  mockDbHolder.db = firestoreDb();
  mockDbHolder.getCalls = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  seam?.__resetChaptersSupaAdapterForTests();
  jest.restoreAllMocks();
});

describe('contracts: GET /api/v1/chapters unpinned flag behavior', () => {
  testFlag('flag ON + adapter returns an empty list: 200 { chapters: [] }, Firestore untouched', async () => {
    process.env[ENV_KEY] = 'chapters';
    seam.__setChaptersSupaAdapterForTests({
      async getDoc() {
        return null;
      },
      async listDocs() {
        return [];
      },
      async countDocs() {
        return 0;
      },
      async setDoc() {
        return null;
      },
      async updateDoc() {
        return null;
      },
      async deleteDoc() {
        return undefined;
      },
    });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chapters: [] });
    expect(mockDbHolder.getCalls).toBe(0);
  });
});
