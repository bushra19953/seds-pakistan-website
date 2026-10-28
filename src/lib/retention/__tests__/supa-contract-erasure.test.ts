/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 6.
 *
 * Invariant 6 (ERASURE): executing an erasure request does exactly
 * the deletion/anonymisation set in src/lib/retention/erasure.ts
 * and nothing beyond it. Lifecycle states are exactly
 * 'cooling_off' -> 'executed' | 'withdrawn' (erasure.ts:36, and
 * there is no other status value in the module).
 *
 * The exact execution set (executeErasure, erasure.ts:112-181):
 *  1. users/{uid} merged with the 11-field tombstone set
 *     (TOMBSTONE_FIELDS :92-104) + erasedAt — merge, so fields
 *     outside the set (e.g. role, warningCount) survive untouched;
 *  2. roles/{uid}.memberStatus='erased' ONLY if the role doc exists
 *     (no role doc is created);
 *  3. points_ledger docs with userId==uid get
 *     { userId: pseudonym, erasedPseudonym: true } — other users'
 *     ledger docs and all other fields untouched;
 *  4. the Firebase Auth account is deleted exactly once, LAST;
 *  5. the erasure_requests record is RETAINED, updated to
 *     status='executed' with executedAt/executedBy/pseudonym;
 *  6. one ERASURE_EXECUTED audit entry.
 * The pseudonym is `erased-` + first 12 hex chars of sha256(uid)
 * (erasure.ts:49-51): stable and deterministic.
 *
 * Request side: requestErasure creates status 'cooling_off' with
 * executeAfter exactly requestedAt + 14 days (COOLING_OFF_DAYS),
 * rejects a second open request, and executeErasure before
 * executeAfter throws and writes NOTHING. Withdrawal is owner-only
 * and only from cooling_off.
 */
import { createHash } from 'node:crypto';
jest.mock('@/lib/server/user-contact', () => ({
  clearUserContact: jest.fn(async () => undefined),
}));
import { FakeFirestore } from '../../governance/__tests__/fake-firestore';
import {
  COOLING_OFF_DAYS,
  ERASURE_REQUESTS_COLLECTION,
  executeErasure,
  pseudonymFor,
  requestErasure,
  withdrawErasure,
  type ErasureDeps,
} from '../erasure';

const T0 = new Date('2026-10-01T00:00:00.000Z');
const DAY = 86400000;

function makeWorld() {
  const db = new FakeFirestore();
  db.seed('users', 'u-erase', {
    displayName: 'Leaving Member',
    email: 'leaving@example.com',
    photoURL: 'https://example.com/p.png',
    phoneNumber: '+92-300', phone: '+92-300', cnic: '35202-x', address: 'Somewhere', bio: 'hello',
    hasApplied: true, applicationStatus: 'approved',
    memberStatus: 'active',
    role: 'chapter_treasurer', // outside the tombstone set: must survive
    warningCount: 2, // outside the tombstone set: must survive
  });
  db.seed('users', 'u-other', { displayName: 'Other', email: 'o@example.com' });
  db.seed('roles', 'u-erase', { role: 'chapter_treasurer', chapterSlug: 'ist' });
  db.seed('points_ledger', 'pl-1', { userId: 'u-erase', points: 40 });
  db.seed('points_ledger', 'pl-2', { userId: 'u-erase', points: 5 });
  db.seed('points_ledger', 'pl-3', { userId: 'someone-else', points: 7 });
  const authDeletes: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let clock = T0;
  const deps: ErasureDeps = {
    db: db as unknown as ErasureDeps['db'],
    deleteAuthUser: async (uid) => { authDeletes.push(uid); },
    writeAudit: async (entry) => { audits.push(entry); },
    now: () => clock,
  };
  return { db, deps, authDeletes, audits, advanceDays: (d: number) => { clock = new Date(clock.getTime() + d * DAY); } };
}

describe('CONTRACT 6a: pseudonym is a stable sha256-derived erased-<12 hex> id', () => {
  it('matches the exact derivation and is deterministic per uid', () => {
    const expected = `erased-${createHash('sha256').update('u-erase').digest('hex').slice(0, 12)}`;
    expect(pseudonymFor('u-erase')).toBe(expected);
    expect(pseudonymFor('u-erase')).toMatch(/^erased-[0-9a-f]{12}$/);
    expect(pseudonymFor('u-erase')).toBe(pseudonymFor('u-erase'));
    expect(pseudonymFor('u-other')).not.toBe(pseudonymFor('u-erase'));
  });
  it('the cooling-off constant is 14 days', () => {
    expect(COOLING_OFF_DAYS).toBe(14);
    expect(ERASURE_REQUESTS_COLLECTION).toBe('erasure_requests');
  });
});

describe('CONTRACT 6b: request lifecycle states', () => {
  it('request creates cooling_off with executeAfter exactly +14d and null execution fields', async () => {
    const w = makeWorld();
    const { requestId, executeAfter } = await requestErasure(w.deps, 'u-erase');
    expect(executeAfter).toBe(new Date(T0.getTime() + 14 * DAY).toISOString());
    const req = w.db.getDoc('erasure_requests', requestId);
    expect(req).toMatchObject({
      uid: 'u-erase', status: 'cooling_off', reason: null,
      requestedAt: T0.toISOString(), executeAfter, executedAt: null, executedBy: null,
    });
    expect(w.audits).toEqual([
      expect.objectContaining({ type: 'ERASURE_REQUESTED', actorId: 'u-erase', targetId: 'u-erase' }),
    ]);
    // A second open request for the same uid is rejected.
    await expect(requestErasure(w.deps, 'u-erase')).rejects.toThrow(/already in its cooling-off/);
  });

  it('executing before the cooling-off ends throws and writes NOTHING', async () => {
    const w = makeWorld();
    const { requestId } = await requestErasure(w.deps, 'u-erase');
    const userBefore = { ...w.db.getDoc('users', 'u-erase') };
    w.advanceDays(13);
    await expect(executeErasure(w.deps, requestId, 'admin-1')).rejects.toThrow(/Cooling-off period has not ended/);
    expect(w.db.getDoc('users', 'u-erase')).toEqual(userBefore);
    expect(w.db.getDoc('roles', 'u-erase')?.memberStatus).toBeUndefined();
    expect(w.db.getDoc('points_ledger', 'pl-1')?.userId).toBe('u-erase');
    expect(w.authDeletes).toHaveLength(0);
    expect(w.db.getDoc('erasure_requests', requestId)?.status).toBe('cooling_off');
  });

  it('withdrawal is owner-only, cooling_off-only, and blocks later execution', async () => {
    const w = makeWorld();
    const { requestId } = await requestErasure(w.deps, 'u-erase');
    await expect(withdrawErasure(w.deps, requestId, 'someone-else')).rejects.toThrow(/Not your erasure request/);
    await withdrawErasure(w.deps, requestId, 'u-erase');
    const req = w.db.getDoc('erasure_requests', requestId);
    expect(req?.status).toBe('withdrawn');
    expect(req?.withdrawnAt).toBe(T0.toISOString());
    w.advanceDays(30);
    await expect(executeErasure(w.deps, requestId, 'admin-1')).rejects.toThrow(/is withdrawn, not cooling_off/);
    expect(w.authDeletes).toHaveLength(0);
  });

  it('executing a missing request throws not-found', async () => {
    const w = makeWorld();
    await expect(executeErasure(w.deps, 'no-such-id', 'admin-1')).rejects.toThrow(/Erasure request not found/);
  });
});

describe('CONTRACT 6c: execution does exactly the pinned set and nothing beyond it', () => {
  it('tombstone + role mirror + ledger pseudonymisation + one auth delete + retained request record', async () => {
    const w = makeWorld();
    const { requestId } = await requestErasure(w.deps, 'u-erase', 'leaving the society');
    w.advanceDays(14); // exactly at executeAfter: executable
    const result = await executeErasure(w.deps, requestId, 'admin-1');
    const pseudonym = pseudonymFor('u-erase');
    expect(result).toEqual({ uid: 'u-erase', pseudonym });

    // 1. Tombstone: exactly the 11 fields + erasedAt changed; the rest survives (merge).
    const user = w.db.getDoc('users', 'u-erase')!;
    expect(user.memberStatus).toBe('erased');
    expect(user.displayName).toBe('Erased member');
    expect(user.email).toBeNull();
    expect(user.photoURL).toBeNull();
    expect(user.phoneNumber).toBeNull();
    expect(user.phone).toBeNull();
    expect(user.cnic).toBeNull();
    expect(user.address).toBeNull();
    expect(user.bio).toBeNull();
    expect(user.hasApplied).toBe(false);
    expect(user.applicationStatus).toBeNull();
    expect(user.erasedAt).toBe(new Date(T0.getTime() + 14 * DAY).toISOString());
    expect(user.role).toBe('chapter_treasurer'); // beyond the set: untouched
    expect(user.warningCount).toBe(2); // beyond the set: untouched
    expect(w.db.getDoc('users', 'u-other')).toEqual({ displayName: 'Other', email: 'o@example.com' });

    // 2. Role mirror: only memberStatus added; role fields survive.
    expect(w.db.getDoc('roles', 'u-erase')).toEqual({ role: 'chapter_treasurer', chapterSlug: 'ist', memberStatus: 'erased' });

    // 3. Ledger: only this uid's docs, only userId + erasedPseudonym change.
    expect(w.db.getDoc('points_ledger', 'pl-1')).toEqual({ userId: pseudonym, points: 40, erasedPseudonym: true });
    expect(w.db.getDoc('points_ledger', 'pl-2')).toEqual({ userId: pseudonym, points: 5, erasedPseudonym: true });
    expect(w.db.getDoc('points_ledger', 'pl-3')).toEqual({ userId: 'someone-else', points: 7 });

    // 4. Auth deleted exactly once.
    expect(w.authDeletes).toEqual(['u-erase']);

    // 5. Request record retained as proof, now executed.
    const req = w.db.getDoc('erasure_requests', requestId)!;
    expect(req.status).toBe('executed');
    expect(req.executedBy).toBe('admin-1');
    expect(req.executedAt).toBe(new Date(T0.getTime() + 14 * DAY).toISOString());
    expect(req.pseudonym).toBe(pseudonym);
    expect(req.reason).toBe('leaving the society');

    // 6. Exactly one execution audit (plus the request audit).
    expect(w.audits.filter((a) => a.type === 'ERASURE_EXECUTED')).toEqual([
      expect.objectContaining({ actorId: 'admin-1', targetId: 'u-erase', data: { requestId, pseudonym } }),
    ]);

    // Re-execution is impossible: status has left cooling_off, auth stays deleted-once.
    await expect(executeErasure(w.deps, requestId, 'admin-1')).rejects.toThrow(/is executed, not cooling_off/);
    expect(w.authDeletes).toEqual(['u-erase']);
  });

  it('a user with no roles doc gets none created by erasure', async () => {
    const w = makeWorld();
    const { requestId } = await requestErasure(w.deps, 'u-other');
    w.advanceDays(15);
    await executeErasure(w.deps, requestId, 'admin-1');
    expect(w.db.getDoc('roles', 'u-other')).toBeUndefined();
    expect(w.db.getDoc('users', 'u-other')?.memberStatus).toBe('erased');
  });
});
