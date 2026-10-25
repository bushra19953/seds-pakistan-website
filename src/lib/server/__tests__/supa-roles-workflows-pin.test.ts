/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION — ROLES+PERMISSIONS cluster contract test (deliverable 4).
 *
 * Pins the flag-OFF identity-read counts of POST /api/workflows:
 * the auth+permission portion costs exactly 2 identity doc reads for the
 * caller cold (roles/{uid} + users/{uid}, one parallel bundle load) and
 * exactly 0 warm (identity cache, 30s TTL), with roleDefinitions/permissions
 * doc gets also at 0 warm for a blanket/definition-cached caller.
 *
 * This FAILS if those counts change on the flag-OFF path — e.g. if the
 * roles migration re-introduces a double users read, bypasses the identity
 * cache, or adds a permission-doc read to the warm path.
 *
 * The canonical regression suite for this pin already exists and lives at
 *   src/lib/server/__tests__/identity-cache-integration.test.ts
 * (test: 'POST /api/workflows: auth+permission portion cold 2 identity doc
 * reads for the caller, warm 0', T-A1 block, plus the T-A2/T-A4/T-A5
 * parity/TTL/failure suites). This file is the migration-cluster's own
 * copy of the pin so the roles contract run does not depend on remembering
 * to run the Read-Burn suite; both must stay green.
 *
 * Harness mirrors identity-cache-integration.test.ts: the real
 * verifyAuthentication + real permissions/identity-cache run against the
 * CountingFirestore fake; ZERO live reads.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => {
        const uid = token.startsWith('tok:') ? token.slice(4) : token;
        return { uid, email: `${uid}@example.com`, email_verified: true, name: uid };
      },
    }),
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'ts',
        increment: (n: number) => ({ __increment: n }),
        delete: () => ({ __delete: true }),
      },
    },
  },
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({ errorEmitter: { emit: jest.fn() } }));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() {
      super('permission-error');
    }
  },
}));

import { NextRequest } from 'next/server';
import { CountingFirestore } from './helpers/counting-firestore';
import { resetIdentityCache } from '../identity-cache';
import { POST as workflowsPOST } from '@/app/api/workflows/route';

const CHAPTER = 'seds-ist-chapter';
let counting: CountingFirestore;

function seed() {
  // Fixture mirrors identity-cache-integration.test.ts seedPersonas()
  // for this persona (officer-1): chapter_president with a definition
  // granting canManageTasks, which is the workflows POST gate.
  counting.seed('roles', 'officer-1', { role: 'chapter_president', chapterId: CHAPTER });
  counting.seed('users', 'officer-1', { isBanned: false, chapterId: CHAPTER, displayName: 'Officer' });
  counting.seed('roleDefinitions', 'chapter_president', {
    name: 'Chapter President',
    permissions: ['canManageTasks'],
  });
  counting.seed('users', 'member-2', {
    isBanned: false,
    chapterId: CHAPTER,
    displayName: 'Assignee',
  });
}

function makeReq() {
  const body = {
    workflowId: 'wf-supa-roles-pin',
    workflowTitle: 'Pin Workflow',
    finalDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    steps: [{ title: 'Step 1', description: 'do it', assigneeId: 'member-2' }],
  };
  return new NextRequest('http://localhost/api/workflows', {
    method: 'POST',
    headers: { authorization: ['Bearer ', 'tok', ':officer-1'].join(''), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetIdentityCache();
  counting = new CountingFirestore();
  mockDbHolder.db = counting.asDb();
  seed();
  delete process.env.SUPA_SURFACES; // the pin is defined on the flag-OFF path
});

describe('POST /api/workflows pinned identity reads (flag OFF)', () => {
  it('cold: exactly 2 identity doc reads for the caller; warm: exactly 0', async () => {
    const coldRes = await workflowsPOST(makeReq());
    expect(coldRes.status).not.toBe(401);
    expect(coldRes.status).not.toBe(403);
    expect(counting.docGetCount('roles', 'officer-1') + counting.docGetCount('users', 'officer-1')).toBe(2);

    counting.resetCounts();
    const warmRes = await workflowsPOST(makeReq());
    expect(warmRes.status).not.toBe(401);
    expect(warmRes.status).not.toBe(403);
    expect(counting.docGetCount('roles', 'officer-1') + counting.docGetCount('users', 'officer-1')).toBe(0);
    expect(counting.docGetCount('roleDefinitions')).toBe(0);
    expect(counting.docGetCount('permissions')).toBe(0);
  });

  it('cold and warm responses are identical in status', async () => {
    const coldRes = await workflowsPOST(makeReq());
    counting.resetCounts();
    const warmRes = await workflowsPOST(makeReq());
    expect(warmRes.status).toBe(coldRes.status);
  });
});
