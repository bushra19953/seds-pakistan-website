/**
 * Money audit helper (Item 7, Phase 0).
 *
 * Canonical audit_logs shape for every money state change on the store
 * surface. Designed so the later maker-checker build consumes it
 * (actor, role, action, before/after, timestamps) with no migration.
 *
 * Schema (spec section (c)):
 *   action, actorUid, actorRole, targetUidOrResource, targetType, orderId,
 *   payload { before, after, changedFields, reason, source },
 *   timestamp, createdAt (same server-timestamp sentinel).
 */
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore, WriteBatch } from 'firebase-admin/firestore';

export type MoneyTargetType = 'order' | 'product' | 'settings';

export interface MoneyAuditInput {
  action: string;
  actorUid: string;
  actorRole?: string;
  targetType: MoneyTargetType;
  targetId: string;
  orderId?: string | null;
  before: unknown;
  after: unknown;
  changedFields?: string[];
  reason?: string | null;
  source: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Strip undefined values (Firestore rejects them) while keeping nulls.
 * Mirrors the sanitizer in src/lib/audit-logging.ts lines 45-59, extended
 * to leave non-plain objects (Timestamp, FieldValue, Date) untouched.
 */
export function sanitizeAuditValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value
      .map((v) => sanitizeAuditValue(v))
      .filter((v) => v !== undefined);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const sv = sanitizeAuditValue(v);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return value;
}

/**
 * Build the audit_logs document for a money action. Pure apart from the
 * server-timestamp sentinel, so it is unit-testable.
 */
export function buildMoneyAuditDoc(input: MoneyAuditInput): Record<string, unknown> {
  const ts = FieldValue.serverTimestamp();
  const orderId =
    input.orderId !== undefined
      ? input.orderId
      : input.targetType === 'order'
        ? input.targetId
        : null;
  return {
    action: input.action,
    actorUid: input.actorUid,
    actorRole: input.actorRole ?? '',
    targetUidOrResource: input.targetId,
    targetType: input.targetType,
    orderId: orderId ?? null,
    payload: {
      before: input.before === undefined ? null : sanitizeAuditValue(input.before),
      after: input.after === undefined ? null : sanitizeAuditValue(input.after),
      changedFields: input.changedFields ? [...input.changedFields] : [],
      reason: input.reason ?? null,
      source: input.source,
    },
    timestamp: ts,
    createdAt: ts,
  };
}

/**
 * Add the audit document to an existing write batch so the audit entry and
 * the state change commit atomically (pattern: issue-warning route).
 * Does NOT swallow errors: a failed audit write fails the batch commit and
 * therefore the money action (fail closed).
 */
export function setMoneyAudit(
  batch: WriteBatch,
  db: Firestore,
  input: MoneyAuditInput,
): FirebaseFirestore.DocumentReference {
  const ref = db.collection('audit_logs').doc();
  batch.set(ref as never, buildMoneyAuditDoc(input) as never);
  return ref as unknown as FirebaseFirestore.DocumentReference;
}

/**
 * Derive the single audit action for an order PATCH. Precedence is
 * normative (spec section (c)); exactly one entry is written per PATCH.
 *   1. paymentStatus == 'refunded'  -> order_refunded
 *   2. status == 'verified'        -> order_payment_verified
 *   3. paymentStatus == 'completed'-> order_marked_paid
 *   4. status present              -> order_status_updated
 *   5. otherwise                   -> order_updated
 */
export function deriveOrderAuditAction(
  updates: Record<string, unknown> | null | undefined,
): string {
  const u = updates || {};
  if (u.paymentStatus === 'refunded') return 'order_refunded';
  if (u.status === 'verified') return 'order_payment_verified';
  if (u.paymentStatus === 'completed') return 'order_marked_paid';
  if (u.status !== undefined && u.status !== null) return 'order_status_updated';
  return 'order_updated';
}

/** Soft-delete predicate: a doc is deleted iff deletedAt is set (not undefined/null). */
export function isSoftDeleted(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false;
  return data.deletedAt !== undefined && data.deletedAt !== null;
}
