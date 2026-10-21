/**
 * @jest-environment node
 */
// Ledger API tests (spec Part C section 7, cases 11-15).
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = {
  'fin-maker': 'treasurer',
  'fin-other': 'finance_officer',
  checker: 'president',
};
const rolePerms: Record<string, Set<string>> = {
  treasurer: new Set(['canManageFinance', 'canApproveMoney']),
  finance_officer: new Set(['canManageFinance']),
  president: new Set(['canApproveMoney']),
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }),
    }),
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  admin: {
    auth: () => ({
      verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }),
    }),
  },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import { POST, PUT, DELETE } from '../route';
import { POST as reversePOST } from '../reverse/route';

function req(uid: string, body: unknown, method = 'POST') {
  return {
    method,
    url: 'http://localhost/api/admin/finance/ledger',
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer token-${uid}` : null) },
    json: async () => body,
  } as never;
}

function seedBase(db: FakeFirestore) {
  db.__seed('settings', 'finance', { accounts: [{ label: 'Main Bank', slug: 'main-bank', type: 'bank' }] });
  db.__seed('finance_budgets', 'fy2026-27', {
    fyLabel: 'fy2026-27',
    status: 'approved',
    revision: 1,
    lines: [{ lineId: 'ops-printing', category: 'operations', label: 'Printing', allocatedPkr: 100000 }],
  });
}

const draftBody = {
  date: '2026-10-05',
  type: 'expense',
  category: 'operations',
  amountPkr: 5000,
  counterparty: 'Print Shop',
  description: 'Banners',
  budgetLineId: 'ops-printing',
  paymentMethod: 'bank_transfer',
  accountLabel: 'Main Bank',
};

describe('ledger API (cases 11-15)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
    seedBase(db);
  });

  it('case 11: posted_entry_cannot_be_edited_or_deleted', async () => {
    const created = await POST(req('fin-maker', draftBody));
    const { id } = await created.json();
    db.__doc('ledger_entries', id)!.status = 'posted';
    const put = await PUT(req('fin-maker', { id, amountPkr: 6000 }, 'PUT'));
    expect(put.status).toBe(409);
    const del = await DELETE(req('fin-maker', { id }, 'DELETE'));
    expect(del.status).toBe(409);
  });

  it('case 12: draft_entry_editable_by_maker_only', async () => {
    const created = await POST(req('fin-maker', draftBody));
    const { id } = await created.json();
    const other = await PUT(req('fin-other', { id, amountPkr: 6000 }, 'PUT'));
    expect(other.status).toBe(403);
    const own = await PUT(req('fin-maker', { id, amountPkr: 6000 }, 'PUT'));
    expect(own.status).toBe(200);
    expect(db.__doc('ledger_entries', id)?.amountPkr).toBe(6000);
  });

  it('case 13: reversal draft flips type, equals amount, sets reversalOf; double reversal and reversing a reversal are 422', async () => {
    db.__seed('ledger_entries', 'posted-1', {
      date: '2026-10-01', fyLabel: 'fy2026-27', type: 'income', category: 'donations',
      amountPkr: 8000, counterparty: 'Donor', description: 'Gift', budgetLineId: null,
      unbudgeted: false, overThreshold: false, consentId: null, paymentMethod: 'bank_transfer',
      accountLabel: 'Main Bank', enteredBy: 'fin-maker', status: 'posted', postedBy: 'checker',
      reversalOf: null, reversedBy: null,
    });
    const res = await reversePOST(req('fin-maker', { entryId: 'posted-1', reason: 'Wrong amount', date: '2026-10-06' }));
    expect(res.status).toBe(201);
    const { id: revId } = await res.json();
    const rev = db.__doc('ledger_entries', revId)!;
    expect(rev.type).toBe('expense');
    expect(rev.amountPkr).toBe(8000);
    expect(rev.reversalOf).toBe('posted-1');
    expect(rev.status).toBe('draft');

    const reverseTheReversal = await reversePOST(req('fin-maker', { entryId: revId, reason: 'x', date: '2026-10-07' }));
    expect(reverseTheReversal.status).toBe(422); // draft, not posted - and a reversal

    db.__doc('ledger_entries', 'posted-1')!.reversedBy = revId; // as the posting apply step would stamp
    // status must be posted for the already-reversed guard; it is posted.
    const again = await reversePOST(req('fin-maker', { entryId: 'posted-1', reason: 'again', date: '2026-10-08' }));
    expect(again.status).toBe(422);
  });

  it('case 14: unbudgeted_entry flagged at creation (hook H1)', async () => {
    const noLine = await POST(req('fin-maker', { ...draftBody, budgetLineId: null }));
    expect((await noLine.json()).unbudgeted).toBe(true);
    const badLine = await POST(req('fin-maker', { ...draftBody, budgetLineId: 'not-a-line' }));
    expect((await badLine.json()).unbudgeted).toBe(true);
    const good = await POST(req('fin-maker', draftBody));
    expect((await good.json()).unbudgeted).toBe(false);
  });

  it('case 15: over_threshold boundary (hook H2) - 250001 fires, 250000 does not', async () => {
    const over = await POST(req('fin-maker', { ...draftBody, amountPkr: 250001 }));
    expect((await over.json()).overThreshold).toBe(true);
    const at = await POST(req('fin-maker', { ...draftBody, amountPkr: 250000 }));
    expect((await at.json()).overThreshold).toBe(false);
  });
});
