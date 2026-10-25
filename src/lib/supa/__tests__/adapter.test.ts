/**
 * @jest-environment node
 *
 * adapter.test.ts — unit tests for the Firestore-shaped Supabase adapter
 * (src/lib/supa/adapter.ts). The Supabase client is a recording fake
 * (fake-client.ts): every assertion is on the exact PostgREST translation
 * the adapter emits and the Firestore shape it returns. ZERO live calls:
 * no Supabase project, no Firestore.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createSupaAdapter,
  firebaseUidForPath,
  getSupaAdapter,
  resolveTarget,
  tableForCollection,
  SupaAdapterError,
  SupaUnavailableError,
  type WhereClause,
} from '@/lib/supa/adapter';
import { FakeClient, type RecordedCall } from './fake-client';

function adapterWith(fake: FakeClient) {
  return createSupaAdapter(fake as unknown as SupabaseClient);
}

function callNames(calls: RecordedCall[]): string[] {
  return calls.map((c) => c[0]);
}

describe('target resolution', () => {
  it('maps collection names to fs_* tables with the kit sanitization', () => {
    expect(tableForCollection('tasks')).toBe('fs_tasks');
    expect(tableForCollection('audit_logs')).toBe('fs_audit_logs');
    expect(tableForCollection('users')).toBe('fs_users');
  });

  it('resolves a top-level collection', () => {
    expect(resolveTarget('tasks')).toEqual({
      table: 'fs_tasks',
      parentPath: 'tasks',
      isSubcollection: false,
    });
  });

  it('resolves the users/{uid}/notifications subcollection family', () => {
    expect(resolveTarget('users/U1/notifications')).toEqual({
      table: 'fs_group_notifications',
      parentPath: 'users/U1/notifications',
      isSubcollection: true,
    });
  });

  it('resolves the events/{id}/registrations subcollection family', () => {
    expect(resolveTarget('events/E1/registrations').table).toBe(
      'fs_group_registrations',
    );
  });

  it('rejects document paths and deeper paths', () => {
    expect(() => resolveTarget('users/U1')).toThrow(SupaAdapterError);
    expect(() => resolveTarget('a/b/c/d')).toThrow(SupaAdapterError);
  });
});

describe('firebaseUidForPath (migration kit rule)', () => {
  it('takes the segment after users', () => {
    expect(firebaseUidForPath(['users', 'U1'])).toBe('U1');
    expect(firebaseUidForPath(['users', 'U1', 'notifications', 'N1'])).toBe('U1');
  });

  it('is null when no users segment owns the doc', () => {
    expect(firebaseUidForPath(['tasks', 'T1'])).toBeNull();
    expect(firebaseUidForPath(['events', 'E1', 'registrations', 'R1'])).toBeNull();
  });
});

describe('getDoc', () => {
  it('returns the Firestore shape {id, ...data} and queries by id', async () => {
    const fake = new FakeClient({
      fs_tasks: { single: { id: 'T1', data: { title: 'Fix', status: 'open' } } },
    });
    const doc = await adapterWith(fake).getDoc('tasks', 'T1');
    expect(doc).toEqual({ id: 'T1', title: 'Fix', status: 'open' });
    expect(fake.fromCalls).toEqual(['fs_tasks']);
    const table = fake.table('fs_tasks');
    expect(table.selectCalls).toEqual([['select', 'id, data']]);
    expect(callNames(table.allCalls())).toEqual(['eq', 'maybeSingle']);
    expect(table.allCalls()[0]).toEqual(['eq', 'id', 'T1']);
  });

  it('returns null when the row does not exist', async () => {
    const fake = new FakeClient({ fs_tasks: { single: null } });
    await expect(adapterWith(fake).getDoc('tasks', 'nope')).resolves.toBeNull();
  });

  it('scopes subcollection reads by parent_path', async () => {
    const fake = new FakeClient({
      fs_group_notifications: { single: { id: 'N1', data: { body: 'hi' } } },
    });
    const doc = await adapterWith(fake).getDoc('users/U1/notifications', 'N1');
    expect(doc).toEqual({ id: 'N1', body: 'hi' });
    expect(fake.table('fs_group_notifications').allCalls()).toEqual([
      ['eq', 'id', 'N1'],
      ['eq', 'parent_path', 'users/U1/notifications'],
      ['maybeSingle'],
    ]);
  });

  it('surfaces PostgREST errors as SupaAdapterError', async () => {
    const fake = new FakeClient({
      fs_tasks: { error: { message: 'relation "public.fs_tasks" does not exist' } },
    });
    await expect(adapterWith(fake).getDoc('tasks', 'T1')).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('listDocs query translation', () => {
  it('maps rows to Firestore-shaped docs', async () => {
    const fake = new FakeClient({
      fs_tasks: {
        rows: [
          { id: 'T1', data: { title: 'a' } },
          { id: 'T2', data: { title: 'b' } },
        ],
      },
    });
    const docs = await adapterWith(fake).listDocs('tasks');
    expect(docs).toEqual([
      { id: 'T1', title: 'a' },
      { id: 'T2', title: 'b' },
    ]);
  });

  it.each([
    ['==', 'eq'],
    ['!=', 'neq'],
    ['<', 'lt'],
    ['<=', 'lte'],
    ['>', 'gt'],
    ['>=', 'gte'],
  ] as const)('translates %s to %s on the data text extraction', async (op, method) => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', {
      where: [['status', op, 'open']],
    });
    expect(fake.table('fs_tasks').allCalls()).toContainEqual([
      method,
      "data->>'status'",
      'open',
    ]);
  });

  it('stringifies numbers and booleans (canonical jsonb text)', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', {
      where: [
        ['points', '==', 42],
        ['done', '==', true],
      ],
    });
    const calls = fake.table('fs_tasks').allCalls();
    expect(calls).toContainEqual(['eq', "data->>'points'", '42']);
    expect(calls).toContainEqual(['eq', "data->>'done'", 'true']);
  });

  it('converts Dates to ISO strings', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    const when = new Date('2026-10-25T00:00:00.000Z');
    await adapterWith(fake).listDocs('tasks', {
      where: [['createdAt', '>=', when]],
    });
    expect(fake.table('fs_tasks').allCalls()).toContainEqual([
      'gte',
      "data->>'createdAt'",
      '2026-10-25T00:00:00.000Z',
    ]);
  });

  it("translates 'in' to a PostgREST in-list of text values", async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', {
      where: [['chapterId', 'in', ['ist', 'lhr']]],
    });
    expect(fake.table('fs_tasks').allCalls()).toContainEqual([
      'in',
      "data->>'chapterId'",
      ['ist', 'lhr'],
    ]);
  });

  it("translates 'array-contains' to jsonb containment on data->field", async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', {
      where: [['workflowParticipantIds', 'array-contains', 'U1']],
    });
    expect(fake.table('fs_tasks').allCalls()).toContainEqual([
      'filter',
      "data->'workflowParticipantIds'",
      'cs',
      '["U1"]',
    ]);
  });

  it("translates null equality to 'is null' and null inequality to 'not is null'", async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', {
      where: [
        ['deletedAt', '==', null],
        ['archivedAt', '!=', null],
      ],
    });
    const calls = fake.table('fs_tasks').allCalls();
    expect(calls).toContainEqual(['is', "data->>'deletedAt'", null]);
    expect(calls).toContainEqual(['not', "data->>'archivedAt'", 'is', null]);
  });

  it('rejects an unsupported op', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    const bad = [['status', 'contains', 'x']] as unknown as WhereClause[];
    await expect(adapterWith(fake).listDocs('tasks', { where: bad })).rejects.toThrow(
      SupaAdapterError,
    );
  });

  it('orders by the text extraction, by id for id/__name__, honoring direction', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', {
      orderBy: [
        { field: 'createdAt', direction: 'desc' },
        { field: '__name__' },
      ],
    });
    const calls = fake.table('fs_tasks').allCalls();
    expect(calls).toContainEqual(['order', "data->>'createdAt'", { ascending: false }]);
    expect(calls).toContainEqual(['order', 'id', { ascending: true }]);
  });

  it('accepts a bare string orderBy as ascending on that field', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', { orderBy: 'title' });
    expect(fake.table('fs_tasks').allCalls()).toContainEqual([
      'order',
      "data->>'title'",
      { ascending: true },
    ]);
  });

  it('applies limit', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', { limit: 25 });
    expect(fake.table('fs_tasks').allCalls()).toContainEqual(['limit', 25]);
  });

  it('pages by document id when startAfter has no data-field order', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', { startAfter: 'T99', limit: 500 });
    const calls = fake.table('fs_tasks').allCalls();
    expect(calls).toContainEqual(['order', 'id', { ascending: true }]);
    expect(calls).toContainEqual(['gt', 'id', 'T99']);
  });

  it('bounds startAfter on the ordered field, direction-aware', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    await adapterWith(fake).listDocs('tasks', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      startAfter: '2026-10-01T00:00:00.000Z',
    });
    expect(fake.table('fs_tasks').allCalls()).toContainEqual([
      'lt',
      "data->>'createdAt'",
      '2026-10-01T00:00:00.000Z',
    ]);
  });
});

describe('countDocs', () => {
  it('uses a head count with exact counting and applies filters', async () => {
    const fake = new FakeClient({ fs_applications: { count: 63 } });
    const n = await adapterWith(fake).countDocs('applications', [
      ['status', '==', 'pending'],
    ]);
    expect(n).toBe(63);
    const table = fake.table('fs_applications');
    expect(table.selectCalls).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
    ]);
    expect(table.allCalls()).toContainEqual(['eq', "data->>'status'", 'pending']);
  });

  it('returns 0 when PostgREST reports a null count', async () => {
    const fake = new FakeClient({ fs_applications: { count: null } });
    await expect(adapterWith(fake).countDocs('applications')).resolves.toBe(0);
  });
});

describe('setDoc', () => {
  it('upserts the kit row shape for a top-level doc', async () => {
    const fake = new FakeClient({ fs_tasks: {} });
    const written = await adapterWith(fake).setDoc('tasks', 'T1', { title: 'x' });
    expect(written).toEqual({ id: 'T1', title: 'x' });
    expect(fake.table('fs_tasks').upsertCalls).toEqual([
      [
        'upsert',
        { id: 'T1', firebase_uid: null, parent_path: 'tasks', data: { title: 'x' } },
        { onConflict: 'id' },
      ],
    ]);
  });

  it('stamps firebase_uid for user docs and subcollection docs', async () => {
    const fake = new FakeClient({ fs_users: {}, fs_group_notifications: {} });
    const adapter = adapterWith(fake);
    await adapter.setDoc('users', 'U1', { displayName: 'Z' });
    expect(fake.table('fs_users').upsertCalls[0][1]).toMatchObject({
      id: 'U1',
      firebase_uid: 'U1',
      parent_path: 'users',
    });
    await adapter.setDoc('users/U1/notifications', 'N1', { body: 'hi' });
    expect(fake.table('fs_group_notifications').upsertCalls[0][1]).toMatchObject({
      id: 'N1',
      firebase_uid: 'U1',
      parent_path: 'users/U1/notifications',
    });
  });

  it('merges top-level keys when asked', async () => {
    const fake = new FakeClient({
      fs_tasks: { single: { id: 'T1', data: { title: 'old', status: 'open' } } },
    });
    await adapterWith(fake).setDoc('tasks', 'T1', { status: 'done' }, { merge: true });
    expect(fake.table('fs_tasks').upsertCalls[0][1]).toMatchObject({
      data: { title: 'old', status: 'done' },
    });
  });
});

describe('updateDoc', () => {
  it('writes back merged data, expanding dot paths like Firestore', async () => {
    const fake = new FakeClient({
      fs_users: {
        single: {
          id: 'U1',
          data: { displayName: 'Z', profile: { city: 'ISB', zip: '44000' } },
        },
      },
    });
    const updated = await adapterWith(fake).updateDoc('users', 'U1', {
      'profile.city': 'LHR',
      status: 'active',
    });
    expect(updated).toEqual({
      id: 'U1',
      displayName: 'Z',
      profile: { city: 'LHR', zip: '44000' },
      status: 'active',
    });
    const table = fake.table('fs_users');
    expect(table.updateCalls).toEqual([
      [
        'update',
        {
          data: {
            displayName: 'Z',
            profile: { city: 'LHR', zip: '44000' },
            status: 'active',
          },
        },
      ],
    ]);
    expect(table.allCalls()).toContainEqual(['eq', 'id', 'U1']);
  });

  it('rejects with a not-found error on a missing document (Firestore parity)', async () => {
    const fake = new FakeClient({ fs_users: { single: null } });
    await expect(
      adapterWith(fake).updateDoc('users', 'ghost', { status: 'x' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('deleteDoc', () => {
  it('deletes by id, scoped by parent_path for subcollections', async () => {
    const fake = new FakeClient({ fs_group_registrations: {} });
    await adapterWith(fake).deleteDoc('events/E1/registrations', 'R1');
    const table = fake.table('fs_group_registrations');
    expect(table.chains).toHaveLength(1);
    expect(table.chains[0].kind).toBe('delete');
    expect(table.allCalls()).toEqual([
      ['eq', 'id', 'R1'],
      ['eq', 'parent_path', 'events/E1/registrations'],
    ]);
  });
});

describe('unconfigured client', () => {
  it('rejects every operation with SupaUnavailableError', async () => {
    const adapter = createSupaAdapter(null);
    await expect(adapter.getDoc('tasks', 'T1')).rejects.toThrow(SupaUnavailableError);
    await expect(adapter.listDocs('tasks')).rejects.toThrow(SupaUnavailableError);
    await expect(adapter.countDocs('tasks')).rejects.toThrow(SupaUnavailableError);
    await expect(adapter.setDoc('tasks', 'T1', {})).rejects.toThrow(
      SupaUnavailableError,
    );
    await expect(adapter.updateDoc('tasks', 'T1', {})).rejects.toThrow(
      SupaUnavailableError,
    );
    await expect(adapter.deleteDoc('tasks', 'T1')).rejects.toThrow(
      SupaUnavailableError,
    );
  });

  it('getSupaAdapter() is unavailable when the env is unconfigured', async () => {
    const savedUrl = process.env.SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      await expect(getSupaAdapter().getDoc('tasks', 'T1')).rejects.toThrow(
        SupaUnavailableError,
      );
    } finally {
      if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
      if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    }
  });
});
