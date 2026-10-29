/**
 * @jest-environment node
 *
 * P1 MIRROR LOUDNESS — POST /api/admin/applications/status.
 * Before the fix, applyApplicationUpdate swallowed mirror failures
 * in BOTH arms (primacy: the Firestore mirror update's catch logged
 * and proceeded; dual-write: mirrorApplicationUpdate's false was
 * ignored), so the status op answered 200 over a stranded mirror.
 * Pins:
 *  - dual-write, adapter mirror update reports failure -> 500.
 *  - dual-write, healthy adapter -> 200 { ok: true } (unchanged).
 *  - primacy, Firestore mirror update throws -> 500 (op 'status').
 *  - primacy, Firestore mirror update throws -> op
 *    'post-approve-sync' KEEPS its always-200 contract:
 *    200 { ok: true, stamped: false }.
 */
const appUpdates: Array<{ id: string; data: any }> = [];
let primary = false;
let mirrorOk = true;
let firestoreMirrorThrows = false;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        update: async (data: any) => {
          if (name === 'applications') {
            if (firestoreMirrorThrows) throw new Error('Firestore mirror update failed');
            appUpdates.push({ id, data });
          }
        },
        get: async () => ({
          exists: true,
          data: () => ({ status: 'pending', userId: id }),
        }),
      }),
      add: async () => ({ id: 'a1' }),
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'admin-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
}));
jest.mock('@/lib/applicant-status', () => ({
  stageHistoryKeyForStatus: (s: string) => (s === 'approved' ? 'onboardingAt' : null),
}));
jest.mock('@/lib/applications-supa', () => ({
  updateApplicationPrimaryFirst: async () => primary,
  mirrorApplicationUpdate: async () => mirrorOk,
  resolveApplicationsSupaAdapter: async () => ({}),
  getApplicationRecord: async () => ({ status: 'rejected', userId: 'app-1' }),
}));
jest.mock('@/lib/server/universal-submissions-sync', () => ({
  syncApplicationUniversalSubmission: async () => undefined,
}));

import { POST } from '../route';
import { NextRequest } from 'next/server';

function req(body: any): NextRequest {
  return new NextRequest('http://localhost/api/admin/applications/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('P1 mirror loudness — admin applications status route', () => {
  beforeEach(() => {
    appUpdates.length = 0;
    primary = false;
    mirrorOk = true;
    firestoreMirrorThrows = false;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (console.error as jest.Mock).mockRestore?.();
    (console.warn as jest.Mock).mockRestore?.();
  });

  it('dual-write: a failed Supabase mirror update answers 500 (previously 200)', async () => {
    mirrorOk = false;
    const res = await POST(req({ op: 'status', applicationId: 'app-1', status: 'rejected', reason: 'Weak fit' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to update application status');
    // The Firestore primary write still landed first (dual-write order).
    expect(appUpdates).toHaveLength(1);
  });

  it('dual-write success control: healthy adapter -> 200, same body as before', async () => {
    const res = await POST(req({ op: 'status', applicationId: 'app-1', status: 'rejected', reason: 'Weak fit' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(appUpdates).toHaveLength(1);
  });

  it('primacy: a throwing Firestore mirror update answers 500 (previously swallowed to 200)', async () => {
    primary = true;
    firestoreMirrorThrows = true;
    const res = await POST(req({ op: 'status', applicationId: 'app-1', status: 'rejected' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to update application status');
  });

  it('primacy success control: healthy Firestore mirror -> 200', async () => {
    primary = true;
    const res = await POST(req({ op: 'status', applicationId: 'app-1', status: 'rejected' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("post-approve-sync contract preserved: primacy mirror failure still answers 200 with stamped=false", async () => {
    primary = true;
    firestoreMirrorThrows = true;
    const res = await POST(req({ op: 'post-approve-sync', applicationId: 'app-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stamped: false });
  });
});
