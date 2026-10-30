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
 *
 * Audit-fix regressions (fix/warning-registry-audit-fixes):
 *  - WR-20: a banned-only entry shows its bannedAt as the sanction
 *    date;
 *  - WR-21: a revoked newest warning never supplies the date; the
 *    newest ACTIVE warning does;
 *  - WR-26 fail-closed: a warningConfig read error withholds every
 *    entry, never defaults public. Perf fix 2026-10-30: the
 *    withholding is now LOUD (500), not a fake-empty 200.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── In-memory fake of the Admin SDK surface the route uses ──────────
interface FakeState {
  config: Record<string, any> | null;
  configError: boolean;
  chapters: Map<string, Record<string, any>>;
  users: Map<string, Record<string, any>>;
  warnings: Map<string, Record<string, any>[]>;
  // v2 read accounting: user docs actually returned by the marker
  // queries (Firestore bills per returned doc) and the uids whose
  // warnings subcollection was read.
  userDocsReturned: number;
  userLimitsSeen: number[];
  warningReadUids: string[];
  // Perf-fix instrumentation (2026-10-30): per-uid warnings read
  // failures, config read count (the kill switch must stay fresh),
  // warnings-read concurrency (parallelism proof), and an artificial
  // per-RPC delay for the timing/concurrency harness.
  warningsErrorUids: Set<string>;
  configReads: number;
  warningsInFlight: number;
  warningsMaxConcurrent: number;
  rpcDelayMs: number;
}

const mockState: FakeState = {
  config: null,
  configError: false,
  chapters: new Map(),
  users: new Map(),
  warnings: new Map(),
  userDocsReturned: 0,
  userLimitsSeen: [],
  warningReadUids: [],
  warningsErrorUids: new Set(),
  configReads: 0,
  warningsInFlight: 0,
  warningsMaxConcurrent: 0,
  rpcDelayMs: 0,
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

function warningsQuery(all: Record<string, any>[], uid?: string) {
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
      if (uid) mockState.warningReadUids.push(uid);
      if (uid && mockState.warningsErrorUids.has(uid)) {
        throw new Error('warnings read failed (fixture)');
      }
      mockState.warningsInFlight += 1;
      mockState.warningsMaxConcurrent = Math.max(
        mockState.warningsMaxConcurrent,
        mockState.warningsInFlight
      );
      if (mockState.rpcDelayMs > 0) {
        await new Promise((r) => setTimeout(r, mockState.rpcDelayMs));
      }
      mockState.warningsInFlight -= 1;
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
            get: async () => {
              state.configReads += 1;
              if (state.configError) {
                throw new Error('warningConfig read failed (fixture)');
              }
              return {
                exists: state.config !== null,
                data: () => state.config ?? undefined,
              };
            },
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
          where: (field: string, op: string, value: any) => {
            let limitN: number | null = null;
            const builder: any = {
              limit: (n: number) => {
                limitN = n;
                state.userLimitsSeen.push(n);
                return builder;
              },
              get: async () => {
                let matched = [...state.users.entries()].filter(
                  ([, data]) => {
                    const v = data[field];
                    if (op === '>') return typeof v === 'number' && v > value;
                    if (op === '==') return v === value;
                    return false;
                  }
                );
                if (limitN !== null) matched = matched.slice(0, limitN);
                state.userDocsReturned += matched.length;
                return { docs: matched.map(([id, d]) => docSnap(id, d)) };
              },
            };
            return builder;
          },
          doc: (uid: string) => ({
            collection: (_sub: string) =>
              warningsQuery([...(state.warnings.get(uid) ?? [])], uid),
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

import { GET, __resetWarningRegistryCache } from '../route';

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
  mockState.configError = false;
  mockState.chapters = new Map([['seds-ist-chapter', { name: 'IST Chapter' }]]);
  mockState.users = new Map();
  mockState.warnings = new Map();
  mockState.userDocsReturned = 0;
  mockState.userLimitsSeen = [];
  mockState.warningReadUids = [];
  mockState.warningsErrorUids = new Set();
  mockState.configReads = 0;
  mockState.warningsInFlight = 0;
  mockState.warningsMaxConcurrent = 0;
  mockState.rpcDelayMs = 0;
}

beforeEach(() => {
  seedBase();
  __resetWarningRegistryCache();
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
    expect(Object.keys(json).sort()).toEqual(
      ['entries', 'page', 'pageSize', 'total', 'totalPages'].sort()
    );
    expect(json.entries).toHaveLength(1);
    const entry = json.entries[0];
    expect(Object.keys(entry).sort()).toEqual(
      [
        'chapter',
        'expiresAt',
        'lastSanctionDate',
        'name',
        'profilePath',
        'status',
        'warnings',
      ].sort()
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

  test('WR-20: a banned-only entry shows the ban date', async () => {
    // The only sanction is the ban itself: no warnings subcollection
    // docs, no blacklist. bannedAt (written by the expulsion path)
    // must supply the date, not null.
    mockState.users.set('u-banned-only', {
      displayName: 'Banned Only',
      chapterId: 'seds-ist-chapter',
      warningCount: 0,
      isBanned: true,
      bannedAt: ts('2026-10-22T00:00:00.000Z'),
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'banned',
      lastSanctionDate: '2026-10-22T00:00:00.000Z',
    });
  });

  test('WR-21: a revoked newest warning does not supply the date', async () => {
    // Newest warning is revoked (isActive false); the older warning
    // is still current. The displayed date must be the CURRENT one.
    // Reconciliation note: the audit-fix fixture seeded the older
    // warning bare (no expiresAt); under cb330eb6 currency semantics
    // with expirationDays 14 it would itself be expired by the run
    // date, so it is seeded via activeWarning() (expiresAt 2027),
    // which keeps the WR-21 assertion identical in intent.
    mockState.users.set('u-revoked-latest', {
      displayName: 'Revoked Latest',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
    });
    mockState.warnings.set('u-revoked-latest', [
      {
        isActive: false,
        status: 'revoked',
        createdAt: ts('2026-10-25T00:00:00.000Z'),
      },
      activeWarning('2026-10-12T00:00:00.000Z'),
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].lastSanctionDate).toBe('2026-10-12T00:00:00.000Z');
  });

  test('WR-26 fail-closed, loud (perf fix 2026-10-30): a warningConfig read error serves NO entries and answers 500, never a fake-empty 200', async () => {
    mockState.configError = true;
    mockState.users.set('u1', {
      displayName: 'Should Not Appear',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
    });
    mockState.warnings.set('u1', [
      activeWarning('2026-10-19T00:00:00.000Z'),
    ]);

    const res = await GET();
    // Privacy is unchanged (nothing is published: the stored "off"
    // might be in effect), but the response no longer claims the
    // register is clear: an unreachable source is a loud error. The
    // 2026-10-30 06:00 incident served entries=0 with 200 during the
    // quota death; the perf-fix brief retires that shape.
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['error']);
    expect(JSON.stringify(json)).not.toContain('Should Not Appear');
  });

  test('the page no longer redirects and reads the public feed', () => {
    const pagePath = join(process.cwd(), 'src/app/warning-registry/page.tsx');
    const source = readFileSync(pagePath, 'utf8');
    expect(source).not.toContain('permanentRedirect');
    expect(source).toContain('/api/public/warning-registry');
    expect(source).toContain('The register is clear.');
    // No shaming branding on the public page.
    expect(source.toLowerCase()).not.toContain('defaulter');
  });
});

// =====================================================================
// v2 (founder order 2026-10-26): expiry shown, people clickable,
// built to scale (bounded reads, pagination, filters, search).
// =====================================================================

function getWith(query: string) {
  return (GET as any)({
    url: `http://test.local/api/public/warning-registry${query}`,
  });
}

const V2_ENTRY_KEYS = [
  'chapter',
  'expiresAt',
  'lastSanctionDate',
  'name',
  'profilePath',
  'status',
  'warnings',
];

function seedProbationMember(
  uid: string,
  name: string,
  chapterId: string | undefined,
  warnings: Record<string, any>[]
) {
  mockState.users.set(uid, {
    displayName: name,
    chapterId,
    warningCount: warnings.length,
    activeWarningCount: warnings.length,
  });
  mockState.warnings.set(uid, warnings);
}

describe('v2: expiry computation', () => {
  test('expiresAt is the LATEST expiry among current warnings (stored expiresAt)', async () => {
    seedProbationMember('u-exp', 'Expiry Member', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
      activeWarning('2026-10-10T00:00:00.000Z', '2027-02-15T00:00:00.000Z'),
      // A lapsed warning with a later date must not extend the expiry.
      {
        isActive: true,
        isPermanent: false,
        createdAt: ts('2026-09-01T00:00:00.000Z'),
        expiresAt: ts('2026-09-10T00:00:00.000Z'),
      },
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].expiresAt).toBe('2027-02-15T00:00:00.000Z');
    expect(entries[0].warnings).toBe('2/3');
  });

  test('expiresAt falls back to createdAt + expirationDays when expiresAt is not stored', async () => {
    // Clock pinned so the fixture is deterministic on any run date:
    // warning created 2026-10-20, config expirationDays 14, so the
    // fallback expiry is 2026-11-03 and the warning is still current
    // on 2026-10-26.
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-26T12:00:00.000Z'));
    try {
      seedProbationMember('u-fallback', 'Fallback Member', 'seds-ist-chapter', [
        {
          isActive: true,
          isPermanent: false,
          createdAt: ts('2026-10-20T00:00:00.000Z'),
        },
      ]);
      const res = await GET();
      const { entries } = await res.json();
      expect(entries).toHaveLength(1);
      expect(entries[0].expiresAt).toBe('2026-11-03T00:00:00.000Z');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('Fahad-shaped fixture: expiry renders as 27 Oct 2026', async () => {
    // The acceptance case from the live register: one warning,
    // created 2026-10-13, no stored expiresAt, expirationDays 14 in
    // config. 13 Oct + 14 days = 27 Oct 2026.
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-26T12:00:00.000Z'));
    try {
      seedProbationMember('u-fahad', 'Fahad Ullah', 'seds-ist-chapter', [
        {
          isActive: true,
          isPermanent: false,
          createdAt: ts('2026-10-13T00:00:00.000Z'),
        },
      ]);
      const res = await GET();
      const { entries } = await res.json();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('Fahad Ullah');
      expect(entries[0].expiresAt).toBe('2026-10-27T00:00:00.000Z');
      // The page format ('d MMM yyyy') of that instant in UTC.
      expect(
        new Date(entries[0].expiresAt).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        })
      ).toBe('27 Oct 2026');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('a permanent current warning means no expiry (expiresAt null)', async () => {
    seedProbationMember('u-perm', 'Permanent Member', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'),
      {
        isActive: true,
        isPermanent: true,
        createdAt: ts('2026-10-05T00:00:00.000Z'),
      },
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].expiresAt).toBeNull();
  });

  test('blacklisted and banned entries carry no expiry (until reinstated)', async () => {
    mockState.users.set('u-bl', {
      displayName: 'Black Listed',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      isBlacklisted: true,
      blacklistedAt: ts('2026-10-20T00:00:00.000Z'),
    });
    mockState.warnings.set('u-bl', [
      activeWarning('2026-10-19T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
    ]);
    mockState.users.set('u-bn', {
      displayName: 'Banned Person',
      warningCount: 0,
      isBanned: true,
      bannedAt: ts('2026-10-21T00:00:00.000Z'),
    });
    const res = await GET();
    const { entries } = await res.json();
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.expiresAt).toBeNull();
  });
});

describe('v2: people are clickable (profilePath)', () => {
  test('profilePath is the canonical unified profile route for the member uid', async () => {
    seedProbationMember('uid-abc-123', 'Linked Member', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].profilePath).toBe('/profile/unified/uid-abc-123');
    expect(Object.keys(entries[0]).sort()).toEqual([...V2_ENTRY_KEYS].sort());
  });
});

describe('v2: pagination, filters, search', () => {
  function seedThirty() {
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(2, '0');
      seedProbationMember(`u-${n}`, `Member ${n}`, 'seds-ist-chapter', [
        activeWarning('2026-10-01T00:00:00.000Z'),
      ]);
    }
  }

  test('default page is 25 with totals; page 2 returns the remainder', async () => {
    seedThirty();
    const res1 = await getWith('');
    const j1 = await res1.json();
    expect(j1.entries).toHaveLength(25);
    expect(j1.total).toBe(30);
    expect(j1.page).toBe(1);
    expect(j1.pageSize).toBe(25);
    expect(j1.totalPages).toBe(2);

    const res2 = await getWith('?page=2');
    const j2 = await res2.json();
    expect(j2.entries).toHaveLength(5);
    expect(j2.page).toBe(2);
    const names = new Set([
      ...j1.entries.map((e: any) => e.name),
      ...j2.entries.map((e: any) => e.name),
    ]);
    expect(names.size).toBe(30);
  });

  test('pageSize is capped at 50 and honoured below the cap', async () => {
    seedThirty();
    const capped = await (await getWith('?pageSize=500')).json();
    expect(capped.pageSize).toBe(50);
    expect(capped.entries).toHaveLength(30);
    const small = await (await getWith('?pageSize=10&page=3')).json();
    expect(small.pageSize).toBe(10);
    expect(small.entries).toHaveLength(10);
    expect(small.totalPages).toBe(3);
  });

  test('status filter returns only that status', async () => {
    seedProbationMember('u-p', 'Probation Person', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    mockState.users.set('u-b', {
      displayName: 'Banned Person',
      warningCount: 0,
      isBanned: true,
      bannedAt: ts('2026-10-21T00:00:00.000Z'),
    });
    const banned = await (await getWith('?status=banned')).json();
    expect(banned.total).toBe(1);
    expect(banned.entries[0].status).toBe('banned');
    const probation = await (await getWith('?status=probation')).json();
    expect(probation.total).toBe(1);
    expect(probation.entries[0].status).toBe('probation');
  });

  test('chapter filter matches by chapter name and by chapter id', async () => {
    mockState.chapters.set('seds-lhr-chapter', { name: 'Lahore Chapter' });
    seedProbationMember('u-ist', 'IST Person', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    seedProbationMember('u-lhr', 'Lahore Person', 'seds-lhr-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    const byName = await (await getWith('?chapter=Lahore%20Chapter')).json();
    expect(byName.total).toBe(1);
    expect(byName.entries[0].name).toBe('Lahore Person');
    const byId = await (await getWith('?chapter=seds-ist-chapter')).json();
    expect(byId.total).toBe(1);
    expect(byId.entries[0].name).toBe('IST Person');
  });

  test('name search is a case-insensitive substring and composes with chapter and status', async () => {
    mockState.chapters.set('seds-lhr-chapter', { name: 'Lahore Chapter' });
    seedProbationMember('u-1', 'Fatima Noor', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    seedProbationMember('u-2', 'Fatima Zahra', 'seds-lhr-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    seedProbationMember('u-3', 'Ahmed Raza', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    const search = await (await getWith('?q=fatima')).json();
    expect(search.total).toBe(2);
    const composed = await (
      await getWith('?q=FATIMA&chapter=IST%20Chapter&status=probation')
    ).json();
    expect(composed.total).toBe(1);
    expect(composed.entries[0].name).toBe('Fatima Noor');
    const none = await (await getWith('?q=no-such-person')).json();
    expect(none.total).toBe(0);
    expect(none.entries).toEqual([]);
  });

  test('filters apply BEFORE warning reads: only surviving members have warnings read', async () => {
    mockState.chapters.set('seds-lhr-chapter', { name: 'Lahore Chapter' });
    for (let i = 0; i < 10; i++) {
      seedProbationMember(`u-ist-${i}`, `IST Member ${i}`, 'seds-ist-chapter', [
        activeWarning('2026-10-01T00:00:00.000Z'),
      ]);
      seedProbationMember(`u-lhr-${i}`, `LHR Member ${i}`, 'seds-lhr-chapter', [
        activeWarning('2026-10-01T00:00:00.000Z'),
      ]);
    }
    const res = await getWith('?chapter=Lahore%20Chapter');
    const json = await res.json();
    expect(json.total).toBe(10);
    expect(mockState.warningReadUids.sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `u-lhr-${i}`).sort()
    );
  });

  test('candidate scan is bounded: 600 sanctioned members cost at most 500 user reads', async () => {
    for (let i = 0; i < 600; i++) {
      seedProbationMember(`bulk-${i}`, `Bulk Member ${i}`, 'seds-ist-chapter', [
        activeWarning('2026-10-01T00:00:00.000Z'),
      ]);
    }
    const res = await getWith('');
    const json = await res.json();
    expect(mockState.userDocsReturned).toBeLessThanOrEqual(500);
    expect(mockState.userLimitsSeen.length).toBeGreaterThan(0);
    for (const l of mockState.userLimitsSeen) expect(l).toBeLessThanOrEqual(500);
    expect(json.total).toBeLessThanOrEqual(500);
    expect(json.entries.length).toBeLessThanOrEqual(25);
  });
});

describe('v2: page upgrades (source)', () => {
  test('page shows expiry, links people, and carries filters + pagination', () => {
    const pagePath = join(process.cwd(), 'src/app/warning-registry/page.tsx');
    const source = readFileSync(pagePath, 'utf8');
    expect(source).toContain('Expires');
    expect(source).toContain('Until reinstated');
    expect(source).toContain('No expiry');
    expect(source).toContain('profilePath');
    expect(source).toContain('Showing');
    expect(source).toContain('pageSize');
    expect(source.toLowerCase()).not.toContain('defaulter');
  });
});

describe('read-bleed fix (census 15): caching + per-member warnings bound', () => {
  test('successful response carries the shared-cache header', async () => {
    seedProbationMember('u-cache', 'Cached Member', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    const res = await getWith('');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=120');
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.entries[0].name).toBe('Cached Member');
  });

  test('config read error response is NOT cached (loud 500, perf fix 2026-10-30)', async () => {
    mockState.configError = true;
    const res = await getWith('');
    expect(res.status).toBe(500);
    const cc = res.headers.get('cache-control') || '';
    expect(cc).not.toContain('s-maxage');
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['error']);
  });

  test('per-member warnings read is bounded: 150 warnings judge as at most 100', async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      activeWarning(`2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`)
    );
    seedProbationMember('u-many', 'Many Warnings', 'seds-ist-chapter', many);
    const res = await getWith('');
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.entries[0].warnings).toBe('100/3');
  });
});

// =====================================================================
// Perf fix (2026-10-30): the route was the slowest public data route
// (median 3.04 s, p95 8.59 s live) because ~10 Firestore round trips
// ran SEQUENTIALLY per request (config, chapters, 4 marker queries,
// then one warnings read per candidate, each awaited in a loop) and
// no payload was ever cached in-process. Proven here against the
// instrumented fake:
//  - the expensive read set runs in parallel rounds, not a chain;
//  - a repeat request with the same query is served from the
//    in-process payload cache (hierarchy-route pattern) while the
//    warningConfig read still runs fresh, so the kill switch and a
//    settings change take effect on the very next request;
//  - a failed warnings read is a loud 500, never a silently dropped
//    or undercounted member (a false register).
// =====================================================================

describe('perf fix (2026-10-30): parallel reads, payload cache, loud failures', () => {
  function seedFourCandidates() {
    for (let i = 0; i < 4; i++) {
      seedProbationMember(`u-par-${i}`, `Parallel ${i}`, 'seds-ist-chapter', [
        activeWarning('2026-10-01T00:00:00.000Z'),
      ]);
    }
  }

  test('warnings reads for multiple candidates run concurrently, not in a sequential loop', async () => {
    seedFourCandidates();
    mockState.rpcDelayMs = 25;
    const res = await getWith('');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(4);
    expect(mockState.warningsMaxConcurrent).toBeGreaterThanOrEqual(3);
  });

  test('repeat request is served from the payload cache: no marker or warnings reads repeat, config still read fresh', async () => {
    seedFourCandidates();
    const res1 = await getWith('');
    const j1 = await res1.json();
    expect(j1.total).toBe(4);
    const docsAfterFirst = mockState.userDocsReturned;
    const warningsAfterFirst = [...mockState.warningReadUids];
    const configReadsAfterFirst = mockState.configReads;
    expect(docsAfterFirst).toBeGreaterThan(0);
    expect(warningsAfterFirst).toHaveLength(4);

    const res2 = await getWith('');
    const j2 = await res2.json();
    expect(j2).toEqual(j1);
    // The expensive sets did not run again...
    expect(mockState.userDocsReturned).toBe(docsAfterFirst);
    expect(mockState.warningReadUids).toEqual(warningsAfterFirst);
    // ...but the config read DID (kill-switch freshness).
    expect(mockState.configReads).toBe(configReadsAfterFirst + 1);
  });

  test('a different query misses the cache and re-reads', async () => {
    seedFourCandidates();
    await getWith('');
    const docsAfterFirst = mockState.userDocsReturned;
    const res = await getWith('?pageSize=2');
    const json = await res.json();
    expect(json.entries).toHaveLength(2);
    expect(mockState.userDocsReturned).toBeGreaterThan(docsAfterFirst);
  });

  test('a settings change (threshold) bypasses the cached payload via the fingerprint', async () => {
    seedFourCandidates();
    const j1 = await (await getWith('')).json();
    expect(j1.entries[0].warnings).toBe('1/3');
    mockState.config = {
      blacklistThreshold: 7,
      expirationDays: 14,
      publicVisibility: true,
    };
    const j2 = await (await getWith('')).json();
    expect(j2.entries[0].warnings).toBe('1/7');
  });

  test('kill switch still closes the feed immediately, even with a warm cache', async () => {
    seedFourCandidates();
    const res1 = await getWith('');
    expect(res1.status).toBe(200);
    mockState.config = {
      blacklistThreshold: 3,
      expirationDays: 14,
      publicVisibility: false,
    };
    const res2 = await getWith('');
    expect(res2.status).toBe(403);
  });

  test('a failed warnings read is a loud 500, never a silently dropped member', async () => {
    seedProbationMember('u-good', 'Good Member', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    seedProbationMember('u-bad', 'Unreadable Member', 'seds-ist-chapter', [
      activeWarning('2026-10-01T00:00:00.000Z'),
    ]);
    mockState.warningsErrorUids.add('u-bad');
    const res = await getWith('');
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['error']);
  });
});
