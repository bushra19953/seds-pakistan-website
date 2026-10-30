/**
 * @jest-environment node
 */
// SUPABASE MIGRATION — FINANCE SEAM UNIT TESTS (build team, feat/supa-finance-4).
//
// The cherry-picked contract suites pin behavior with the surface flags
// OFF (Firestore path). These tests pin the ON side with a fake adapter
// port injected through the seam test hooks — no live Supabase, no live
// Firestore (fake-firestore backs the routes):
//   - gate: flag OFF -> port never consulted, Firestore serves;
//   - gate ON + port rows -> routes/lib serve the adapter rows (incl.
//     createdAt-desc ordering passthrough and ISO timestamp shape);
//   - gate ON + port throws -> byte-identical Firestore fallback;
//   - mirrors: a committed Firestore write mirrors via setDoc/updateDoc
//     with timestamps serialized to ISO strings; MANUAL_LIST writes
//     (money-approval create) produce NO mirror calls at all;
//   - amount precision ON-side: posted-entry sums over adapter rows are
//     exact integers (A1/A2 aggregates).
import { createFakeFirestore, type FakeFirestore } from './fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = { fin: 'treasurer', checker: 'president', officer: 'officer' };
const rolePerms: Record<string, Set<string>> = {
  treasurer: new Set(['canManageFinance', 'canApproveMoney', 'canAccessAdmin']),
  president: new Set(['canApproveMoney']),
  officer: new Set(['canAccessAdmin']),
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('uid-', '') }) }) },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  admin: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('uid-', '') }) }) },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) => rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false,
  ),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import {
  __setFinanceSupaEnabledForTests,
  __setFinanceSupaPortForTests,
  financeSupaTimestamp,
  serializeForSupaMirror,
  type FinanceSupaPort,
} from '../supa/_shared';
import { computeLineActuals, getFinanceAccounts } from '../ledger';
import { GET as budgetsGET, POST as budgetsPOST } from '@/app/api/admin/finance/budgets/route';
import { GET as ledgerGET } from '@/app/api/admin/finance/ledger/route';
import { GET as approvalsGET, POST as approvalsPOST } from '@/app/api/admin/finance/approvals/route';

type Row = Record<string, unknown> & { id: string };

function makePort(store: Record<string, Row[]>, opts: { throwOnRead?: boolean } = {}) {
  const calls: Array<{ op: string; collectionPath: string; id?: string; data?: Row }> = [];
  const match = (row: Row, where?: Array<[string, string, unknown]>) =>
    (where ?? []).every(([f, op, v]) => {
      const rv = row[f];
      if (op === '==') return rv === v;
      if (op === '!=') return rv !== v;
      return false;
    });
  const port: FinanceSupaPort = {
    getDoc: async (collectionPath: string, id: string) => {
      calls.push({ op: 'getDoc', collectionPath, id });
      if (opts.throwOnRead) throw new Error('adapter boom');
      const row = (store[collectionPath] ?? []).find((r) => r.id === id);
      return row ? ({ ...row } as never) : null;
    },
    listDocs: async (collectionPath: string, options?: never) => {
      calls.push({ op: 'listDocs', collectionPath });
      if (opts.throwOnRead) throw new Error('adapter boom');
      const o = (options ?? {}) as {
        where?: Array<[string, string, unknown]>;
        orderBy?: { field: string; direction?: string } | string;
        limit?: number;
      };
      let rows = (store[collectionPath] ?? []).filter((r) => match(r, o.where));
      const ob = typeof o.orderBy === 'string' ? { field: o.orderBy } : o.orderBy;
      if (ob?.field) {
        const dir = ob.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const av = String(a[ob.field] ?? '');
          const bv = String(b[ob.field] ?? '');
          return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
        });
      }
      if (o.limit) rows = rows.slice(0, o.limit);
      return rows.map((r) => ({ ...r })) as never;
    },
    countDocs: async () => 0,
    setDoc: async (collectionPath: string, id: string, data: Row) => {
      calls.push({ op: 'setDoc', collectionPath, id, data });
      const arr = (store[collectionPath] ??= []);
      const i = arr.findIndex((r) => r.id === id);
      if (i >= 0) arr[i] = { ...arr[i], ...data, id };
      else arr.push({ ...data, id });
      return { ...data, id } as never;
    },
    updateDoc: async (collectionPath: string, id: string, data: Row) => {
      calls.push({ op: 'updateDoc', collectionPath, id, data });
      const arr = (store[collectionPath] ??= []);
      const i = arr.findIndex((r) => r.id === id);
      if (i >= 0) arr[i] = { ...arr[i], ...data, id };
      return { ...(arr[i] ?? data), id } as never;
    },
    deleteDoc: async (collectionPath: string, id: string) => {
      calls.push({ op: 'deleteDoc', collectionPath, id });
      store[collectionPath] = (store[collectionPath] ?? []).filter((r) => r.id !== id);
    },
    rpc: async () => { throw new Error('unexpected rpc'); },
    tx: async () => { throw new Error('unexpected tx'); },
  };
  return { port, calls };
}

function req(uid: string, body?: unknown, url = 'http://localhost/api/admin/finance/x', method = 'POST') {
  return {
    method,
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer uid-${uid}` : null) },
    json: async () => body ?? {},
  } as never;
}

describe('finance seams: timestamp + mirror serialization primitives', () => {
  it('financeSupaTimestamp normalizes every stored form to the same ISO string', () => {
    const iso = '2026-10-05T00:00:00.000Z';
    const secs = Date.parse(iso) / 1000;
    expect(financeSupaTimestamp(iso)).toBe(iso);
    expect(financeSupaTimestamp(new Date(iso))).toBe(iso);
    expect(financeSupaTimestamp({ _seconds: secs, _nanoseconds: 0 })).toBe(iso);
    expect(financeSupaTimestamp({ seconds: secs, nanoseconds: 0 })).toBe(iso);
    expect(financeSupaTimestamp({ toDate: () => new Date(iso) })).toBe(iso);
    expect(financeSupaTimestamp(null)).toBeNull();
    expect(financeSupaTimestamp('not-a-date')).toBeNull();
  });

  it('serializeForSupaMirror converts timestamps/sentinels deeply and keeps integers exact', () => {
    const out = serializeForSupaMirror({
      amountPkr: 250001,
      createdAt: { _seconds: 1791000000, _nanoseconds: 0 },
      updatedAt: { __serverTimestamp: true },
      lines: [{ lineId: 'l1', allocatedPkr: 100000 }],
    }) as Record<string, unknown>;
    expect(out.amountPkr).toBe(250001);
    expect(out.createdAt).toBe(new Date(1791000000 * 1000).toISOString());
    expect(typeof out.updatedAt).toBe('string');
    expect((out.lines as Array<{ allocatedPkr: number }>)[0].allocatedPkr).toBe(100000);
  });
});

describe('finance seams: flag gate + fallback + ON-side reads', () => {
  let db: FakeFirestore;
  let store: Record<string, Row[]>;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    store = {
      settings: [{ id: 'finance', accounts: [{ label: 'Supa Bank', slug: 'supa', type: 'bank', openingBalancePkr: 7 }] }],
      finance_budgets: [
        { id: 'fy2026-27', fyLabel: 'fy2026-27', status: 'approved', revision: 1, lines: [], totalAllocatedPkr: 5, createdAt: '2026-08-01T00:00:00.000Z' },
      ],
      ledger_entries: [
        { id: 's1', fyLabel: 'fy2026-27', status: 'posted', type: 'income', amountPkr: 100001, budgetLineId: 'l1', accountLabel: 'Supa Bank', date: '2026-10-02', createdAt: '2026-10-02T00:00:00.000Z' },
        { id: 's2', fyLabel: 'fy2026-27', status: 'posted', type: 'expense', amountPkr: 1, budgetLineId: 'l1', accountLabel: 'Supa Bank', date: '2026-10-03', createdAt: '2026-10-03T00:00:00.000Z' },
      ],
      money_approvals: [],
    };
    db.__seed('settings', 'finance', { accounts: [{ label: 'Fs Bank', slug: 'fs', type: 'bank', openingBalancePkr: 1 }] });
  });
  afterEach(() => {
    __setFinanceSupaEnabledForTests(undefined);
    __setFinanceSupaPortForTests(undefined);
  });

  it('flag OFF: lib reads serve Firestore, port never consulted', async () => {
    const { port, calls } = makePort(store);
    __setFinanceSupaEnabledForTests(false);
    __setFinanceSupaPortForTests(port);
    await expect(getFinanceAccounts(db as never)).resolves.toEqual([
      { label: 'Fs Bank', slug: 'fs', type: 'bank', openingBalancePkr: 1 },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('flag ON: getFinanceAccounts + computeLineActuals serve adapter rows, exact integer sums', async () => {
    const { port } = makePort(store);
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    await expect(getFinanceAccounts(db as never)).resolves.toEqual([
      { label: 'Supa Bank', slug: 'supa', type: 'bank', openingBalancePkr: 7 },
    ]);
    const actuals = await computeLineActuals(db as never, 'fy2026-27');
    expect(actuals.get('l1')).toEqual({ incomePkr: 100001, expensePkr: 1 });
  });

  it('flag ON + adapter error: lib reads fall back to Firestore byte-identically', async () => {
    const { port } = makePort(store, { throwOnRead: true });
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    await expect(getFinanceAccounts(db as never)).resolves.toEqual([
      { label: 'Fs Bank', slug: 'fs', type: 'bank', openingBalancePkr: 1 },
    ]);
  });

  it('flag ON: budgets GET serves adapter rows; ledger GET serves adapter entries', async () => {
    const { port } = makePort(store);
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    const b = await budgetsGET(req('fin', undefined, 'http://localhost/api/admin/finance/budgets', 'GET'));
    expect(b.status).toBe(200);
    const bBody = await b.json();
    expect(bBody.budgets).toHaveLength(1);
    expect(bBody.budgets[0].id).toBe('fy2026-27');
    expect(bBody.budgets[0].computedActuals).toEqual({ l1: { incomePkr: 100001, expensePkr: 1 } });

    const l = await ledgerGET(req('fin', undefined, 'http://localhost/api/admin/finance/ledger', 'GET'));
    expect(l.status).toBe(200);
    const lBody = await l.json();
    expect(lBody.entries.map((e: { id: string }) => e.id)).toEqual(['s2', 's1']);
    expect(typeof lBody.entries[0].createdAt).toBe('string');
  });

  it('flag ON: approvals GET serves adapter queue rows (pending, not mine)', async () => {
    store.money_approvals = [
      { id: 'a1', makerUid: 'fin', status: 'pending', targetType: 'budget_approve', targetId: 'fy2026-27', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    ];
    const { port } = makePort(store);
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    const res = await approvalsGET(req('checker', undefined, 'http://localhost/api/admin/finance/approvals?scope=checkable', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].id).toBe('a1');
  });

  it('rbt2: approvals GET scope=both splits both scopes from ONE list read, single scopes unchanged', async () => {
    const exp = new Date(Date.now() + 3600_000).toISOString();
    store.money_approvals = [
      { id: 'a-mine', makerUid: 'checker', status: 'pending', targetType: 'budget_approve', targetId: 'fy2026-27', createdAt: '2026-10-03T00:00:00.000Z', expiresAt: exp },
      { id: 'a-other', makerUid: 'fin', status: 'pending', targetType: 'budget_approve', targetId: 'fy2026-27', createdAt: '2026-10-02T00:00:00.000Z', expiresAt: exp },
      { id: 'a-decided', makerUid: 'fin', status: 'approved', targetType: 'budget_approve', targetId: 'fy2026-27', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: exp },
    ];
    const { port, calls } = makePort(store);
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    const res = await approvalsGET(req('checker', undefined, 'http://localhost/api/admin/finance/approvals?scope=both', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkable.map((a: { id: string }) => a.id)).toEqual(['a-other']);
    expect(body.mine.map((a: { id: string }) => a.id)).toEqual(['a-mine']);
    expect(body.approvals).toEqual(body.checkable);
    // The whole point: one list read serves both scopes.
    expect(calls.filter((c) => c.op === 'listDocs' && c.collectionPath === 'money_approvals')).toHaveLength(1);

    const mineRes = await approvalsGET(req('checker', undefined, 'http://localhost/api/admin/finance/approvals?scope=mine', 'GET'));
    expect((await mineRes.json()).approvals.map((a: { id: string }) => a.id)).toEqual(['a-mine']);
  });

  it('rbt2: budgets GET computes actuals ONCE per FY across revisions of that FY', async () => {
    store.finance_budgets.push({
      id: 'fy2026-27-v2', fyLabel: 'fy2026-27', status: 'draft', revision: 2, lines: [], totalAllocatedPkr: 5, createdAt: '2026-09-01T00:00:00.000Z',
    });
    const { port, calls } = makePort(store);
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    const b = await budgetsGET(req('fin', undefined, 'http://localhost/api/admin/finance/budgets', 'GET'));
    expect(b.status).toBe(200);
    const bBody = await b.json();
    expect(bBody.budgets).toHaveLength(2);
    for (const budget of bBody.budgets) {
      expect(budget.computedActuals).toEqual({ l1: { incomePkr: 100001, expensePkr: 1 } });
    }
    // Two budgets, one FY: exactly one posted-entries-by-FY read.
    expect(calls.filter((c) => c.op === 'listDocs' && c.collectionPath === 'ledger_entries')).toHaveLength(1);
  });
});

describe('finance seams: mirrors + MANUAL_LIST no-mirror law', () => {
  let db: FakeFirestore;
  let store: Record<string, Row[]>;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    store = {
      finance_budgets: [{ id: 'bud-draft', status: 'draft', fyLabel: 'fy2026-27', revision: 1, lines: [] }],
      money_approvals: [],
    };
    db.__seed('finance_budgets', 'bud-draft', { status: 'draft', fyLabel: 'fy2026-27', revision: 1, lines: [] });
  });
  afterEach(() => {
    __setFinanceSupaEnabledForTests(undefined);
    __setFinanceSupaPortForTests(undefined);
  });

  it('budgets POST (flag ON): Firestore write commits AND mirrors via setDoc with ISO timestamps', async () => {
    const { port, calls } = makePort(store);
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    const res = await budgetsPOST(req('fin', {
      fyLabel: 'fy2027-28', fyStart: '2027-07-01', fyEnd: '2028-06-30',
      lines: [{ lineId: 'l1', category: 'operations', label: 'Ops', allocatedPkr: 40000 }],
    }));
    expect(res.status).toBe(201);
    expect(db.__doc('finance_budgets', 'fy2027-28')).toBeTruthy();
    const mirror = calls.find((c) => c.op === 'setDoc' && c.collectionPath === 'finance_budgets');
    expect(mirror?.id).toBe('fy2027-28');
    expect(typeof (mirror?.data as Row)?.createdAt).toBe('string');
    expect((mirror?.data as Row)?.totalAllocatedPkr).toBe(40000);
  });

  it('approvals POST create (flag ON): MANUAL_LIST M-FG4-2 — NO mirror calls for money_approvals', async () => {
    const { port, calls } = makePort(store);
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    const res = await approvalsPOST(req('fin', { targetType: 'budget_approve', targetId: 'bud-draft', changePayload: {} }));
    expect(res.status).toBe(201);
    const writes = calls.filter((c) => c.op === 'setDoc' || c.op === 'updateDoc' || c.op === 'deleteDoc');
    expect(writes).toHaveLength(0);
  });

  it('mirror failure is swallowed: budgets POST still 201 when setDoc throws', async () => {
    const { port } = makePort(store);
    (port as { setDoc: unknown }).setDoc = async () => { throw new Error('mirror boom'); };
    __setFinanceSupaEnabledForTests(true);
    __setFinanceSupaPortForTests(port);
    const res = await budgetsPOST(req('fin', {
      fyLabel: 'fy2028-29', fyStart: '2028-07-01', fyEnd: '2029-06-30',
      lines: [{ lineId: 'l1', category: 'operations', label: 'Ops', allocatedPkr: 1 }],
    }));
    expect(res.status).toBe(201);
  });
});
