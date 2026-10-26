/**
 * @jest-environment node
 *
 * WS10 — A2/A3 pins (the applications-primacy flip-blockers).
 *  - Static: the admin applications page performs no client Firestore
 *    write; A2 goes through op 'status', A3 through 'post-approve-sync'
 *    on POST /api/admin/applications/status.
 *  - op 'status' dual-write: Firestore update with the page's exact
 *    payload (incl. stageHistory dot-path stamp), seam mirror, the
 *    server-owned universal_submissions sync (replica parity), the
 *    users decision mirror, and the audit entry.
 *  - op 'status' primacy: adapter-first helper used; Firestore update
 *    still lands as the mirror; sync reads the primary store.
 *  - op 'post-approve-sync': stage stamp only + users mirror + audit;
 *    best-effort (200 even when the stamp fails).
 *  - Gate: no canManageApplications → 403, zero writes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../../..');

describe('WS10 A2/A3 static pins', () => {
  it('admin applications page performs no client Firestore write', () => {
    const src = readFileSync(join(root, 'app/admin/applications/page.tsx'), 'utf8');
    expect(src).not.toMatch(/firestore-wrapper/);
    expect(src).not.toMatch(/from '@\/lib\/audit-logging'|logAuditEntry\(/);
    expect(src).toContain("/api/admin/applications/status");
    expect(src).toContain('post-approve-sync');
  });
});

/* ------------------------------------------------------------ route fakes */
const appUpdates: Array<{ id: string; data: any }> = [];
const userUpdates: Array<{ id: string; data: any }> = [];
const auditAdds: any[] = [];
const universalSets: Array<{ id: string; data: any }> = [];
const seamMirrors: Array<{ id: string; data: any }> = [];
let primary = false;
let stampFails = false;
let permitted = true;
const appDoc: Record<string, any> = {
  status: 'pending', userId: 'app-1', roleAppliedFor: 'Rover Lead',
  createdAt: 'CREATED', chapterId: 'ist',
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        update: async (data: any) => {
          if (name === 'applications') {
            if (stampFails && !('status' in data)) throw new Error('stamp failed');
            appUpdates.push({ id, data });
            Object.assign(appDoc, data);
          }
          if (name === 'users') userUpdates.push({ id, data });
        },
        get: async () => ({
          exists: name === 'applications' || name === 'users',
          data: () => (name === 'applications' ? { ...appDoc } : { displayName: 'App One', chapterId: 'ist' }),
        }),
      }),
      add: async (data: any) => { if (name === 'audit_logs') auditAdds.push(data); return { id: 'a1' }; },
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
  hasServerPermissionForUser: async () => permitted,
}));
jest.mock('@/lib/applicant-status', () => ({
  stageHistoryKeyForStatus: (s: string) =>
    s === 'shortlisted' ? 'crucibleAt' : s === 'approved' ? 'onboardingAt' : s === 'rejected' ? 'decidedAt' : null,
}));
jest.mock('@/lib/applications-supa', () => ({
  updateApplicationPrimaryFirst: async (id: string, data: any) => {
    if (!primary) return false;
    seamMirrors.push({ id, data });
    return true;
  },
  mirrorApplicationUpdate: async (id: string, data: any) => { seamMirrors.push({ id, data }); return true; },
  resolveApplicationsSupaAdapter: async () => ({}),
  getApplicationRecord: async () => ({ ...appDoc }),
}));
jest.mock('@/lib/server/universal-submissions-sync', () => ({
  syncApplicationUniversalSubmission: async (_db: any, id: string, after: any) => {
    universalSets.push({ id, data: after });
  },
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

describe('WS10 A2 op status', () => {
  beforeEach(() => {
    appUpdates.length = 0; userUpdates.length = 0; auditAdds.length = 0;
    universalSets.length = 0; seamMirrors.length = 0;
    primary = false; stampFails = false; permitted = true;
    appDoc.status = 'pending';
  });

  it('dual-write: exact page payload + mirror + universal sync + users mirror + audit', async () => {
    const res = await POST(req({ op: 'status', applicationId: 'app-1', status: 'rejected', reason: 'Weak fit' }));
    expect(res.status).toBe(200);
    expect(appUpdates).toEqual([{
      id: 'app-1',
      data: {
        status: 'rejected', reviewedAt: '__ST__', reviewedBy: 'admin-1',
        reviewNotes: 'Weak fit', rejection_reason: 'Weak fit',
        'stageHistory.decidedAt': '__ST__',
      },
    }]);
    expect(seamMirrors).toEqual([{ id: 'app-1', data: appUpdates[0].data }]);
    expect(universalSets).toHaveLength(1);
    expect(universalSets[0].data.status).toBe('rejected');
    expect(userUpdates).toEqual([{
      id: 'app-1',
      data: { applicationStatus: 'rejected', hasApplied: false, updatedAt: '__ST__' },
    }]);
    expect(auditAdds).toEqual([{
      action: 'application_status_updated', actorUid: 'admin-1',
      targetUidOrResource: 'app-1',
      payload: { new_status: 'rejected', rejection_reason: 'Weak fit' },
      timestamp: '__ST__',
    }]);
  });

  it('primacy: adapter-first helper carries the write; Firestore follows', async () => {
    primary = true;
    const res = await POST(req({ op: 'status', applicationId: 'app-1', status: 'shortlisted' }));
    expect(res.status).toBe(200);
    expect(seamMirrors[0].data).toMatchObject({ status: 'shortlisted', 'stageHistory.crucibleAt': '__ST__' });
    expect(appUpdates).toHaveLength(1);
    expect(userUpdates[0].data).toEqual({ applicationStatus: 'shortlisted', updatedAt: '__ST__' });
    // No reason: the audit payload drops rejection_reason (sanitize parity).
    expect(auditAdds[0].payload).toEqual({ new_status: 'shortlisted' });
  });

  it('gate: without canManageApplications → 403 and zero writes', async () => {
    permitted = false;
    const res = await POST(req({ op: 'status', applicationId: 'app-1', status: 'rejected' }));
    expect(res.status).toBe(403);
    expect(appUpdates).toHaveLength(0);
    expect(seamMirrors).toHaveLength(0);
  });
});

describe('WS10 A3 op post-approve-sync', () => {
  beforeEach(() => {
    appUpdates.length = 0; userUpdates.length = 0; auditAdds.length = 0;
    universalSets.length = 0; seamMirrors.length = 0;
    primary = false; stampFails = false; permitted = true;
  });

  it('stamps stageHistory.onboardingAt, mirrors, syncs, mirrors user + audits approved', async () => {
    const res = await POST(req({ op: 'post-approve-sync', applicationId: 'app-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stamped: true });
    expect(appUpdates).toEqual([{ id: 'app-1', data: { 'stageHistory.onboardingAt': '__ST__' } }]);
    expect(userUpdates[0].data).toEqual({ applicationStatus: 'approved', updatedAt: '__ST__' });
    expect(auditAdds[0].payload).toEqual({ new_status: 'approved' });
  });

  it('best-effort: a failed stamp still returns 200 and still mirrors the decision', async () => {
    stampFails = true;
    const res = await POST(req({ op: 'post-approve-sync', applicationId: 'app-1' }));
    expect(res.status).toBe(200);
    expect((await res.json()).stamped).toBe(false);
    expect(userUpdates).toHaveLength(1);
  });
});
