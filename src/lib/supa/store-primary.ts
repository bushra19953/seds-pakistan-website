/**
 * Store WRITE-PRIMARY transport (cutover program, Option A — store build).
 *
 * Design: ~/workspace/supabase-migration/cutover-sections/store-design.md §3.
 * Foundation: `isSupaPrimary` flag law in ./flags.ts — a slice is
 * write-primary iff its token is in BOTH SUPA_SURFACES and SUPA_PRIMARY.
 * SUPA_PRIMARY OFF (the default) = today's Firestore behaviour
 * byte-identical; every helper here resolves to OFF / null in that state
 * and the callers run their pre-cutover Firestore bodies untouched.
 *
 * NAMING (design vs shipped foundation, same reconciliation the finance
 * build recorded): the design wave named the functions
 * `store_product_create` etc. and invoked them via `rpc()`; the shipped
 * foundation wins — transactional functions are named `tx_store_*` and
 * are invoked through the adapter's `tx()` primitive, which injects the
 * idempotency key as `p_idempotency_key`. `callStoreTx` therefore prefers
 * `tx()` with the `tx_store_*` name. An adapter that predates the
 * foundation amendment (exposes `rpc()` but no `tx()` — the shape older
 * contract doubles use) is served through `rpc()` under the design name
 * with the key passed as an explicit argument; the two transports are
 * the same PostgREST function call, and the production adapter always
 * takes the `tx()` path.
 *
 * RESULT CONTRACT (every tx_store_* function): one jsonb object.
 * Business outcomes are RETURNED, never raised:
 *   { ok: true, ...result }                       — applied
 *   { ok: true, created: false, ... }             — idempotent replay
 *   { ok: false, httpStatus, message, ... }       — business rejection
 * Unexpected SQL errors RAISE; the call rejects and the call site maps
 * it to today's 500 shape. On a write error there is NO Firestore
 * fallback — a failed primary write surfaces rather than splitting the
 * writer across databases (the read seams' fallback law does not apply
 * to writes).
 */

import { getSupaAdapter, getSupaClient, isSupaPrimary } from './index';

export interface StoreTxResult {
  ok?: boolean;
  httpStatus?: number;
  code?: string;
  message?: string;
  created?: boolean;
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
 * Write-primary gate for one store slice. Any failure to evaluate the
 * flag layer (a partial test double that does not provide
 * `isSupaPrimary`, an unconfigured client) resolves to OFF — the
 * pre-cutover behaviour is the safe default, and the flag law's
 * byte-identity pin depends on it.
 */
export function storePrimaryEnabled(surface: string): boolean {
  try {
    return isSupaPrimary(surface) && !!getSupaClient();
  } catch {
    return false;
  }
}

/**
 * Invoke one store transactional function as the flow's only writer.
 * `txName` is the shipped foundation name (`tx_store_*`); `designName`
 * is the design-wave name (`store_*`) used only on the pre-foundation
 * `rpc()` fallback arm. Throws on transport/SQL failure — callers map
 * to today's error shape and never fall back to Firestore.
 */
export async function callStoreTx(
  txName: string,
  designName: string,
  args: Record<string, unknown>,
  idempotencyKey?: string | null,
): Promise<StoreTxResult> {
  const adapter = getSupaAdapter() as unknown as TxCapableAdapter;
  if (typeof adapter.tx === 'function') {
    return (await adapter.tx(
      txName,
      args,
      idempotencyKey != null ? { idempotencyKey } : undefined,
    )) as StoreTxResult;
  }
  if (typeof adapter.rpc === 'function') {
    return (await adapter.rpc(designName, {
      ...args,
      ...(idempotencyKey != null ? { p_idempotency_key: idempotencyKey } : {}),
    })) as StoreTxResult;
  }
  throw new Error(
    `store write-primary: adapter exposes neither tx() nor rpc() (needed for ${txName})`,
  );
}

const FIRESTORE_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A Firestore-auto-id-shaped document id (20 chars, [A-Za-z0-9]) —
 * design §3: ids keep this shape under primacy so URLs, notifications
 * (`orderId.slice(0,8)`) and cross-references are unchanged.
 */
export function makeStoreDocId(): string {
  const { randomInt } = require('crypto') as typeof import('crypto');
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += FIRESTORE_ID_ALPHABET[randomInt(FIRESTORE_ID_ALPHABET.length)];
  }
  return id;
}

/**
 * Deep-convert a Firestore-bound payload into the shape the Supabase
 * landing tables hold: Timestamp-like / Date values become ISO strings
 * (the adapter's storage ruling) and FieldValue sentinels
 * (serverTimestamp) become the supplied ISO instant. Used only on the
 * primacy path, where payloads are handed to a tx function instead of
 * the Admin SDK; the Firestore path keeps its sentinels untouched.
 */
export function toSupaStorePayload(value: unknown, nowIso: string): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) return value.map((v) => toSupaStorePayload(v, nowIso));
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toDate === 'function') {
      try {
        const d = (v.toDate as () => Date)();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : nowIso;
      } catch {
        return nowIso;
      }
    }
    if (typeof v.toMillis === 'function') {
      try {
        const d = new Date((v.toMillis as () => number)());
        return Number.isNaN(d.getTime()) ? nowIso : d.toISOString();
      } catch {
        return nowIso;
      }
    }
    // FieldValue sentinels (serverTimestamp et al.) carry no readable
    // instant; on the primacy path they mean "now".
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'FieldValue') return nowIso;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = toSupaStorePayload(val, nowIso);
    return out;
  }
  return value;
}
