/**
 * @jest-environment node
 *
 * Cluster F (CRM, merge plan step 7) seam contracts for
 * src/lib/server/crm-supa.ts, against the REAL adapter over FakeSupa.
 * Zero live reads.
 *
 * Contracts pinned:
 *  - OFF parity: flag OFF => every read returns null (caller falls back
 *    to Firestore) and mirrors write nothing.
 *  - ON served: single doc, by-ids (order kept, missing skipped),
 *    status-filtered list, and updatedAt-desc list with ISO-normalized
 *    timestamps and the id-ascending tiebreak for equal-second rows.
 *  - Whole-collection completeness: 1005 seeded rows come back whole
 *    (the adapter keyset-pages; no 1000-row silent truncation) — the
 *    sponsor-match panel's P14 read pattern.
 *  - Pagination: limit+cursor pages tile the collection exactly once.
 *  - Error fallback: a failing adapter yields null reads; mirrors never
 *    throw.
 *  - Mirrors: create/update/delete land in fs_sponsors_partners;
 *    update of a missing mirror row converges via setDoc merge;
 *    serverTimestamp sentinels and Dates serialize to ISO strings.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow, dumpedTimestamp } from '@/lib/supa/__tests__/fake-supa';
import {
  __setCrmSupaEnabledForTests,
  __setCrmSupaPortForTests,
  crmSupaEnabled,
  mirrorPartnerCreate,
  mirrorPartnerDelete,
  mirrorPartnerUpdate,
  normalizePartnerTimes,
  serializePartnerForMirror,
  supaGetPartner,
  supaGetPartnersByIds,
  supaListAllPartners,
  supaListPartnersByStatus,
  supaListPartnersPage,
  supaPartnerDoc,
  type CrmSupaPort,
} from '../crm-supa';

const TABLE = 'fs_sponsors_partners';

function portFor(fake: FakeSupa): CrmSupaPort {
  return createSupaAdapter(fake as unknown as SupabaseClient) as unknown as CrmSupaPort;
}

function seedBasic(fake: FakeSupa): FakeSupa {
  return fake.seed(TABLE, [
    landingRow('p-old', {
      organizationName: 'Old Co',
      status: 'Past',
      updatedAt: dumpedTimestamp('2026-01-01T10:00:00.000Z'),
      createdAt: dumpedTimestamp('2025-12-01T10:00:00.000Z'),
    }),
    landingRow('p-b', {
      organizationName: 'Bee Co',
      status: 'Active',
      // Same second as p-a: the id-ascending tiebreak decides order.
      updatedAt: '2026-03-01T10:00:00.500Z',
    }),
    landingRow('p-a', {
      organizationName: 'Aye Co',
      status: 'Active',
      updatedAt: dumpedTimestamp('2026-03-01T10:00:00.500Z'),
      timeline: [{ id: 't1', timestamp: dumpedTimestamp('2026-02-01T09:00:00.000Z'), content: 'call' }],
    }),
  ]);
}

beforeEach(() => {
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
});

afterEach(() => {
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
});

describe('OFF parity', () => {
  it('flag OFF: reads return null and mirrors write nothing', async () => {
    const fake = seedBasic(new FakeSupa());
    __setCrmSupaEnabledForTests(false);
    __setCrmSupaPortForTests(portFor(fake));

    expect(crmSupaEnabled()).toBe(false);
    expect(await supaListAllPartners()).toBeNull();
    expect(await supaPartnerDoc('p-a')).toBeNull();
    expect(await supaGetPartnersByIds(['p-a'])).toBeNull();
    expect(await supaListPartnersPage({ limit: 2 })).toBeNull();

    await mirrorPartnerCreate('p-new', { organizationName: 'Nope' });
    await mirrorPartnerUpdate('p-a', { status: 'Past' });
    await mirrorPartnerDelete('p-a');
    expect(fake.rows(TABLE)).toHaveLength(3);
    expect(fake.rows(TABLE).find((r) => r.id === 'p-a')?.data.status).toBe('Active');
  });
});

describe('ON served', () => {
  beforeEach(() => {
    __setCrmSupaEnabledForTests(true);
  });

  it('list: updatedAt desc, equal-second id tiebreak, ISO normalization incl. nested timeline', async () => {
    const fake = seedBasic(new FakeSupa());
    __setCrmSupaPortForTests(portFor(fake));

    const rows = await supaListAllPartners();
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.id)).toEqual(['p-a', 'p-b', 'p-old']);
    expect(rows![0].updatedAt).toBe('2026-03-01T10:00:00.500Z');
    expect(rows![2].createdAt).toBe('2025-12-01T10:00:00.000Z');
    const timeline = rows![0].timeline as Array<Record<string, unknown>>;
    expect(timeline[0].timestamp).toBe('2026-02-01T09:00:00.000Z');
  });

  it('single doc: fake-doc shape, exists and not-exists', async () => {
    const fake = seedBasic(new FakeSupa());
    __setCrmSupaPortForTests(portFor(fake));

    const hit = await supaPartnerDoc('p-a');
    expect(hit?.exists).toBe(true);
    expect(hit?.data()?.organizationName).toBe('Aye Co');
    const miss = await supaPartnerDoc('nope');
    expect(miss?.exists).toBe(false);
    expect(miss?.data()).toBeUndefined();
    expect(await supaGetPartner('p-b')).toMatchObject({ id: 'p-b', organizationName: 'Bee Co' });
    expect(await supaGetPartner('nope')).toBeNull();
  });

  it('by-ids: input order kept, missing skipped', async () => {
    const fake = seedBasic(new FakeSupa());
    __setCrmSupaPortForTests(portFor(fake));
    const rows = await supaGetPartnersByIds(['p-old', 'ghost', 'p-a']);
    expect(rows!.map((r) => r.id)).toEqual(['p-old', 'p-a']);
  });

  it('status filter: only matching rows; All/null means whole collection', async () => {
    const fake = seedBasic(new FakeSupa());
    __setCrmSupaPortForTests(portFor(fake));
    expect((await supaListPartnersByStatus('Active'))!.map((r) => r.id)).toEqual(['p-a', 'p-b']);
    expect((await supaListPartnersByStatus('All'))).toHaveLength(3);
    expect((await supaListPartnersByStatus(null))).toHaveLength(3);
  });

  it('whole-collection completeness: 1005 rows, no truncation', async () => {
    const rows = Array.from({ length: 1005 }, (_, i) =>
      landingRow(`bulk-${String(i).padStart(4, '0')}`, {
        organizationName: `Bulk ${i}`,
        status: 'Active',
        updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      }),
    );
    const fake = new FakeSupa().seed(TABLE, rows);
    __setCrmSupaPortForTests(portFor(fake));

    const all = await supaListAllPartners();
    expect(all).toHaveLength(1005);
    expect(new Set(all!.map((r) => r.id)).size).toBe(1005);
    // Newest first.
    expect(all![0].id).toBe('bulk-1004');
  }, 30_000);

  it('pagination: pages tile the collection exactly once, cursor ends null', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      landingRow(`pg-${i}`, {
        organizationName: `Page ${i}`,
        status: 'Active',
        updatedAt: new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString(),
      }),
    );
    const fake = new FakeSupa().seed(TABLE, rows);
    __setCrmSupaPortForTests(portFor(fake));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await supaListPartnersPage({ limit: 2, cursor });
      expect(page).not.toBeNull();
      seen.push(...page!.partners.map((r) => String(r.id)));
      cursor = page!.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['pg-4', 'pg-3', 'pg-2', 'pg-1', 'pg-0']);
  });
});

describe('error fallback', () => {
  it('throwing adapter: reads return null, mirrors resolve without throwing', async () => {
    __setCrmSupaEnabledForTests(true);
    const boom = () => {
      throw new Error('adapter down');
    };
    __setCrmSupaPortForTests({
      listDocs: boom as never,
      getDoc: boom as never,
      setDoc: boom as never,
      updateDoc: boom as never,
      deleteDoc: boom as never,
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await supaListAllPartners()).toBeNull();
      expect(await supaPartnerDoc('p-a')).toBeNull();
      await expect(mirrorPartnerCreate('x', {})).resolves.toBeUndefined();
      await expect(mirrorPartnerUpdate('x', {})).resolves.toBeUndefined();
      await expect(mirrorPartnerDelete('x')).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('mirrors', () => {
  beforeEach(() => {
    __setCrmSupaEnabledForTests(true);
  });

  it('create/update/delete land in fs_sponsors_partners; missing-row update converges', async () => {
    const fake = seedBasic(new FakeSupa());
    __setCrmSupaPortForTests(portFor(fake));

    await mirrorPartnerCreate('p-new', {
      organizationName: 'New Co',
      status: 'Prospect',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    let row = fake.rows(TABLE).find((r) => r.id === 'p-new');
    expect(row?.data.organizationName).toBe('New Co');
    expect(row?.data.createdAt).toBe('2026-04-01T00:00:00.000Z');

    await mirrorPartnerUpdate('p-new', { status: 'Active' });
    row = fake.rows(TABLE).find((r) => r.id === 'p-new');
    expect(row?.data.status).toBe('Active');
    expect(row?.data.organizationName).toBe('New Co');

    // Update against a row the mirror never saw: setDoc-merge fallback.
    await mirrorPartnerUpdate('p-ghost', { organizationName: 'Ghost Co' });
    expect(fake.rows(TABLE).find((r) => r.id === 'p-ghost')?.data.organizationName).toBe('Ghost Co');

    await mirrorPartnerDelete('p-new');
    expect(fake.rows(TABLE).find((r) => r.id === 'p-new')).toBeUndefined();
  });
});

describe('serialization + normalization helpers', () => {
  it('serverTimestamp sentinel and Date become ISO strings', () => {
    const out = serializePartnerForMirror({
      updatedAt: { _methodName: 'serverTimestamp' },
      when: new Date('2026-05-05T05:05:05.000Z'),
      nested: { at: { _seconds: 1767225600, _nanoseconds: 0 } },
      plain: 'keep',
    }) as Record<string, unknown>;
    expect(typeof out.updatedAt).toBe('string');
    expect(out.when).toBe('2026-05-05T05:05:05.000Z');
    expect((out.nested as Record<string, unknown>).at).toBe('2026-01-01T00:00:00.000Z');
    expect(out.plain).toBe('keep');
  });

  it('normalizePartnerTimes leaves unparseable values and nulls untouched', () => {
    const out = normalizePartnerTimes({
      id: 'x',
      updatedAt: 'not-a-date',
      createdAt: null,
      lastContactAt: dumpedTimestamp('2026-02-02T02:02:02.000Z'),
    });
    expect(out.updatedAt).toBe('not-a-date');
    expect(out.createdAt).toBeNull();
    expect(out.lastContactAt).toBe('2026-02-02T02:02:02.000Z');
  });
});
