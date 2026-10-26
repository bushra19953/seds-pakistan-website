import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';

/**
 * Thin server route for the roles/permissions client seam
 * (src/lib/supa-roles-client-seam.ts, file-group 3).
 *
 * Why this exists: client libraries in this group historically read
 * roleDefinitions / role_permissions / roles / role_requests directly
 * through the Firestore web SDK. Supabase is server-only (service key),
 * so those reads/writes are routed through here behind the flag. This
 * route is the ONLY server file in the group that touches the adapter.
 *
 * Backend selection, per request:
 *   useSupa('roles') && getSupaClient()  -> Supabase adapter (fs_* tables)
 *   otherwise                            -> Admin-SDK Firestore
 * Either way the response shape is the Firestore doc shape the client
 * seam expects: { doc: { id, exists, data } } / { docs: [...] }, with
 * timestamps serialized to ISO strings.
 *
 * RE-POINT NOTE (DONE, live-defect fix port): the adapter is loaded
 * through the static
 * `import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa'`.
 * The earlier non-literal webpackIgnore dynamic import never resolved
 * in the standalone server bundle (see loadSupa below).
 *
 * Auth: every call requires a verified Firebase session
 * (verifyAuthentication; Bearer header or __session cookie).
 * - roleDefinitions / role_permissions / permissions docs: any
 *   authenticated user (the same posture the client SDK rules give
 *   signed-in readers of definition docs).
 * - roles/{uid} and role_requests reads/writes for ANOTHER user, all
 *   roles/role_requests queries, and roleDefinitions writes: require
 *   canManageRoles (hasServerPermissionForUser) — the admin flows are
 *   the only consumers of those shapes.
 * - role_requests create: requesterUid must equal the caller, unless
 *   the caller holds canManageRoles.
 *
 * The roles/{uid} onSnapshot listener in user-provider.tsx is NOT
 * served by this route and stays on Firestore (deferred seam).
 */

export const dynamic = 'force-dynamic';

const COLLECTIONS = new Set([
  'roles',
  'roleDefinitions',
  'role_permissions',
  'role_requests',
  'permissions',
]);
const DEFINITION_COLLECTIONS = new Set(['roleDefinitions', 'role_permissions', 'permissions']);
const QUERY_FIELDS: Record<string, Set<string>> = {
  roles: new Set(['role']),
  role_requests: new Set(['requesterUid', 'status']),
};

/* ------------------------------------------------------------ adapter */

interface SupaAdapterLike {
  getDoc(collection: string, id: string): Promise<Record<string, unknown> | null>;
  listDocs(
    collection: string,
    options?: {
      where?: [string, string, unknown][];
      orderBy?: { field: string; direction?: 'asc' | 'desc' };
    },
  ): Promise<Record<string, unknown>[]>;
  setDoc(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
  updateDoc(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
}

interface SupaModuleLike {
  useSupa(surface: string): boolean;
  getSupaClient(): unknown | null;
  getSupaAdapter(): SupaAdapterLike;
}

function loadSupa(): SupaModuleLike | null {
  try {
    // STATIC import (live-defect fix port; the RE-POINT NOTE's merge
    // step): the previous webpackIgnore dynamic import of the
    // '@/lib/supa' alias never resolved in the standalone server
    // bundle, so this loader always returned null and the route
    // silently fell back to Firestore for every read/write in
    // production. The statically imported module always exists in
    // this tree. Failure semantics are unchanged: supaAdapter() below
    // still gates on useSupa + getSupaClient and converts any throw
    // to null, and getSupaAdapter() over an unconfigured client
    // returns an adapter whose calls throw SupaUnavailableError into
    // those same try/catch layers. Callers keep `await loadSupa()`
    // (await on the sync return is a no-op).
    if (typeof useSupa !== 'function' || typeof getSupaAdapter !== 'function') {
      return null;
    }
    return {
      useSupa,
      getSupaClient: () => getSupaClient(),
      getSupaAdapter: () => getSupaAdapter() as unknown as SupaAdapterLike,
    };
  } catch {
    return null;
  }
}

async function supaAdapter(): Promise<SupaAdapterLike | null> {
  const mod = await loadSupa();
  if (!mod) return null;
  try {
    if (!mod.useSupa('roles')) return null;
    if (!mod.getSupaClient()) return null;
    return mod.getSupaAdapter();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- serialization */

/** Firestore values -> JSON-plain: Timestamps/Dates become ISO strings. */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

function serializeData(data: Record<string, unknown>): Record<string, unknown> {
  return serializeValue(data) as Record<string, unknown>;
}

interface SeamDocPayload {
  id: string;
  exists: boolean;
  data: Record<string, unknown> | null;
}

function supaRowToDoc(row: Record<string, unknown> | null, id: string): SeamDocPayload {
  if (!row) return { id, exists: false, data: null };
  const { id: rowId, ...rest } = row;
  return {
    id: typeof rowId === 'string' ? rowId : id,
    exists: true,
    data: serializeData(rest),
  };
}

/* -------------------------------------------------------------- authz */

async function requireCaller(req: NextRequest): Promise<string | null> {
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return null;
  return auth.user.userId;
}

async function callerCanManageRoles(uid: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    return await hasServerPermissionForUser(db as never, uid, 'canManageRoles');
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ backends */

async function readDoc(
  collection: string,
  id: string,
): Promise<SeamDocPayload | null> {
  const adapter = await supaAdapter();
  if (adapter) {
    const row = await adapter.getDoc(collection, id);
    return supaRowToDoc(row, id);
  }
  const db = getDb();
  if (!db) return null;
  const snap = await db.collection(collection).doc(id).get();
  if (!snap.exists) return { id, exists: false, data: null };
  return { id: snap.id, exists: true, data: serializeData(snap.data() ?? {}) };
}

async function listDocs(collection: string): Promise<SeamDocPayload[] | null> {
  const adapter = await supaAdapter();
  if (adapter) {
    const rows = await adapter.listDocs(collection);
    return rows.map((r) => supaRowToDoc(r, String(r.id ?? '')));
  }
  const db = getDb();
  if (!db) return null;
  const snap = await db.collection(collection).get();
  return snap.docs.map((d) => ({
    id: d.id,
    exists: true,
    data: serializeData(d.data() ?? {}),
  }));
}

async function queryDocs(
  collection: string,
  field: string,
  value: string,
  orderByDesc?: string,
): Promise<SeamDocPayload[] | null> {
  const adapter = await supaAdapter();
  if (adapter) {
    const rows = await adapter.listDocs(collection, {
      where: [[field, '==', value]],
      ...(orderByDesc
        ? { orderBy: { field: orderByDesc, direction: 'desc' as const } }
        : {}),
    });
    return rows.map((r) => supaRowToDoc(r, String(r.id ?? '')));
  }
  const db = getDb();
  if (!db) return null;
  let q: FirebaseFirestore.Query = db.collection(collection).where(field, '==', value);
  if (orderByDesc) q = q.orderBy(orderByDesc, 'desc');
  const snap = await q.get();
  return snap.docs.map((d) => ({
    id: d.id,
    exists: true,
    data: serializeData(d.data() ?? {}),
  }));
}

async function writeDoc(
  collection: string,
  id: string | null,
  data: Record<string, unknown>,
  merge: boolean,
  op: 'set' | 'update',
): Promise<string | null> {
  const adapter = await supaAdapter();
  if (adapter) {
    const docId = id ?? globalThis.crypto.randomUUID();
    if (op === 'update') await adapter.updateDoc(collection, docId, data);
    else await adapter.setDoc(collection, docId, data, { merge });
    return docId;
  }
  const db = getDb();
  if (!db) return null;
  const ref = id ? db.collection(collection).doc(id) : db.collection(collection).doc();
  if (op === 'update') await ref.update(data);
  else await ref.set(data, { merge });
  return ref.id;
}

/* --------------------------------------------------------------- route */

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET(req: NextRequest) {
  if (!ensureAdminInitialized()) return bad(500, 'Server misconfiguration');
  const callerUid = await requireCaller(req);
  if (!callerUid) return bad(401, 'Unauthorized');

  const params = req.nextUrl.searchParams;
  const kind = params.get('kind') ?? '';
  const collection = params.get('collection') ?? '';
  if (!COLLECTIONS.has(collection)) return bad(400, 'Collection not allowed');

  try {
    if (kind === 'doc') {
      const id = params.get('id') ?? '';
      if (!id) return bad(400, 'Missing id');
      if (!DEFINITION_COLLECTIONS.has(collection)) {
        // roles/{uid}: self or canManageRoles. role_requests/{id}: the
        // requester or canManageRoles (checked against the doc body).
        if (collection === 'roles' && id !== callerUid) {
          if (!(await callerCanManageRoles(callerUid))) return bad(403, 'Forbidden');
        }
      }
      const doc = await readDoc(collection, id);
      if (!doc) return bad(500, 'Read failed');
      if (collection === 'role_requests' && doc.exists && doc.data) {
        const requester = doc.data.requesterUid;
        if (requester !== callerUid && !(await callerCanManageRoles(callerUid))) {
          return bad(403, 'Forbidden');
        }
      }
      return NextResponse.json({ doc });
    }

    if (kind === 'list') {
      // Full-collection lists are registry-scale only in this group.
      if (collection !== 'roleDefinitions') return bad(400, 'List not allowed for collection');
      const docs = await listDocs(collection);
      if (!docs) return bad(500, 'Read failed');
      return NextResponse.json({ docs });
    }

    if (kind === 'query') {
      const field = params.get('field') ?? '';
      const value = params.get('value') ?? '';
      const orderByDesc = params.get('orderByDesc') ?? undefined;
      if (!QUERY_FIELDS[collection]?.has(field)) return bad(400, 'Query not allowed');
      if (orderByDesc && orderByDesc !== 'createdAt') return bad(400, 'Order not allowed');
      // roles queries enumerate holders; role_requests queries list
      // other people's requests — both are manager shapes, except a
      // user listing their OWN role_requests.
      const ownRequests =
        collection === 'role_requests' && field === 'requesterUid' && value === callerUid;
      if (!ownRequests && !(await callerCanManageRoles(callerUid))) {
        return bad(403, 'Forbidden');
      }
      const docs = await queryDocs(collection, field, value, orderByDesc);
      if (!docs) return bad(500, 'Read failed');
      return NextResponse.json({ docs });
    }

    return bad(400, 'Unknown kind');
  } catch (err) {
    console.error('[api/roles/reads] GET failed:', err);
    return bad(500, 'Read failed');
  }
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) return bad(500, 'Server misconfiguration');
  const callerUid = await requireCaller(req);
  if (!callerUid) return bad(401, 'Unauthorized');

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad(400, 'Invalid JSON');
  }
  const op = body.op;
  const collection = typeof body.collection === 'string' ? body.collection : '';
  const id = typeof body.id === 'string' && body.id !== '' ? body.id : null;
  const data =
    body.data && typeof body.data === 'object'
      ? (body.data as Record<string, unknown>)
      : null;
  if ((op !== 'set' && op !== 'update') || !COLLECTIONS.has(collection) || !data) {
    return bad(400, 'Invalid write');
  }
  // Writes in this group are dormant-library shapes (role_requests
  // lifecycle, roleDefinitions upsert). roles / role_permissions /
  // permissions writes stay on their existing gated routes
  // (/api/admin/roles/write, /api/admin/role-permissions) — never here.
  if (collection !== 'role_requests' && collection !== 'roleDefinitions') {
    return bad(400, 'Write not allowed for collection');
  }

  try {
    if (collection === 'roleDefinitions') {
      if (!(await callerCanManageRoles(callerUid))) return bad(403, 'Forbidden');
    } else if (op === 'set') {
      // role_requests create: only for oneself, unless a manager.
      if (data.requesterUid !== callerUid && !(await callerCanManageRoles(callerUid))) {
        return bad(403, 'Forbidden');
      }
    } else {
      // role_requests approve/reject style updates are manager actions;
      // the requester may not decide their own request.
      if (!(await callerCanManageRoles(callerUid))) return bad(403, 'Forbidden');
      if (!id) return bad(400, 'Missing id');
    }
    const docId = await writeDoc(collection, id, data, body.merge === true, op);
    if (!docId) return bad(500, 'Write failed');
    return NextResponse.json({ ok: true, id: docId });
  } catch (err) {
    console.error('[api/roles/reads] POST failed:', err);
    return bad(500, 'Write failed');
  }
}
