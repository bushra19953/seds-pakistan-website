/**
 * @jest-environment node
 *
 * GET /api/public/warning-registry - RESTORED 2026-10-26 by founder
 * decision, reversing the Phase 2 retirement (spec E.7 Variant R).
 * This suite replaces the T37 retirement pin. The adversarial
 * companion suite (route.adversarial.test.ts) attacks the same
 * contract with polluted and stale records.
 *
 * Proven here, against a mocked Admin SDK (zero live reads):
 *  - the feed publishes ONLY the whitelisted fields (name, chapter,
 *    status, warnings, lastSanctionDate) even when the source docs
 *    carry reasons, notes, and contact data;
 *  - inclusion and status mirror the admin register, with "current"
 *    judged on the warning records: a sanction whose warnings have
 *    all lapsed or been revoked does not appear, and the published
 *    count is the count of current warnings;
 *  - blacklist and ban flags persist until founder reinstatement;
 *  - the warningConfig publicVisibility kill switch still gates the
 *    feed, and the count renders against the configured threshold;
 *  - the /warning-registry page no longer redirects and reads the feed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── In-memory fake of the Admin SDK surface the route uses ──────────
interface FakeState {
  config: Record<string, any> | null;
  chapters: Map<string, Record<string, any>>;
  users: Map<string, Record<string, any>>;
  warnings: Map<string, Record<string, any>[]>;
}

const mockState: FakeState = {
  config: null,
  chapters: new Map(),
  users: new Map(),
  warnings: new Map(),
};

function millisOf(val: any): number {
  if (!val) return 0;
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000;
  }
  return 0;
}

function docSnap(id: string, data: Record<string, any>) {
  return { id, data: () => data };
}

function warningsQuery(all: Record<string, any>[]) {
  const filters: Array<[string, string, any]> = [];
  let sortField: string | null = null;
  let sortDir = 1;
  let limitN: number | null = null;
  const builder: any = {
    where: (f: string, op: string, v: any) => {
      filters.push([f, op, v]);
      return builder;
    },
    orderBy: (f: string, dir?: string) => {
      sortField = f;
      sortDir = dir === 'desc' ? -1 : 1;
      return builder;
    },
    limit: (n: number) => {
      limitN = n;
      return builder;
    },
    get: async () => {
      let rows = all.filter((w) =>
        filters.every(([f, op, v]) => {
          const val = w[f];
          if (op === '==') return val === v;
          if (op === '>') return typeof val === 'number' && val > v;
          return false;
        })
      );
      if (sortField) {
        const f = sortField;
        rows = [...rows].sort(
          (x, y) => (millisOf(x[f]) - millisOf(y[f])) * sortDir
        );
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      const docs = rows.map((d) => ({ data: () => d }));
      return { empty: docs.length === 0, docs };
    },
  };
  return builder;
}

function makeFakeDb(state: FakeState) {
  return {
    collection: (name: string) => {
      if (name === 'warningConfig') {
        return {
          doc: (_id: string) => ({
            get: async () => ({
              exists: state.config !== null,
              data: () => state.config ?? undefined,
            }),
          }),
        };
      }
      if (name === 'chapters') {
        return {
          get: async () => ({
            docs: [...state.chapters.entries()].map(([id, d]) =>
              docSnap(id, d)
            ),
          }),
        };
      }
      if (name === 'users') {
        return {
          where: (field: string, op: string, value: any) => ({
            get: async () => {
              const matched = [...state.users.entries()].filter(
                ([, data]) => {
                  const v = data[field];
                  if (op === '>') return typeof v === 'number' && v > value;
                  if (op === '==') return v === value;
                  return false;
                }
              );
              return { docs: matched.map(([id, d]) => docSnap(id, d)) };
            },
          }),
          doc: (uid: string) => ({
            collection: (_sub: string) =>
              warningsQuery([...(state.warnings.get(uid) ?? [])]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => makeFakeDb(mockState),
}));

import { GET } from '../route';

function ts(iso: string) {
  return { seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 };
}

function activeWarning(createdIso: string, expiresIso = '2027-06-01T00:00:00.000Z') {
  return {
    isActive: true,
    isPermanent: false,
    createdAt: ts(createdIso),
    expiresAt: ts(expiresIso),
  };
}

function seedBase() {
  mockState.config = {
    blacklistThreshold: 3,
    expirationDays: 14,
    publicVisibility: true,
  };
  mockState.chapters = new Map([['seds-ist-chapter', { name: 'IST Chapter' }]]);
  mockState.users = new Map();
  mockState.warnings = new Map();
}

beforeEach(() => {
  seedBase();
});

describe('public warning registry (restored)', () => {
  test('publishes exactly the whitelisted fields, nothing else', async () => {
    mockState.users.set('u1', {
      displayName: 'Ahmed Ali',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      email: 'ahmedalikamran44@gmail.com',
      whatsappNumber: '+92 331 0000000',
      blacklistReason: 'internal reason text',
      banReason: 'internal ban text',
      warningHistory: [{ date: '2026-10-01', reason: 'internal history' }],
    });
    mockState.warnings.set('u1', [
      {
        reason: 'internal warning reason',
        notes: 'internal admin notes',
        createdBy: 'admin-uid-1',
        ...activeWarning('2026-10-14T06:53:51.355Z'),
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['entries']);
    expect(json.entries).toHaveLength(1);
    const entry = json.entries[0];
    expect(Object.keys(entry).sort()).toEqual(
      ['chapter', 'lastSanctionDate', 'name', 'status', 'warnings'].sort()
    );
    const raw = JSON.stringify(json);
    for (const poison of [
      'ahmedalikamran44@gmail.com',
      '+92 331 0000000',
      'internal reason text',
      'internal ban text',
      'internal history',
      'internal warning reason',
      'internal admin notes',
      'admin-uid-1',
      'reason',
      'notes',
      'email',
    ]) {
      expect(raw).not.toContain(poison);
    }
  });

  test('mirrors the admin register: inclusion, status, sort, chapter, date', async () => {
    // Probation: two warnings on record, one already lapsed. Only the
    // current one counts, and it sets the date.
    mockState.users.set('u-probation', {
      displayName: 'Maira Batool',
      chapterId: 'seds-ist-chapter',
      warningCount: 2,
    });
    mockState.warnings.set('u-probation', [
      activeWarning('2026-10-19T00:00:00.000Z'),
      {
        isActive: true,
        isPermanent: false,
        createdAt: ts('2026-10-10T00:00:00.000Z'),
        expiresAt: ts('2026-10-12T00:00:00.000Z'),
      },
    ]);
    // Blacklisted: three current warnings; the blacklist date is the
    // latest sanction date.
    mockState.users.set('u-blacklisted', {
      displayName: 'Black Listed',
      chapterId: 'seds-ist-chapter',
      warningCount: 3,
      isBlacklisted: true,
      blacklistedAt: ts('2026-10-20T00:00:00.000Z'),
    });
    mockState.warnings.set('u-blacklisted', [
      activeWarning('2026-10-16T00:00:00.000Z'),
      activeWarning('2026-10-17T00:00:00.000Z'),
      activeWarning('2026-10-18T00:00:00.000Z'),
    ]);
    // Banned: flag only, no warnings on record.
    mockState.users.set('u-banned', {
      displayName: 'Banned Person',
      warningCount: 0,
      isBanned: true,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries.map((e: any) => e.name)).toEqual([
      'Banned Person',
      'Black Listed',
      'Maira Batool',
    ]);
    expect(entries[0]).toMatchObject({
      status: 'banned',
      warnings: '0/3',
      lastSanctionDate: null,
    });
    expect(entries[1]).toMatchObject({
      status: 'blacklisted',
      warnings: '3/3',
      chapter: 'IST Chapter',
      lastSanctionDate: '2026-10-20T00:00:00.000Z',
    });
    expect(entries[2]).toMatchObject({
      status: 'probation',
      warnings: '1/3',
      chapter: 'IST Chapter',
      lastSanctionDate: '2026-10-19T00:00:00.000Z',
    });
  });

  test('a cleared or lapsed sanction does not appear', async () => {
    // The state the clear-probation cron leaves behind: the warning is
    // archived (isActive false, status probation_cleared) and the
    // derived counters are recomputed to 0.
    mockState.users.set('u-cleared', {
      displayName: 'Cleared Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 0,
      activeWarningCount: 0,
    });
    mockState.warnings.set('u-cleared', [
      {
        isActive: false,
        status: 'probation_cleared',
        createdAt: ts('2026-09-01T00:00:00.000Z'),
        expiresAt: ts('2026-09-15T00:00:00.000Z'),
      },
    ]);
    // Stale counters, voided sanction: the warning was revoked, so
    // nothing is current even though warningCount still says 1.
    mockState.users.set('u-voided', {
      displayName: 'Voided Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      activeWarningCount: 0,
    });
    mockState.warnings.set('u-voided', [
      {
        isActive: false,
        status: 'revoked',
        createdAt: ts('2026-10-01T00:00:00.000Z'),
        expiresAt: ts('2027-06-01T00:00:00.000Z'),
      },
    ]);
    mockState.users.set('u-plain', {
      displayName: 'Plain Member',
      chapterId: 'seds-ist-chapter',
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries).toEqual([]);
  });

  test('publicVisibility off closes the feed', async () => {
    mockState.config = {
      blacklistThreshold: 3,
      expirationDays: 14,
      publicVisibility: false,
    };
    mockState.users.set('u1', { displayName: 'Someone', warningCount: 1 });
    mockState.warnings.set('u1', [activeWarning('2026-10-01T00:00:00.000Z')]);
    const res = await GET();
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['error']);
  });

  test('warning count renders against the configured threshold', async () => {
    mockState.config = {
      blacklistThreshold: 5,
      expirationDays: 14,
      publicVisibility: true,
    };
    mockState.users.set('u1', { displayName: 'Counted', warningCount: 2 });
    mockState.warnings.set('u1', [
      activeWarning('2026-10-01T00:00:00.000Z'),
      activeWarning('2026-10-05T00:00:00.000Z'),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries[0].warnings).toBe('2/5');
  });

  test('the page no longer redirects and reads the public feed', () => {
    const pagePath = join(process.cwd(), 'src/app/warning-registry/page.tsx');
    const source = readFileSync(pagePath, 'utf8');
    expect(source).not.toContain('permanentRedirect');
    expect(source).toContain('/api/public/warning-registry');
    expect(source).toContain('No active sanctions. The register is currently clear.');
    // No shaming branding on the public page.
    expect(source.toLowerCase()).not.toContain('defaulter');
  });
});
