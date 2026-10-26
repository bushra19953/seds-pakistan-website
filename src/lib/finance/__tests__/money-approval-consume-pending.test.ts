/**
 * @jest-environment node
 */
// Defect 2 regression tests: the order-side verify action dead-ended with
// "Failed — A pending request already exists for this target" whenever a
// request for the same order was already pending. The maker-checker engine
// keeps its 409 uniqueness contract (money-approval.test.ts case 8); the
// verify action instead goes through createOrConsumeMoneyApprovalRequest,
// which CONSUMES an existing equivalent pending request (returns its id,
// creates nothing) so the action completes against the outstanding request.
import { createFakeFirestore, type FakeFirestore } from './fake-firestore';

const rolePerms: Record<string, Set<string>> = {
  store_officer: new Set(['canManageStore']),
  president: new Set(['canApproveMoney']),
  treasurer: new Set(['canApproveMoney', 'canManageFinance']),
  finance_officer: new Set(['canManageFinance']),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));

const uidRoles: Record<string, string> = {
  'maker-1': 'treasurer',
  'checker-1': 'president',
};
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (role: string, perm: string) => rolePerms[role]?.has(perm) ?? false),
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, uid: string, perm: string) =>
      rolePerms[uidRoles[uid] ?? 'member']?.has(perm) ?? false,
  ),
  resolveCanonicalRole: jest.fn(async () => 'officer'),
}));

import {
  createMoneyApprovalRequest,
  createOrConsumeMoneyApprovalRequest,
} from '../money-approval';

const maker = { uid: 'maker-1', role: 'store_officer' };

function seedOrder(db: FakeFirestore) {
  return db.__seed('orders', 'ord-1', {
    status: 'pending_verification',
    paymentStatus: 'pending',
    total: 500,
    buyerUserId: 'buyer-1',
    buyer: { fullName: 'EV2 Buyer', email: 'ev2@example.com' },
    items: [{ type: 'event_ticket', eventId: 'ev2' }],
    originatingModule: 'Events',
    receiptUrl: '',
  });
}

function pendingCount(db: FakeFirestore): number {
  const docs = db.__store.get('money_approvals');
  if (!docs) return 0;
  return [...docs.values()].filter((d) => d.status === 'pending').length;
}

describe('createOrConsumeMoneyApprovalRequest (defect 2 dead-end)', () => {
  it('fresh verify request: creates one pending request, alreadyPending=false', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const res = await createOrConsumeMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: { fromStatus: 'pending_verification', toStatus: 'verified' },
    });
    expect(res.alreadyPending).toBe(false);
    expect(pendingCount(db)).toBe(1);
    expect(db.__doc('money_approvals', res.id)?.status).toBe('pending');
  });

  it('REPRODUCES the dead-end shape: a second verify click consumes the existing pending request instead of failing', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const first = await createOrConsumeMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: { fromStatus: 'pending_verification', toStatus: 'verified' },
    });
    // Base behaviour of the raw create used by the old action: this second
    // call is exactly what threw 409 'A pending request already exists'.
    await expect(
      createMoneyApprovalRequest(db as never, maker, {
        targetType: 'order_verify_payment',
        targetId: 'ord-1',
        changePayload: {},
      }),
    ).rejects.toMatchObject({ status: 409, existingId: first.id });

    const second = await createOrConsumeMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: { fromStatus: 'pending_verification', toStatus: 'verified' },
    });
    expect(second).toEqual({ id: first.id, alreadyPending: true });
    // Nothing new was created; the one outstanding request is the consumed one.
    expect(pendingCount(db)).toBe(1);
    expect(db.__store.get('money_approvals')?.size).toBe(1);
  });

  it('cross-type equivalence: a pending order_mark_paid for the same order is consumed by a verify request (both apply the same verify)', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const first = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_mark_paid',
      targetId: 'ord-1',
      changePayload: { fromStatus: 'pending_verification', toStatus: 'verified' },
    });
    const res = await createOrConsumeMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: { fromStatus: 'pending_verification', toStatus: 'verified' },
    });
    expect(res).toEqual({ id: first.id, alreadyPending: true });
    expect(db.__store.get('money_approvals')?.size).toBe(1);
  });

  it('non-equivalent types keep the hard 409 (no silent consumption of e.g. a soft-delete duplicate)', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    await createOrConsumeMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_soft_delete',
      targetId: 'ord-1',
      changePayload: {},
      reason: 'duplicate order',
    });
    await expect(
      createOrConsumeMoneyApprovalRequest(db as never, maker, {
        targetType: 'order_soft_delete',
        targetId: 'ord-1',
        changePayload: {},
        reason: 'duplicate order',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.__store.get('money_approvals')?.size).toBe(1);
  });

  it('an expired pending verify request is not consumed: it is stamped expired and a fresh request is created', async () => {
    const db = createFakeFirestore();
    seedOrder(db as never);
    const first = await createMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: {},
    });
    (db.__doc('money_approvals', first.id) as { expiresAt: unknown }).expiresAt =
      new Date(Date.now() - 1000);
    const res = await createOrConsumeMoneyApprovalRequest(db as never, maker, {
      targetType: 'order_verify_payment',
      targetId: 'ord-1',
      changePayload: { fromStatus: 'pending_verification', toStatus: 'verified' },
    });
    expect(res.alreadyPending).toBe(false);
    expect(res.id).not.toBe(first.id);
    expect(db.__doc('money_approvals', first.id)?.status).toBe('expired');
    expect(pendingCount(db)).toBe(1);
  });
});
