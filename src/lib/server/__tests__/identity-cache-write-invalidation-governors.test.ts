/**
 * @jest-environment node
 *
 * Read-Burn A, plan §5 T-A3 (g)/(h)/(i) + security review S2-1 (W14/W15)
 * - governor write-bust invalidation with ZERO clock advance: warm the
 * identity cache, run the REAL governor write path against the same
 * store, and assert the new role is visible immediately in-process.
 *
 * Covered bust rows: W14 (governors/register.ts assignSeat grant,
 * vacateSeat / removeSeat prior-role restore), W15 (governors/
 * term-sweep.ts per-seat expiry restore). The grant/restore composers
 * live in governors/shared.ts (grantGovernorRole / restorePriorRole)
 * and deliberately carry NO bust - the bust must fire after the
 * committing batch in register.ts / term-sweep.ts, so these tests
 * exercise the real committing functions end to end.
 *
 * "Zero clock advance": no fake timers, no TTL waiting, no manual
 * bustIdentity call anywhere in this file - the only thing that can
 * make the post-write resolution differ from the warmed one is the
 * write path's own post-commit bust. Against a bust-less governor
 * implementation every case below fails (the warmed bundle is served
 * for the full 30s TTL).
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
jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(async () => 'audit-1'),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));

import { NextRequest } from 'next/server';
import { CountingFirestore } from './helpers/counting-firestore';
import { resetIdentityCache } from '../identity-cache';
import * as serverPerms from '../permissions';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { FOUNDER_UID } from '@/lib/roles';
import {
  assignSeat,
  removeSeat,
  seedGovernors,
  vacateSeat,
  type GovernorActor,
} from '../governors/register';
import { runGovernorTermSweep } from '../governors/term-sweep';

const CHAPTER = 'seds-ist-chapter';
const NOW = new Date('2026-10-21T10:00:00Z');
/** Distinctive prior role so a restore is unambiguous (never the floor). */
const PRIOR_ROLE = 'chapter_president';

const founderActor: GovernorActor = {
  uid: FOUNDER_UID,
  name: 'Founder',
  role: 'founder_patron',
  authorized: true,
};
const keeperActor: GovernorActor = {
  uid: 'ngs-1',
  name: 'NGS',
  role: 'national_general_secretary',
  authorized: true,
};

function req(uid: string): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'GET',
    headers: { authorization: `Bearer tok:${uid}` },
  });
}

interface Harness {
  counting: CountingFirestore;
  db: never;
}

async function harness(): Promise<Harness> {
  const counting = new CountingFirestore();
  const db = counting.asDb();
  mockDbHolder.db = db;
  await seedGovernors(db, founderActor, {
    founderHolder: { uid: FOUNDER_UID, name: 'The Founder', email: 'founder@example.com' },
  });
  return { counting, db };
}

function addAccount(counting: CountingFirestore, uid: string): void {
  counting.seed('users', uid, {
    role: PRIOR_ROLE,
    displayRole: PRIOR_ROLE,
    displayName: `Holder ${uid}`,
    isBanned: false,
    chapterId: CHAPTER,
  });
  counting.seed('roles', uid, { role: PRIOR_ROLE, chapterId: CHAPTER });
}

/** Seat `uid` on Founder-Appointed seat 1 via the real assignSeat. */
async function seatFounderAppointed(h: Harness, uid: string): Promise<void> {
  h.counting.seed('consent_requests', 'consent-seat_fa_1', { status: 'consented' });
  await assignSeat(
    h.db,
    founderActor,
    'seat_fa_1',
    {
      holderUid: uid,
      holderName: `Holder ${uid}`,
      consentRequestId: 'consent-seat_fa_1',
      expectedVersion: 1,
    },
    NOW,
  );
}

beforeEach(() => {
  resetIdentityCache();
});

// ------------------------------------------------------------------
// T-A3 (g) - W14 assignSeat grant bust
// ------------------------------------------------------------------
describe('T-A3 (g) W14 assignSeat grant bust', () => {
  it('warm member -> real assignSeat -> immediate re-auth shows the governor role, zero clock advance', async () => {
    const h = await harness();
    addAccount(h.counting, 'gov-g');

    // Warm the cache with the pre-grant role.
    const warm = await serverPerms.resolveIdentityForAuth(h.db, 'gov-g');
    expect(warm.role).toBe(PRIOR_ROLE);
    const warmAuth = await verifyAuthentication(req('gov-g'));
    expect(warmAuth.authenticated).toBe(true);
    expect(warmAuth.user?.role).toBe(PRIOR_ROLE);

    await seatFounderAppointed(h, 'gov-g');

    // Sanity: the real write landed in both stores.
    expect(h.counting.read('roles', 'gov-g')?.role).toBe('governor_founder');
    expect(h.counting.read('users', 'gov-g')?.role).toBe('governor_founder');

    // Immediate re-resolution / re-auth: no clock advance, no manual
    // bust. Without the W14 post-commit bust this still serves the
    // warmed chapter_president bundle.
    const after = await serverPerms.resolveIdentityForAuth(h.db, 'gov-g');
    expect(after.role).toBe('governor_founder');
    const afterAuth = await verifyAuthentication(req('gov-g'));
    expect(afterAuth.authenticated).toBe(true);
    expect(afterAuth.user?.role).toBe('governor_founder');
  });
});

// ------------------------------------------------------------------
// T-A3 (h) - W14 vacateSeat / removeSeat restore busts
// ------------------------------------------------------------------
describe('T-A3 (h) W14 vacateSeat/removeSeat restore busts', () => {
  it('warm governor holder -> real vacateSeat -> immediate re-auth shows the restored prior role', async () => {
    const h = await harness();
    addAccount(h.counting, 'gov-hv');
    await seatFounderAppointed(h, 'gov-hv');
    expect(h.counting.read('roles', 'gov-hv')?.role).toBe('governor_founder');

    // Warm the cache with the governor role.
    const warm = await serverPerms.resolveIdentityForAuth(h.db, 'gov-hv');
    expect(warm.role).toBe('governor_founder');

    await vacateSeat(
      h.db,
      keeperActor,
      'seat_fa_1',
      {
        reason: 'resigned',
        detail: 'Resigned by letter dated 2026-10-20',
        recordRef: 'resignation-letter-1',
        expectedVersion: 2,
      },
      NOW,
    );

    // Sanity: the real restore landed in both stores.
    expect(h.counting.read('roles', 'gov-hv')?.role).toBe(PRIOR_ROLE);
    expect(h.counting.read('users', 'gov-hv')?.role).toBe(PRIOR_ROLE);

    const after = await serverPerms.resolveIdentityForAuth(h.db, 'gov-hv');
    expect(after.role).toBe(PRIOR_ROLE);
    const afterAuth = await verifyAuthentication(req('gov-hv'));
    expect(afterAuth.authenticated).toBe(true);
    expect(afterAuth.user?.role).toBe(PRIOR_ROLE);
  });

  it('warm governor holder -> real removeSeat -> immediate re-auth shows the restored prior role', async () => {
    const h = await harness();
    addAccount(h.counting, 'gov-hr');
    await seatFounderAppointed(h, 'gov-hr');
    expect(h.counting.read('roles', 'gov-hr')?.role).toBe('governor_founder');

    // Warm the cache with the governor role.
    const warm = await serverPerms.resolveIdentityForAuth(h.db, 'gov-hr');
    expect(warm.role).toBe('governor_founder');

    await removeSeat(
      h.db,
      founderActor,
      'seat_fa_1',
      {
        removal: { causeDetail: 'Removed at the Founder discretion after review' },
        expectedVersion: 2,
      },
      NOW,
    );

    // Sanity: the real restore landed in both stores.
    expect(h.counting.read('roles', 'gov-hr')?.role).toBe(PRIOR_ROLE);
    expect(h.counting.read('users', 'gov-hr')?.role).toBe(PRIOR_ROLE);

    const after = await serverPerms.resolveIdentityForAuth(h.db, 'gov-hr');
    expect(after.role).toBe(PRIOR_ROLE);
    const afterAuth = await verifyAuthentication(req('gov-hr'));
    expect(afterAuth.authenticated).toBe(true);
    expect(afterAuth.user?.role).toBe(PRIOR_ROLE);
  });
});

// ------------------------------------------------------------------
// T-A3 (i) - W15 term-sweep expiry restore bust
// ------------------------------------------------------------------
describe('T-A3 (i) W15 term-sweep expiry restore bust', () => {
  it('warm governor holder -> real runGovernorTermSweep past termEnd -> immediate re-auth shows the restored prior role', async () => {
    const h = await harness();
    addAccount(h.counting, 'gov-i');

    // Seat on a termed (co-opted) seat via the real assignSeat.
    h.counting.seed('governance_votes', 'vote-co1', {
      kind: 'cooption',
      seatKey: 'seat_co_1',
      candidateName: 'Holder gov-i',
      status: 'closed',
      outcome: 'passed',
      seatedCountAtOpen: 1,
      votesFor: 1,
      founderPresent: true,
    });
    await assignSeat(
      h.db,
      founderActor,
      'seat_co_1',
      {
        holderUid: 'gov-i',
        holderName: 'Holder gov-i',
        voteRecordId: 'vote-co1',
        expectedVersion: 1,
      },
      NOW,
    );
    expect(h.counting.read('roles', 'gov-i')?.role).toBe('governor_coopted');

    // Force the term into the past (out-of-band seed of the seat doc
    // only - the holder's identity docs are untouched).
    const seat = h.counting.read('governors', 'seat_co_1');
    expect(seat).toBeDefined();
    h.counting.seed('governors', 'seat_co_1', {
      ...seat,
      termEnd: new Date('2026-10-01T00:00:00Z'),
    });

    // Warm the cache with the governor role.
    const warm = await serverPerms.resolveIdentityForAuth(h.db, 'gov-i');
    expect(warm.role).toBe('governor_coopted');
    const warmAuth = await verifyAuthentication(req('gov-i'));
    expect(warmAuth.authenticated).toBe(true);
    expect(warmAuth.user?.role).toBe('governor_coopted');

    const summary = await runGovernorTermSweep(h.db, NOW);
    expect(summary.expiredMaterialised).toContain('seat_co_1');

    // Sanity: the real restore landed in both stores.
    expect(h.counting.read('roles', 'gov-i')?.role).toBe(PRIOR_ROLE);
    expect(h.counting.read('users', 'gov-i')?.role).toBe(PRIOR_ROLE);

    // Immediate re-resolution / re-auth, zero clock advance. Without
    // the W15 post-commit bust this still serves governor_coopted.
    const after = await serverPerms.resolveIdentityForAuth(h.db, 'gov-i');
    expect(after.role).toBe(PRIOR_ROLE);
    const afterAuth = await verifyAuthentication(req('gov-i'));
    expect(afterAuth.authenticated).toBe(true);
    expect(afterAuth.user?.role).toBe(PRIOR_ROLE);
  });
});
