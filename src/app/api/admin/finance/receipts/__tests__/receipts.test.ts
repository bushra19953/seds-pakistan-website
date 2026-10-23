/**
 * @jest-environment node
 */
// Receipts + auditor tests (spec Part C section 7: receipts SLA/delivery,
// auditor fallback disclosure).
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };
const uidRoles: Record<string, string> = { officer1: 'officer', fin1: 'treasurer', fin2: 'finance_officer' };
const rolePerms: Record<string, Set<string>> = {
  officer: new Set(['canAccessAdmin']),
  treasurer: new Set(['canManageFinance', 'canAccessAdmin']),
  finance_officer: new Set(['canManageFinance', 'canAccessAdmin']),
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }) }) },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
  admin: { auth: () => ({ verifyIdToken: async (token: string) => ({ uid: token.replace('token-', '') }) }) },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), arrayUnion: (v: unknown) => ({ __arrayUnion: v }) },
}));
const customGrants: Record<string, { perms: Set<string>; expired: boolean }> = {
  'custom-holder': { perms: new Set(['canAccessAdmin', 'canManageFinance']), expired: false },
  'expired-holder': { perms: new Set(['canAccessAdmin', 'canManageFinance']), expired: true },
};
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) =>
      (rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false) ||
      (!!customGrants[uid] && !customGrants[uid].expired && customGrants[uid].perms.has(perm)),
  ),
  resolveCanonicalRole: jest.fn(async (_db: unknown, uid: string) => uidRoles[uid] ?? 'member'),
}));

import { GET, POST } from '../route';
import { POST as deliverPOST } from '../deliver/route';
import { GET as auditorGET, PUT as auditorPUT } from '../../auditor/route';

function req(uid: string, body?: unknown, url = 'http://localhost/api/admin/finance/receipts') {
  return {
    method: 'POST',
    url,
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer token-${uid}` : null) },
    json: async () => body ?? {},
  } as never;
}

describe('receipts inbox', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
  });

  it('officer logs an expense receipt; SLA due date is transactionDate + 14 days', async () => {
    const res = await POST(req('officer1', {
      kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 4500,
      description: 'Taxi for parts', receiptDriveId: 'drv-1',
    }));
    expect(res.status).toBe(201);
    const { id, slaDueAt } = await res.json();
    expect(slaDueAt.slice(0, 10)).toBe('2026-10-15');
    expect(db.__doc('finance_receipts', id)?.officerUid).toBe('officer1');
  });

  it('SLA breach is visible in the read model and filterable', async () => {
    db.__seed('finance_receipts', 'old-1', {
      officerUid: 'officer1', kind: 'officer_expense', transactionDate: '2026-09-01', amountPkr: 100,
      receiptDriveId: 'd', deliveredToTreasurerAt: null, slaDueAt: new Date('2026-09-15T00:00:00Z'),
    });
    const res = await GET(req('fin1', undefined, 'http://localhost/api/admin/finance/receipts?sla=breached'));
    const { receipts } = await res.json();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].slaBreached).toBe(true);
    expect(receipts[0].daysRemaining).toBeLessThan(0);
  });

  it('the spending officer cannot stamp their own delivery; another finance officer can', async () => {
    const res = await POST(req('officer1', {
      kind: 'officer_expense', transactionDate: '2026-10-20', amountPkr: 900,
      description: 'Cables', receiptUrl: 'https://drive.example/x',
    }));
    const { id } = await res.json();
    // officer1 lacks canManageFinance AND is the spender: finance check fires first for officer role,
    // so use a spender who also holds finance rights to isolate the self-stamp guard.
    db.__doc('finance_receipts', id)!.officerUid = 'fin1';
    const selfStamp = await deliverPOST(req('fin1', { id }));
    expect(selfStamp.status).toBe(422);
    const other = await deliverPOST(req('fin2', { id }));
    expect(other.status).toBe(200);
    const again = await deliverPOST(req('fin2', { id }));
    expect(again.status).toBe(409);
  });
});

describe('auditor appointment', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
  });

  it('founder fallback appointment is recorded and disclosed as fallback', async () => {
    const put = await auditorPUT(req('fin1', {
      fyLabel: 'fy2026-27', auditorName: 'A. Chartered', firmName: 'Example & Co', appointedBy: 'founder_fallback',
      appointedAt: '2026-10-01', engagementLetterDriveId: 'drv-eng',
    }));
    expect(put.status).toBe(200);
    expect((await put.json()).fallback).toBe(true);
    const get = await auditorGET(req('fin1', undefined, 'http://localhost/api/admin/finance/auditor?fy=fy2026-27'));
    const { auditor } = await get.json();
    expect(auditor.fallback).toBe(true);
    expect(auditor.appointedBy).toBe('founder_fallback');
    expect(auditor.auditorName).toBe('A. Chartered');
  });

  it('a fallback flag contradicting appointedBy is a 422, not a silent fix', async () => {
    const put = await auditorPUT(req('fin1', {
      fyLabel: 'fy2026-27', auditorName: 'A. Chartered', firmName: 'Example & Co', appointedBy: 'board',
      appointedAt: '2026-10-01', fallback: true,
    }));
    expect(put.status).toBe(422);
  });
});

describe('receipts parity: custom-role holder (Family C)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
  });

  it('primary member + unexpired custom canAccessAdmin grant can log a receipt (C13)', async () => {
    const res = await POST(req('custom-holder', {
      kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 1200,
      description: 'Holder expense', receiptDriveId: 'drv-h',
    }));
    expect(res.status).toBe(201);
  });

  it('expired custom grant falls back to the original denial (403)', async () => {
    const res = await POST(req('expired-holder', {
      kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 1200,
      description: 'Holder expense', receiptDriveId: 'drv-h',
    }));
    expect(res.status).toBe(403);
  });

  it('primary member with no grant is denied unchanged (403)', async () => {
    const res = await POST(req('plain-member', {
      kind: 'officer_expense', transactionDate: '2026-10-01', amountPkr: 1200,
      description: 'Holder expense', receiptDriveId: 'drv-h',
    }));
    expect(res.status).toBe(403);
  });
});
