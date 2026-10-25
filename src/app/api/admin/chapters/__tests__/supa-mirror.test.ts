/**
 * @jest-environment node
 *
 * Admin chapters routes — Supa seam tests (APPS-3). Everything is
 * mocked (auth, permission, consent gate, audit, Firestore, seam);
 * zero live reads.
 *  OFF: no seam read is consulted for a decision, no mirror fires.
 *  ON:  POST existence read hits the seam (409 from Supa alone) and a
 *       successful create/update fires the mirror after Firestore.
 *  ON + seam read error: Firestore path decides, request succeeds.
 */

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

const seamHolder: { adapter: any } = { adapter: null };
const seamGet = jest.fn();
const mirrorCreate = jest.fn().mockResolvedValue(undefined);
const mirrorUpdate = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/chapters-supa', () => ({
  resolveChaptersSupaAdapter: jest.fn(async () => seamHolder.adapter),
  getChapterViaSupa: (...args: any[]) => seamGet(...args),
  mirrorChapterCreate: (...args: any[]) => mirrorCreate(...args),
  mirrorChapterUpdate: (...args: any[]) => mirrorUpdate(...args),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/chapters/route';
import { PATCH } from '@/app/api/admin/chapters/[id]/route';
import { verifyAuthentication } from '@/lib/auth-middleware';

const mockAuth = verifyAuthentication as jest.Mock;

function makeDb(opts: { exists: boolean; data?: Record<string, unknown> }) {
  const sets: any[] = [];
  const updates: any[] = [];
  return {
    __sets: sets,
    __updates: updates,
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({ exists: opts.exists, id, data: () => opts.data ?? {} }),
        set: async (d: any) => { sets.push(d); },
        update: async (d: any) => { updates.push(d); },
      }),
    }),
  };
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
  jest.clearAllMocks();
  seamHolder.adapter = null;
  mockAuth.mockResolvedValue({ authenticated: true, user: { userId: 'admin-1', role: 'executive_director' } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('POST flag OFF: creates on Firestore only; seam read and mirror unused', async () => {
  const db = makeDb({ exists: false });
  mockDbHolder.db = db;
  const res = await POST(postReq());
  expect(res.status).toBe(200);
  expect(db.__sets).toHaveLength(1);
  expect(seamGet).not.toHaveBeenCalled();
  expect(mirrorCreate).not.toHaveBeenCalled();
});

it('POST flag ON: successful create mirrors the exact chapter payload', async () => {
  seamHolder.adapter = { marker: 1 };
  seamGet.mockResolvedValue(null);
  const db = makeDb({ exists: false });
  mockDbHolder.db = db;
  const res = await POST(postReq());
  expect(res.status).toBe(200);
  expect(seamGet).toHaveBeenCalledWith(seamHolder.adapter, 'seds-test');
  expect(mirrorCreate).toHaveBeenCalledWith('seds-test', expect.objectContaining({ name: 'SEDS Test', slug: 'seds-test', status: 'active', isActive: true }));
});

it('POST flag ON: a Supa-side existing row returns 409 before any Firestore write', async () => {
  seamHolder.adapter = { marker: 1 };
  seamGet.mockResolvedValue({ id: 'seds-test', name: 'Existing' });
  const db = makeDb({ exists: false });
  mockDbHolder.db = db;
  const res = await POST(postReq());
  expect(res.status).toBe(409);
  expect(db.__sets).toHaveLength(0);
  expect(mirrorCreate).not.toHaveBeenCalled();
});

it('POST flag ON + seam read error: falls back to Firestore and creates', async () => {
  seamHolder.adapter = { marker: 1 };
  seamGet.mockRejectedValue(new Error('supa down'));
  const db = makeDb({ exists: false });
  mockDbHolder.db = db;
  const res = await POST(postReq());
  expect(res.status).toBe(200);
  expect(db.__sets).toHaveLength(1);
});

it('PATCH flag ON: current state comes from the seam (suspended row blocks re-suspend classification) and update mirrors', async () => {
  seamHolder.adapter = { marker: 1 };
  // Firestore says active; Supa says already suspended -> a PATCH to
  // suspended must NOT classify as a fresh 'suspend' lifecycle action.
  seamGet.mockResolvedValue({ id: 'seds-test', name: 'SEDS Test', isActive: false, status: 'suspended' });
  const db = makeDb({ exists: true, data: { name: 'SEDS Test', isActive: true, status: 'active' } });
  mockDbHolder.db = db;
  const res = await PATCH(patchReq({ status: 'suspended' }), params);
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.lifecycleAction).toBeNull();
  expect(mirrorUpdate).toHaveBeenCalledWith('seds-test', expect.objectContaining({ status: 'suspended' }));
});

it('PATCH flag OFF: seam unused, Firestore classification preserved (suspend)', async () => {
  const db = makeDb({ exists: true, data: { name: 'SEDS Test', isActive: true, status: 'active' } });
  mockDbHolder.db = db;
  const res = await PATCH(patchReq({ status: 'suspended' }), params);
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.lifecycleAction).toBe('suspend');
  expect(seamGet).not.toHaveBeenCalled();
  expect(mirrorUpdate).not.toHaveBeenCalled();
});
