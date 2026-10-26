/**
 * MIGRATION: finance WRITE-PRIMARY transport (cutover program, Option A).
 *
 * Design: ~/workspace/supabase-migration/cutover-sections/finance-design.md
 * Foundation: ~/workspace/supabase-migration/cutover-sections/foundation.md
 *
 * FLAG LAW: `isSupaPrimary('finance')` (SUPA_PRIMARY token present AND the
 * surface present in SUPA_SURFACES) gates every primary flow in this
 * workstream. OFF = the caller's existing Firestore body runs
 * byte-identically (existing post-commit mirrors included). ON = the
 * Postgres function named here is the ONLY writer for that flow: no
 * Firestore write, no mirror, and NO Firestore fallback on a write error
 * (a failed primary write surfaces; it never splits across databases —
 * the read seams' fallback law does not apply to writes).
 * FINANCE_MAKER_CHECKER_ENFORCED is finance law and is never conflated
 * with this flag.
 *
 * NAMING (design vs shipped foundation): the design wave was written
 * against a spec'd `rpc('finance_*')` interface; the foundation as
 * shipped wins — transactional functions are named `tx_finance_*` and
 * are invoked through the adapter's `tx()` primitive, which injects the
 * idempotency key as `p_idempotency_key`. `callFinanceTx` therefore
 * prefers `tx()` with the `tx_finance_*` name. An adapter that predates
 * the foundation amendment (exposes `rpc()` but no `tx()` — the shape
 * the design wave's contract doubles use) is served through `rpc()`
 * under the design name with the key passed as an explicit argument;
 * the two transports are the same PostgREST function call, and the
 * production adapter always takes the `tx()` path.
 *
 * RESULT CONTRACT (every tx_finance_* function): one jsonb object.
 * Business outcomes are RETURNED, never raised:
 *   { ok: true, ...result }                              — applied
 *   { ok: true, ..., replayed: true }                    — idempotent replay
 *   { ok: false, httpStatus, code?, message, ... }       — business rejection
 * Unexpected SQL errors RAISE; the call rejects and the call site maps
 * it to today's 500 shape. No call site falls back to Firestore.
 *
 * IDEMPOTENCY: keys are deterministic per flow (design §IDEMPOTENCY
 * LAW), derived from the target identity + actor + decision/payload
 * hash, never random per attempt (the one exception is the report
 * audit, whose logical operation is per-request; see reports route).
 * The functions implement the finance_write_idempotency claim pattern:
 * claim-first insert, NULL-result = in-flight/crashed -> retryable
 * IDEMPOTENCY_INCOMPLETE raise, result recorded before commit.
 */

import { createHash } from 'crypto';
import { getSupaAdapter, getSupaClient, isSupaPrimary } from '@/lib/supa';

export interface FinanceTxResult {
  ok?: boolean;
  httpStatus?: number;
  code?: string;
  message?: string;
  existingId?: string;
  replayed?: boolean;
  [key: string]: unknown;
}

type TxCapableAdapter = {
  tx?: (
    fn: string,
    args?: Record<string, unknown>,
    options?: { idempotencyKey?: string },
  ) => Promise<unknown>;
  rpc?: (fn: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Write-primary gate for the finance surface. Any failure to evaluate
 * the flag (unmocked/partial module in a test double, unconfigured
 * client) resolves to OFF — the pre-cutover behavior is the safe
 * default, and the flag law's byte-identity pin depends on it.
 */
export function financePrimaryEnabled(): boolean {
  try {
    return isSupaPrimary('finance') && !!getSupaClient();
  } catch {
    return false;
  }
}

/** Deterministic payload hash for idempotency keys (design §F1/§F5). */
export function financePayloadHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
}

/**
 * Invoke one finance transactional function as the flow's only writer.
 * `designName` is the design-wave name (`finance_*`); `txName` is the
 * shipped foundation name (`tx_finance_*`) for the same function.
 * Throws on transport/SQL failure — callers map to today's 500 shape
 * and never fall back to Firestore.
 */
export async function callFinanceTx(
  designName: string,
  txName: string,
  args: Record<string, unknown>,
  idempotencyKey: string,
): Promise<FinanceTxResult> {
  const adapter = getSupaAdapter() as unknown as TxCapableAdapter;
  if (typeof adapter.tx === 'function') {
    return (await adapter.tx(txName, args, {
      idempotencyKey,
    })) as FinanceTxResult;
  }
  if (typeof adapter.rpc === 'function') {
    return (await adapter.rpc(designName, {
      ...args,
      p_idempotency_key: idempotencyKey,
    })) as FinanceTxResult;
  }
  throw new Error(
    `finance write-primary: adapter exposes neither tx() nor rpc() (needed for ${txName})`,
  );
}
