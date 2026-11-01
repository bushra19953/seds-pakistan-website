/**
 * DEFERRED-CLAUSE PUSHDOWN — wave-2 query-shapes (2026-10-30).
 *
 * The adapter deferred EVERY null clause to client-side finishing
 * (isDeferredClause), so a `!= null` predicate forced listDocs to page
 * the ENTIRE mirror table through fetchAllRows and filter in memory —
 * the mission-board board leg paged all 132 fs_tasks rows per request
 * (API latency census 2026-10-30), and the cost grows with the table.
 *
 * The G8 ruling behind the deferral is about `== null`: Firestore
 * equality-to-null matches an EXPLICIT stored null only, while the
 * PostgREST text extraction (data->>'f') yields SQL NULL for an explicit
 * null AND for a missing key, so `== null` genuinely cannot be pushed.
 *
 * `!= null` is the opposite case. Firestore `!= null` matches a doc
 * exactly when the field is present and not null; the extraction is
 * NOT NULL exactly for those docs (a present non-null scalar extracts
 * to its text; missing key and explicit null both extract to SQL NULL).
 * So `data->>'f' IS NOT NULL` — the translation applyWhere already
 * emits for `!= null` — is faithful, and the clause belongs server-side.
 *
 * These tests pin, through the faithful FakeSupa:
 *  - the deferral matrix (only == null / timestamp-likes / null-carrying
 *    arrays defer; != null no longer does);
 *  - the transport proof: a board-shaped list (1100-row table, 100
 *    matches) moves 100 rows over the wire in ONE chain, not 1100 rows
 *    over the paged fetch-all loop;
 *  - semantic identity of the pushed form (missing and explicit-null
 *    excluded, every present non-null value included);
 *  - the mixed case: a pushed != null clause composing with a still-
 *    deferred == null clause returns the Firestore-semantics set;
 *  - countDocs with a != null clause takes the exact head-count path.
 */

jest.mock(
  '@supabase/supabase-js',
  () => ({ createClient: jest.fn(() => null) }),
  { virtual: true },
);

import { createSupaAdapter, isDeferredClause, type WhereClause } from '../adapter';
import { FakeSupa, landingRow } from './fake-supa';

/** FakeSupa that tallies rows actually returned over the wire. */
class CountingSupa extends FakeSupa {
  transported = 0;
  chainsIssued = 0;

  override from(table: string) {
    const builder = super.from(table);
    const origSelect = builder.select.bind(builder);
    builder.select = ((...args: [string, { count?: string; head?: boolean }?]) => {
      const chain = origSelect(...args) as unknown as {
        then: (
          onF?: ((res: { data: unknown }) => unknown) | null,
          onR?: ((e: unknown) => unknown) | null,
        ) => Promise<unknown>;
      };
      const origThen = chain.then.bind(chain);
      this.chainsIssued += 1;
      chain.then = (onF?: ((res: { data: unknown }) => unknown) | null, onR?: ((e: unknown) => unknown) | null) =>
        origThen((res: { data: unknown }) => {
          if (Array.isArray(res?.data)) this.transported += res.data.length;
          return onF ? onF(res) : res;
        }, onR ?? undefined);
      return chain;
    }) as typeof builder.select;
    return builder;
  }
}

function adapterWith(fake: FakeSupa) {
  return createSupaAdapter(fake as never);
}

describe('deferral matrix after the != null pushdown', () => {
  it('no longer defers != null (expressible as IS NOT NULL)', () => {
    expect(isDeferredClause(['workflowId', '!=', null])).toBe(false);
  });

  it('still defers == null (explicit-null-only semantics, G8)', () => {
    expect(isDeferredClause(['deletedAt', '==', null])).toBe(true);
  });

  it('still defers in-lists carrying a null member', () => {
    expect(isDeferredClause(['status', 'in', [null, 'active']])).toBe(true);
  });

  it('still defers timestamp-like values (G3)', () => {
    const ts = {
      toDate: () => new Date('2026-10-30T00:00:00.000Z'),
      toMillis: () => Date.parse('2026-10-30T00:00:00.000Z'),
      seconds: 1793328000,
      nanoseconds: 0,
    };
    expect(isDeferredClause(['createdAt', '>', ts] as WhereClause)).toBe(true);
    expect(isDeferredClause(['createdAt', '>', new Date('2026-10-30')] as WhereClause)).toBe(true);
  });

  it('never deferred array-contains or plain scalar clauses', () => {
    expect(isDeferredClause(['team', 'array-contains', 'u1'])).toBe(false);
    expect(isDeferredClause(['status', '==', 'active'])).toBe(false);
  });
});

describe('board-shaped list: the predicate runs in Postgres', () => {
  function seedBigTable(fake: CountingSupa) {
    const rows = [];
    for (let i = 0; i < 100; i++) {
      rows.push(landingRow(`wf-${String(i).padStart(3, '0')}`, { workflowId: 'wf-x', title: 'step' }));
    }
    for (let i = 0; i < 1000; i++) {
      rows.push(landingRow(`solo-${String(i).padStart(4, '0')}`, { title: 'standalone' }));
    }
    return fake.seed('fs_tasks', rows);
  }

  it('transports only the matching rows, in a single chain', async () => {
    const fake = seedBigTable(new CountingSupa());
    const docs = await adapterWith(fake).listDocs('tasks', {
      where: [['workflowId', '!=', null]],
      limit: 5000,
    });
    expect(docs).toHaveLength(100);
    expect(docs.every((d) => d.workflowId === 'wf-x')).toBe(true);
    // The whole table no longer crosses the wire: 100 rows, 1 chain.
    expect(fake.transported).toBe(100);
    expect(fake.chainsIssued).toBe(1);
  });

  it('keeps Firestore != semantics exactly: missing and explicit-null excluded', async () => {
    const fake = new CountingSupa().seed('fs_tasks', [
      landingRow('str', { workflowId: 'wf-a' }),
      landingRow('empty-str', { workflowId: '' }),
      landingRow('num', { workflowId: 7 as unknown as string }),
      landingRow('explicit-null', { workflowId: null }),
      landingRow('missing', { title: 'no workflowId key' }),
    ]);
    const docs = await adapterWith(fake).listDocs('tasks', {
      where: [['workflowId', '!=', null]],
      limit: 100,
    });
    expect(docs.map((d) => d.id).sort()).toEqual(['empty-str', 'num', 'str']);
  });

  it('countDocs with != null takes the exact head-count path', async () => {
    const fake = new CountingSupa().seed('fs_tasks', [
      landingRow('a', { workflowId: 'wf-a' }),
      landingRow('b', { workflowId: null }),
      landingRow('c', { title: 'missing' }),
      landingRow('d', { workflowId: 'wf-b' }),
    ]);
    const n = await adapterWith(fake).countDocs('tasks', [['workflowId', '!=', null]]);
    expect(n).toBe(2);
    // Head count: zero data rows cross the wire.
    expect(fake.transported).toBe(0);
  });
});

describe('mixed clauses: pushed != null composes with deferred == null', () => {
  it('returns exactly the Firestore-semantics set', async () => {
    const fake = new CountingSupa().seed('fs_tasks', [
      // deletedAt explicit null AND archivedAt present -> the only match
      landingRow('both', { deletedAt: null, archivedAt: '2026-01-01' }),
      // deletedAt explicit null, archivedAt explicit null -> excluded by !=
      landingRow('arch-null', { deletedAt: null, archivedAt: null }),
      // deletedAt explicit null, archivedAt missing -> excluded by !=
      landingRow('arch-missing', { deletedAt: null }),
      // deletedAt set -> excluded by == null
      landingRow('not-deleted', { deletedAt: '2026-02-01', archivedAt: '2026-01-01' }),
      // deletedAt missing -> excluded by == null (never matches missing, G8)
      landingRow('del-missing', { archivedAt: '2026-01-01' }),
    ]);
    const docs = await adapterWith(fake).listDocs('tasks', {
      where: [
        ['deletedAt', '==', null],
        ['archivedAt', '!=', null],
      ],
    });
    expect(docs.map((d) => d.id)).toEqual(['both']);
    // The != leg was pushed: only the 3 rows whose archivedAt extraction
    // is NOT NULL (both, not-deleted, del-missing) crossed the wire; the
    // deferred == null leg then finished the set in memory. Before the
    // pushdown all 5 rows crossed.
    expect(fake.transported).toBe(3);
  });
});
