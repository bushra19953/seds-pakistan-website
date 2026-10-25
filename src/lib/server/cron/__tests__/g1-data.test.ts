/**
 * @jest-environment node
 *
 * Seam tests for the G1 cron group (src/lib/server/cron/g1-data.ts).
 * Everything runs against the adapter's in-memory FakeSupa; zero live
 * reads. Covers:
 *  - the PLAN_G1 §3 timestamp hotspot: a task row whose deadline is an
 *    ISO string (the adapter's storage shape) is rehydrated to a
 *    Timestamp-like object by the seam's task queries, so
 *    remind-deadlines' `task.deadline?.toDate()` consumption works;
 *  - flag-OFF resolution: with no handle, the seam returns the
 *    Firestore db object untouched (identity), i.e. behaviour is
 *    byte-identical to the pre-migration routes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '../../../supa';
import { FakeSupa, landingRow } from '../../../supa/__tests__/fake-supa';
import { createSupaDbHandle, type SupaDbHandle } from '../../supa-db-handle';
import {
  getCronG1Db,
  queryAcceptanceTasks,
  queryDueSoonTasks,
  rehydrateTaskData,
  resolveCronG1Db,
  wrapCronG1Handle,
} from '../g1-data';

const mockFirestoreDb = { __firestoreSentinel: true };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockFirestoreDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

function makeHandle(): { handle: SupaDbHandle; fake: FakeSupa } {
  const fake = new FakeSupa();
  const adapter = createSupaAdapter(fake as unknown as SupabaseClient);
  return { handle: createSupaDbHandle(adapter), fake };
}

describe('g1-data seam — timestamp hotspot (PLAN_G1 §3)', () => {
  it('raw handle returns the ISO string; the seam rehydrates deadline/createdAt to Timestamp-like', async () => {
    const { handle, fake } = makeHandle();
    const deadlineIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    fake.seed('fs_tasks', [
      landingRow('t-due', {
        title: 'Due soon',
        status: 'pending',
        assigneeIds: ['u-9'],
        deadline: deadlineIso,
      }),
    ]);

    // Proof the hotspot is real: through the unwrapped handle the
    // deadline is a plain string and .toDate does not exist.
    const rawDb = handle as any;
    const rawSnap = await rawDb
      .collection('tasks')
      .where('status', 'in', ['pending', 'in-progress'])
      .where('deadline', '>=', new Date(Date.now() + 23 * 3600 * 1000))
      .where('deadline', '<=', new Date(Date.now() + 25 * 3600 * 1000))
      .get();
    expect(rawSnap.size).toBe(1);
    expect(typeof rawSnap.docs[0].data().deadline).toBe('string');
    expect(rawSnap.docs[0].data().deadline.toDate).toBeUndefined();

    // Through the seam helper the same row is selected AND its
    // deadline is Timestamp-like with the right instant.
    const db = wrapCronG1Handle(handle);
    const snap = await queryDueSoonTasks(
      db,
      new Date(Date.now() + 23 * 3600 * 1000),
      new Date(Date.now() + 25 * 3600 * 1000),
    );
    expect(snap.size).toBe(1);
    const task = snap.docs[0].data();
    expect(typeof task.deadline?.toDate).toBe('function');
    expect(task.deadline.toDate().toISOString()).toBe(deadlineIso);
    // The remind route's label path: toDate() -> toLocaleString works.
    expect(task.deadline.toDate().getTime()).toBe(Date.parse(deadlineIso));
  });

  it('acceptance query rehydrates createdAt so the 24h grace check can run', async () => {
    const { handle, fake } = makeHandle();
    const createdIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    fake.seed('fs_tasks', [
      landingRow('t-acc', {
        title: 'Unaccepted',
        status: 'pending',
        acceptanceStatus: 'pending-acceptance',
        assigneeIds: ['u-7'],
        createdAt: createdIso,
      }),
    ]);
    const db = wrapCronG1Handle(handle);
    const snap = await queryAcceptanceTasks(db);
    expect(snap.size).toBe(1);
    const task = snap.docs[0].data();
    expect(typeof task.createdAt?.toDate).toBe('function');
    expect(task.createdAt.toDate().toISOString()).toBe(createdIso);
    expect(Date.now() - task.createdAt.toDate().getTime()).toBeGreaterThan(
      24 * 3600 * 1000,
    );
  });

  it('rehydrateTaskData leaves Timestamp-like and non-ISO values untouched', () => {
    const tsLike = { toDate: () => new Date(0), toMillis: () => 0 };
    const out = rehydrateTaskData({
      deadline: tsLike,
      createdAt: 'not-a-date',
      title: 'x',
    } as any);
    expect((out as any).deadline).toBe(tsLike);
    expect((out as any).createdAt).toBe('not-a-date');
    expect((out as any).title).toBe('x');
  });
});

describe('g1-data seam — flag OFF is byte-identical Firestore', () => {
  it('resolveCronG1Db(null, firestoreDb) returns the Firestore db by identity', () => {
    expect(resolveCronG1Db(null, mockFirestoreDb)).toBe(mockFirestoreDb);
  });

  it("getCronG1Db() with SUPA_SURFACES unset returns getDb()'s object", () => {
    delete process.env.SUPA_SURFACES;
    expect(getCronG1Db()).toBe(mockFirestoreDb);
  });

  it('resolveCronG1Db(handle, firestoreDb) returns a wrapped handle, not the Firestore db', () => {
    const { handle } = makeHandle();
    const db = resolveCronG1Db(handle, mockFirestoreDb);
    expect(db).not.toBe(mockFirestoreDb);
    expect(typeof db.collection).toBe('function');
    expect(typeof db.batch).toBe('function');
  });
});
