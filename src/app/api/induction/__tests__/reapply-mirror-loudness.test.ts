/**
 * @jest-environment node
 *
 * P1 MIRROR LOUDNESS — POST /api/induction/reapply.
 * The route mirrors the hasApplied flag clear into fs_users via the
 * REAL applications seam (mirrorInductionFlagClear), with a fake
 * adapter injected through __setApplicationsSupaAdapterForTests.
 * Before the fix a failed mirror was silent: the route answered
 * 200 while fs_users still held hasApplied=true, so the submit
 * gate (which reads the flag from fs_users) wrongly 409'd the next
 * submit. Pins:
 *  - adapter setDoc throws (mirror reports failure) -> 500
 *    { error: 'Re-apply failed' } — the same body/status the route
 *    uses for a failed Firestore flag clear. The Firestore clear
 *    itself already committed (the operation is idempotent; a
 *    retry is safe).
 *  - healthy adapter -> 200 { ok: true }, fs_users flag cleared.
 */
const userUpdates: Array<{ id: string; data: any }> = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: name === 'users',
          data: () => ({ applicationStatus: 'rejected', hasApplied: true }),
        }),
        update: async (data: any) => {
          if (name === 'users') userUpdates.push({ id, data });
        },
      }),
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'user-1' } }),
}));

import { POST } from '../reapply/route';
import { NextRequest } from 'next/server';
import {
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  type ApplicationsSupaAdapter,
} from '@/lib/applications-supa';

let failSet = false;
const fsUsers = new Map<string, Record<string, any>>();

function makeAdapter(): ApplicationsSupaAdapter {
  return {
    async getDoc(collection, id) {
      if (collection !== 'users') return null;
      const data = fsUsers.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs() {
      return [];
    },
    async countDocs() {
      return 0;
    },
    async setDoc(collection, id, data) {
      if (failSet) throw new Error('fake adapter setDoc failure');
      if (collection === 'users') fsUsers.set(id, { ...data });
      return { id, ...data };
    },
    async updateDoc(collection, id, updates) {
      const next = { ...(fsUsers.get(id) ?? {}), ...updates };
      if (collection === 'users') fsUsers.set(id, next);
      return { id, ...next };
    },
    async deleteDoc(collection, id) {
      if (collection === 'users') fsUsers.delete(id);
    },
  };
}

function req(): NextRequest {
  return new NextRequest('http://localhost/api/induction/reapply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({}),
  });
}

const savedSurfaces = process.env.SUPA_SURFACES;

describe('P1 mirror loudness — induction reapply route', () => {
  beforeEach(() => {
    userUpdates.length = 0;
    failSet = false;
    fsUsers.clear();
    fsUsers.set('user-1', { hasApplied: true, applicationStatus: 'rejected' });
    process.env.SUPA_SURFACES = 'applications';
    __setApplicationsSupaAdapterForTests(makeAdapter());
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetApplicationsSupaAdapterForTests();
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
    (console.error as jest.Mock).mockRestore?.();
    (console.warn as jest.Mock).mockRestore?.();
  });

  it('failed fs_users mirror -> 500 { error: "Re-apply failed" } (previously a silent 200)', async () => {
    failSet = true;
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Re-apply failed' });
    // The Firestore clear committed before the mirror attempt; the
    // fs_users row still holds the stale flag, which is exactly the
    // stranded state the 500 now surfaces for a retry.
    expect(userUpdates).toHaveLength(1);
    expect(fsUsers.get('user-1')?.hasApplied).toBe(true);
  });

  it('success control: healthy adapter -> 200 { ok: true } and the fs_users flag is cleared', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fsUsers.get('user-1')).toMatchObject({ hasApplied: false, applicationStatus: null });
  });
});
