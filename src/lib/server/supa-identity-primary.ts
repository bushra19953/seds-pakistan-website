/**
 * Identity (users + roles) WRITE-PRIMACY helpers — Supabase cutover,
 * Option A, identity full build (design: cutover-sections/
 * identity-design.md §2.1).
 *
 * This module is the ONLY primary-write path for the identity family:
 *
 *   - Roles primary helpers live here and are re-exported through the
 *     roles seam (supa-roles-seam.ts supaPrimarySet/Update/Delete and
 *     supa-roles-route.ts primarySeamSet/Delete) so the seam remains
 *     the roles cluster's single Supabase doorway.
 *   - Users primary helpers live here directly (design §2.1: users
 *     has no server seam of its own; this thin module's ONLY job is
 *     gate on isSupaPrimary('users'), translate sentinels, throw on
 *     error. It owns no reads beyond the RMW current-doc fetch a
 *     primary write needs).
 *
 * FLAG LAW: a surface is write-primary iff its token is in BOTH
 * SUPA_SURFACES and SUPA_PRIMARY (isSupaPrimary). When NOT primary,
 * every helper here is inert: the enabled checks answer false and the
 * write helpers are never reached by call sites (they would throw a
 * "not primary" error rather than silently write — primacy call sites
 * must branch on the enabled check first, exactly as the tasks /
 * applications primacy builds do).
 *
 * When primary:
 *   - the adapter write is AUTHORITATIVE: its failure THROWS (loud)
 *     and the call site must fail the operation — never fall back to
 *     Firestore as the primary (that would re-create the stale-store
 *     split the inversion exists to close);
 *   - an unavailable adapter (no client configured) under a primary
 *     flag is likewise a loud throw, not a fallback;
 *   - Firestore reverse mirrors are the CALL SITE's job, executed
 *     after the primary commit, best-effort and non-throwing
 *     (design §1.2(a)); this module never writes Firestore.
 *
 * SHAPE RULE (design §1, H-03 / the R19 precedent): the payload that
 * lands in fs_* data jsonb must be JSON-plain. FieldValue sentinels
 * have no jsonb equivalent, so they are resolved HERE, in the seam,
 * against the primary's current doc (read-modify-write):
 *   serverTimestamp -> the apply-time Date (the adapter stores it as
 *     an ISO string via its own normalizeForStorage);
 *   delete -> the key is REMOVED from the merged doc;
 *   increment(n) -> current numeric value + n (missing -> n;
 *     non-numeric current -> loud throw, as Firestore errors);
 *   arrayUnion/arrayRemove -> deep-equality membership ops against
 *     the current array.
 * Resolution lives here, never at call sites. `data.id` is never
 * written from a payload: the adapter owns the row id (the
 * announcements-merge id-clobber caveat applies verbatim).
 *
 * Test injection mirrors the roles seam: __setIdentityPrimaryAdapter
 * ForTests swaps the adapter + flag functions; null restores the real
 * dynamic lookup of '@/lib/supa'.
 */

export type IdentitySurface = 'users' | 'roles';

export interface IdentityPrimaryAdapter {
  getDoc?: (
    collection: string,
    id: string,
  ) => Promise<{ exists: boolean; data?: Record<string, unknown> | null } | null | undefined>;
  setDoc?: (
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ) => Promise<unknown>;
  updateDoc?: (
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  deleteDoc?: (collection: string, id: string) => Promise<void>;
  listDocs?: (
    collection: string,
    opts?: Record<string, unknown>,
  ) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  useSupa?: (surface: string) => boolean;
  isSupaPrimary?: (surface: string) => boolean;
}

export class IdentityPrimaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityPrimaryError';
  }
}

/* ------------------------------------------------------------ adapter */

let injected: IdentityPrimaryAdapter | null | undefined;
export function __setIdentityPrimaryAdapterForTests(
  adapter: IdentityPrimaryAdapter | null,
): void {
  injected = adapter;
}

let cached: IdentityPrimaryAdapter | null | undefined;
async function loadAdapter(): Promise<IdentityPrimaryAdapter | null> {
  if (injected !== undefined) return injected;
  if (cached !== undefined) return cached;
  try {
    const specifier = '@/lib/supa';
    const mod = (await import(/* webpackIgnore: true */ specifier)) as Record<string, unknown>;
    if (typeof mod.getSupaAdapter !== 'function') {
      cached = null;
      return cached;
    }
    type RealAdapter = {
      getDoc: (collection: string, id: string) => Promise<Record<string, unknown> | null>;
      listDocs: (
        collection: string,
        opts?: Record<string, unknown>,
      ) => Promise<Array<Record<string, unknown>>>;
      setDoc: (
        collection: string,
        id: string,
        data: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => Promise<unknown>;
      updateDoc: (
        collection: string,
        id: string,
        data: Record<string, unknown>,
      ) => Promise<unknown>;
      deleteDoc: (collection: string, id: string) => Promise<unknown>;
    };
    const real = (mod.getSupaAdapter as () => RealAdapter)();
    const stripId = (doc: Record<string, unknown>): Record<string, unknown> => {
      const { id: _docId, ...data } = doc;
      return data;
    };
    cached = {
      useSupa: typeof mod.useSupa === 'function' ? (mod.useSupa as IdentityPrimaryAdapter['useSupa']) : undefined,
      isSupaPrimary:
        typeof mod.isSupaPrimary === 'function'
          ? (mod.isSupaPrimary as IdentityPrimaryAdapter['isSupaPrimary'])
          : undefined,
      getDoc: async (collection, id) => {
        const doc = await real.getDoc(collection, id);
        if (doc == null) return { exists: false };
        return { exists: true, data: stripId(doc) };
      },
      listDocs: async (collection, opts) => {
        const docs = await real.listDocs(collection, opts);
        return docs.map((doc) => ({ id: String(doc.id), data: stripId(doc) }));
      },
      setDoc: async (collection, id, data, options) => {
        await real.setDoc(collection, id, data, options);
      },
      updateDoc: async (collection, id, data) => {
        await real.updateDoc(collection, id, data);
      },
      deleteDoc: async (collection, id) => {
        await real.deleteDoc(collection, id);
      },
    };
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * True iff the surface is write-primary AND an adapter exists to write
 * with. When the flag law says primary but no adapter is loadable,
 * this answers false and `requireIdentityPrimaryAdapter` (used by the
 * write helpers) throws — call sites that branch on this check MUST
 * use `identityPrimaryLoudCheck` first when they need the loud
 * unavailable-under-primacy failure instead of a silent dual-write.
 */
export async function identityPrimaryEnabled(surface: IdentitySurface): Promise<boolean> {
  const adapter = await loadAdapter();
  if (!adapter || typeof adapter.isSupaPrimary !== 'function') return false;
  try {
    return adapter.isSupaPrimary(surface) === true;
  } catch {
    return false;
  }
}

/**
 * The flag-law answer WITHOUT the adapter-availability condition:
 * true iff isSupaPrimary(surface). Call sites use this to decide
 * "are we in primary mode at all"; inside primary mode an unavailable
 * adapter is loud (requireIdentityPrimaryAdapter throws).
 */
export async function identityPrimaryFlagOn(surface: IdentitySurface): Promise<boolean> {
  const adapter = await loadAdapter();
  if (!adapter || typeof adapter.isSupaPrimary !== 'function') return false;
  try {
    return adapter.isSupaPrimary(surface) === true;
  } catch {
    return false;
  }
}

async function requireAdapter(surface: IdentitySurface): Promise<IdentityPrimaryAdapter> {
  const adapter = await loadAdapter();
  if (!adapter) {
    throw new IdentityPrimaryError(
      `identity primacy: Supabase adapter unavailable while SUPA_PRIMARY includes '${surface}' — refusing to fall back to Firestore as primary`,
    );
  }
  if (typeof adapter.isSupaPrimary !== 'function' || adapter.isSupaPrimary(surface) !== true) {
    throw new IdentityPrimaryError(
      `identity primacy: primary write attempted for '${surface}' while isSupaPrimary('${surface}') is false`,
    );
  }
  return adapter;
}

/* --------------------------------------------------- sentinel handling */

type Sentinel =
  | { kind: 'serverTimestamp' }
  | { kind: 'delete' }
  | { kind: 'increment'; operand: number }
  | { kind: 'arrayUnion'; elements: unknown[] }
  | { kind: 'arrayRemove'; elements: unknown[] };

/** Structural FieldValue detection (same contract as supa-db-handle). */
export function identitySentinelOf(value: unknown): Sentinel | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { methodName?: unknown; operand?: unknown; elements?: unknown };
  if (typeof v.methodName !== 'string' || !v.methodName.startsWith('FieldValue.')) return null;
  switch (v.methodName) {
    case 'FieldValue.serverTimestamp':
      return { kind: 'serverTimestamp' };
    case 'FieldValue.delete':
      return { kind: 'delete' };
    case 'FieldValue.increment':
      return { kind: 'increment', operand: Number(v.operand) };
    case 'FieldValue.arrayUnion':
      return { kind: 'arrayUnion', elements: Array.isArray(v.elements) ? v.elements : [] };
    case 'FieldValue.arrayRemove':
      return { kind: 'arrayRemove', elements: Array.isArray(v.elements) ? v.elements : [] };
    default:
      throw new IdentityPrimaryError(`identity primacy: unsupported FieldValue sentinel ${v.methodName}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const PRIMARY_DELETE_KEY = Symbol('identity-primary-delete-key');

function resolveValue(value: unknown, current: unknown): unknown {
  const sentinel = identitySentinelOf(value);
  if (sentinel) {
    switch (sentinel.kind) {
      case 'serverTimestamp':
        return new Date();
      case 'delete':
        return PRIMARY_DELETE_KEY;
      case 'increment': {
        if (current === undefined || current === null) return sentinel.operand;
        if (typeof current !== 'number') {
          throw new IdentityPrimaryError('identity primacy: FieldValue.increment on a non-numeric field');
        }
        return current + sentinel.operand;
      }
      case 'arrayUnion': {
        const base = Array.isArray(current) ? [...current] : [];
        for (const el of sentinel.elements) {
          const resolved = resolveValue(el, undefined);
          if (!base.some((existing) => deepEqual(existing, resolved))) base.push(resolved);
        }
        return base;
      }
      case 'arrayRemove': {
        const base = Array.isArray(current) ? [...current] : [];
        const drop = sentinel.elements.map((el) => resolveValue(el, undefined));
        return base.filter((existing) => !drop.some((d) => deepEqual(existing, d)));
      }
    }
  }
  if (Array.isArray(value)) return value.map((el) => resolveValue(el, undefined));
  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    typeof (value as { toDate?: unknown }).toDate !== 'function'
  ) {
    const currentObj =
      current !== null && typeof current === 'object' ? (current as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const resolved = resolveValue(v, currentObj[k]);
      if (resolved !== PRIMARY_DELETE_KEY) out[k] = resolved;
    }
    return out;
  }
  return value;
}

/**
 * Resolve a write payload against the doc's current primary state.
 * Returns the RESOLVED TOP-LEVEL FIELDS (merge semantics): keys whose
 * value resolved to the delete marker are listed in `deletes` and
 * absent from `fields`. Exported for the contract suites (IC-09:
 * no sentinel / Date-free scan is asserted on `fields` after the
 * adapter's own storage normalization; Dates are allowed HERE because
 * the adapter normalizes them to ISO — sentinel OBJECTS never pass).
 */
export function resolvePrimaryPayload(
  payload: Record<string, unknown>,
  current: Record<string, unknown>,
): { fields: Record<string, unknown>; deletes: string[] } {
  const fields: Record<string, unknown> = {};
  const deletes: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'id') continue; // adapter owns the row id (H-03)
    const resolved = resolveValue(v, current[k]);
    if (resolved === PRIMARY_DELETE_KEY) deletes.push(k);
    else fields[k] = resolved;
  }
  return { fields, deletes };
}

/** Deep-scan assertion helper for contracts: true when no FieldValue
 * sentinel object survives anywhere in the value. */
export function containsSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (identitySentinelOf(value)) return true;
  } catch {
    return true;
  }
  if (Array.isArray(value)) return value.some(containsSentinel);
  if (value instanceof Date) return false;
  return Object.values(value as Record<string, unknown>).some(containsSentinel);
}

/* ------------------------------------------------------- primary writes */

async function currentDoc(
  adapter: IdentityPrimaryAdapter,
  collection: string,
  id: string,
): Promise<{ exists: boolean; data: Record<string, unknown> }> {
  if (!adapter.getDoc) {
    throw new IdentityPrimaryError('identity primacy: adapter has no getDoc');
  }
  const result = await adapter.getDoc(collection, id);
  if (result == null) {
    throw new IdentityPrimaryError(`identity primacy: adapter getDoc returned no answer for ${collection}/${id}`);
  }
  if (!result.exists) return { exists: false, data: {} };
  return { exists: true, data: (result.data ?? {}) as Record<string, unknown> };
}

/**
 * Primary merge-set: resolves the payload against the current primary
 * doc and writes the merged doc via adapter setDoc (full-doc write of
 * current+resolved, so delete sentinels actually remove keys — the
 * adapter's {merge:true} cannot express removal). Throws on any
 * adapter error (loud primary failure).
 */
export async function primaryIdentitySet(
  surface: IdentitySurface,
  collection: string,
  id: string,
  data: Record<string, unknown>,
  options?: { merge?: boolean },
): Promise<void> {
  const adapter = await requireAdapter(surface);
  if (!adapter.setDoc) throw new IdentityPrimaryError('identity primacy: adapter has no setDoc');
  if (options?.merge === false) {
    const { fields, deletes } = resolvePrimaryPayload(data, {});
    if (deletes.length > 0) {
      throw new IdentityPrimaryError('identity primacy: FieldValue.delete in a non-merge set (Firestore parity)');
    }
    await adapter.setDoc(collection, id, fields);
    return;
  }
  const current = await currentDoc(adapter, collection, id);
  const { fields, deletes } = resolvePrimaryPayload(data, current.data);
  const next: Record<string, unknown> = { ...current.data, ...fields };
  for (const key of deletes) delete next[key];
  await adapter.setDoc(collection, id, next);
}

/**
 * Primary update: Firestore update() semantics — the doc must exist
 * on the primary (missing -> loud throw, Firestore 'not-found'
 * parity). Implemented as RMW over setDoc for delete-sentinel parity.
 */
export async function primaryIdentityUpdate(
  surface: IdentitySurface,
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const adapter = await requireAdapter(surface);
  if (!adapter.setDoc) throw new IdentityPrimaryError('identity primacy: adapter has no setDoc');
  const current = await currentDoc(adapter, collection, id);
  if (!current.exists) {
    throw new IdentityPrimaryError(`identity primacy: update on missing document ${collection}/${id}`);
  }
  const { fields, deletes } = resolvePrimaryPayload(data, current.data);
  const next: Record<string, unknown> = { ...current.data, ...fields };
  for (const key of deletes) delete next[key];
  await adapter.setDoc(collection, id, next);
}

/** Primary update that is a no-op-skip when the doc is missing
 * (for call sites whose Firestore contract is skip-if-missing, e.g.
 * U-47 email_lowercase sync and R-10/R-12 conditional role updates). */
export async function primaryIdentityUpdateIfExists(
  surface: IdentitySurface,
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const adapter = await requireAdapter(surface);
  const current = await currentDoc(adapter, collection, id);
  if (!current.exists) return false;
  await primaryIdentitySet(surface, collection, id, data, { merge: true });
  return true;
}

/** Primary delete. Throws on adapter error. */
export async function primaryIdentityDelete(
  surface: IdentitySurface,
  collection: string,
  id: string,
): Promise<void> {
  const adapter = await requireAdapter(surface);
  if (!adapter.deleteDoc) throw new IdentityPrimaryError('identity primacy: adapter has no deleteDoc');
  await adapter.deleteDoc(collection, id);
}

/** Primary read (RMW source / idempotency source under primacy).
 * Returns null ONLY when the adapter cannot answer at all; call sites
 * in primary mode treat null as loud (they check the flag first). */
export async function primaryIdentityGet(
  surface: IdentitySurface,
  collection: string,
  id: string,
): Promise<{ exists: boolean; data: Record<string, unknown> } | null> {
  const adapter = await loadAdapter();
  if (!adapter?.getDoc) return null;
  void surface;
  const result = await adapter.getDoc(collection, id);
  if (result == null) return null;
  if (!result.exists) return { exists: false, data: {} };
  return { exists: true, data: (result.data ?? {}) as Record<string, unknown> };
}

/* ------------------------------------------------ pending-op batches */

/**
 * Batch-site pattern (INC/RMW classes, design G-USER-5/G-USER-7):
 * routes that compose ONE Firestore batch across many ops collect
 * their users/{uid} payloads here as they compose, then flush them
 * IN ORDER immediately before batch.commit(). Under users primacy
 * the flush is the primary commit (each payload resolved by RMW in
 * primaryIdentitySet — increments, array ops and delete sentinels
 * included); the Firestore batch then commits with its NATIVE
 * increment/array ops as the reverse mirror (the only race-safe
 * representation on that side). Non-primary: the flush is a no-op
 * and the batch is byte-identical to today.
 */
export interface PendingUsersPrimaryOp {
  uid: string;
  payload: Record<string, unknown>;
}

export async function flushPendingUsersPrimaryOps(
  ops: PendingUsersPrimaryOp[],
): Promise<void> {
  if (ops.length === 0) return;
  if (!(await identityPrimaryFlagOn('users'))) return;
  for (const op of ops) {
    await primaryIdentitySet('users', 'users', op.uid, op.payload, { merge: true });
  }
}

/** Primary list (idempotency lookup source under primacy). Filters
 * client-side after the adapter answers, so a fake/real adapter that
 * ignores the where opts still yields the correct set. */
export async function primaryIdentityList(
  surface: IdentitySurface,
  collection: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }> | null> {
  const adapter = await loadAdapter();
  if (!adapter?.listDocs) return null;
  void surface;
  const rows = await adapter.listDocs(collection);
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => ({ id: String(r.id), data: (r.data ?? {}) as Record<string, unknown> }));
}
