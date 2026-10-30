/**
 * consents-supa.ts — the ONE Supabase seam for the Founder Consent
 * surface (consents mirror + seam program, 2026-10-30; census 15 rows
 * G3–G8: consents were the last fully-unseamed governance surface).
 *
 * STORES:
 * - `consent_requests` documents live in the mirror table
 *   `fs_consent_requests` (house mirror shape: id, data jsonb,
 *   firebase_uid, parent_path, migrated_at; RLS enabled with ZERO
 *   policies — service-role only, verified live 2026-10-30: 6 rows
 *   present from the Phase-1 dump vs ~59 live Firestore docs; the
 *   backfill in scripts/backfill-consents-mirror.mjs closes that gap
 *   post-reset). Main-doc traffic goes through the shared Supabase
 *   adapter (src/lib/supa), like every other flipped surface.
 * - `consent_requests/{id}/history` entries live in the dedicated
 *   mirror table `fs_consent_requests_history` (DDL:
 *   scripts/fs_consent_requests_history.sql; composite primary key
 *   (parent_path, id), parent_path = `consent_requests/<id>`, same
 *   RLS posture). The adapter's subcollection rule would land these
 *   in fs_group_history, which does not exist; the dedicated table
 *   keeps consent history out of the shared group namespace, so
 *   history traffic uses the raw service client (the user-contact.ts
 *   contacts-mirror pattern), still service-role only. Consent
 *   records are governance records, not PII contacts, but reads flow
 *   only through the same gated server paths as today's Firestore
 *   reads — no new client-readable path exists.
 *
 * BEHAVIOUR CONTRACT:
 * - READS are mirror-first ONLY when the `consents` surface token is
 *   in SUPA_SURFACES and a Supabase client exists
 *   (consentsSupaEnabled). Flag OFF: every read helper returns null
 *   and callers run their Firestore path byte-identically. An adapter
 *   error THROWS from the read helpers; callers catch and fall back
 *   to Firestore (the applications-seam ladder). A seam MISS (no row)
 *   also falls back, and the caller's trusted Firestore resolution
 *   heals the mirror row (the contacts-mirror pattern), so a miss is
 *   paid at most once per doc.
 * - WRITES dual-write whenever a Supabase client exists, regardless
 *   of the read flag (the Train 2 contacts ruling: freshness cannot
 *   wait on a flag, or the window between backfill and flip strands
 *   new writes — the P1 applications incident). Mirror helpers NEVER
 *   throw: Firestore is primary, a mirror failure is logged and the
 *   request proceeds; the resync guard
 *   (src/lib/consents-resync.ts) is the proactive backstop. Mirror
 *   payloads are built from the caller's IN-MEMORY post-write doc —
 *   never a Firestore re-read after a write (the accept-fix pattern).
 * - No primacy: SUPA_PRIMARY is not consulted for consents. Firestore
 *   stays the write-primary store in every flag state of this seam.
 */

import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
import {
  SUPA_DELETE_FIELD,
  restoreTimestampFields,
  serializeForSupa,
  supaTimestampMillis,
} from '@/lib/applications-supa';

export const CONSENTS_SURFACE = 'consents';
export const CONSENTS_COLLECTION = 'consent_requests';
export const CONSENT_HISTORY_TABLE = 'fs_consent_requests_history';

export const CONSENT_TIMESTAMP_FIELDS = [
  'createdAt',
  'updatedAt',
  'submittedAt',
  'decisionDate',
  'decidedAt',
  'decidedAtSort',
  'decisionDeadlineAt',
  'deadlineWarningSentAt',
  'informationReceivedAt',
  'executedAt',
  'cancelledAt',
  'deemedWithheldAt',
  'consumedAt',
  'expiresAt',
] as const;

/* ------------------------------------------------------------ adapter */

export interface ConsentsSupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<Record<string, any> | null>;
  listDocs(
    collectionPath: string,
    options?: {
      where?: Array<[string, string, any]>;
      orderBy?:
        | string
        | { field: string; direction?: 'asc' | 'desc' }
        | Array<{ field: string; direction?: 'asc' | 'desc' }>;
      limit?: number;
      startAfter?: any;
    },
  ): Promise<Array<Record<string, any>>>;
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, any>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
  updateDoc(collectionPath: string, id: string, updates: Record<string, any>): Promise<unknown>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

let injectedAdapter: ConsentsSupaAdapter | null | undefined;

/** Test-only: inject a mocked adapter (or null to simulate absence). */
export function __setConsentsSupaAdapterForTests(
  adapter: ConsentsSupaAdapter | null,
): void {
  injectedAdapter = adapter;
}

/** Test-only: clear adapter injection. */
export function __resetConsentsSupaAdapterForTests(): void {
  injectedAdapter = undefined;
}

function realAdapter(): ConsentsSupaAdapter | null {
  try {
    if (!getSupaClient()) return null;
    const candidate: any = getSupaAdapter();
    if (
      candidate &&
      typeof candidate.getDoc === 'function' &&
      typeof candidate.listDocs === 'function' &&
      typeof candidate.setDoc === 'function'
    ) {
      return candidate as ConsentsSupaAdapter;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the consents READ seam may serve: flag ON + client present. */
export function consentsSupaEnabled(): boolean {
  try {
    if (!useSupa(CONSENTS_SURFACE)) return false;
    if (injectedAdapter !== undefined) return injectedAdapter !== null;
    if (injectedHistoryClient !== undefined) return injectedHistoryClient !== null;
    return getSupaClient() !== null;
  } catch {
    return false;
  }
}

/**
 * Adapter for READ paths: null unless the consents surface is enabled
 * (flag ON + Supabase configured). A test injection replaces the real
 * adapter but never the flag: flag OFF returns null even with an
 * adapter injected, so flag-off tests prove the seam is not consulted.
 * Null always means: use the Firestore path, unchanged.
 */
export function resolveConsentsAdapter(): ConsentsSupaAdapter | null {
  if (!consentsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  return realAdapter();
}

/**
 * Adapter for MIRROR WRITES: resolves whenever Supabase is configured,
 * regardless of the read flag (see the header's write contract).
 */
function resolveConsentsWriteAdapter(): ConsentsSupaAdapter | null {
  if (injectedAdapter !== undefined) return injectedAdapter;
  return realAdapter();
}

/* ------------------------------------------------------- history client */

type HistoryClient = { from: (table: string) => any };

let injectedHistoryClient: HistoryClient | null | undefined;

/** Test-only: inject the fs_consent_requests_history client. */
export function __setConsentsHistoryClientForTests(
  client: HistoryClient | null,
): void {
  injectedHistoryClient = client;
}

/** Test-only: clear history-client injection. */
export function __resetConsentsHistoryClientForTests(): void {
  injectedHistoryClient = undefined;
}

function historyClient(): HistoryClient | null {
  if (injectedHistoryClient !== undefined) return injectedHistoryClient;
  try {
    return (getSupaClient() as unknown as HistoryClient | null) ?? null;
  } catch {
    return null;
  }
}

function historyParentPath(requestId: string): string {
  return `${CONSENTS_COLLECTION}/${requestId}`;
}

/* ------------------------------------------------------------ reads */

/**
 * One consent_requests doc via the mirror ({ id, ...data } with the
 * consent timestamp fields restored to Timestamp-shaped values), or
 * null when the seam cannot serve (flag OFF / unconfigured) OR the
 * mirror holds no such row — callers fall back to Firestore in both
 * cases and heal the mirror from a trusted hit. Throws on adapter
 * error; callers catch and fall back the same way.
 */
export async function getConsentViaSeam(
  id: string,
): Promise<Record<string, any> | null> {
  const adapter = resolveConsentsAdapter();
  if (!adapter) return null;
  const doc = await adapter.getDoc(CONSENTS_COLLECTION, id);
  if (!doc) return null;
  const { id: docId, ...data } = doc;
  return { id: docId, ...restoreTimestampFields(data, CONSENT_TIMESTAMP_FIELDS) };
}

/**
 * consent_requests list via the mirror. Returns null when the seam
 * cannot serve; throws on adapter error (callers fall back).
 */
export async function listConsentsViaSeam(options: {
  where?: Array<[string, string, any]>;
  orderBy?:
    | string
    | { field: string; direction?: 'asc' | 'desc' }
    | Array<{ field: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  startAfter?: any;
}): Promise<Array<Record<string, any>> | null> {
  const adapter = resolveConsentsAdapter();
  if (!adapter) return null;
  const docs = await adapter.listDocs(CONSENTS_COLLECTION, options as any);
  return docs.map((doc) => {
    const { id, ...data } = doc;
    return { id, ...restoreTimestampFields(data, CONSENT_TIMESTAMP_FIELDS) };
  });
}

/**
 * History entries for one request via fs_consent_requests_history,
 * oldest first (the Firestore read's orderBy createdAt asc). Returns
 * null when the seam cannot serve or the query fails — the caller
 * falls back to the Firestore subcollection read. Entry data is
 * returned as stored (ISO timestamp strings), the JSON shape the
 * detail route already emits for seam-served records.
 */
export async function listConsentHistoryViaSeam(
  requestId: string,
): Promise<Array<Record<string, any>> | null> {
  if (!consentsSupaEnabled()) return null;
  const client = historyClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from(CONSENT_HISTORY_TABLE)
      .select('id, data')
      .eq('parent_path', historyParentPath(requestId))
      .limit(200);
    if (error) throw error;
    const rows: Array<Record<string, any>> = (
      (data ?? []) as Array<{ id: string; data: Record<string, any> }>
    ).map((row) => ({
      id: String(row.id),
      ...((row.data ?? {}) as Record<string, any>),
    }));
    rows.sort((a, b) => {
      const ma = supaTimestampMillis(a.createdAt) ?? 0;
      const mb = supaTimestampMillis(b.createdAt) ?? 0;
      if (ma !== mb) return ma - mb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return rows;
  } catch (err) {
    console.warn(
      '[consents-supa] history mirror read failed; falling back to Firestore:',
      err,
    );
    return null;
  }
}

/* ------------------------------------------------------ mirror writes */

function serializedDoc(data: Record<string, any>): Record<string, any> {
  const serialized = serializeForSupa(data) as Record<string, any>;
  for (const key of Object.keys(serialized)) {
    if (serialized[key] === SUPA_DELETE_FIELD) delete serialized[key];
  }
  return serialized;
}

/**
 * Mirror a full post-write consent_requests doc (the accept-fix
 * pattern: the payload is the caller's in-memory post-write state,
 * never a Firestore re-read). Never throws; returns success.
 */
export async function mirrorConsentSet(
  id: string,
  data: Record<string, any>,
): Promise<boolean> {
  const adapter = resolveConsentsWriteAdapter();
  if (!adapter) return false;
  try {
    const { id: _drop, ...rest } = data as Record<string, any>;
    void _drop;
    await adapter.setDoc(CONSENTS_COLLECTION, id, serializedDoc(rest));
    return true;
  } catch (err) {
    console.error(`[consents-supa] mirror set failed for ${CONSENTS_COLLECTION}/${id}`, err);
    return false;
  }
}

/**
 * Mirror a partial update (the consumeConsent stamp). Read-modify
 * semantics come from the adapter's updateDoc; a missing mirror row
 * is a logged failure, never a partial row. Never throws.
 */
export async function mirrorConsentUpdate(
  id: string,
  updates: Record<string, any>,
): Promise<boolean> {
  const adapter = resolveConsentsWriteAdapter();
  if (!adapter) return false;
  try {
    await adapter.updateDoc(CONSENTS_COLLECTION, id, serializedDoc(updates));
    return true;
  } catch (err) {
    console.error(
      `[consents-supa] mirror update failed for ${CONSENTS_COLLECTION}/${id}`,
      err,
    );
    return false;
  }
}

/** Mirror one history entry append. Never throws; returns success. */
export async function mirrorConsentHistorySet(
  requestId: string,
  historyId: string,
  entry: Record<string, any>,
): Promise<boolean> {
  const client = historyClient();
  if (!client) return false;
  try {
    const { error } = await client.from(CONSENT_HISTORY_TABLE).upsert(
      {
        id: historyId,
        firebase_uid: null,
        parent_path: historyParentPath(requestId),
        data: serializedDoc(entry),
        migrated_at: new Date().toISOString(),
      },
      { onConflict: 'parent_path,id' },
    );
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(
      `[consents-supa] history mirror set failed for ${historyParentPath(requestId)}/${historyId}`,
      err,
    );
    return false;
  }
}

/**
 * Mirror a consent_requests delete. No consent-service path deletes
 * requests today (verified by census of the service: create / update /
 * submit / decide / execute / cancel / stamp only); this exists so a
 * future erasure path has the mirror leg ready on day one, mirroring
 * the contacts doorway's erase-both-stores rule. Never throws.
 */
export async function mirrorConsentDelete(id: string): Promise<boolean> {
  const adapter = resolveConsentsWriteAdapter();
  if (!adapter) return false;
  try {
    await adapter.deleteDoc(CONSENTS_COLLECTION, id);
    return true;
  } catch (err) {
    console.error(
      `[consents-supa] mirror delete failed for ${CONSENTS_COLLECTION}/${id}`,
      err,
    );
    return false;
  }
}

/** Mirror-delete every history entry of a request. Never throws. */
export async function mirrorConsentHistoryDelete(requestId: string): Promise<boolean> {
  const client = historyClient();
  if (!client) return false;
  try {
    const { error } = await client
      .from(CONSENT_HISTORY_TABLE)
      .delete()
      .eq('parent_path', historyParentPath(requestId));
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(
      `[consents-supa] history mirror delete failed for ${historyParentPath(requestId)}`,
      err,
    );
    return false;
  }
}
