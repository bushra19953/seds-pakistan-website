/**
 * SEAM contracts for the events cluster's Supabase migration, written
 * against the DOCUMENTED adapter contract (src/lib/supa/:
 * getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc over fs_*
 * jsonb tables; useSupa(surface) default OFF; Firestore fallback;
 * byte-identical response shapes) with the adapter MOCKED, because
 * the seam does not exist on the base tree (feat/integration-wave3 @
 * 4d5a1e16 — pinned by S-BASE-01 below).
 *
 * Status of each contract:
 *   PASSING ON BASE (against the mock / the real datetime oracle):
 *     S-REG-01..05  registrations parent scoping at the adapter
 *                   interface, the only level consumers may depend on.
 *     S-TS-01..04   timestamp-shape equivalence, using the REAL
 *                   src/lib/events/datetime.ts as the oracle.
 *   PENDING-BRANCH VERIFICATION (skipped, named for the branch that
 *   must un-skip and pass them):
 *     S-FLAG-01     feat/supa-adapter (in flight, @ 85e657f on
 *                   feat/supa-adapter) merged into the events branches.
 *     S-REG-06      REPRESENTATION CONFLICT, see below.
 *     S-E2E-01..02  feat/supa-events-2 / feat/supa-events-4 flag-on
 *                   end-to-end parity.
 *
 * S-REG-06 REPRESENTATION CONFLICT (must be reconciled before any
 * events implementer writes registration rows): the migration brief
 * for this cluster states registrations land in table
 * `fs_registrations` with parent_path = 'events/<eventId>'. The
 * adapter as actually built on feat/supa-adapter (resolveTarget /
 * writeRow in src/lib/supa/adapter.ts, and its own adapter.test.ts)
 * maps the subcollection path 'events/<eventId>/registrations' to
 * table `fs_group_registrations` with parent_path =
 * 'events/<eventId>/registrations'. Both cannot be the row shape.
 * The interface-level contracts below are deliberately agnostic to
 * which representation wins; anything that reads rows directly (the
 * migration dump, admin tooling, RLS policies) is not.
 *
 * The mock adapter below implements the documented interface with
 * the adapter branch's target resolution, in memory. It is a test
 * double for the CONTRACT, not a copy of the adapter: when the real
 * adapter lands, these tests should be re-pointed at it (the
 * adapter's own suite on feat/supa-adapter covers its internals).
 */

import { existsSync } from 'fs';
import { join } from 'path';
import {
  eventInstantToMs,
  formatEventInstantInPkt,
  dateToPktWallTime,
  pktWallTimeToUtcMs,
  type EventDateVariant,
} from '../datetime';

/* ------------------------------------------------------------------ *
 * Mock adapter implementing the documented interface.
 * Row shape: { table, id, parent_path, data }.
 * Target resolution mirrors feat/supa-adapter's resolveTarget:
 *   'events'                       -> fs_events,               parent 'events'
 *   'events/<id>/registrations'    -> fs_group_registrations,  parent 'events/<id>/registrations'
 * ------------------------------------------------------------------ */
type Row = { table: string; id: string; parent_path: string; data: Record<string, any> };

function resolveTargetLocal(collectionPath: string) {
  const seg = collectionPath.split('/').filter(Boolean);
  if (seg.length === 1) return { table: `fs_${seg[0]}`, parentPath: seg[0], sub: false };
  if (seg.length === 3) return { table: `fs_group_${seg[2]}`, parentPath: seg.join('/'), sub: true };
  throw new Error(`bad path ${collectionPath}`);
}

function createMockAdapter() {
  const rows: Row[] = [];
  const find = (collectionPath: string, id: string) => {
    const t = resolveTargetLocal(collectionPath);
    return rows.find((r) => r.table === t.table && r.id === id && (!t.sub || r.parent_path === t.parentPath));
  };
  const inScope = (collectionPath: string) => {
    const t = resolveTargetLocal(collectionPath);
    return rows.filter((r) => r.table === t.table && (!t.sub || r.parent_path === t.parentPath));
  };
  return {
    rows,
    async getDoc(collectionPath: string, id: string): Promise<Record<string, any> | null> {
      const row = find(collectionPath, id);
      return row ? { id: row.id, ...row.data } : null;
    },
    async listDocs(collectionPath: string, options: any = {}) {
      let out = inScope(collectionPath).map((r) => ({ id: r.id, ...r.data }));
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') out = out.filter((d: any) => d[field] === value);
      }
      const orders = options.orderBy
        ? (Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]).map((o: any) =>
            typeof o === 'string' ? { field: o, direction: 'asc' } : o,
          )
        : [];
      // The real adapter orders by the TEXT extraction data->>'field';
      // for ISO-8601 timestamp strings text order IS instant order.
      for (const o of [...orders].reverse()) {
        out = [...out].sort((a: any, b: any) => {
          const c = String(a[o.field]) < String(b[o.field]) ? -1 : String(a[o.field]) > String(b[o.field]) ? 1 : 0;
          return o.direction === 'desc' ? -c : c;
        });
      }
      if (options.limit !== undefined) out = out.slice(0, options.limit);
      return out;
    },
    async countDocs(collectionPath: string, where: any[] = []) {
      let out = inScope(collectionPath);
      for (const [field, op, value] of where) {
        if (op === '==') out = out.filter((r) => r.data[field] === value);
      }
      return out.length;
    },
    async setDoc(collectionPath: string, id: string, data: Record<string, any>, options: any = {}) {
      const t = resolveTargetLocal(collectionPath);
      const existing = find(collectionPath, id);
      const finalData = options.merge && existing ? { ...existing.data, ...data } : data;
      if (existing) existing.data = finalData;
      else rows.push({ table: t.table, id, parent_path: t.parentPath, data: finalData });
      return { id, ...finalData };
    },
    async updateDoc(collectionPath: string, id: string, updates: Record<string, any>) {
      const existing = find(collectionPath, id);
      if (!existing) throw new Error(`updateDoc on missing document ${collectionPath}/${id}`);
      existing.data = { ...existing.data, ...updates };
      return { id, ...existing.data };
    },
    async deleteDoc(collectionPath: string, id: string) {
      const t = resolveTargetLocal(collectionPath);
      const idx = rows.findIndex(
        (r) => r.table === t.table && r.id === id && (!t.sub || r.parent_path === t.parentPath),
      );
      if (idx >= 0) rows.splice(idx, 1);
    },
  };
}

type MockAdapter = ReturnType<typeof createMockAdapter>;

async function seedRegistrations(adapter: MockAdapter) {
  await adapter.setDoc('events/ev-1/registrations', 'user-1', { uid: 'user-1', eventId: 'ev-1', status: 'pending' });
  await adapter.setDoc('events/ev-1/registrations', 'user-2', { uid: 'user-2', eventId: 'ev-1', status: 'pending' });
  await adapter.setDoc('events/ev-2/registrations', 'user-1', { uid: 'user-1', eventId: 'ev-2', status: 'confirmed' });
  await adapter.setDoc('events/ev-2/registrations', 'user-3', { uid: 'user-3', eventId: 'ev-2', status: 'pending' });
}

/* ================================================================== */
describe('S-BASE: the seam on the base tree', () => {
  it('S-BASE-01 src/lib/supa exists on the merged tree (adapter landed at merge step 0; the base-tree precondition this pin was written under has ended — inverted by the merge coordinator, see MERGE_PROGRAM_REPORT step 12)', () => {
    expect(existsSync(join(process.cwd(), 'src/lib/supa'))).toBe(true);
  });
});

describe('S-REG: registrations parent scoping at the adapter interface', () => {
  it("S-REG-01 listDocs('events/ev-1/registrations') returns only ev-1's registrations", async () => {
    const adapter = createMockAdapter();
    await seedRegistrations(adapter);
    const ev1 = await adapter.listDocs('events/ev-1/registrations');
    expect(ev1.map((d: any) => d.id).sort()).toEqual(['user-1', 'user-2']);
    expect(ev1.every((d: any) => d.eventId === 'ev-1')).toBe(true);
    const ev2 = await adapter.listDocs('events/ev-2/registrations');
    expect(ev2.map((d: any) => d.id).sort()).toEqual(['user-1', 'user-3']);
  });

  it('S-REG-02 getDoc is parent-scoped: the same uid under two events resolves to each event\'s own registration', async () => {
    const adapter = createMockAdapter();
    await seedRegistrations(adapter);
    expect((await adapter.getDoc('events/ev-1/registrations', 'user-1'))!.status).toBe('pending');
    expect((await adapter.getDoc('events/ev-2/registrations', 'user-1'))!.status).toBe('confirmed');
    expect(await adapter.getDoc('events/ev-1/registrations', 'user-3')).toBeNull();
  });

  it('S-REG-03 countDocs is parent-scoped and honors where clauses', async () => {
    const adapter = createMockAdapter();
    await seedRegistrations(adapter);
    expect(await adapter.countDocs('events/ev-1/registrations')).toBe(2);
    expect(await adapter.countDocs('events/ev-2/registrations')).toBe(2);
    expect(await adapter.countDocs('events/ev-1/registrations', [['status', '==', 'confirmed']])).toBe(0);
    expect(await adapter.countDocs('events/ev-2/registrations', [['status', '==', 'confirmed']])).toBe(1);
  });

  it('S-REG-04 the public list contract over the seam: published filter + createdAt desc + limit cap compose at the interface', async () => {
    const adapter = createMockAdapter();
    const iso = (s: number) => new Date(Date.UTC(2026, 9, 20) + s * 1000).toISOString();
    await adapter.setDoc('events', 'old-pub', { status: 'published', createdAt: iso(100) });
    await adapter.setDoc('events', 'new-pub', { status: 'published', createdAt: iso(300) });
    await adapter.setDoc('events', 'mid-draft', { status: 'draft', createdAt: iso(200) });
    const page = await adapter.listDocs('events', {
      where: [['status', '==', 'published']],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 12,
    });
    expect(page.map((d: any) => d.id)).toEqual(['new-pub', 'old-pub']);
    const capped = await adapter.listDocs('events', {
      where: [['status', '==', 'published']],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 1,
    });
    expect(capped.map((d: any) => d.id)).toEqual(['new-pub']);
  });

  it('S-REG-05 updateDoc rejects on a missing registration (Firestore update semantics) and deleteDoc removes only the scoped row', async () => {
    const adapter = createMockAdapter();
    await seedRegistrations(adapter);
    await expect(adapter.updateDoc('events/ev-1/registrations', 'ghost', { status: 'x' })).rejects.toThrow(
      /missing document/,
    );
    await adapter.deleteDoc('events/ev-1/registrations', 'user-1');
    expect(await adapter.getDoc('events/ev-1/registrations', 'user-1')).toBeNull();
    // The same uid's registration under ev-2 is a different row.
    expect((await adapter.getDoc('events/ev-2/registrations', 'user-1'))!.status).toBe('confirmed');
  });
});

/* ================================================================== */
// 2026-10-25 10:00:00.250 PKT == 2026-10-25 05:00:00.250 UTC.
const INSTANT_MS = Date.UTC(2026, 9, 25, 5, 0, 0) + 250;
const SECONDS = Math.floor(INSTANT_MS / 1000);
const NANOS = 250_000_000;

const FORMS: Record<string, unknown> = {
  'Firestore Timestamp-like (toMillis + toDate + seconds/nanoseconds)': {
    seconds: SECONDS,
    nanoseconds: NANOS,
    toMillis: () => INSTANT_MS,
    toDate: () => new Date(INSTANT_MS),
  },
  'seam-normalized { seconds, nanoseconds, toDate() }': {
    seconds: SECONDS,
    nanoseconds: NANOS,
    toDate: () => new Date(INSTANT_MS),
  },
  'serialized { seconds, nanoseconds } (jsonb round-trip, no methods)': {
    seconds: SECONDS,
    nanoseconds: NANOS,
  },
  'ISO instant string': new Date(INSTANT_MS).toISOString(),
  Date: new Date(INSTANT_MS),
  'epoch millis': INSTANT_MS,
};

describe('S-TS: timestamp-shape equivalence (oracle: src/lib/events/datetime.ts)', () => {
  it('S-TS-01 every representation of the same instant normalizes to the same epoch ms, nanoseconds included', () => {
    for (const [label, value] of Object.entries(FORMS)) {
      expect({ label, ms: eventInstantToMs(value) }).toEqual({ label, ms: INSTANT_MS });
    }
  });

  it.each(['long', 'weekdayLong', 'datePadded', 'date', 'dateTime24'] as EventDateVariant[])(
    'S-TS-02 a consumer fed any representation renders the identical %s date as the Firestore original',
    (variant) => {
      const expected = formatEventInstantInPkt(FORMS['Firestore Timestamp-like (toMillis + toDate + seconds/nanoseconds)'], variant);
      expect(expected).not.toBeNull();
      for (const value of Object.values(FORMS)) {
        expect(formatEventInstantInPkt(value, variant)).toBe(expected);
      }
    },
  );

  it('S-TS-03 the PKT wall-time a form reopens with is identical for every representation, and re-saving is lossless', () => {
    for (const value of Object.values(FORMS)) {
      expect(dateToPktWallTime(value)).toBe('2026-10-25T10:00');
      expect(pktWallTimeToUtcMs(dateToPktWallTime(value))).toBe(INSTANT_MS - 250); // wall format carries no sub-second part
    }
  });

  it('S-TS-04 the PKT-midnight boundary renders the PKT calendar date for every representation', () => {
    const midnightMs = Date.UTC(2026, 9, 24, 19, 0); // 2026-10-25 00:00 PKT
    const forms = [
      { seconds: midnightMs / 1000, nanoseconds: 0, toDate: () => new Date(midnightMs) },
      { seconds: midnightMs / 1000, nanoseconds: 0 },
      new Date(midnightMs).toISOString(),
      midnightMs,
    ];
    for (const value of forms) {
      expect(formatEventInstantInPkt(value, 'datePadded')).toBe('Oct 25, 2026');
      expect(formatEventInstantInPkt(value, 'dateTime24')).toBe('Oct 25, 2026 00:00');
    }
  });
});

/* ================================================================== */
describe('PENDING-BRANCH VERIFICATION (un-skip on the named branch)', () => {
  it.skip('S-FLAG-01 [feat/supa-adapter merged into events branches] useSupa defaults OFF: false with SUPA_SURFACES unset or empty, true when it lists the surface or *', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useSupa } = require('@/lib/supa');
    const saved = process.env.SUPA_SURFACES;
    try {
      delete process.env.SUPA_SURFACES;
      expect(useSupa('events')).toBe(false);
      process.env.SUPA_SURFACES = '';
      expect(useSupa('events')).toBe(false);
      process.env.SUPA_SURFACES = 'tasks,users';
      expect(useSupa('events')).toBe(false);
      process.env.SUPA_SURFACES = 'events';
      expect(useSupa('events')).toBe(true);
      process.env.SUPA_SURFACES = '*';
      expect(useSupa('events')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SUPA_SURFACES;
      else process.env.SUPA_SURFACES = saved;
    }
  });

  it.skip('S-REG-06 [RECONCILIATION REQUIRED before feat/supa-events-2 writes rows] registrations table + parent_path representation: brief says fs_registrations + parent_path events/<eventId>; feat/supa-adapter @ 85e657f implements fs_group_registrations + parent_path events/<eventId>/registrations', () => {
    // Assert the reconciled representation here once the adapter owner
    // and the events implementers agree on one. Until then this stays
    // skipped so neither claim is silently blessed.
  });

  it.skip('S-E2E-01 [feat/supa-events-2] with SUPA_SURFACES=events and the adapter mocked, POST /registerForEvent and POST /api/event-registrations reproduce every E-REG-F / E-REG-P / X contract byte-identically (envelopes, counters, duplicate and capacity semantics)', () => {});

  it.skip('S-E2E-02 [feat/supa-events-4] with SUPA_SURFACES=events and the adapter mocked, the public list query contract E-LST-01 (createdAt desc, cap 12 before client filtering) and the detail contracts E-DET-02/03 hold against adapter-served rows, including S-TS timestamp forms in createdAt/startAt', () => {});
});
