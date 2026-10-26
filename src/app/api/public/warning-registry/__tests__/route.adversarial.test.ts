/**
 * @jest-environment node
 *
 * ADVERSARIAL suite for GET /api/public/warning-registry (restored
 * 2026-10-26, founder decision). Companion to route.test.ts: that suite
 * proves the happy-path contract against clean-ish fixtures; this suite
 * assumes the implementation LOOKS right and attacks it with polluted,
 * stale, and dump-realistic records.
 *
 * Founder-approved design under test (fixed):
 *  - the public feed lists CURRENT ACTIVE sanctions ONLY;
 *  - each person object carries EXACTLY the whitelist: name, chapter,
 *    status, warnings (count), lastSanctionDate. Nothing else may ever
 *    leak: no reasons, no case details, no notes, no email, no phone,
 *    no internal record fields, no ids that resolve to case details;
 *  - a sanction past its expiry date does not appear even if its
 *    status string was never updated (per-warning expiry as the admin
 *    register's WarningStatusBadge defines it: !isPermanent and
 *    expiresAt before now means Expired; !isActive means Revoked);
 *  - the published warning count reflects ACTIVE warnings only;
 *  - blacklist/ban FLAGS are a distinct current sanction: they persist
 *    until a founder reinstatement clears them (admin register +
 *    clear-probation cron: "isBlacklisted is NEVER cleared here"), so
 *    an expired warning must not erase a still-flagged blacklist entry.
 *
 * Fixture shapes are hand-built from the production dump record shapes
 * in ~/workspace/supabase-migration/dump/ (users.json: warningCount,
 * warningHistory[{date, reason, taskId, revoked}], blacklistedAt,
 * blacklistReason, banReason, whatsapp, whatsappNumber, fcmTokens,
 * searchableIndex; warningConfig.json global: blacklistThreshold 3,
 * expirationDays 14, publicVisibility). ZERO live Firestore reads.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------
// In-memory fake of the Admin SDK surface the route uses. The warnings
// subcollection query is a chainable builder (where/orderBy/limit/get
// in any order) so these tests keep running unchanged if the route is
// fixed to filter active warnings in the query instead of in code.
// ---------------------------------------------------------------------
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
    return val.seconds * 1000 + (val.nanoseconds || 0) / 1000000;
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function compareVal(v: any, op: string, value: any): boolean {
  const a = millisOf(v) || v;
  const b = millisOf(value) || value;
  switch (op) {
    case '==':
      return v === value;
    case '!=':
      return v !== value;
    case '>':
      return typeof a === 'number' && typeof b === 'number' ? a > b : v > value;
    case '>=':
      return typeof a === 'number' && typeof b === 'number' ? a >= b : v >= value;
    case '<':
      return typeof a === 'number' && typeof b === 'number' ? a < b : v < value;
    case '<=':
      return typeof a === 'number' && typeof b === 'number' ? a <= b : v <= value;
    default:
      return false;
  }
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
        filters.every(([f, op, v]) => compareVal(w[f], op, v))
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
              const matched = [...state.users.entries()].filter(([, data]) =>
                compareVal(data[field], op, value)
              );
              return { docs: matched.map(([id, d]) => docSnap(id, d)) };
            },
          }),
          doc: (uid: string) => ({
            get: async () => ({
              exists: state.users.has(uid),
              id: uid,
              data: () => state.users.get(uid),
            }),
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

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;

function ts(date: Date) {
  return {
    seconds: Math.floor(date.getTime() / 1000),
    nanoseconds: 0,
  };
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}
function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * DAY);
}

const WHITELIST_KEYS = [
  'chapter',
  'lastSanctionDate',
  'name',
  'status',
  'warnings',
];

function expectExactWhitelist(entry: any) {
  // Set equality, not absence-of-known-bad-keys: any future field the
  // serializer picks up (zzzFutureField today, anything tomorrow)
  // fails this assertion.
  expect(Object.keys(entry).sort()).toEqual([...WHITELIST_KEYS].sort());
}

function seedBase() {
  mockState.config = {
    blacklistThreshold: 3,
    expirationDays: 14,
    publicVisibility: true,
  };
  mockState.chapters = new Map([
    ['seds-ist-chapter', { name: 'IST Chapter' }],
  ]);
  mockState.users = new Map();
  mockState.warnings = new Map();
}

beforeEach(() => {
  seedBase();
});

// Poison values planted across user doc, warning subdoc, chapter doc,
// and config doc. None of these strings may appear anywhere in the
// serialized response, and none of these KEY names may appear either.
const POISON_VALUES = [
  'poison-reason-text',
  'poison-details-text',
  'poison-notes-text',
  'poison-internal-notes',
  'poison@example.com',
  '+92 300 9999999',
  'poison-decided-by-uid',
  'poison-case-id-123',
  'poison-future-field-value',
  'poison-task-id',
  'poison-fcm-token',
  'poison-chapter-secret',
  'poison-config-secret',
];
const POISON_KEYS = [
  'reason',
  'details',
  'notes',
  'internalNotes',
  'email',
  'phone',
  'whatsapp',
  'whatsappNumber',
  'decidedBy',
  'createdBy',
  'caseId',
  'zzzFutureField',
  'warningHistory',
  'fcmTokens',
  'blacklistReason',
  'banReason',
];

function pollutedUser(extra: Record<string, any>): Record<string, any> {
  return {
    displayName: 'Polluted Person',
    chapterId: 'seds-ist-chapter',
    warningCount: 1,
    reason: 'poison-reason-text',
    details: 'poison-details-text',
    notes: 'poison-notes-text',
    internalNotes: 'poison-internal-notes',
    email: 'poison@example.com',
    phone: '+92 300 9999999',
    whatsapp: '+92 300 9999999',
    whatsappNumber: '+92 300 9999999',
    decidedBy: 'poison-decided-by-uid',
    caseId: 'poison-case-id-123',
    zzzFutureField: 'poison-future-field-value',
    blacklistReason: 'poison-reason-text',
    banReason: 'poison-reason-text',
    warningHistory: [
      { date: '2026-04-26', reason: 'poison-reason-text', taskId: 'poison-task-id', revoked: false },
    ],
    fcmTokens: ['poison-fcm-token'],
    ...extra,
  };
}

function pollutedWarning(extra: Record<string, any>): Record<string, any> {
  return {
    reason: 'poison-reason-text',
    details: 'poison-details-text',
    notes: 'poison-notes-text',
    internalNotes: 'poison-internal-notes',
    decidedBy: 'poison-decided-by-uid',
    createdBy: 'poison-decided-by-uid',
    caseId: 'poison-case-id-123',
    zzzFutureField: 'poison-future-field-value',
    taskId: 'poison-task-id',
    isActive: true,
    createdAt: ts(daysAgo(2)),
    expiresAt: ts(daysFromNow(30)),
    ...extra,
  };
}

// =====================================================================
describe('A. exact key set / leak-proof projection', () => {
  test('polluted source record yields EXACTLY the whitelist keys and no poison anywhere', async () => {
    mockState.users.set('uid-polluted-1', pollutedUser({}));
    mockState.warnings.set('uid-polluted-1', [pollutedWarning({})]);
    mockState.chapters.set('seds-ist-chapter', {
      name: 'IST Chapter',
      internalNotes: 'poison-chapter-secret',
      zzzFutureField: 'poison-chapter-secret',
    });
    mockState.config = {
      blacklistThreshold: 3,
      expirationDays: 14,
      publicVisibility: true,
      internalNotes: 'poison-config-secret',
      zzzFutureField: 'poison-config-secret',
    };

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();

    // Top-level shape is exactly { entries }.
    expect(Object.keys(json).sort()).toEqual(['entries']);
    expect(json.entries).toHaveLength(1);

    const entry = json.entries[0];
    expectExactWhitelist(entry);
    expect(entry).toMatchObject({
      name: 'Polluted Person',
      chapter: 'IST Chapter',
      status: 'probation',
    });

    const raw = JSON.stringify(json);
    for (const v of POISON_VALUES) expect(raw).not.toContain(v);
    for (const k of POISON_KEYS) expect(raw).not.toContain(`"${k}"`);
    expect(raw).not.toContain('uid-polluted-1');
  });

  test('EVERY person object in a multi-person list passes the exact-key-set assertion', async () => {
    mockState.users.set('uid-a', pollutedUser({ displayName: 'Person A', warningCount: 2 }));
    mockState.users.set(
      'uid-b',
      pollutedUser({ displayName: 'Person B', warningCount: 3, isBlacklisted: true, blacklistedAt: ts(daysAgo(1)) })
    );
    mockState.users.set(
      'uid-c',
      pollutedUser({ displayName: 'Person C', warningCount: 0, isBanned: true })
    );
    mockState.users.set('uid-d', pollutedUser({ displayName: 'Person D', warningCount: 1, chapterId: undefined, chapterName: undefined }));
    for (const uid of ['uid-a', 'uid-b', 'uid-c', 'uid-d']) {
      mockState.warnings.set(uid, [pollutedWarning({})]);
    }

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(4);
    for (const entry of json.entries) {
      expectExactWhitelist(entry);
      expect(['probation', 'blacklisted', 'banned']).toContain(entry.status);
      expect(typeof entry.warnings).toBe('string');
    }
    const raw = JSON.stringify(json);
    for (const v of POISON_VALUES) expect(raw).not.toContain(v);
    for (const uid of ['uid-a', 'uid-b', 'uid-c', 'uid-d']) {
      expect(raw).not.toContain(uid);
    }
  });

  test('no resolvable identifiers: no id/uid/caseId fields, no case links in the payload', async () => {
    mockState.users.set('uid-secret-9', pollutedUser({}));
    mockState.warnings.set('uid-secret-9', [pollutedWarning({})]);

    const res = await GET();
    const json = await res.json();
    expect(json.entries).toHaveLength(1);
    const entry = json.entries[0];
    // The founder whitelist has NO id field. Any of these keys is a
    // finding on its own, even if the value looks harmless.
    for (const bad of ['id', 'uid', 'userId', 'caseId', 'href', 'link', 'url', 'path']) {
      expect(entry).not.toHaveProperty(bad);
    }
    const raw = JSON.stringify(json);
    expect(raw).not.toContain('uid-secret-9');
    expect(raw).not.toContain('poison-case-id-123');
    expect(raw).not.toContain('/api/discipline');
    expect(raw).not.toContain('/cases/');
    expect(raw).not.toContain('href');
  });
});

// =====================================================================
describe('B. active-only inclusion: expired / cleared / voided', () => {
  test('cleared sanction (cron-cleaned state) does not appear', async () => {
    mockState.users.set('uid-cleared', {
      displayName: 'Cleared Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 0,
      activeWarningCount: 0,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-cleared', [
      pollutedWarning({
        isActive: false,
        status: 'probation_cleared',
        createdAt: ts(daysAgo(60)),
        expiresAt: ts(daysAgo(30)),
        expiredAt: ts(daysAgo(30)),
      }),
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toEqual([]);
  });

  test('VOIDED sanction does not appear even when the stored counter was never recomputed', async () => {
    // Warning revoked by an admin (isActive false, status revoked) but
    // the derived warningCount on the user doc is still stale at 1.
    // The sanction is void NOW; the public feed must not wait for a
    // cleanup pass to stop publishing it.
    mockState.users.set('uid-voided', {
      displayName: 'Voided Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      activeWarningCount: 0,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-voided', [
      pollutedWarning({
        isActive: false,
        status: 'revoked',
        revokedBy: 'poison-decided-by-uid',
        revokedReason: 'poison-reason-text',
        createdAt: ts(daysAgo(5)),
        expiresAt: ts(daysFromNow(30)),
      }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries.map((e: any) => e.name)).not.toContain('Voided Member');
    expect(entries).toEqual([]);
  });

  test('EXPIRED sanction does not appear even if its status string was never updated', async () => {
    // Register WarningStatusBadge: !isPermanent and expiresAt before
    // now means Expired, regardless of the stored status string. This
    // record still says status 'active' / isActive true because the
    // clear-probation cron has not run yet.
    mockState.users.set('uid-expired', {
      displayName: 'Expired Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      activeWarningCount: 1,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-expired', [
      pollutedWarning({
        isActive: true,
        status: 'active',
        isPermanent: false,
        createdAt: ts(daysAgo(40)),
        expiresAt: ts(daysAgo(10)),
      }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries.map((e: any) => e.name)).not.toContain('Expired Member');
    expect(entries).toEqual([]);
  });

  test('EXPIRED by createdAt + expirationDays fallback (no expiresAt stored) does not appear', async () => {
    // clear-probation cron getWarningExpiryMillis: when expiresAt is
    // absent, expiry is createdAt + warningConfig expirationDays.
    // Config here sets expirationDays 14; this warning is 30 days old.
    mockState.users.set('uid-expired-fallback', {
      displayName: 'Fallback Expired Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      isBlacklisted: false,
      isBanned: false,
    });
    const w = pollutedWarning({
      isActive: true,
      status: 'active',
      isPermanent: false,
      createdAt: ts(daysAgo(30)),
    });
    delete w.expiresAt;
    mockState.warnings.set('uid-expired-fallback', [w]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries.map((e: any) => e.name)).not.toContain('Fallback Expired Member');
    expect(entries).toEqual([]);
  });

  test('control: a warning that expires in the future still appears', async () => {
    mockState.users.set('uid-live', {
      displayName: 'Live Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-live', [
      pollutedWarning({
        isActive: true,
        status: 'active',
        isPermanent: false,
        createdAt: ts(daysAgo(2)),
        expiresAt: ts(daysFromNow(30)),
      }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'Live Member', status: 'probation', warnings: '1/3' });
    expectExactWhitelist(entries[0]);
  });

  test('control: a PERMANENT warning never expires and still appears', async () => {
    mockState.users.set('uid-perm', {
      displayName: 'Permanent Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-perm', [
      pollutedWarning({
        isActive: true,
        isPermanent: true,
        createdAt: ts(daysAgo(400)),
        expiresAt: ts(daysAgo(300)),
      }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    expect(entries.map((e: any) => e.name)).toContain('Permanent Member');
  });

  test('dump-realistic: warningHistory and blacklistedAt alone do not publish a person', async () => {
    // Shape lifted from the production dump: warningCount -1,
    // isBlacklisted false, isBanned false, blacklistedAt set, and a
    // warningHistory array with 3 entries. History is not a current
    // sanction; blacklistedAt without the flag is not a blacklist.
    mockState.users.set('uid-dump-shape', {
      displayName: 'Dump Shape Member',
      chapterId: 'seds-ist-chapter',
      warningCount: -1,
      isBlacklisted: false,
      isBanned: false,
      blacklistedAt: '2026-04-26T14:34:36.072Z',
      blacklistReason: '',
      banReason: '',
      warningHistory: [
        { date: '2026-04-26T14:34:37.172Z', reason: 'poison-reason-text', taskId: 'poison-task-id', revoked: false },
        { date: '2026-04-26T14:34:38.273Z', reason: 'poison-reason-text', taskId: 'poison-task-id', revoked: false },
        { date: '2026-04-26T14:34:40.582Z', reason: 'poison-reason-text', taskId: 'poison-task-id', revoked: false },
      ],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toEqual([]);
    expect(JSON.stringify(json)).not.toContain('poison-reason-text');
  });

  test('control: expired warnings do NOT erase a still-flagged blacklist (flags persist until founder reinstatement)', async () => {
    mockState.users.set('uid-still-blacklisted', {
      displayName: 'Still Blacklisted',
      chapterId: 'seds-ist-chapter',
      warningCount: 3,
      isBlacklisted: true,
      isBanned: false,
      blacklistedAt: ts(daysAgo(20)),
    });
    mockState.warnings.set('uid-still-blacklisted', [
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(40)), expiresAt: ts(daysAgo(10)) }),
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(35)), expiresAt: ts(daysAgo(5)) }),
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(30)), expiresAt: ts(daysAgo(1)) }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    const mine = entries.filter((e: any) => e.name === 'Still Blacklisted');
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('blacklisted');
    expectExactWhitelist(mine[0]);
  });
});

// =====================================================================
describe('C. warning count reflects ACTIVE warnings only', () => {
  test('3 warnings, 1 expired (stale status string): published count is the ACTIVE count', async () => {
    mockState.users.set('uid-count-exp', {
      displayName: 'Count Expired',
      chapterId: 'seds-ist-chapter',
      warningCount: 3,
      activeWarningCount: 2,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-count-exp', [
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(9)), expiresAt: ts(daysFromNow(20)) }),
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(5)), expiresAt: ts(daysFromNow(20)) }),
      pollutedWarning({ isActive: true, status: 'active', createdAt: ts(daysAgo(40)), expiresAt: ts(daysAgo(10)) }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    const mine = entries.filter((e: any) => e.name === 'Count Expired');
    expect(mine).toHaveLength(1);
    expect(mine[0].warnings).toBe('2/3');
  });

  test('3 warnings, 1 revoked: published count is the ACTIVE count', async () => {
    mockState.users.set('uid-count-rev', {
      displayName: 'Count Revoked',
      chapterId: 'seds-ist-chapter',
      warningCount: 3,
      activeWarningCount: 2,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-count-rev', [
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(9)), expiresAt: ts(daysFromNow(20)) }),
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(5)), expiresAt: ts(daysFromNow(20)) }),
      pollutedWarning({ isActive: false, status: 'revoked', createdAt: ts(daysAgo(3)), expiresAt: ts(daysFromNow(20)) }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    const mine = entries.filter((e: any) => e.name === 'Count Revoked');
    expect(mine).toHaveLength(1);
    expect(mine[0].warnings).toBe('2/3');
  });

  test('control: consistent record (stored count equals active count) publishes that count', async () => {
    mockState.users.set('uid-count-ok', {
      displayName: 'Count Consistent',
      chapterId: 'seds-ist-chapter',
      warningCount: 2,
      activeWarningCount: 2,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-count-ok', [
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(9)), expiresAt: ts(daysFromNow(20)) }),
      pollutedWarning({ isActive: true, createdAt: ts(daysAgo(5)), expiresAt: ts(daysFromNow(20)) }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    const mine = entries.filter((e: any) => e.name === 'Count Consistent');
    expect(mine).toHaveLength(1);
    expect(mine[0].warnings).toBe('2/3');
  });

  test('lastSanctionDate is the latest ACTIVE sanction, not a newer revoked one', async () => {
    const activeDate = daysAgo(10);
    mockState.users.set('uid-date', {
      displayName: 'Date Member',
      chapterId: 'seds-ist-chapter',
      warningCount: 2,
      activeWarningCount: 1,
      isBlacklisted: false,
      isBanned: false,
    });
    mockState.warnings.set('uid-date', [
      pollutedWarning({ isActive: true, createdAt: ts(activeDate), expiresAt: ts(daysFromNow(20)) }),
      pollutedWarning({ isActive: false, status: 'revoked', createdAt: ts(daysAgo(1)), expiresAt: ts(daysFromNow(20)) }),
    ]);
    const res = await GET();
    const { entries } = await res.json();
    const mine = entries.filter((e: any) => e.name === 'Date Member');
    expect(mine).toHaveLength(1);
    expect(mine[0].lastSanctionDate).toBe(activeDate.toISOString());
  });
});

// =====================================================================
describe('D. empty state + public-access safety', () => {
  test('empty state: no users at all -> 200 with exactly { entries: [] }', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['entries']);
    expect(json).toEqual({ entries: [] });
  });

  test('empty state: members exist but none hold an active sanction -> empty list', async () => {
    mockState.users.set('uid-plain-1', { displayName: 'Plain One', chapterId: 'seds-ist-chapter', warningCount: 0, isBlacklisted: false, isBanned: false });
    mockState.users.set('uid-plain-2', { displayName: 'Plain Two', chapterId: 'seds-ist-chapter' });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toEqual([]);
  });

  test('the route requires NO auth: an anonymous call with no headers or session succeeds', async () => {
    mockState.users.set('uid-anon', {
      displayName: 'Anon Visible',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
    });
    mockState.warnings.set('uid-anon', [pollutedWarning({})]);
    // GET is invoked exactly as an unauthenticated public fetch would
    // reach it: no request object, no Authorization header, no cookie.
    const res = await (GET as any)();
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
  });

  test('route source carries no per-user auth gate (public by design, Admin SDK does the reading)', () => {
    const routePath = join(process.cwd(), 'src/app/api/public/warning-registry/route.ts');
    const source = readFileSync(routePath, 'utf8');
    expect(source).not.toContain('verifyAuthentication');
    expect(source).not.toContain('getServerSession');
    expect(source).not.toContain('Authorization');
    // And it must not build per-case detail URLs for the payload.
    expect(source).not.toContain('/api/discipline/cases');
  });

  test('kill switch: publicVisibility off returns an error body with NO registry data in it', async () => {
    mockState.config = { blacklistThreshold: 3, expirationDays: 14, publicVisibility: false };
    mockState.users.set('uid-gated', pollutedUser({ displayName: 'Gated Person' }));
    mockState.warnings.set('uid-gated', [pollutedWarning({})]);
    const res = await GET();
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(['error']);
    const raw = JSON.stringify(json);
    expect(raw).not.toContain('Gated Person');
    for (const v of POISON_VALUES) expect(raw).not.toContain(v);
  });
});
