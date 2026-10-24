/**
 * @jest-environment node
 *
 * Read-Burn A, plan §5 T-A3 - write invalidation with ZERO clock
 * advance: warm the cache, run the REAL write path against the same
 * store, and assert the new state is visible immediately in-process.
 *
 * Covered bust rows: W1 (assignRole promote + demote), W2 (removeRole),
 * W3 (setMirror), W5 (applyExpulsionBan), W7 (founder-review
 * reinstate), W11 (role-permissions POST definition edit).
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
  adminDb: null,
  getAdminStorage: () => null,
  getLastAdminError: () => null,
  getAdminDiagnostics: () => ({}),
}));
jest.mock('firebase/auth', () => ({ getAuth: jest.fn() }));
jest.mock('@/firebase', () => ({ getFirebaseApp: jest.fn() }));
jest.mock('@/firebase/error-emitter', () => ({ errorEmitter: { emit: jest.fn() } }));
jest.mock('@/firebase/errors', () => ({
  FirestorePermissionError: class FirestorePermissionError extends Error {
    constructor() { super('permission-error'); }
  },
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));
jest.mock('@/lib/server/consent-gate', () => {
  const types = jest.requireActual('@/lib/server/consent-gate-types');
  return {
    ...types,
    assertConsentFor: jest.fn(async () => ({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' })),
    consentGateHttpError: (err: unknown) => ({
      status: 500,
      body: { error: 'CONSENT_GATE_ERROR', message: String(err) },
    }),
  };
});

import { NextRequest } from 'next/server';
import { CountingFirestore } from './helpers/counting-firestore';
import { resetIdentityCache } from '../identity-cache';
import * as serverPerms from '../permissions';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assignRole, removeRole, setMirror } from '../role-writes';
import { applyExpulsionBan } from '../discipline/apply-decision';
import { makeFakeDb } from '../discipline/__tests__/fake-firestore';
import { FOUNDER_UID } from '@/lib/roles';
import { POST as founderReviewPOST } from '@/app/api/admin/founder-review/route';
import { POST as rolePermissionsPOST } from '@/app/api/admin/role-permissions/route';

const CHAPTER = 'seds-ist-chapter';

function req(path: string, uid: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer tok:${uid}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  resetIdentityCache();
});

// ------------------------------------------------------------------
// W1 / W2 / W3 - role-writes central busts
// ------------------------------------------------------------------
describe('T-A3 W1/W2/W3 role-writes busts', () => {
  let counting: CountingFirestore;
  let db: never;
  beforeEach(() => {
    counting = new CountingFirestore();
    mockDbHolder.db = counting.asDb();
    db = counting.asDb();
    counting.seed('roles', 'member-1', { role: 'member', chapterId: CHAPTER });
    counting.seed('users', 'member-1', { role: 'member', isBanned: false, chapterId: CHAPTER });
    counting.seed('users', FOUNDER_UID, { isBanned: false, chapterId: CHAPTER });
    counting.seed('roles', FOUNDER_UID, { role: 'founder_patron', chapterId: CHAPTER });
  });

  it('W1 assignRole promotion AND demotion are visible immediately', async () => {
    const before = await serverPerms.resolveIdentityForAuth(db, 'member-1');
    expect(before.role).toBe('member');

    await assignRole(db, {
      uid: 'member-1',
      role: 'chapter_president',
      chapterId: CHAPTER,
      actorUid: FOUNDER_UID,
      reason: 'elected chapter president',
      source: 'admin_ui',
      idempotencyKey: 't-a3-promote-1',
    });
    const promoted = await serverPerms.resolveIdentityForAuth(db, 'member-1');
    expect(promoted.role).toBe('chapter_president');

    await assignRole(db, {
      uid: 'member-1',
      role: 'member_basic',
      chapterId: CHAPTER,
      actorUid: FOUNDER_UID,
      reason: 'term ended',
      source: 'admin_ui',
      idempotencyKey: 't-a3-demote-1',
    });
    const demoted = await serverPerms.resolveIdentityForAuth(db, 'member-1');
    expect(demoted.role).toBe('member_basic');
  });

  it('W2 removeRole floors the member to member_basic immediately', async () => {
    await assignRole(db, {
      uid: 'member-1',
      role: 'chapter_president',
      chapterId: CHAPTER,
      actorUid: FOUNDER_UID,
      reason: 'elected chapter president',
      source: 'admin_ui',
      idempotencyKey: 't-a3-promote-2',
    });
    const promoted = await serverPerms.resolveIdentityForAuth(db, 'member-1');
    expect(promoted.role).toBe('chapter_president');

    await removeRole(db, {
      uid: 'member-1',
      actorUid: FOUNDER_UID,
      reason: 'record retired',
      source: 'admin_ui',
      idempotencyKey: 't-a3-remove-1',
    });
    const after = await serverPerms.resolveIdentityForAuth(db, 'member-1');
    expect(after.role).toBe('member_basic');
  });

  it('W3 setMirror repair is reflected in the cached bundle immediately', async () => {
    const warm = await serverPerms.getIdentityBundleCached(db, 'member-1');
    expect(warm.users?.role).toBe('member');
    // Drift: the roles doc moves, the mirror is stale (out-of-band seed).
    counting.seed('roles', 'member-1', { role: 'chapter_president', additionalRoles: [], chapterId: CHAPTER });
    const repaired = await setMirror(db, 'member-1');
    expect(repaired).toBe(true);
    const after = await serverPerms.getIdentityBundleCached(db, 'member-1');
    expect(after.users?.role).toBe('chapter_president');
  });
});

// ------------------------------------------------------------------
// W5 - expulsion ban bust (discipline fake, real applyExpulsionBan)
// ------------------------------------------------------------------
describe('T-A3 W5 applyExpulsionBan bust', () => {
  it('after expulsion the next auth is Account Banned, zero clock advance', async () => {
    const discDb: any = makeFakeDb();
    mockDbHolder.db = discDb;
    discDb.seed('users/subject-1', { displayName: 'S', role: 'team_member', warningCount: 2 });
    discDb.seed('roles/subject-1', { role: 'team_member', chapterId: CHAPTER });
    discDb.seed('settings/discipline', { shadowMode: false });
    discDb.seed('disciplinary_cases/case-x', {
      caseId: 'case-x',
      caseNumber: 'DISC-2026-0100',
      subjectUid: 'subject-1',
      status: 'board_vote_open',
      decision: 'strike3',
      strikeNumber: 3,
      founderReview: null,
      sanctionApplied: null,
      cause: {
        causeType: 'gross_misconduct',
        grossMisconductStatement: 'Gross misconduct under Const 10.9 head (a).',
        countedCaseIds: [],
        priorStrikesAtDecision: null,
      },
      statusHistory: [
        { from: 'decided', to: 'board_notice_issued', byUid: 'ngs-1', at: '2026-10-14T00:00:00.000Z' },
        { from: 'board_notice_issued', to: 'board_vote_open', byUid: 'ngs-1', at: '2026-10-21T00:00:00.000Z' },
      ],
    });

    const warm = await serverPerms.resolveIdentityForAuth(discDb, 'subject-1');
    expect(warm.isBanned).toBe(false);

    await applyExpulsionBan(
      discDb,
      'case-x',
      { voteId: 'v1', votesFor: 3, votesAgainst: 1, quorumMet: true },
      new Date('2026-10-21T12:00:00.000Z'),
    );
    expect(discDb.read('users/subject-1')?.isBanned).toBe(true);

    const after = await serverPerms.resolveIdentityForAuth(discDb, 'subject-1');
    expect(after.isBanned).toBe(true);
    const auth = await verifyAuthentication(req('/api/test', 'subject-1'));
    expect(auth.authenticated).toBe(false);
    expect(auth.error).toBe('Account Banned');
  });
});

// ------------------------------------------------------------------
// W7 - founder-review reinstate bust (real route, discipline fake)
// ------------------------------------------------------------------
describe('T-A3 W7 founder-review reinstate bust', () => {
  it('after reinstate, auth succeeds again immediately', async () => {
    const discDb: any = makeFakeDb();
    mockDbHolder.db = discDb;
    discDb.seed('users/s1', {
      displayName: 'S', role: 'team_member', warningCount: 3,
      chapterId: CHAPTER,
      isBanned: true, bannedBy: 'board:v1', bannedReason: 'Expelled by Board vote - case DISC-2026-0009',
      bannedAt: '2026-10-01T00:00:00.000Z', isBlacklisted: true,
    });
    discDb.seed('roles/s1', { role: 'team_member', chapterId: CHAPTER });
    discDb.seed('roles', FOUNDER_UID, { role: 'founder_patron', chapterId: CHAPTER });
    discDb.seed('users', FOUNDER_UID, { isBanned: false, chapterId: CHAPTER });
    discDb.seed('disciplinary_cases/c9', {
      caseId: 'c9', caseNumber: 'DISC-2026-0009', subjectUid: 's1', status: 'closed',
      decision: 'strike3', strikeNumber: 3, founderReview: null, statusHistory: [],
      subjectRoleSnapshot: 'chapter_president', boardVoteId: 'v1',
      sanctionApplied: { warningRecordId: null, suspensionDays: null, banVoteId: 'v1' },
    });

    const bannedAuth = await verifyAuthentication(req('/api/test', 's1'));
    expect(bannedAuth.authenticated).toBe(false);
    expect(bannedAuth.error).toBe('Account Banned');

    const res = await founderReviewPOST(req('/api/admin/founder-review', FOUNDER_UID, {
      caseId: 'c9', action: 'reinstate',
      noticeText: 'The Founder has reinstated your membership.',
      reason: 'New evidence reviewed.',
    }));
    expect(res.status).toBe(200);
    expect(discDb.read('users/s1')?.isBanned).toBe(false);

    const after = await verifyAuthentication(req('/api/test', 's1'));
    expect(after.authenticated).toBe(true);
  });
});

// ------------------------------------------------------------------
// W11 - role-permissions POST definition edit bust
// ------------------------------------------------------------------
describe('T-A3 W11 role-permissions POST bust', () => {
  it('a definition edit flips the hasServerPermission answer immediately', async () => {
    const counting = new CountingFirestore();
    mockDbHolder.db = counting.asDb();
    const db2 = counting.asDb();
    counting.seed('roles', FOUNDER_UID, { role: 'founder_patron', chapterId: CHAPTER });
    counting.seed('users', FOUNDER_UID, { isBanned: false, chapterId: CHAPTER });
    counting.seed('roleDefinitions', 'chapter_president', {
      name: 'Chapter President', permissions: ['canManageTasks'],
    });

    const before = await serverPerms.hasServerPermission('chapter_president', 'canManageUsers');
    expect(before).toBe(false);

    const res = await rolePermissionsPOST(req('/api/admin/role-permissions', FOUNDER_UID, {
      role: 'chapter_president',
      label: 'Chapter President',
      permissionKeys: ['canManageTasks', 'canManageUsers'],
    }));
    expect(res.status).toBe(200);

    const after = await serverPerms.hasServerPermission('chapter_president', 'canManageUsers');
    expect(after).toBe(true);
    void db2;
  });
});
