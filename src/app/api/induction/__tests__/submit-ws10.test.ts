/**
 * @jest-environment node
 *
 * WS10 — A1 pins (the induction submit, third primacy flip-blocker),
 * plus the reapply and autosave routes the page conversion uses.
 *  - Static: the induction page and use-autosave perform no client
 *    Firestore write; the page's two explicit fireWebhook dispatches
 *    REMAIN (replica parity is carried by them, unchanged).
 *  - POST /api/induction/submit: the hasApplied gate is the seam's
 *    runInductionSubmitGate (ONE Postgres transaction: per-uid
 *    advisory lock, priors re-read from fs_applications + fs_users,
 *    re-appliable-state rule, fs_applications upsert on allow). The
 *    gate receives applicationData with guarded keys stripped
 *    server-side and uid/email/status stamped from the token,
 *    timestamps stamped, intakeWindowId passed through. On allow the
 *    route then writes the Firestore MIRROR through doc refs
 *    (applications replace + users flag set-merge) and the audit
 *    entry. Deny → 409 ALREADY_APPLIED with zero writes anywhere.
 *    The route uses no Admin batch and no Firestore runTransaction
 *    (and no Firestore reads at all).
 *  - Failure semantics: a gate throw (adapter down) → 500 with zero
 *    writes. A Firestore mirror failure after the gate applied →
 *    500 with compensation: Supa is restored from the gate's
 *    returned priors (mirrorApplicationSet for a prior application,
 *    mirrorDeleteDoc when there was none, mirrorMergeSetDoc with
 *    SUPA_DELETE_FIELD restoring the fs_users flag keys), so the
 *    net effect is still "no submission".
 *  - POST /api/induction/reapply: rejected-only guard (403
 *    'permission-denied' otherwise), exact three-field Firestore
 *    update, then mirrorInductionFlagClear(uid) mirrors the flag
 *    clear into fs_users (never on the 403 path).
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
let runTxCalls = 0;
const docSets: Array<{ path: string; data: any; opts?: any }> = [];
const auditAdds: any[] = [];
const userUpdates: Array<{ id: string; data: any }> = [];
const draftSets: Array<{ id: string; data: any; opts: any }> = [];
const draftDeletes: string[] = [];
// Firestore mirror state: documents as the doc-ref writes land them.
// Absent key = doc does not exist. The reapply route's users/user-1
// read falls back to the canned flag shape below (storedStatus).
const txDocs: Record<string, any> = {};
let storedStatus: string | null = 'rejected';
let mirrorSetThrows = false;
// SEC-RACE gate state (the Supa side): fs_applications / fs_users as
// the gate transaction sees them, plus the seam call records. The
// gate fake applies the re-appliable-state rule over these maps and
// upserts supaApps on allow, returning deep-cloned priors.
const WS10_DELETE_FIELD = Symbol('ws10-fake-delete-field');
const cloneWs10 = (v: any) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const supaApps: Record<string, any> = {};
const supaUsers: Record<string, any> = {};
const gateCalls: Array<{ uid: string; data: any }> = [];
const gateWrites: Array<{ id: string; data: any }> = [];
let gateThrows = false;
const mirrorCalls: Array<{ method: string; args: any[] }> = [];
const flagClearCalls: string[] = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    batch: () => ({
      set: (ref: any, data: any, opts?: any) => { batchSets.push({ path: ref.__path, data, opts }); },
      commit: async () => { batchCommits += 1; },
    }),
    runTransaction: async (fn: any) => {
      // Retained for the other routes sharing this mock; the submit
      // route must never call it (its tests assert runTxCalls === 0).
      runTxCalls += 1;
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
          if (mirrorSetThrows && name === 'applications') throw new Error('Firestore mirror write failed');
          docSets.push({ path: `${name}/${id}`, data, opts });
          if (name === 'drafts') draftSets.push({ id, data, opts });
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
  APPLICATIONS_COLLECTION: 'applications',
  USERS_COLLECTION: 'users',
  SUPA_DELETE_FIELD: WS10_DELETE_FIELD,
  runInductionSubmitGate: async (uid: string, applicationData: any) => {
    gateCalls.push({ uid, data: cloneWs10(applicationData) });
    if (gateThrows) throw new Error('adapter down');
    const priorApp = supaApps[uid] !== undefined ? cloneWs10(supaApps[uid]) : null;
    const priorUser = supaUsers[uid] !== undefined ? cloneWs10(supaUsers[uid]) : null;
    const status = typeof priorApp?.status === 'string' ? priorApp.status.toLowerCase() : '';
    const terminal = status === 'rejected' || status === 'withdrawn';
    const allowed = !priorApp || (terminal && priorUser?.hasApplied !== true);
    if (!allowed) {
      return {
        outcome: 'already_applied',
        applied: false,
        existingStatus: typeof priorApp?.status === 'string' ? priorApp.status : null,
        priorApp,
        priorUser,
      };
    }
    supaApps[uid] = cloneWs10(applicationData);
    gateWrites.push({ id: uid, data: cloneWs10(applicationData) });
    return { outcome: 'created', applied: true, existingStatus: null, priorApp, priorUser };
  },
  mirrorApplicationSet: async (id: string, data: any) => {
    mirrorCalls.push({ method: 'mirrorApplicationSet', args: [id, cloneWs10(data)] });
    supaApps[id] = cloneWs10(data);
    return true;
  },
  mirrorDeleteDoc: async (collection: string, id: string) => {
    mirrorCalls.push({ method: 'mirrorDeleteDoc', args: [collection, id] });
    if (collection === 'users') delete supaUsers[id];
    else delete supaApps[id];
    return true;
  },
  mirrorMergeSetDoc: async (collection: string, id: string, fields: any) => {
    mirrorCalls.push({ method: 'mirrorMergeSetDoc', args: [collection, id, fields] });
    const target = collection === 'users' ? supaUsers : supaApps;
    const next: Record<string, any> = { ...(target[id] ?? {}) };
    for (const [k, v] of Object.entries(fields)) {
      if (v === WS10_DELETE_FIELD) delete next[k];
      else next[k] = v;
    }
    target[id] = next;
    return true;
  },
  // P1 mirror loudness: the reapply route resolves the adapter to
  // know a mirror exists before treating a false mirror result as
  // fatal. This fake's flag clear always succeeds, so behavior here
  // is unchanged.
  resolveApplicationsSupaAdapter: async () => ({}),
  mirrorInductionFlagClear: async (uid: string) => {
    flagClearCalls.push(uid);
    supaUsers[uid] = {
      ...(supaUsers[uid] ?? {}),
      hasApplied: false,
      applicationStatus: null,
      updatedAt: new Date().toISOString(),
    };
    return true;
  },
  setApplicationPrimaryFirst: async () => false,
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
    batchSets.length = 0; batchCommits = 0; runTxCalls = 0; docSets.length = 0; auditAdds.length = 0;
    gateCalls.length = 0; gateWrites.length = 0; gateThrows = false;
    mirrorCalls.length = 0; mirrorSetThrows = false;
    for (const k of Object.keys(txDocs)) delete txDocs[k];
    for (const k of Object.keys(supaApps)) delete supaApps[k];
    for (const k of Object.keys(supaUsers)) delete supaUsers[k];
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (console.error as jest.Mock).mockRestore?.();
    (console.warn as jest.Mock).mockRestore?.();
  });

  it('gate-first dual-write: strip + token stamps reach the gate, Firestore mirror sets + audit after', async () => {
    const res = await submitPOST(req('http://localhost/api/induction/submit', {
      applicationData: {
        fullName: 'User One', intakeWindowId: 'w-2026', resume_url: null,
        uid: 'spoofed', email: 'spoof@x', role: 'admin', pre_score: 99, status: 'approved',
      },
    }));
    expect(res.status).toBe(200);
    // No Admin batch, no Firestore transaction: the gate is the write.
    expect(batchCommits).toBe(0);
    expect(batchSets).toHaveLength(0);
    expect(runTxCalls).toBe(0);
    // The gate received the stripped, token-stamped applicationData:
    // uid/email from the token (not the spoofed body values), status
    // forced to 'pending', no guarded keys (role/pre_score/...),
    // intakeWindowId passed through, timestamps stamped.
    const expectedApp = {
      fullName: 'User One', intakeWindowId: 'w-2026', resume_url: null,
      uid: 'user-1', email: 'user1@example.com', status: 'pending',
      created_at: '__ST__', updated_at: '__ST__', last_saved_at: '__ST__',
    };
    expect(gateCalls).toEqual([{ uid: 'user-1', data: expectedApp }]);
    expect(gateWrites).toEqual([{ id: 'user-1', data: expectedApp }]);
    expect(supaApps['user-1']).toEqual(expectedApp);
    // Firestore mirror: the same application set (no opts) plus the
    // users flag set-merge, both through doc refs.
    const appSet = docSets.find((s) => s.path === 'applications/user-1');
    expect(appSet?.opts).toBeUndefined();
    expect(appSet?.data).toEqual(expectedApp);
    const flagSet = docSets.find((s) => s.path === 'users/user-1');
    expect(flagSet?.data).toEqual({ hasApplied: true, applicationStatus: 'pending', updatedAt: '__ST__' });
    expect(flagSet?.opts).toEqual({ merge: true });
    expect(auditAdds).toEqual([{
      action: 'application_submitted', actorUid: 'user-1',
      targetUidOrResource: 'user-1', payload: { application_id: 'user-1' }, timestamp: '__ST__',
    }]);
  });

  it('409 semantics: a live application in the gate denies with zero writes anywhere', async () => {
    supaApps['user-1'] = { uid: 'user-1', status: 'pending', fullName: 'Original' };
    supaUsers['user-1'] = { hasApplied: true, applicationStatus: 'pending' };
    const res = await submitPOST(req('http://localhost/api/induction/submit', {
      applicationData: { fullName: 'User One' },
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ALREADY_APPLIED');
    expect(body.existingStatus).toBe('pending');
    expect(gateWrites).toHaveLength(0);
    expect(docSets).toHaveLength(0);
    expect(mirrorCalls).toHaveLength(0);
    expect(auditAdds).toHaveLength(0);
    expect(supaApps['user-1'].fullName).toBe('Original');
  });

  it('gate failure (adapter down): 500, zero writes in either store', async () => {
    gateThrows = true;
    const res = await submitPOST(req('http://localhost/api/induction/submit', {
      applicationData: { fullName: 'User One' },
    }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Submission failed');
    expect(supaApps['user-1']).toBeUndefined();
    expect(docSets).toHaveLength(0);
    expect(txDocs['applications/user-1']).toBeUndefined();
    expect(auditAdds).toHaveLength(0);
  });

  it('Firestore mirror failure after the gate applied: 500, compensated — no submission survives', async () => {
    mirrorSetThrows = true;
    const res = await submitPOST(req('http://localhost/api/induction/submit', {
      applicationData: { fullName: 'User One' },
    }));
    expect(res.status).toBe(500);
    // The gate applied its Supa write, then compensation removed it
    // (no prior application → mirrorDeleteDoc) and restored the
    // fs_users flag keys via a merge-set of delete markers.
    expect(gateWrites).toHaveLength(1);
    expect(supaApps['user-1']).toBeUndefined();
    expect(mirrorCalls.filter((c) => c.method === 'mirrorDeleteDoc')).toEqual([
      { method: 'mirrorDeleteDoc', args: ['applications', 'user-1'] },
    ]);
    const flagRestores = mirrorCalls.filter((c) => c.method === 'mirrorMergeSetDoc');
    expect(flagRestores).toHaveLength(1);
    expect(flagRestores[0].args[0]).toBe('users');
    expect(flagRestores[0].args[2].hasApplied).toBe(WS10_DELETE_FIELD);
    expect(txDocs['applications/user-1']).toBeUndefined();
    expect(auditAdds).toHaveLength(0);
  });
});

describe('WS10 POST /api/induction/reapply', () => {
  beforeEach(() => { userUpdates.length = 0; storedStatus = 'rejected'; flagClearCalls.length = 0; });

  it('rejected: clears the flag with the exact three-field update', async () => {
    const res = await reapplyPOST(req('http://localhost/api/induction/reapply', {}));
    expect(res.status).toBe(200);
    expect(userUpdates).toEqual([{
      id: 'user-1',
      data: { hasApplied: false, applicationStatus: null, updatedAt: '__ST__' },
    }]);
    // The clear is mirrored into fs_users exactly once, for the caller.
    expect(flagClearCalls).toEqual(['user-1']);
    expect(supaUsers['user-1']).toMatchObject({ hasApplied: false, applicationStatus: null });
  });

  it('non-rejected: 403 permission-denied, zero writes', async () => {
    storedStatus = 'pending';
    const res = await reapplyPOST(req('http://localhost/api/induction/reapply', {}));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('permission-denied');
    expect(userUpdates).toHaveLength(0);
    expect(flagClearCalls).toHaveLength(0);
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
