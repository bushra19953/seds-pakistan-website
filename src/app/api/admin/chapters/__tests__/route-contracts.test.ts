/**
 * @jest-environment node
 *
 * Route-level parity contracts for the admin chapters routes that the
 * APPS-3 slice suites (lifecycle, consent-gate-founder, supa-mirror)
 * leave UNPINNED:
 *  1. POST flag ON: the seam existence read answering "no row" does NOT
 *     suppress the Firestore duplicate check — a Firestore-only slug
 *     still returns 409 and nothing is written or mirrored
 *     (supa-mirror pins the Supa-side 409 and the read-error fallback,
 *     not this dual-source case).
 *  2. PATCH flag ON + seam current-read error: lifecycle classification
 *     falls back to the Firestore current doc (supa-mirror pins the
 *     seam-served classification and flag OFF, not the error fallback).
 *
 * Uses the REAL chapters seam with its test adapter injection, so the
 * flag parsing and the seam's never-throw mirror are exercised, not
 * mocked away. On the base tree the seam module does not exist; these
 * contracts skip with that reason and activate on the merged tree.
 */

import * as fs from 'fs';
import * as path from 'path';

const SEAM_WIRED =
  fs.existsSync(path.join(process.cwd(), 'src/lib/chapters-supa.ts')) &&
  fs
    .readFileSync(
      path.join(process.cwd(), 'src/app/api/admin/chapters/route.ts'),
      'utf8',
    )
    .includes('chapters-supa');

const seam: any = SEAM_WIRED ? require('@/lib/chapters-supa') : null;
const testFlag = SEAM_WIRED ? test : test.skip;

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn().mockResolvedValue({ mode: 'hard', outcome: 'consented' }),
  consentGateHttpError: () => ({ status: 500, body: { error: 'CONSENT_CHECK_UNAVAILABLE' } }),
}));
jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn().mockResolvedValue('audit-1'),
}));
jest.mock('@/lib/auth-middleware', () => ({ verifyAuthentication: jest.fn() }));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ _methodName: 'serverTimestamp' }) },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/chapters/route';
import { PATCH } from '@/app/api/admin/chapters/[id]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';

const mockAuth = verifyAuthentication as jest.Mock;
const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

function makeDb(opts: { exists: boolean; data?: Record<string, unknown> }) {
  const sets: any[] = [];
  const updates: any[] = [];
  return {
    __sets: sets,
    __updates: updates,
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({ exists: opts.exists, id, data: () => opts.data ?? {} }),
        set: async (d: any) => {
          sets.push(d);
        },
        update: async (d: any) => {
          updates.push(d);
        },
      }),
    }),
  };
}

function makeAdapter(faults: { throwOnGet?: boolean } = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const adapter = {
    async getDoc(_collection: string, id: string) {
      calls.push({ method: 'getDoc', args: [_collection, id] });
      if (faults.throwOnGet) throw new Error('fake adapter get failure');
      return null; // fs_chapters holds no row for the slug
    },
    async listDocs() {
      return [];
    },
    async countDocs() {
      return 0;
    },
    async setDoc(collection: string, id: string, data: any) {
      calls.push({ method: 'setDoc', args: [collection, id, data] });
      return { id, ...data };
    },
    async updateDoc(collection: string, id: string, updates: any) {
      calls.push({ method: 'updateDoc', args: [collection, id, updates] });
      return { id, ...updates };
    },
    async deleteDoc() {
      return undefined;
    },
  };
  return { adapter, calls };
}

function postReq() {
  return new NextRequest('http://localhost/api/admin/chapters', {
    method: 'POST',
    body: JSON.stringify({ name: 'SEDS Test', slug: 'seds-test' }),
  });
}
function patchReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/chapters/seds-test', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: 'seds-test' }) };

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  seam?.__resetChaptersSupaAdapterForTests();
  mockAuth.mockResolvedValue({
    authenticated: true,
    user: { userId: 'admin-1', role: 'executive_director' },
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  seam?.__resetChaptersSupaAdapterForTests();
  jest.restoreAllMocks();
});

describe('contracts: admin chapters unpinned flag behavior', () => {
  testFlag('POST flag ON + seam says free + Firestore has the slug: 409, no write, no mirror', async () => {
    process.env[ENV_KEY] = 'chapters';
    const { adapter, calls } = makeAdapter();
    seam.__setChaptersSupaAdapterForTests(adapter);
    const db = makeDb({ exists: true, data: { name: 'Existing', slug: 'seds-test' } });
    mockDbHolder.db = db;

    const res = await POST(postReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('A chapter with this slug already exists');
    expect(calls.some((c) => c.method === 'getDoc')).toBe(true);
    expect(db.__sets).toHaveLength(0);
    expect(calls.some((c) => c.method === 'setDoc')).toBe(false);
  });

  testFlag('PATCH flag ON + seam read error: classification falls back to the Firestore doc', async () => {
    process.env[ENV_KEY] = 'chapters';
    const { adapter } = makeAdapter({ throwOnGet: true });
    seam.__setChaptersSupaAdapterForTests(adapter);
    // Firestore current state: ACTIVE chapter. A suspend must classify.
    const db = makeDb({
      exists: true,
      data: { name: 'SEDS Test', slug: 'seds-test', status: 'active', isActive: true },
    });
    mockDbHolder.db = db;

    const res = await PATCH(patchReq({ status: 'suspended' }), params);
    expect(res.status).toBe(200);
    expect(db.__updates).toHaveLength(1);
    expect(db.__updates[0]).toMatchObject({ status: 'suspended', isActive: false });
  });
});
