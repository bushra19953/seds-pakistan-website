import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  MONEY_APPROVAL_AUDIT_ACTIONS,
  MONEY_APPROVAL_TARGET_COLLECTIONS,
  type MoneyApproval,
  type MoneyApprovalTargetType,
} from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { normalizeOrder, ledgerCategoryForModule } from '@/lib/finance/order-canonical';
import { getConsentView, isDecidedApprovedConsent } from '@/lib/finance/adapters';
import { evaluateRelatedPartyGate } from '@/lib/finance/related-party-gate';
import { deriveFyLabel } from '@/lib/finance/ledger';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
// MIGRATION SEAM: finance finance-approvals
import { supaApprovalDoc, supaApprovalTargetDoc, supaPendingApproval } from '@/lib/finance/supa/money-approvals-seam';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts. OFF: every write below is the
// Firestore batch/transaction it has always been. ON: the tx_finance_*
// Postgres function is the only writer for the flow.
import { callFinanceTx, financePayloadHash, financePrimaryEnabled } from '@/lib/finance/supa/primary';

/**
 * MIGRATION SEAM: finance finance-approvals — the (collection, id) a
 * targetType resolves to, mirroring targetRef() exactly (including the
 * destination_change special cases and its 400 on an unknown store).
 * Used only to serve the seam's pre-reads; targetRef() itself and every
 * write stay on Firestore (MANUAL_LIST M-FG4-1/-2/-3: no adapter writes,
 * no mirrors for money_approvals in this phase).
 */
function targetLocation(
  targetType: MoneyApprovalTargetType,
  targetId: string,
): { collection: string; id: string } {
  if (targetType === 'destination_change') {
    if (targetId === 'payment_methods') return { collection: 'settings', id: 'payment_methods' };
    if (targetId === 'pages_donate') return { collection: 'pages', id: 'donate' };
    throw new MoneyApprovalError(400, `Unknown destination store: ${targetId}`);
  }
  return { collection: MONEY_APPROVAL_TARGET_COLLECTIONS[targetType], id: targetId };
}

/**
 * Maker-checker engine (spec Part C 3.4 + 4.5, CH-09). ONE collection
 * (money_approvals), ONE module where maker != checker is enforced, ONE
 * apply path per target type. Every money state change in the finance
 * workstream - new module and retrofitted surfaces alike - goes through
 * here. No surface invents a local variant.
 *
 * Rollback flag (spec 9): when FINANCE_MAKER_CHECKER_ENFORCED is false the
 * approvals POST path returns 503 and UIs show a controls-paused notice.
 * The UIs do NOT fall back to direct writes: a paused control is safer
 * than a silently single-person one. The flag itself lives in
 * src/lib/finance/flags.ts (client-safe, single source of truth).
 */
export { FINANCE_MAKER_CHECKER_ENFORCED } from '@/lib/finance/flags';
import { FINANCE_MAKER_CHECKER_ENFORCED } from '@/lib/finance/flags';

export class MoneyApprovalError extends Error {
  status: number;
  code?: string;
  existingId?: string;
  constructor(status: number, message: string, opts?: { code?: string; existingId?: string }) {
    super(message);
    this.status = status;
    this.code = opts?.code;
    this.existingId = opts?.existingId;
  }
}

export interface Caller {
  uid: string;
  role: string;
}

const REASON_REQUIRED: ReadonlySet<MoneyApprovalTargetType> = new Set([
  'order_refund',
  'order_soft_delete',
  'destination_change',
]);

type DocRef = ReturnType<Firestore['doc']>;
type Tx = {
  get: (ref: never) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (ref: never, data: Record<string, unknown>, opts?: { merge?: boolean }) => unknown;
  update: (ref: never, data: Record<string, unknown>) => unknown;
};

export function targetRef(db: Firestore, targetType: MoneyApprovalTargetType, targetId: string): DocRef {
  if (targetType === 'destination_change') {
    if (targetId === 'payment_methods') return db.collection('settings').doc('payment_methods');
    if (targetId === 'pages_donate') return db.collection('pages').doc('donate');
    throw new MoneyApprovalError(400, `Unknown destination store: ${targetId}`);
  }
  return db.collection(MONEY_APPROVAL_TARGET_COLLECTIONS[targetType]).doc(targetId);
}

/** Money-relevant snapshot used for stale-approval protection (spec 3.4). */
export function snapshotFor(
  targetType: MoneyApprovalTargetType,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const d = data ?? {};
  switch (targetType) {
    case 'order_verify_payment':
    case 'order_mark_paid':
    case 'order_confirm_seat':
    case 'order_refund':
    case 'order_soft_delete':
      return {
        status: d.status ?? null,
        paymentStatus: d.paymentStatus ?? null,
        total: d.total ?? null,
        totalPkr: d.totalPkr ?? null,
        amount: d.amount ?? null,
        isDeleted: d.isDeleted ?? null,
      };
    case 'budget_approve':
      return { status: d.status ?? null, revision: d.revision ?? null, fyLabel: d.fyLabel ?? null };
    case 'ledger_post':
      return {
        status: d.status ?? null,
        amountPkr: d.amountPkr ?? null,
        consentId: d.consentId ?? null,
        unbudgeted: d.unbudgeted ?? null,
        overThreshold: d.overThreshold ?? null,
      };
    case 'crm_financial_edit':
    case 'crm_status_active':
      return { status: d.status ?? null, financials: d.financials ?? null, isRelatedParty: d.isRelatedParty ?? null };
    case 'destination_change': {
      const { destinationMeta: _ignored, ...values } = d;
      return values;
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function assertLedgerConsent(db: Firestore, entry: Record<string, unknown>): Promise<void> {
  const unbudgeted = entry.unbudgeted === true;
  const overThreshold = entry.overThreshold === true;
  if (!unbudgeted && !overThreshold) return;
  const consentId = typeof entry.consentId === 'string' ? entry.consentId : '';
  const view = consentId ? await getConsentView(db, consentId) : null;
  const min = overThreshold && typeof entry.amountPkr === 'number' ? entry.amountPkr : undefined;
  if (!view || !isDecidedApprovedConsent(view, min)) {
    throw new MoneyApprovalError(
      422,
      'Entry is unbudgeted or over the PKR 250,000 threshold and requires a decided Founder Consent before posting (hooks H1/H2)',
      { code: 'CONSENT_REQUIRED' },
    );
  }
}

function validateOrderTransition(targetType: MoneyApprovalTargetType, data: Record<string, unknown>): void {
  const o = normalizeOrder(data);
  switch (targetType) {
    case 'order_verify_payment':
    case 'order_mark_paid':
      if (o.isDeleted || o.status === 'cancelled' || o.status === 'soft_deleted') {
        throw new MoneyApprovalError(422, 'Cannot verify payment on a cancelled or deleted order');
      }
      if (o.paymentStatus === 'completed') {
        throw new MoneyApprovalError(422, 'Payment is already completed for this order');
      }
      if (o.status !== 'pending_verification') {
        throw new MoneyApprovalError(422, `Order in status ${o.status} cannot move to verified`);
      }
      break;
    case 'order_confirm_seat':
      if (o.paymentStatus !== 'completed') {
        throw new MoneyApprovalError(422, 'Seat confirmation requires a completed payment');
      }
      break;
    case 'order_refund':
      if (o.paymentStatus !== 'completed') {
        throw new MoneyApprovalError(422, 'Cannot refund an order whose payment is not completed');
      }
      break;
    case 'order_soft_delete':
      if (o.isDeleted) throw new MoneyApprovalError(422, 'Order is already soft-deleted');
      break;
    default:
      break;
  }
}

export interface CreateApprovalInput {
  targetType: MoneyApprovalTargetType;
  targetId: string;
  changePayload: Record<string, unknown>;
  reason?: string | null;
}

export async function createMoneyApprovalRequest(
  db: Firestore,
  caller: Caller,
  input: CreateApprovalInput,
): Promise<{ id: string }> {
  if (!FINANCE_MAKER_CHECKER_ENFORCED) {
    throw new MoneyApprovalError(503, 'Money controls are paused (FINANCE_MAKER_CHECKER_ENFORCED is off)');
  }
  const { targetType, targetId } = input;
  if (REASON_REQUIRED.has(targetType) && !input.reason?.trim()) {
    throw new MoneyApprovalError(422, `A reason is mandatory for ${targetType}`);
  }

  const ref = targetRef(db, targetType, targetId);

  // CUTOVER (F1): write-primary create. The function re-runs the target
  // read, the pending-uniqueness check, and the per-type validation
  // under a per-target advisory lock (closing today's check-then-batch
  // race), computes beforeSnapshot SQL-side, stamps expiresAt = now()+7d
  // inside the function (timestamp law T4 — no timestamp is passed in),
  // and writes the approval + MONEY_APPROVAL_REQUESTED audit in one tx.
  if (financePrimaryEnabled()) {
    // The new id is DETERMINISTIC for one logical proposal (derived
    // from the same components as the idempotency key): an HTTP retry
    // of the same proposal targets the same id and the function's
    // key table replays the recorded outcome, instead of minting a
    // second request. A genuinely new proposal (different payload,
    // reason, maker, or target) derives a different id.
    const newId = `ma_${financePayloadHash({
      targetType,
      targetId,
      makerUid: caller.uid,
      changePayload: input.changePayload,
      reason: input.reason ?? null,
    }).slice(0, 40)}`;
    const res = await callFinanceTx(
      'finance_create_money_approval',
      'tx_finance_create_money_approval',
      {
        p_maker_uid: caller.uid,
        p_maker_role: caller.role,
        p_target_type: targetType,
        p_target_id: targetId,
        p_change_payload: input.changePayload,
        p_reason: input.reason ?? null,
        p_new_id: newId,
        p_target_collection: MONEY_APPROVAL_TARGET_COLLECTIONS[targetType],
        p_audit_action: MONEY_APPROVAL_AUDIT_ACTIONS[targetType],
      },
      `create:${targetType}:${targetId}:${caller.uid}:${financePayloadHash({
        changePayload: input.changePayload,
        reason: input.reason ?? null,
      })}`,
    );
    if (!res || res.ok !== true) {
      throw new MoneyApprovalError(
        res?.httpStatus ?? 500,
        res?.message ?? 'Money approval create failed',
        {
          ...(res?.code ? { code: res.code } : {}),
          ...(res?.existingId ? { existingId: res.existingId } : {}),
        },
      );
    }
    return { id: (res.id as string) ?? newId };
  }

  // MIGRATION SEAM: finance finance-approvals (R2 snapshot read; the
  // create WRITE stays Firestore batch — MANUAL_LIST M-FG4-2)
  const loc = targetLocation(targetType, targetId);
  const snap = (await supaApprovalTargetDoc(loc.collection, loc.id)) ?? (await ref.get());
  if (!snap.exists && targetType !== 'destination_change') {
    throw new MoneyApprovalError(404, 'Target not found');
  }
  const targetData = (snap.data() as Record<string, unknown> | undefined) ?? {};

  // One pending request per (targetType, targetId) - spec 3.4 uniqueness rule.
  // MIGRATION SEAM: finance finance-approvals (R3)
  const pending =
    (await supaPendingApproval(targetType, targetId)) ??
    (await db
      .collection('money_approvals')
      .where('targetType', '==', targetType)
      .where('targetId', '==', targetId)
      .where('status', '==', 'pending')
      .limit(1)
      .get());
  if (!pending.empty) {
    throw new MoneyApprovalError(409, 'A pending request already exists for this target', {
      existingId: pending.docs[0].id,
    });
  }

  // Per-type request-time validation (fail early, spec 4.2/4.5).
  if (targetType.startsWith('order_')) validateOrderTransition(targetType, targetData);
  if (targetType === 'ledger_post') {
    if (targetData.status !== 'draft') throw new MoneyApprovalError(422, 'Only a draft entry can be posted');
    await assertLedgerConsent(db, targetData);
  }
  if (targetType === 'budget_approve') {
    if (targetData.status !== 'draft') throw new MoneyApprovalError(422, 'Only a draft budget can be approved');
    const consentId = typeof targetData.consentId === 'string' ? targetData.consentId : '';
    if (consentId) {
      const view = await getConsentView(db, consentId);
      if (!isDecidedApprovedConsent(view)) {
        throw new MoneyApprovalError(422, 'The linked Founder Consent is not decided-approved');
      }
    }
  }
  if (targetType === 'destination_change') {
    if (!input.changePayload || Object.keys(input.changePayload).length === 0) {
      throw new MoneyApprovalError(422, 'destination_change requires the complete proposed value set');
    }
  }
  if (targetType === 'crm_financial_edit') {
    const fin = input.changePayload.financials as Record<string, unknown> | undefined;
    if (!fin || typeof fin !== 'object') {
      throw new MoneyApprovalError(422, 'crm_financial_edit requires the full proposed financials map');
    }
  }

  const reqRef = db.collection('money_approvals').doc();
  const now = new Date();
  const request: Record<string, unknown> = {
    targetType,
    targetId,
    targetCollection: MONEY_APPROVAL_TARGET_COLLECTIONS[targetType],
    changePayload: input.changePayload,
    beforeSnapshot: snapshotFor(targetType, targetData),
    reason: input.reason ?? null,
    makerUid: caller.uid,
    makerRole: caller.role,
    checkerUid: null,
    checkerRole: null,
    status: 'pending',
    auditAction: MONEY_APPROVAL_AUDIT_ACTIONS[targetType],
    createdAt: FieldValue.serverTimestamp(),
    decidedAt: null,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  };

  const batch = db.batch();
  batch.set(reqRef, request);
  await writeFinanceAudit(db, batch, {
    action: 'MONEY_APPROVAL_REQUESTED',
    actorUid: caller.uid,
    targetUidOrResource: `money_approvals/${reqRef.id}`,
    payload: { targetType, targetId, approvalId: reqRef.id },
  });
  await batch.commit();
  return { id: reqRef.id };
}

/* ---------------- Consume-an-existing-pending (defect 2) ---------------- */

/**
 * The two order verification types are functionally ONE request: both are
 * decided through applyOrderVerify (order -> verified/completed plus the
 * event-registration mirror). A pending request of either type for the
 * same order therefore blocks — and satisfies — a verify action from
 * either Store surface.
 */
const VERIFY_EQUIVALENT_TARGET_TYPES: readonly MoneyApprovalTargetType[] = [
  'order_verify_payment',
  'order_mark_paid',
];

/**
 * Id of a LIVE pending request for (targetType, targetId), or null. A
 * pending request past its expiresAt is stamped expired on the way past
 * (same lazy-expiry rule as the queue read) and does not count as live.
 */
async function findLivePendingApprovalId(
  db: Firestore,
  targetType: MoneyApprovalTargetType,
  targetId: string,
): Promise<string | null> {
  const pending =
    (await supaPendingApproval(targetType, targetId)) ??
    (await db
      .collection('money_approvals')
      .where('targetType', '==', targetType)
      .where('targetId', '==', targetId)
      .where('status', '==', 'pending')
      .limit(1)
      .get());
  if (pending.empty) return null;
  const existingId = pending.docs[0].id;
  const snap = (await supaApprovalDoc(existingId)) ?? (await db.collection('money_approvals').doc(existingId).get());
  if (!snap.exists) return existingId;
  const req = { id: existingId, ...(snap.data() as MoneyApproval) };
  if (await expireIfNeeded(db, req)) return null;
  return req.status === 'pending' ? existingId : null;
}

/**
 * The order surfaces' verify entry point (defect 2 un-dead-end).
 * createMoneyApprovalRequest keeps its spec 3.4 contract — a duplicate
 * pending request is a 409 (money-approval.test.ts case 8) — but a verify
 * ACTION that finds its verification already requested must not dead-end
 * on that 409: it consumes the outstanding request and completes against
 * it (the checker queue then decides that one request, maker != checker
 * untouched). Only the verify-equivalent order types are consumable;
 * every other target type delegates to create unchanged, 409 and all.
 */
export async function createOrConsumeMoneyApprovalRequest(
  db: Firestore,
  caller: Caller,
  input: CreateApprovalInput,
): Promise<{ id: string; alreadyPending: boolean }> {
  if (VERIFY_EQUIVALENT_TARGET_TYPES.includes(input.targetType)) {
    const ordered = [
      input.targetType,
      ...VERIFY_EQUIVALENT_TARGET_TYPES.filter((t) => t !== input.targetType),
    ];
    for (const t of ordered) {
      const existingId = await findLivePendingApprovalId(db, t, input.targetId);
      if (existingId) return { id: existingId, alreadyPending: true };
    }
  }
  try {
    const { id } = await createMoneyApprovalRequest(db, caller, input);
    return { id, alreadyPending: false };
  } catch (err) {
    // Lost a create race against a just-created equivalent request:
    // consume that one instead of surfacing the 409 to the action.
    if (
      VERIFY_EQUIVALENT_TARGET_TYPES.includes(input.targetType) &&
      err instanceof MoneyApprovalError &&
      err.status === 409 &&
      err.existingId
    ) {
      return { id: err.existingId, alreadyPending: true };
    }
    throw err;
  }
}

/* ---------------- Apply handlers (spec 4.5) ---------------- */

interface ApplyCtx {
  db: Firestore;
  tx: Tx;
  req: MoneyApproval & { id: string };
  caller: Caller;
  targetData: Record<string, unknown>;
}

function tsNow(): unknown {
  return FieldValue.serverTimestamp();
}

function mirrorEventRegistration(ctx: ApplyCtx, orderId: string): void {
  const { tx, targetData } = ctx;
  const items = Array.isArray(targetData.items) ? (targetData.items as Array<Record<string, unknown>>) : [];
  const buyerUserId = typeof targetData.buyerUserId === 'string' ? targetData.buyerUserId : (targetData.userId as string);
  if (!buyerUserId) return;
  for (const item of items) {
    const eventId = (item.eventId as string) || (targetData.eventId as string);
    if ((item.type === 'event_ticket' || targetData.originatingModule === 'Events') && eventId) {
      const eventRef = ctx.db.collection('events').doc(eventId);
      tx.update(eventRef as never, { attendeeIds: FieldValue.arrayUnion(buyerUserId) } as never);
      const regRef = eventRef.collection('registrations').doc(buyerUserId);
      tx.set(
        regRef as never,
        {
          uid: buyerUserId,
          eventId,
          transactionId: orderId,
          displayName: (targetData.buyer as { fullName?: string } | undefined)?.fullName || 'Unknown',
          email: (targetData.buyer as { email?: string } | undefined)?.email || '',
          status: 'confirmed',
          paymentStatus: 'verified',
          paymentMethod: (targetData.paymentMethod as string) || 'manual',
          paymentRef: (targetData.paymentRef as string) || (targetData.receiptUrl as string) || '',
          createdAt: tsNow(),
          updatedAt: tsNow(),
        } as never,
        { merge: true },
      );
    }
  }
}

function applyOrderVerify(ctx: ApplyCtx, withSeatEffects: boolean): void {
  const { tx, db, req, targetData } = ctx;
  const orderId = req.targetId;
  const order = normalizeOrder(targetData, orderId);
  const ref = targetRef(db, req.targetType, orderId);
  const update: Record<string, unknown> = {
    status: 'verified',
    paymentStatus: 'completed',
    updatedAt: tsNow(),
  };
  // Canonical write + compat dual-write (spec 9): total mirrors totalPkr.
  if (order.totalPkr != null) {
    update.totalPkr = order.totalPkr;
    update.total = order.totalPkr;
  }
  tx.update(ref as never, update as never);

  if (withSeatEffects) mirrorEventRegistration(ctx, orderId);

  // Income ledger DRAFT entry (spec 4.5): posted immediately only when the
  // checker also holds canManageFinance (spec 3.2 exception - the two-person
  // rule is inherited from this approval: enteredBy = maker, postedBy = checker).
  const amount = order.totalPkr ?? 0;
  const entryRef = db.collection('ledger_entries').doc();
  // decide() resolves the checker's canManageFinance into this flag.
  const postNow =
    (req as unknown as { __checkerCanManageFinance?: boolean }).__checkerCanManageFinance === true;
  const entryDate = new Date().toISOString().slice(0, 10);
  tx.set(entryRef as never, {
    date: entryDate,
    fyLabel: deriveFyLabel(entryDate),
    type: 'income',
    category: ledgerCategoryForModule(order.originatingModule),
    amountPkr: amount,
    counterparty: order.buyer?.fullName || order.buyerUserId || '',
    counterpartyPartnerId: null,
    description: `Order ${orderId} payment verified (${order.originatingModule ?? 'store'})`,
    budgetLineId: null,
    unbudgeted: false,
    overThreshold: false,
    consentId: null,
    paymentMethod: 'bank_transfer',
    accountLabel: '',
    receiptDriveId: order.receiptDriveId,
    receiptHash: null,
    relatedPartyEntryId: null,
    enteredBy: req.makerUid,
    status: postNow ? 'posted' : 'draft',
    postedBy: postNow ? ctx.caller.uid : null,
    postedAt: postNow ? tsNow() : null,
    sourceOrderId: orderId,
    reversalOf: null,
    reversedBy: null,
    createdAt: tsNow(),
    updatedAt: tsNow(),
  } as never);

  // Receipts inbox record (inbound payment; delivered at verification time).
  const receiptRef = db.collection('finance_receipts').doc();
  tx.set(receiptRef as never, {
    officerUid: order.buyerUserId,
    officerName: order.buyer?.fullName || '',
    kind: 'inbound_payment',
    transactionDate: new Date().toISOString().slice(0, 10),
    amountPkr: amount,
    description: `Order ${orderId} payment receipt`,
    receiptDriveId: order.receiptDriveId || '',
    receiptUrl: order.receiptUrl || '',
    receiptHash: null,
    sourceOrderId: orderId,
    ledgerEntryId: entryRef.id,
    deliveredToTreasurerAt: tsNow(),
    slaDueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    createdBy: req.makerUid,
    createdAt: tsNow(),
    updatedAt: tsNow(),
  } as never);
}

async function applyChange(ctx: ApplyCtx): Promise<void> {
  const { tx, db, req, caller, targetData } = ctx;
  const ref = targetRef(db, req.targetType, req.targetId);
  const payload = req.changePayload;

  switch (req.targetType) {
    case 'order_verify_payment':
      applyOrderVerify(ctx, true);
      return;
    case 'order_mark_paid': {
      const items = Array.isArray(targetData.items) ? targetData.items : [];
      applyOrderVerify(ctx, items.length > 0);
      return;
    }
    case 'order_confirm_seat':
      mirrorEventRegistration(ctx, req.targetId);
      return;
    case 'order_refund': {
      const order = normalizeOrder(targetData, req.targetId);
      const fulfilled = ['shipped', 'delivered'].includes(order.status);
      tx.update(ref as never, {
        paymentStatus: 'refunded',
        ...(fulfilled ? {} : { status: 'refunded' }),
        updatedAt: tsNow(),
      } as never);
      // Reversing ledger DRAFT when a posted income entry exists for the order.
      const posted = await db
        .collection('ledger_entries')
        .where('sourceOrderId', '==', req.targetId)
        .where('status', '==', 'posted')
        .limit(1)
        .get();
      if (!posted.empty) {
        const orig = posted.docs[0].data() as Record<string, unknown>;
        const revRef = db.collection('ledger_entries').doc();
        tx.set(revRef as never, {
          ...orig,
          type: orig.type === 'income' ? 'expense' : 'income',
          status: 'draft',
          postedBy: null,
          postedAt: null,
          reversalOf: posted.docs[0].id,
          reversedBy: null,
          description: `Refund reversal for order ${req.targetId}: ${req.reason ?? ''}`,
          enteredBy: req.makerUid,
          createdAt: tsNow(),
          updatedAt: tsNow(),
        } as never);
      }
      return;
    }
    case 'order_soft_delete':
      tx.update(ref as never, {
        isDeleted: true,
        status: 'soft_deleted',
        deletedBy: caller.uid,
        deletedAt: tsNow(),
        deleteReason: req.reason ?? null,
        deleteApprovalId: req.id,
        updatedAt: tsNow(),
      } as never);
      return;
    case 'destination_change': {
      // S-W5 (store workstream, executed here): on the write-primary
      // path this same write is performed by tx_finance_decide_money_
      // approval INSIDE its Postgres transaction — fs_settings/
      // payment_methods (or fs_pages/donate) commits atomically with
      // the approval record + audit, which is the isSupaPrimary(
      // 'store-settings') ON behavior the store design names. This
      // Firestore arm is the OFF behavior, byte-identical to today.
      tx.set(ref as never, {
        ...payload,
        destinationMeta: {
          lastChangedBy: req.makerUid,
          lastChangedAt: tsNow(),
          approvedBy: caller.uid,
          approvalId: req.id,
        },
      } as never);
      return;
    }
    case 'budget_approve': {
      // Supersede the prior approved revision for the same FY in the same transaction.
      const fyLabel = targetData.fyLabel as string;
      const approvedSnap = await db
        .collection('finance_budgets')
        .where('fyLabel', '==', fyLabel)
        .where('status', '==', 'approved')
        .get();
      for (const doc of approvedSnap.docs) {
        if (doc.id !== req.targetId) {
          tx.update(doc.ref as never, { status: 'superseded', supersededBy: req.targetId } as never);
        }
      }
      const consentId = typeof targetData.consentId === 'string' && targetData.consentId ? targetData.consentId : null;
      tx.update(ref as never, {
        status: 'approved',
        approvedBy: caller.uid,
        approvedAt: tsNow(),
        approvalId: req.id,
        consentId,
        consentPending: consentId ? false : true,
        updatedAt: tsNow(),
      } as never);
      return;
    }
    case 'ledger_post': {
      await assertLedgerConsent(db, targetData);
      tx.update(ref as never, { status: 'posted', postedBy: caller.uid, postedAt: tsNow(), updatedAt: tsNow() } as never);
      // A posted reversal stamps reversedBy on its original - the ONLY
      // post-posting write ever made to a posted entry (spec 3.2).
      const reversalOf = targetData.reversalOf as string | null;
      if (reversalOf) {
        const origRef = db.collection('ledger_entries').doc(reversalOf);
        tx.update(origRef as never, { reversedBy: req.targetId } as never);
      }
      return;
    }
    case 'crm_financial_edit': {
      const proposed = (payload.financials as Record<string, unknown>) ?? {};
      tx.update(ref as never, {
        financials: { ...proposed, currency: 'PKR' },
        updatedAt: tsNow(),
      } as never);
      return;
    }
    case 'crm_status_active': {
      const consentId = (targetData.relatedParty as { consentRequestId?: string } | undefined)?.consentRequestId;
      const view = consentId ? await getConsentView(db, consentId) : null;
      const gate = evaluateRelatedPartyGate(
        targetData as Parameters<typeof evaluateRelatedPartyGate>[0],
        view ? { exists: view.exists, decision: view.decision, decisionDate: view.decisionDate, amountPkr: view.amountPkr } : null,
      );
      if (!gate.canActivate) {
        // Gate failure at apply: the request STAYS pending (spec 4.5) -
        // gate data may be completed while the request waits.
        throw new MoneyApprovalError(422, `Related-party gate not satisfied: ${gate.missing.join('; ')}`, {
          code: 'GATE_NOT_SATISFIED',
        });
      }
      tx.update(ref as never, { status: 'Active', updatedAt: tsNow() } as never);
      return;
    }
  }
}

/* ---------------- Decide (spec 4.5) ---------------- */

function toMillis(v: unknown): number | null {
  if (!v) return null;
  // MIGRATION SEAM: finance finance-approvals — jsonb timestamps arrive
  // as ISO strings; an ISO-string expiresAt must expire exactly like the
  // Timestamp form (before this branch it never expired).
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number; seconds?: number };
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  return null;
}

export async function expireIfNeeded(db: Firestore, req: MoneyApproval & { id: string }): Promise<boolean> {
  if (req.status !== 'pending') return false;
  const exp = toMillis(req.expiresAt);
  if (exp == null || exp > Date.now()) return false;
  // CUTOVER (F3): write-primary expire. The local check above keeps the
  // common (not-yet-expired) path rpc-free — decide's single-rpc shape
  // depends on it; the function's guarded UPDATE re-checks status and
  // expiresAt SQL-side, so a stale local copy cannot expire a request
  // that is no longer pending/expired. NO audit row (parity, Q3).
  if (financePrimaryEnabled()) {
    const res = await callFinanceTx(
      'finance_expire_money_approval',
      'tx_finance_expire_money_approval',
      { p_approval_id: req.id },
      `expire:${req.id}`,
    );
    if (res && res.ok === false) {
      throw new MoneyApprovalError(res.httpStatus ?? 500, res.message ?? 'Money approval expire failed', {
        ...(res.code ? { code: res.code } : {}),
      });
    }
    return res?.expired === true;
  }
  await db.collection('money_approvals').doc(req.id).update({ status: 'expired' });
  return true;
}

export async function decideMoneyApproval(
  db: Firestore,
  caller: Caller,
  approvalId: string,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<{ status: string }> {
  const reqRef = db.collection('money_approvals').doc(approvalId);
  // MIGRATION SEAM: finance finance-approvals (R4 decide load; all decide
  // WRITES — transaction, reject batch, self-check audit — stay Firestore,
  // MANUAL_LIST M-FG4-1)
  const reqSnap = (await supaApprovalDoc(approvalId)) ?? (await reqRef.get());
  if (!reqSnap.exists) throw new MoneyApprovalError(404, 'Approval request not found');
  const req = { id: approvalId, ...(reqSnap.data() as MoneyApproval) };

  // CUTOVER (F2/F2b): write-primary decide. Checker permission resolution
  // stays at this call site, in today's order and with today's reads
  // (design Q8); the pre-expiry above it keeps today's expire-before-
  // permission outcome. Everything else — expiry re-check under the
  // approval row lock, maker!=checker WITH its audit row, stale-snapshot,
  // applyChange (all 11 targetTypes), the audit row, and the decision
  // stamp — is the function's ONE transaction. A GATE_NOT_SATISFIED
  // result maps to 422 with the request left pending and no apply_failed
  // stamp; a ledger_post CONSENT_REQUIRED inside apply is stamped
  // apply_failed BY THE FUNCTION and maps to 500 (today's asymmetry,
  // design Q5b, preserved). No Firestore fallback on any failure.
  if (financePrimaryEnabled()) {
    if (await expireIfNeeded(db, req)) {
      throw new MoneyApprovalError(409, 'Approval request has expired');
    }
    if (req.status !== 'pending') {
      // Replay-aware (design §F2/Q6): a request THIS checker already
      // decided with THIS decision may be an exact retry — the
      // function's idempotency table replays its recorded outcome
      // instead of today's 409. Every other decided state keeps
      // today's call-site 409 (and a different checker deciding an
      // already-decided request still gets it, here or in the
      // function's status guard — verifier V2 pins both halves).
      const replayCandidate =
        (req.status === 'approved_applied' && decision === 'approve' && req.checkerUid === caller.uid) ||
        (req.status === 'rejected' && decision === 'reject' && req.checkerUid === caller.uid);
      if (!replayCandidate) {
        throw new MoneyApprovalError(409, `Request is already ${req.status}`);
      }
    }
    let permitted = await hasServerPermissionForUser(db, caller.uid, 'canApproveMoney');
    if (!permitted && req.targetType === 'ledger_post') {
      const entryLoc = targetLocation('ledger_post', req.targetId);
      const entrySnap =
        (await supaApprovalTargetDoc(entryLoc.collection, entryLoc.id)) ??
        (await targetRef(db, 'ledger_post', req.targetId).get());
      const entry = entrySnap.data() as Record<string, unknown> | undefined;
      if (entry && entry.overThreshold !== true) {
        permitted = await hasServerPermissionForUser(db, caller.uid, 'canManageFinance');
      }
    }
    if (!permitted) throw new MoneyApprovalError(403, 'Missing checker permission (canApproveMoney)');
    const checkerCanManageFinance = await hasServerPermissionForUser(db, caller.uid, 'canManageFinance');
    const res = await callFinanceTx(
      'finance_decide_money_approval',
      'tx_finance_decide_money_approval',
      {
        p_approval_id: approvalId,
        p_checker_uid: caller.uid,
        p_checker_role: caller.role,
        p_decision: decision,
        p_note: note ?? null,
        p_checker_can_manage_finance: checkerCanManageFinance,
        // Caller-generated ids for the docs applyOrderVerify / refund
        // create inside the function (as db.collection().doc() does
        // today); unused by the other targetTypes.
        p_ledger_entry_id: db.collection('ledger_entries').doc().id,
        p_receipt_id: db.collection('finance_receipts').doc().id,
        p_reversal_entry_id: db.collection('ledger_entries').doc().id,
      },
      `decide:${approvalId}:${decision}:${caller.uid}`,
    );
    if (!res || res.ok !== true) {
      const code = res?.code && res.code !== 'APPLY_FAILED' ? res.code : undefined;
      throw new MoneyApprovalError(
        res?.httpStatus ?? 500,
        res?.message ?? 'Money approval decide failed',
        code ? { code } : undefined,
      );
    }
    return { status: res.status as string };
  }

  if (await expireIfNeeded(db, req)) {
    throw new MoneyApprovalError(409, 'Approval request has expired');
  }
  if (req.status !== 'pending') {
    throw new MoneyApprovalError(409, `Request is already ${req.status}`);
  }

  // Checker permission: canApproveMoney; routine ledger_post (not over
  // threshold) may also be checked by a canManageFinance holder (spec 3.9).
  let permitted = await hasServerPermissionForUser(db, caller.uid, 'canApproveMoney');
  if (!permitted && req.targetType === 'ledger_post') {
    // MIGRATION SEAM: finance finance-approvals (R5 threshold-branch read)
    const entryLoc = targetLocation('ledger_post', req.targetId);
    const entrySnap =
      (await supaApprovalTargetDoc(entryLoc.collection, entryLoc.id)) ??
      (await targetRef(db, 'ledger_post', req.targetId).get());
    const entry = entrySnap.data() as Record<string, unknown> | undefined;
    if (entry && entry.overThreshold !== true) {
      permitted = await hasServerPermissionForUser(db, caller.uid, 'canManageFinance');
    }
  }
  if (!permitted) throw new MoneyApprovalError(403, 'Missing checker permission (canApproveMoney)');

  // Maker != checker, enforced by UID. A denied self-check is itself audited.
  if (caller.uid === req.makerUid) {
    const batch = db.batch();
    await writeFinanceAudit(db, batch, {
      action: 'MONEY_APPROVAL_SELF_CHECK_DENIED',
      actorUid: caller.uid,
      targetUidOrResource: `money_approvals/${approvalId}`,
      payload: { approvalId, targetType: req.targetType, targetId: req.targetId },
    });
    await batch.commit();
    throw new MoneyApprovalError(422, 'Maker cannot check their own request', { code: 'MAKER_EQUALS_CHECKER' });
  }

  const tRef = targetRef(db, req.targetType, req.targetId);
  // MIGRATION SEAM: finance finance-approvals (R6 stale-snapshot read)
  const tLoc = targetLocation(req.targetType, req.targetId);
  const tSnap = (await supaApprovalTargetDoc(tLoc.collection, tLoc.id)) ?? (await tRef.get());
  const targetData = (tSnap.data() as Record<string, unknown> | undefined) ?? {};
  if (!deepEqual(snapshotFor(req.targetType, targetData), req.beforeSnapshot)) {
    throw new MoneyApprovalError(409, 'Target changed since the request was created (stale approval)');
  }

  if (decision === 'reject') {
    const batch = db.batch();
    batch.update(reqRef, {
      status: 'rejected',
      checkerUid: caller.uid,
      checkerRole: caller.role,
      decidedAt: FieldValue.serverTimestamp(),
      decisionNote: note ?? null,
    });
    await writeFinanceAudit(db, batch, {
      action: 'MONEY_APPROVAL_REJECTED',
      actorUid: caller.uid,
      targetUidOrResource: `money_approvals/${approvalId}`,
      payload: { approvalId, targetType: req.targetType, targetId: req.targetId, note: note ?? null },
    });
    await batch.commit();
    return { status: 'rejected' };
  }

  // Approve: apply + audit + decision stamp in ONE transaction.
  const checkerCanManageFinance = await hasServerPermissionForUser(db, caller.uid, 'canManageFinance');
  try {
    await db.runTransaction(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      const freshReq = await tx.get(reqRef as never);
      const fresh = freshReq.data() as unknown as MoneyApproval;
      if (!fresh || fresh.status !== 'pending') {
        throw new MoneyApprovalError(409, 'Request is no longer pending');
      }
      const freshTarget = await tx.get(tRef as never);
      const freshData = (freshTarget.data() as Record<string, unknown> | undefined) ?? {};
      const ctx: ApplyCtx = {
        db,
        tx,
        req: { ...req, __checkerCanManageFinance: checkerCanManageFinance } as MoneyApproval & { id: string },
        caller,
        targetData: freshData,
      };
      await applyChange(ctx);
      await writeFinanceAudit(db, tx as never, {
        action: req.auditAction,
        actorUid: caller.uid,
        targetUidOrResource: `${req.targetCollection}/${req.targetId}`,
        payload: {
          approvalId,
          targetType: req.targetType,
          makerUid: req.makerUid,
          before: req.beforeSnapshot,
          after: req.changePayload,
        },
      });
      tx.update(reqRef as never, {
        status: 'approved_applied',
        checkerUid: caller.uid,
        checkerRole: caller.role,
        decidedAt: FieldValue.serverTimestamp(),
        decisionNote: note ?? null,
      } as never);
    });
  } catch (err) {
    if (err instanceof MoneyApprovalError && err.code === 'GATE_NOT_SATISFIED') {
      throw err; // request stays pending by design
    }
    if (err instanceof MoneyApprovalError) throw err;
    // Apply failed: record it terminally, target unchanged (transaction aborted).
    await reqRef.update({
      status: 'apply_failed',
      checkerUid: caller.uid,
      checkerRole: caller.role,
      decidedAt: FieldValue.serverTimestamp(),
      applyError: err instanceof Error ? err.message : String(err),
    });
    throw new MoneyApprovalError(500, `Apply failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status: 'approved_applied' };
}
