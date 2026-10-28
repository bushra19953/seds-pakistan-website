/**
 * @jest-environment node
 *
 * WS10 — A1 pins (the induction submit, third primacy flip-blocker),
 * plus the reapply and autosave routes the page conversion uses.
 *  - Static: the induction page and use-autosave perform no client
 *    Firestore write; the page's two explicit fireWebhook dispatches
 *    REMAIN (replica parity is carried by them, unchanged).
 *  - POST /api/induction/submit dual-write: ONE Admin batch
 *    (applications replace + users flag set-merge), guarded keys
 *    stripped server-side, uid/email/status stamped from the token,
 *    timestamps stamped, mirrorApplicationSet after commit, audit
 *    entry written.
 *  - Primacy: setApplicationPrimaryFirst still gates the Supa leg;
 *    a throwing adapter → 500. SEC-RACE amendment: the Firestore
 *    write is now a gate runTransaction (hasApplied check-and-set)
 *    that runs BEFORE the Supa leg in both modes, and an adapter
 *    failure triggers compensation restoring the pre-submit
 *    Firestore snapshots, so the net effect of a failed primary
 *    write is still "no submission".
 *  - POST /api/induction/reapply: rejected-only guard (403
 *    'permission-denied' otherwise), exact three-field update.
 *  - /api/autosave: POST set-merge with the hook's stored shape;
 *    DELETE removes the caller's draft.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');

describe('WS10 A1 static pins', () => {
  it('induction page performs no client Firestore write but keeps its dispatches', () => {
    const src = readFileSync(join(root, 'app/induction/page.tsx'), 'utf8');
    expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
    expect(src).not.toMatch(/writeBatch|updateDoc\(/);
    expect(src).toContain("/api/induction/submit");
    expect(src).toContain("/api/induction/reapply");
    expect(src).toContain("fireWebhook('applications'");
    expect(src).toContain("fireWebhook('users'");
  });
  it('use-autosave performs no client Firestore write', () => {
    const src = readFileSync(join(root, 'hooks/use-autosave.ts'), 'utf8');
    expect(src).not.toMatch(/firestore-wrapper/);
    expect(src).not.toMatch(/from 'firebase\/firestore'/);
    expect(src).toContain('/api/autosave');
  });
});

/* ------------------------------------------------------------ route fakes */
const batchSets: Array<{ path: string; data: any; opts?: any }> = [];
let batchCommits = 0;
const seamSets: Array<{ id: string; data: any }> = [];
const auditAdds: any[] = [];
const userUpdates: Array<{ id: string; data: any }> = [];
const draftSets: Array<{ id: string; data: any; opts: any }> = [];
const draftDeletes: string[] = [];
let primary = false;
let primaryThrows = false;
// SEC-RACE gate state: documents as the gate transaction sees them.
// Absent key = doc does not exist. users/user-1 falls back to the
// canned flag shape below when no tx write has landed.
const txDocs: Record<string, any> = {};
let storedStatus: string | null = 'rejected';

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    batch: () => ({
      set: (ref: any, data: any, opts?: any) => { batchSets.push({ path: ref.__path, data, opts }); },
      commit: async () => { batchCommits += 1; },
    }),
    runTransaction: async (fn: any) => {
      const tx = {
        get: async (ref: any) => {
          const data = txDocs[ref.__path];
          if (data !== undefined) return { exists: true, data: () => data };
          if (ref.__path === 'users/user-1') return { exists: true, data: () => ({ applicationStatus: storedStatus }) };
          return { exists: false, data: () => undefined };
        },
        set: (ref: any, data: any, opts?: any) => {
          batchSets.push({ path: ref.__path, data, opts });
          txDocs[ref.__path] = opts?.merge
            ? { ...(txDocs[ref.__path] ?? (ref.__path === 'users/user-1' ? { applicationStatus: storedStatus } : {})), ...data }
            : data;
        },
        update: (ref: any, data: any) => { txDocs[ref.__path] = { ...(txDocs[ref.__path] ?? {}), ...data }; },
        delete: (ref: any) => { delete txDocs[ref.__path]; },
      };
      const result = await fn(tx);
      batchCommits += 1;
      return result;
    },
    collection: (name: string) => ({
      doc: (id: string) => ({
        __path: `${name}/${id}`,
        get: async () => ({
          exists: name === 'users',
          data: () => ({ applicationStatus: storedStatus }),
        }),
        update: async (data: any) => { userUpdates.push({ id, data }); },
        set: async (data: any, opts: any) => {
          draftSets.push({ id, data, opts });
          const p = `${name}/${id}`;
          txDocs[p] = opts?.merge ? { ...(txDocs[p] ?? {}), ...data } : data;
        },
        delete: async () => { draftDeletes.push(id); delete txDocs[`${name}/${id}`]; },
      }),
      add: async (data: any) => { auditAdds.push(data); return { id: 'a1' }; },
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__', delete: () => '__DELETE__' },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { userId: 'user-1', email: 'user1@example.com' },
  }),
}));
jest.mock('@/lib/applications-supa', () => ({
  setApplicationPrimaryFirst: async (id: string, data: any) => {
    if (primaryThrows) throw new Error('adapter down');
    if (!primary) return false;
    seamSets.push({ id, data });
    return true;
  },
  mirrorApplicationSet: async (id: string, data: any) => { seamSets.push({ id, data }); return true; },
}));

import { POST as submitPOST } from '../submit/route';
import { POST as reapplyPOST } from '../reapply/route';
import { POST as autosavePOST, DELETE as autosaveDELETE } from '../../autosave/route';
import { NextRequest } from 'next/server';

function req(url: string, body?: any, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('WS10 A1 POST /api/induction/submit', () => {
  beforeEach(() => {
    batchSets.length = 0; batchCommits = 0; seamSets.length = 0; auditAdds.length = 0;
    primary = false; primaryThrows = false;
    for (const k of Object.keys(txDocs)) delete txDocs[k];
  });

  it('dual-write: one atomic batch, strip + token stamps, mirror + audit after', async () => {
    const res = await submitPOST(req('http://localhost/api/induction/submit', {
      applicationData: {
        fullName: 'User One', intakeWindowId: 'w-2026', resume_url: null,
        uid: 'spoofed', email: 'spoof@x', role: 'admin', pre_score: 99, status: 'approved',
      },
    }));
    expect(res.status).toBe(200);
    expect(batchCommits).toBe(1);
    const appSet = batchSets.find((s) => s.path === 'applications/user-1');
    expect(appSet?.opts).toBeUndefined();
    expect(appSet?.data).toEqual({
      fullName: 'User One', intakeWindowId: 'w-2026', resume_url: null,
      uid: 'user-1', email: 'user1@example.com', status: 'pending',
      created_at: '__ST__', updated_at: '__ST__', last_saved_at: '__ST__',
    });
    const flagSet = batchSets.find((s) => s.path === 'users/user-1');
    expect(flagSet?.data).toEqual({ hasApplied: true, applicationStatus: 'pending', updatedAt: '__ST__' });
    expect(flagSet?.opts).toEqual({ merge: true });
    expect(seamSets).toEqual([{ id: 'user-1', data: appSet?.data }]);
    expect(auditAdds).toEqual([{
      action: 'application_submitted', actorUid: 'user-1',
      targetUidOrResource: 'user-1', payload: { application_id: 'user-1' }, timestamp: '__ST__',
    }]);
  });

  it('primacy: gate transaction commits, adapter set follows as the primary write', async () => {
    primary = true;
    const res = await submitPOST(req('http://localhost/api/induction/submit', {
      applicationData: { fullName: 'User One' },
    }));
    expect(res.status).toBe(200);
    expect(seamSets).toHaveLength(1);
    expect(batchCommits).toBe(1);
  });

  it('primacy adapter failure: 500, gate transaction compensated away', async () => {
    primary = true; primaryThrows = true;
    const res = await submitPOST(req('http://localhost/api/induction/submit', {
      applicationData: { fullName: 'User One' },
    }));
    expect(res.status).toBe(500);
    // The gate transaction committed, then compensation removed the
    // application it wrote: no submission survives a failed primary.
    expect(batchCommits).toBe(1);
    expect(txDocs['applications/user-1']).toBeUndefined();
  });
});

describe('WS10 POST /api/induction/reapply', () => {
  beforeEach(() => { userUpdates.length = 0; storedStatus = 'rejected'; });

  it('rejected: clears the flag with the exact three-field update', async () => {
    const res = await reapplyPOST(req('http://localhost/api/induction/reapply', {}));
    expect(res.status).toBe(200);
    expect(userUpdates).toEqual([{
      id: 'user-1',
      data: { hasApplied: false, applicationStatus: null, updatedAt: '__ST__' },
    }]);
  });

  it('non-rejected: 403 permission-denied, zero writes', async () => {
    storedStatus = 'pending';
    const res = await reapplyPOST(req('http://localhost/api/induction/reapply', {}));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('permission-denied');
    expect(userUpdates).toHaveLength(0);
  });
});

describe('WS10 /api/autosave', () => {
  beforeEach(() => { draftSets.length = 0; draftDeletes.length = 0; });

  it('POST set-merges the caller draft in the hook stored shape', async () => {
    const res = await autosavePOST(req('http://localhost/api/autosave', { state: { a: 1 } }));
    expect(res.status).toBe(200);
    expect(draftSets).toHaveLength(1);
    expect(draftSets[0].id).toBe('user-1');
    expect(draftSets[0].data.payload).toEqual({ a: 1 });
    expect(draftSets[0].data.updated_at).toBe('__ST__');
    expect(draftSets[0].data.expires_at).toBeInstanceOf(Date);
    expect(draftSets[0].opts).toEqual({ merge: true });
  });

  it('DELETE removes the caller draft', async () => {
    const res = await autosaveDELETE(req('http://localhost/api/autosave', undefined, 'DELETE'));
    expect(res.status).toBe(200);
    expect(draftDeletes).toEqual(['user-1']);
  });
});
