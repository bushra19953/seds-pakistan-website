'use client';

/**
 * listeners-ce-client — fetch helpers for the Class C/E listener
 * conversions (feat/supa-cut-listeners-ce).
 *
 * Every helper here talks ONLY to token-verified server routes:
 *  - the authority four (A21/A22/B10) poll the EXISTING roles seam
 *    route `/api/roles/reads` (verifyAuthentication; roles/{uid} doc
 *    reads are self-or-canManageRoles there; the roleDefinitions list
 *    is registry-scale there; its backend already selects Supabase
 *    adapter vs Admin Firestore server-side);
 *  - A23 polls `/api/authority/refresh-signal` (uid from token only);
 *  - the chat three (B17/A19/A20) + A18 poll
 *    `/api/workflows/chat-state` (uid from token only; the messages
 *    query's participantIds array-contains is applied server-side
 *    against that token uid).
 * The browser never reads Supabase directly (no-RLS program law) and
 * never subscribes to Firestore on the ON paths that use these.
 *
 * A null return ALWAYS means "route unavailable / not authorized /
 * malformed" — callers keep their last good state (stale-on-error),
 * mirroring the listeners' own error behavior (A22 keeps the existing
 * role on listener error; A21 leaves state untouched on fetch error).
 */

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  try {
    const { getAuth } = await import('firebase/auth');
    const current = getAuth().currentUser;
    if (current) headers.Authorization = `Bearer ${await current.getIdToken()}`;
  } catch {
    // Cookie-only attempt; the route's verifyAuthentication accepts
    // the __session cookie UserProvider maintains.
  }
  return headers;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: await authHeaders() });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    return payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface AuthorityRoleDoc {
  exists: boolean;
  data: Record<string, unknown> | null;
}

/** A21/A22 ON-path read: roles/{uid} via the roles seam route (self). */
export async function fetchAuthorityRoleDoc(
  uid: string,
): Promise<AuthorityRoleDoc | null> {
  const qs = new URLSearchParams({ kind: 'doc', collection: 'roles', id: uid });
  const payload = await getJson(`/api/roles/reads?${qs.toString()}`);
  const doc = payload?.doc as Record<string, unknown> | undefined;
  if (!doc || typeof doc.id !== 'string') return null;
  const exists = doc.exists === true;
  return {
    exists,
    data:
      exists && doc.data && typeof doc.data === 'object'
        ? (doc.data as Record<string, unknown>)
        : null,
  };
}

/** B10 ON-path read: the whole roleDefinitions list via the seam route. */
export async function fetchRoleDefinitionsList(): Promise<
  Array<Record<string, unknown>> | null
> {
  const qs = new URLSearchParams({ kind: 'list', collection: 'roleDefinitions' });
  const payload = await getJson(`/api/roles/reads?${qs.toString()}`);
  const docs = payload?.docs;
  if (!Array.isArray(docs)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const raw of docs) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.id !== 'string') continue;
    // Same shape useCollection produces: { ...doc.data(), id }.
    out.push({
      ...((rec.data ?? {}) as Record<string, unknown>),
      id: rec.id,
    });
  }
  return out;
}

export interface AuthoritySignal {
  requestedAtMs: number;
  processedAtMs: number | null;
}

/** A23 ON-path read: this user's authority_refresh signal (token uid). */
export async function fetchAuthoritySignal(): Promise<AuthoritySignal | null> {
  const payload = await getJson('/api/authority/refresh-signal');
  if (!payload || typeof payload.requestedAtMs !== 'number') return null;
  return {
    requestedAtMs: payload.requestedAtMs,
    processedAtMs:
      typeof payload.processedAtMs === 'number' ? payload.processedAtMs : null,
  };
}

export interface ChatStatePayload {
  messages: Array<Record<string, unknown>>;
  typing: Array<Record<string, unknown>>;
  presence: Array<Record<string, unknown>>;
}

/**
 * B17/A19/A20/A18 ON-path read: one bounded chat-state fetch.
 * `participantIds` is the same UI filter hint the Firestore queries
 * use client-side today (first-10 `userId in` for typing/presence);
 * it is never an identity — the route derives the caller's uid from
 * the verified token and applies the messages membership filter
 * against it server-side.
 */
export async function fetchChatState(
  workflowId: string,
  participantIds: string[],
): Promise<ChatStatePayload | null> {
  const qs = new URLSearchParams({ workflowId });
  if (participantIds.length) {
    qs.set('participants', participantIds.slice(0, 10).join(','));
  }
  const payload = await getJson(`/api/workflows/chat-state?${qs.toString()}`);
  if (!payload) return null;
  const arr = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v)
      ? (v.filter(
          (x) => x && typeof x === 'object',
        ) as Array<Record<string, unknown>>)
      : [];
  return {
    messages: arr(payload.messages),
    typing: arr(payload.typing),
    presence: arr(payload.presence),
  };
}

/** ISO/string timestamp -> Date, exactly as the listener bodies do it. */
export function ceToDate(value: unknown): Date {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  if (value) {
    const d = new Date(value as string);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}
