/**
 * @jest-environment node
 *
 * Contract tests for the cron cluster's shared Firestore-shaped db
 * handle over the Supabase adapter (src/lib/server/supa-db-handle.ts).
 * Everything runs against the adapter's in-memory FakeSupa; zero live
 * reads. FieldValue sentinels are the REAL firebase-admin transforms,
 * so structural sentinel detection is tested against the genuine
 * objects the shared libraries construct.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { FieldValue } from 'firebase-admin/firestore';
import { createSupaAdapter } from '../../supa';
import { SupaTimestamp } from '../../supa/adapter';
import { FakeSupa, landingRow } from '../../supa/__tests__/fake-supa';
import {
  createSupaDbHandle,
  rehydrateTimestampFields,
  type SupaDbHandle,
} from '../supa-db-handle';

function makeDb(): { db: SupaDbHandle; fake: FakeSupa } {
  const fake = new FakeSupa();
  const adapter = createSupaAdapter(fake as unknown as SupabaseClient);
  return { db: createSupaDbHandle(adapter), fake };
}

describe('doc CRUD + snapshots', () => {
  it('set/get round-trips and data() carries no synthetic id', async () => {
    const { db } = makeDb();
    await db.doc('tasks/t1').set({ title: 'A', status: 'pending' });
    const snap = await db.doc('tasks/t1').get();
    expect(snap.exists).toBe(true);
    expect(snap.id).toBe('t1');
    expect(snap.data()).toEqual({ title: 'A', status: 'pending' });
  });

  it('get on a missing doc reports exists=false', async () => {
    const { db } = makeDb();
    const snap = await db.doc('tasks/nope').get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
  });

  it('set without merge replaces; set with merge merges top-level keys', async () => {
    const { db } = makeDb();
    await db.doc('settings/x').set({ a: 1, b: 2 });
    await db.doc('settings/x').set({ c: 3 }, { merge: true });
    expect((await db.doc('settings/x').get()).data()).toEqual({ a: 1, b: 2, c: 3 });
    await db.doc('settings/x').set({ d: 4 });
    expect((await db.doc('settings/x').get()).data()).toEqual({ d: 4 });
  });

  it('update on a missing doc throws not-found, like Firestore', async () => {
    const { db } = makeDb();
    await expect(db.doc('tasks/ghost').update({ a: 1 })).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('delete removes the doc', async () => {
    const { db } = makeDb();
    await db.doc('tasks/t1').set({ a: 1 });
    await db.doc('tasks/t1').delete();
    expect((await db.doc('tasks/t1').get()).exists).toBe(false);
  });
});

describe('FieldValue sentinel resolution', () => {
  it('serverTimestamp resolves to a stored ISO string at write time', async () => {
    const { db, fake } = makeDb();
    await db.doc('tasks/t1').set({ title: 'A' });
    await db
      .doc('tasks/t1')
      .update({ reminder24hSentAt: FieldValue.serverTimestamp() });
    const stored = fake.rows('fs_tasks')[0].data.reminder24hSentAt;
    expect(typeof stored).toBe('string');
    expect(Number.isFinite(Date.parse(stored as string))).toBe(true);
  });

  it('delete sentinel REMOVES the key (never nulls it)', async () => {
    const { db } = makeDb();
    await db.doc('tasks/t1').set({ reminder24hError: 'boom', keep: 1 });
    await db
      .doc('tasks/t1')
      .update({ reminder24hError: FieldValue.delete() });
    const data = (await db.doc('tasks/t1').get()).data()!;
    expect(data).toEqual({ keep: 1 });
    expect('reminder24hError' in data).toBe(false);
  });

  it('increment resolves against current value; missing field takes the operand', async () => {
    const { db } = makeDb();
    await db.doc('users/u1').set({ points: 10 });
    await db.doc('users/u1').update({ points: FieldValue.increment(5) });
    expect((await db.doc('users/u1').get()).data()?.points).toBe(15);
    await db.doc('users/u2').set({}, { merge: true });
    await db.doc('users/u2').update({ points: FieldValue.increment(7) });
    expect((await db.doc('users/u2').get()).data()?.points).toBe(7);
  });

  it('arrayUnion dedupes; arrayRemove filters', async () => {
    const { db } = makeDb();
    await db.doc('users/u1').set({ badges: ['a'] });
    await db.doc('users/u1').update({ badges: FieldValue.arrayUnion('a', 'b') });
    expect((await db.doc('users/u1').get()).data()?.badges).toEqual(['a', 'b']);
    await db.doc('users/u1').update({ badges: FieldValue.arrayRemove('a') });
    expect((await db.doc('users/u1').get()).data()?.badges).toEqual(['b']);
  });

  it('dot-path update keys expand into nested objects', async () => {
    const { db } = makeDb();
    await db.doc('users/u1').set({ deliveryStatus: { email: 'sent' } });
    await db.doc('users/u1').update({ 'deliveryStatus.push': 'queued' });
    expect((await db.doc('users/u1').get()).data()?.deliveryStatus).toEqual({
      email: 'sent',
      push: 'queued',
    });
  });
});

describe('queries', () => {
  it('where + orderBy + limit compose; snapshot shape is Firestore-like', async () => {
    const { db } = makeDb();
    await db.doc('tasks/a').set({ status: 'pending', n: 2 });
    await db.doc('tasks/b').set({ status: 'pending', n: 1 });
    await db.doc('tasks/c').set({ status: 'done', n: 3 });
    const snap = await db
      .collection('tasks')
      .where('status', '==', 'pending')
      .orderBy('n', 'asc')
      .limit(1)
      .get();
    expect(snap.size).toBe(1);
    expect(snap.empty).toBe(false);
    expect(snap.docs[0].id).toBe('b');
    expect(snap.docs[0].ref.path).toBe('tasks/b');
    const seen: string[] = [];
    snap.forEach((d) => seen.push(d.id));
    expect(seen).toEqual(['b']);
  });

  it('count() returns the aggregate shape process-dlq consumes', async () => {
    const { db } = makeDb();
    await db.doc('points_ledger/l1').set({ user_id: 'u1', task_id: 't1' });
    await db.doc('points_ledger/l2').set({ user_id: 'u1', task_id: 't2' });
    const agg = await db
      .collection('points_ledger')
      .where('user_id', '==', 'u1')
      .where('task_id', '==', 't1')
      .count()
      .get();
    expect(agg.data().count).toBe(1);
  });

  it("startAfter(lastSnapshot) pages by id under orderBy('__name__')", async () => {
    const { db } = makeDb();
    for (const id of ['a', 'b', 'c']) {
      await db.doc(`backup_runs/${id}`).set({ startedAt: id });
    }
    const page1 = await db
      .collection('backup_runs')
      .orderBy('__name__')
      .limit(2)
      .get();
    expect(page1.docs.map((d) => d.id)).toEqual(['a', 'b']);
    const page2 = await db
      .collection('backup_runs')
      .orderBy('__name__')
      .limit(2)
      .startAfter(page1.docs[page1.docs.length - 1])
      .get();
    expect(page2.docs.map((d) => d.id)).toEqual(['c']);
  });

  it('unsupported operators throw loudly instead of mistranslating', async () => {
    const { db } = makeDb();
    expect(() => db.collection('tasks').where('x', 'not-in', [1])).toThrow(
      /unsupported where operator/,
    );
  });
});

describe('subcollections + auto-ids', () => {
  it('users/{uid}/warnings resolves through parent_path addressing', async () => {
    const { db, fake } = makeDb();
    const ref = await db
      .doc('users/u1')
      .collection('warnings')
      .add({ isActive: true, reason: 'x' });
    expect(ref.id).toHaveLength(20);
    const snap = await db
      .collection('users/u1/warnings')
      .where('isActive', '==', true)
      .get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].data()?.reason).toBe('x');
    expect(fake.rows('fs_group_warnings')[0].parent_path).toBe('users/u1/warnings');
    // A different user's subcollection stays separate.
    const other = await db.collection('users/u2/warnings').get();
    expect(other.empty).toBe(true);
  });

  it('collection().doc() with no id mints an auto-id ref', async () => {
    const { db } = makeDb();
    const ref = db.collection('audit_logs').doc();
    expect(ref.id).toHaveLength(20);
    await ref.set({ type: 'X' });
    expect((await db.doc(`audit_logs/${ref.id}`).get()).exists).toBe(true);
  });
});

describe('batch (collect-then-commit emulation)', () => {
  it('applies set/update/delete in order at commit, nothing before', async () => {
    const { db } = makeDb();
    await db.doc('tasks/t1').set({ status: 'pending' });
    await db.doc('tasks/t2').set({ status: 'pending' });
    const batch = db.batch();
    batch.update(db.doc('tasks/t1'), { status: 'overdue' });
    batch.set(db.doc('users/u1'), { total_points: FieldValue.increment(30) }, { merge: true });
    batch.delete(db.doc('tasks/t2'));
    // Nothing applied before commit.
    expect((await db.doc('tasks/t1').get()).data()?.status).toBe('pending');
    await batch.commit();
    expect((await db.doc('tasks/t1').get()).data()?.status).toBe('overdue');
    expect((await db.doc('users/u1').get()).data()?.total_points).toBe(30);
    expect((await db.doc('tasks/t2').get()).exists).toBe(false);
  });
});

describe('transaction (buffered-write emulation)', () => {
  it('buffers writes until the callback returns, then applies them', async () => {
    const { db } = makeDb();
    await db.doc('tasks/t1').set({ rewardApplied: false });
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.doc('tasks/t1'));
      expect(snap.data()?.rewardApplied).toBe(false);
      tx.update(db.doc('tasks/t1'), { rewardApplied: true });
      tx.set(db.doc('users/u1/rewards/t1'), { points: 10 }, { merge: true });
      // Buffered: the outside world still sees the old state mid-tx.
      expect((await db.doc('tasks/t1').get()).data()?.rewardApplied).toBe(false);
      return 'done';
    });
    expect(result).toBe('done');
    expect((await db.doc('tasks/t1').get()).data()?.rewardApplied).toBe(true);
    expect((await db.doc('users/u1/rewards/t1').get()).data()?.points).toBe(10);
  });

  it('a throwing callback applies nothing', async () => {
    const { db } = makeDb();
    await db.doc('tasks/t1').set({ n: 1 });
    await expect(
      db.runTransaction(async (tx) => {
        tx.update(db.doc('tasks/t1'), { n: 2 });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await db.doc('tasks/t1').get()).data()?.n).toBe(1);
  });
});

describe('rehydrateTimestampFields (group-seam hotspot tool)', () => {
  it('converts ISO strings to SupaTimestamp and leaves other values alone', () => {
    const out = rehydrateTimestampFields(
      { deadline: '2026-10-26T00:00:00.000Z', note: 'plain', n: 5 },
      ['deadline', 'note', 'n', 'absent'],
    );
    expect(out.deadline).toBeInstanceOf(SupaTimestamp);
    expect((out.deadline as SupaTimestamp).toMillis()).toBe(
      Date.parse('2026-10-26T00:00:00.000Z'),
    );
    expect(out.note).toBe('plain');
    expect(out.n).toBe(5);
  });

  it('seeded dumped timestamps come back through the adapter as SupaTimestamp', async () => {
    const fake = new FakeSupa().seed('fs_tasks', [
      landingRow('t1', {
        deadline: { _seconds: 1793000000, _nanoseconds: 0 },
      }),
    ]);
    const adapter = createSupaAdapter(fake as unknown as SupabaseClient);
    const db = createSupaDbHandle(adapter);
    const data = (await db.doc('tasks/t1').get()).data()!;
    expect(data.deadline).toBeInstanceOf(SupaTimestamp);
  });
});
