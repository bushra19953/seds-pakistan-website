/**
 * ADAPTER CONTRACT TESTS — feat/supa-adapter @ 85e657f
 *
 * Every expectation in this file is written as the FIRESTORE behavior the
 * consuming routes rely on today (see SUPA_CONTRACTS/PATTERN_INVENTORY.md
 * for the derivation, file:line per pattern). A failing test is therefore
 * not a style complaint: it is a place where serving the route from the
 * adapter would change observable behavior versus Firestore.
 *
 * The Supabase client is the faithful in-memory fake in ./fake-supa.ts
 * (real Postgres jsonb text-extraction / NULL / ordering / PostgREST
 * row-cap semantics). Zero live reads.
 *
 * The adapter imports @supabase/supabase-js (declared, not installed in
 * this worktree); the mock below keeps module load hermetic — the
 * contracts only exercise createSupaAdapter() with the fake client.
 */

jest.mock(
  '@supabase/supabase-js',
  () => ({ createClient: jest.fn(() => null) }),
  { virtual: true },
);

import {
  createSupaAdapter,
  resolveTarget,
  tableForCollection,
  SupaAdapterError,
  SupaUnavailableError,
} from '../adapter';
import { FakeSupa, landingRow, dumpedTimestamp, liveTimestamp } from './fake-supa';

function adapterWith(fake: FakeSupa) {
  // createSupaAdapter accepts a SupabaseClient; the fake satisfies the
  // adapter's own SupaLike seam at runtime (adapter.ts casts internally).
  return createSupaAdapter(fake as never);
}

describe('D1 — directory browse: equality + __name__ order + id cursor + limit', () => {
  it('pages chapter-scoped users in doc-id order after the cursor', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('u1', { chapterId: 'ist', email: 'a@x.pk' }),
      landingRow('u2', { chapterId: 'ist', email: 'b@x.pk' }),
      landingRow('u3', { chapterId: 'ist', email: 'c@x.pk' }),
      landingRow('u4', { chapterId: 'ist', email: 'd@x.pk' }),
      landingRow('u5', { chapterId: 'ist', email: 'e@x.pk' }),
      landingRow('u9', { chapterId: 'other', email: 'z@x.pk' }),
    ]);
    const docs = await adapterWith(fake).listDocs('users', {
      where: [['chapterId', '==', 'ist']],
      orderBy: '__name__',
      startAfter: 'u2',
      limit: 2,
    });
    expect(docs.map((d) => d.id)).toEqual(['u3', 'u4']);
  });

  it('resolves the roles overlay by document id (__name__ IN chunk)', async () => {
    // admin/users route.ts:197 and users/picker route.ts:84 fetch the
    // roles docs for the page with where('__name__','in', ids). The
    // adapter must select rows by the id column, not by a data field.
    const fake = new FakeSupa().seed('fs_roles', [
      landingRow('u1', { role: 'member_basic' }),
      landingRow('u2', { role: 'admin' }),
      landingRow('u3', { role: 'member_basic' }),
    ]);
    const docs = await adapterWith(fake).listDocs('roles', {
      where: [['__name__', 'in', ['u1', 'u3']]],
    });
    expect(docs.map((d) => d.id).sort()).toEqual(['u1', 'u3']);
  });
});

describe('D2 — directory search: equality is exact (Firestore == semantics)', () => {
  it('email equality is case-sensitive and exact', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('u1', { email: 'Person@X.pk' }),
      landingRow('u2', { email: 'person@x.pk' }),
    ]);
    const adapter = adapterWith(fake);
    const miss = await adapter.listDocs('users', {
      where: [['email', '==', 'PERSON@x.pk']],
    });
    expect(miss).toEqual([]);
    const hit = await adapter.listDocs('users', {
      where: [['email', '==', 'person@x.pk']],
    });
    expect(hit.map((d) => d.id)).toEqual(['u2']);
  });
});

describe('D3 — user picker: unbounded reads must not silently truncate', () => {
  it('returns every user when no limit is given (picker does .get() unbounded)', async () => {
    const rows = Array.from({ length: 1005 }, (_, i) =>
      landingRow(`u${String(i).padStart(4, '0')}`, { chapterId: 'ist' }),
    );
    const fake = new FakeSupa().seed('fs_users', rows);
    const docs = await adapterWith(fake).listDocs('users', {});
    expect(docs.length).toBe(1005);
  });

  it('preserves array fields verbatim (additionalRoles passthrough)', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('u1', { additionalRoles: ['chair_design', 'editor'] }),
    ]);
    const docs = await adapterWith(fake).listDocs('users', {});
    expect(docs[0].additionalRoles).toEqual(['chair_design', 'editor']);
  });
});

describe('A1 — announcements: timestamp range, existence, ordering', () => {
  it('publish_date <= now admits past-dated and excludes future-dated docs', async () => {
    // Stored shape is what the dump writes: {_seconds,_nanoseconds}.
    const fake = new FakeSupa().seed('fs_announcements', [
      landingRow('past', {
        status: 'published',
        audience: 'public',
        publish_date: dumpedTimestamp('2025-10-24T10:00:00.000Z'),
        updated_at: dumpedTimestamp('2025-10-24T10:00:00.000Z'),
      }),
      landingRow('future', {
        status: 'published',
        audience: 'public',
        publish_date: dumpedTimestamp('2025-10-26T10:00:00.000Z'),
        updated_at: dumpedTimestamp('2025-10-24T10:00:00.000Z'),
      }),
      landingRow('nodate', {
        status: 'published',
        audience: 'public',
        updated_at: dumpedTimestamp('2025-10-24T10:00:00.000Z'),
      }),
    ]);
    const docs = await adapterWith(fake).listDocs('announcements', {
      where: [
        ['status', '==', 'published'],
        ['audience', '==', 'public'],
        ['publish_date', '<=', liveTimestamp('2025-10-25T10:00:00.000Z')],
      ],
    });
    expect(docs.map((d) => d.id)).toEqual(['past']);
  });

  it('orderBy(updated_at desc) excludes docs missing the field (Firestore existence filter)', async () => {
    const fake = new FakeSupa().seed('fs_announcements', [
      landingRow('with', {
        updated_at: dumpedTimestamp('2025-10-24T10:00:00.000Z'),
      }),
      landingRow('without', { title: 'no timestamp' }),
    ]);
    const docs = await adapterWith(fake).listDocs('announcements', {
      orderBy: { field: 'updated_at', direction: 'desc' },
    });
    expect(docs.map((d) => d.id)).toEqual(['with']);
  });

  it('plain string equality composition still works (control)', async () => {
    const fake = new FakeSupa().seed('fs_announcements', [
      landingRow('a', { status: 'published', audience: 'public' }),
      landingRow('b', { status: 'draft', audience: 'public' }),
      landingRow('c', { status: 'published', audience: 'members' }),
    ]);
    const docs = await adapterWith(fake).listDocs('announcements', {
      where: [
        ['status', '==', 'published'],
        ['audience', '==', 'public'],
      ],
    });
    expect(docs.map((d) => d.id)).toEqual(['a']);
  });
});

describe('DB1 — dashboard counts: exact, field-presence aware, and loud on failure', () => {
  it('counts only docs where the field exists and equals', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('u1', { memberStatus: 'departed' }),
      landingRow('u2', { memberStatus: 'departed' }),
      landingRow('u3', { memberStatus: 'departed' }),
      landingRow('u4', { memberStatus: 'active' }),
      landingRow('u5', { displayName: 'no status field' }),
      landingRow('u6', { displayName: 'no status field either' }),
    ]);
    const n = await adapterWith(fake).countDocs('users', [
      ['memberStatus', '==', 'departed'],
    ]);
    expect(n).toBe(3);
  });

  it('countDocs rejects when the backend errors (route degrades per-name, never silently)', async () => {
    const fake = new FakeSupa().seed('fs_users', []);
    fake.setError('fs_users', 'relation unavailable');
    await expect(adapterWith(fake).countDocs('users')).rejects.toBeInstanceOf(
      SupaAdapterError,
    );
  });

  it('listDocs rejects when the backend errors (route degradation ladders depend on it)', async () => {
    const fake = new FakeSupa().seed('fs_tasks', []);
    fake.setError('fs_tasks', 'boom');
    await expect(adapterWith(fake).listDocs('tasks', {})).rejects.toMatchObject({
      code: 'query-failed',
    });
  });

  it('parallel counts stay independent and exact', async () => {
    const fake = new FakeSupa().seed('fs_tasks', [
      landingRow('t1', { status: 'pending' }),
      landingRow('t2', { status: 'pending' }),
      landingRow('t3', { status: 'in-progress' }),
      landingRow('t4', { status: 'completed' }),
    ]);
    const adapter = adapterWith(fake);
    const [pending, inProgress, completed] = await Promise.all([
      adapter.countDocs('tasks', [['status', '==', 'pending']]),
      adapter.countDocs('tasks', [['status', '==', 'in-progress']]),
      adapter.countDocs('tasks', [['status', '==', 'completed']]),
    ]);
    expect([pending, inProgress, completed]).toEqual([2, 1, 1]);
  });
});

describe('T1 — tasks list: createdAt ordering and Timestamp cursor', () => {
  it('orders by createdAt desc chronologically across distinct seconds (control)', async () => {
    const fake = new FakeSupa().seed('fs_tasks', [
      landingRow('old', { createdAt: dumpedTimestamp('2025-10-20T10:00:00.000Z') }),
      landingRow('new', { createdAt: dumpedTimestamp('2025-10-25T10:00:00.000Z') }),
      landingRow('mid', { createdAt: dumpedTimestamp('2025-10-22T10:00:00.000Z') }),
    ]);
    const docs = await adapterWith(fake).listDocs('tasks', {
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    expect(docs.map((d) => d.id)).toEqual(['new', 'mid', 'old']);
  });

  it('orders sub-second timestamps by true chronology, not storage text', async () => {
    // Same second, 123ms vs 45ms. Firestore orders 123ms after 45ms;
    // the dumped JSON text compares "_nanoseconds":123000000 BEFORE
    // "_nanoseconds":45000000 as strings ('1' < '4') — the adapter must
    // not inherit that inversion.
    const fake = new FakeSupa().seed('fs_tasks', [
      landingRow('ms045', {
        createdAt: dumpedTimestamp('2025-10-25T10:00:00.045Z'),
      }),
      landingRow('ms123', {
        createdAt: dumpedTimestamp('2025-10-25T10:00:00.123Z'),
      }),
    ]);
    const docs = await adapterWith(fake).listDocs('tasks', {
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    expect(docs.map((d) => d.id)).toEqual(['ms123', 'ms045']);
  });

  it('startAfter(Timestamp cursor) on createdAt desc returns strictly older docs', async () => {
    const fake = new FakeSupa().seed('fs_tasks', [
      landingRow('t-new', { createdAt: dumpedTimestamp('2025-10-25T10:00:00.000Z') }),
      landingRow('t-cursor', { createdAt: dumpedTimestamp('2025-10-24T10:00:00.000Z') }),
      landingRow('t-old', { createdAt: dumpedTimestamp('2025-10-23T10:00:00.000Z') }),
    ]);
    const docs = await adapterWith(fake).listDocs('tasks', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      startAfter: liveTimestamp('2025-10-24T10:00:00.000Z'),
    });
    expect(docs.map((d) => d.id)).toEqual(['t-old']);
  });

  it('breaks equal-order-value ties by document id ascending (Firestore rule)', async () => {
    const same = dumpedTimestamp('2025-10-25T10:00:00.000Z');
    const fake = new FakeSupa().seed('fs_tasks', [
      landingRow('t-b', { createdAt: { ...same } }),
      landingRow('t-a', { createdAt: { ...same } }),
    ]);
    const docs = await adapterWith(fake).listDocs('tasks', {
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    expect(docs.map((d) => d.id)).toEqual(['t-a', 't-b']);
  });
});

describe('T2 — assignee union: array-contains translation', () => {
  it('matches only docs whose array contains the value', async () => {
    const fake = new FakeSupa().seed('fs_tasks', [
      landingRow('t1', { assigneeIds: ['u1', 'u2'] }),
      landingRow('t2', { assigneeIds: ['u3'] }),
      landingRow('t3', { title: 'no assigneeIds field' }),
      landingRow('t4', { assigneeIds: 'u1' }),
    ]);
    const docs = await adapterWith(fake).listDocs('tasks', {
      where: [['assigneeIds', 'array-contains', 'u1']],
    });
    expect(docs.map((d) => d.id)).toEqual(['t1']);
  });
});

describe('Doc get + subcollections (PATTERN_INVENTORY §10)', () => {
  it('missing doc resolves to null — never throws, never an empty doc', async () => {
    const fake = new FakeSupa().seed('fs_users', []);
    await expect(adapterWith(fake).getDoc('users', 'ghost')).resolves.toBeNull();
  });

  it('existing doc returns {id, ...data}', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('u1', { email: 'a@x.pk', chapterId: 'ist' }),
    ]);
    const doc = await adapterWith(fake).getDoc('users', 'u1');
    expect(doc).toEqual({ id: 'u1', email: 'a@x.pk', chapterId: 'ist' });
  });

  it('subcollection reads are scoped by parent_path', async () => {
    const fake = new FakeSupa().seed('fs_group_notifications', [
      landingRow('n1', { body: 'for u1' }, 'users/u1/notifications', 'u1'),
      landingRow('n1', { body: 'for u2' }, 'users/u2/notifications', 'u2'),
      landingRow('n2', { body: 'also u2' }, 'users/u2/notifications', 'u2'),
    ]);
    const adapter = adapterWith(fake);
    const doc = await adapter.getDoc('users/u2/notifications', 'n1');
    expect(doc?.body).toBe('for u2');
    const list = await adapter.listDocs('users/u2/notifications', {});
    expect(list.map((d) => d.id).sort()).toEqual(['n1', 'n2']);
  });
});

describe('Writes land in the kit row shape (migrate_db.js rowFor parity)', () => {
  it('setDoc on a top-level users doc stamps firebase_uid and parent_path', async () => {
    const fake = new FakeSupa();
    await adapterWith(fake).setDoc('users', 'u7', { email: 'n@x.pk' });
    const rows = fake.rows('fs_users');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'u7',
      firebase_uid: 'u7',
      parent_path: 'users',
    });
    expect(rows[0].data).toEqual({ email: 'n@x.pk' });
  });

  it('setDoc on a subcollection doc records the full parent path', async () => {
    const fake = new FakeSupa();
    await adapterWith(fake).setDoc('users/u7/notifications', 'n9', {
      body: 'hi',
    });
    const rows = fake.rows('fs_group_notifications');
    expect(rows[0]).toMatchObject({
      id: 'n9',
      firebase_uid: 'u7',
      parent_path: 'users/u7/notifications',
    });
  });

  it('updateDoc rejects not-found for a missing doc and expands dot paths', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('u1', { profile: { name: 'Old' } }),
    ]);
    const adapter = adapterWith(fake);
    await expect(adapter.updateDoc('users', 'ghost', { x: 1 })).rejects.toMatchObject({
      code: 'not-found',
    });
    await adapter.updateDoc('users', 'u1', { 'profile.name': 'New' });
    const doc = await adapter.getDoc('users', 'u1');
    expect(doc).toEqual({ id: 'u1', profile: { name: 'New' } });
  });
});

describe('Equality against null (Firestore: explicit null only)', () => {
  it('field == null matches stored nulls but NOT docs missing the field', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('explicit', { deletedAt: null }),
      landingRow('missing', { displayName: 'no deletedAt key' }),
    ]);
    const docs = await adapterWith(fake).listDocs('users', {
      where: [['deletedAt', '==', null]],
    });
    expect(docs.map((d) => d.id)).toEqual(['explicit']);
  });
});

describe('Table mapping + path rules (kit parity)', () => {
  it('tableForCollection matches the kit sanitization', () => {
    expect(tableForCollection('audit_logs')).toBe('fs_audit_logs');
    expect(tableForCollection('users')).toBe('fs_users');
  });

  it('resolveTarget maps subcollections to the group table with full parent path', () => {
    expect(resolveTarget('users/u1/notifications', 'n1')).toEqual({
      table: 'fs_group_notifications',
      parentPath: 'users/u1/notifications',
      isSubcollection: true,
    });
    expect(() => resolveTarget('users/u1', 'x')).toThrow(SupaAdapterError);
  });
});

describe('Client gating', () => {
  it('a null client rejects every op with SupaUnavailableError (callers fall back)', async () => {
    const adapter = createSupaAdapter(null);
    await expect(adapter.getDoc('users', 'u1')).rejects.toBeInstanceOf(
      SupaUnavailableError,
    );
    await expect(adapter.listDocs('users', {})).rejects.toBeInstanceOf(
      SupaUnavailableError,
    );
    await expect(adapter.countDocs('users')).rejects.toBeInstanceOf(
      SupaUnavailableError,
    );
  });
});
