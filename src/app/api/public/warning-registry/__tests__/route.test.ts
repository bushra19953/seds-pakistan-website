/**
 * @jest-environment node
 *
 * GET /api/public/warning-registry - RESTORED 2026-10-26 by founder
 * decision, reversing the Phase 2 retirement (spec E.7 Variant R).
 * This suite replaces the T37 retirement pin.
 *
 * Proven here, against a mocked Admin SDK (zero live reads):
 *  - the feed publishes ONLY the whitelisted fields (name, chapter,
 *    status, warnings, lastSanctionDate) even when the source docs
 *    carry reasons, notes, and contact data;
 *  - inclusion and status mirror the admin register: the union of
 *    warningCount > 0, isBlacklisted, isBanned, with the register's
 *    status derivation and sort;
 *  - a cleared sanction (the state the clear-probation cron leaves:
 *    counters recomputed to 0, warnings archived) does not appear;
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
            collection: (_sub: string) => ({
              orderBy: (_f: string, _dir: string) => ({
                limit: (n: number) => ({
                  get: async () => {
                    const all = [...(state.warnings.get(uid) ?? [])].sort(
                      (a, b) => millisOf(b.createdAt) - millisOf(a.createdAt)
                    );
                    const docs = all.slice(0, n).map((d) => ({ data: () => d }));
                    return { empty: docs.length === 0, docs };
                  },
                }),
              }),
            }),
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

function seedBase() {
  mockState.config = { blacklistThreshold: 3, publicVisibility: true };
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
        isActive: true,
        createdAt: ts('2026-10-14T06:53:51.355Z'),
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
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
    mockState.users.set('u-probation', {
      displayName: 'Maira Batool',
      chapterId: 'seds-ist-chapter',
      warningCount: 1,
    });
    mockState.warnings.set('u-probation', [
      { isActive: true, createdAt: ts('2026-10-19T00:00:00.000Z') },
      { isActive: true, createdAt: ts('2026-10-10T00:00:00.000Z') },
    ]);
    mockState.users.set('u-blacklisted', {
      displayName: 'Black Listed',
      chapterId: 'seds-ist-chapter',
      warningCount: 3,
      isBlacklisted: true,
      blacklistedAt: ts('2026-10-20T00:00:00.000Z'),
    });
    mockState.warnings.set('u-blacklisted', [
      { isActive: true, createdAt: ts('2026-10-18T00:00:00.000Z') },
    ]);
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
    expect(entries[0].status).toBe('banned');
    expect(entries[1]).toMatchObject({
      status: 'blacklisted',
      warnings: '3/3',
      chapter: 'IST Chapter',
      // blacklistedAt is later than the newest warning, so it wins.
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
    // derived counters are recomputed to 0. No flags remain.
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
    mockState.config = { blacklistThreshold: 3, publicVisibility: false };
    mockState.users.set('u1', { displayName: 'Someone', warningCount: 1 });
    const res = await GET();
    expect(res.status).toBe(403);
  });

  test('warning count renders against the configured threshold', async () => {
    mockState.config = { blacklistThreshold: 5, publicVisibility: true };
    mockState.users.set('u1', { displayName: 'Counted', warningCount: 2 });
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
