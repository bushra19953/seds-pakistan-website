/**
 * Public-events seam for the Firestore -> Supabase migration (events
 * cluster, implementer E4: public list page + homepage sections).
 *
 * This module is the ONE place in the E4 surfaces that knows about
 * Supabase. The server route `src/app/api/events/public/route.ts` calls
 * the helpers here; browser code never imports the adapter (the landed
 * adapter in `src/lib/supa/` is server-only: service_role key).
 *
 * Pattern: browser code uses the NEXT_PUBLIC_SUPA_SURFACES hint
 * (surface 'events', in the client-safe companion module
 * public-events-client.ts — the ONLY part of this seam a browser may
 * import) to call the server route; the route re-checks the server
 * flag and answers 503 when the surface is off, so the client falls
 * back to its Firestore path byte-identically.
 *
 * Exposure parity: firestore.rules gives events
 * `allow read, list: if true` — these reads are anonymous-readable in
 * Firestore today, so a service-role server route reproduces today's
 * exposure exactly. The route needs no auth.
 *
 * ADAPTER BINDING (E3's form, per the acceptance auditor's steering
 * on audit blocker B-1 — the E1/E5 dynamic-import resolver was never
 * re-pointed in the merge tree): this module STATICALLY imports
 * { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa', the
 * same binding as src/lib/supa-events/tickets.ts (E3). There is no
 * dynamic import and no merge-time re-point edit. `src/lib/supa`
 * does not exist on this standalone branch: it lands in the merge
 * tree as step 0 (feat/supa-adapter) BEFORE this branch merges, so
 * the static import resolves there; on this branch, unit tests mock
 * '@/lib/supa' with jest.mock (E3's mechanism) and the test-injection
 * point (setPublicEventsAdapterForTests) overrides getSupaAdapter().
 * Because this module now statically binds a server-only adapter, it
 * must never be imported from a client component — clients import
 * the hint from public-events-client.ts only.
 *
 * Behavior contract:
 * - Flag OFF (the default), adapter unconfigured, adapter module
 *   absent, or adapter error: every read helper returns null
 *   ("unavailable") so the route 503s and callers run the Firestore
 *   path byte-identically to before this seam existed.
 * - Flag ON: reads come from fs_events via the adapter, timestamps
 *   normalized at this seam (normalizeSupaData -> Timestamp-like).
 *   The route serializes Timestamp-likes to ISO strings for the wire
 *   (toPublicJson), because functions cannot cross JSON: clients
 *   receive ISO / {seconds,nanoseconds} shapes that the datetime
 *   oracle (src/lib/events/datetime.ts) already handles.
 *
 * Query preservation (VERIFICATION_SPEC section 1.2):
 * - list: orderBy createdAt desc, limit 12, NO where — the cap applies
 *   BEFORE the page's client-side published/deleted filtering
 *   (contract E-LST-01).
 * - workshops: where type=='workshop', status=='published', limit 3
 *   (the section's current Firestore query, verbatim).
 * - feed: where status=='published', limit 10 (verbatim; the
 *   upcoming/deleted filtering and slice(3) stay in the component).
 */

import { getSupaAdapter, getSupaClient, parseSupaSurfaces, useSupa } from '@/lib/supa';
import { PUBLIC_EVENTS_SURFACE } from './public-events-client';

export { PUBLIC_EVENTS_SURFACE, publicEventsSupaClientEnabled } from './public-events-client';

/* ------------------------------------------------------------------ types */

/** Structural copy of the adapter contract (see header). */
export interface PublicEventsSupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<Record<string, unknown> | null>;
  listDocs(collectionPath: string, options?: unknown): Promise<Record<string, unknown>[]>;
  countDocs(collectionPath: string, where?: unknown): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<Record<string, unknown>>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toDate: () => Date;
  toMillis: () => number;
}

export const EVENTS_COLLECTION_PATH = 'events';

/* ------------------------------------------------------------- flag check */

/**
 * Surface check against an explicit env (test/audit surface): the
 * ADAPTER's own parser (statically bound `parseSupaSurfaces`),
 * applied to the given env's SUPA_SURFACES. This is not a local
 * parser — the semantics are the adapter flags.ts semantics,
 * including '*' and case/space tolerance.
 */
export function supaSurfaceEnabled(
  surface: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const surfaces = parseSupaSurfaces(env.SUPA_SURFACES);
    return surfaces.has('*') || surfaces.has(surface.trim().toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The operative runtime flag check (E3 form): with no argument it
 * delegates to the adapter's statically bound `useSupa('events')`
 * reading the process env at call time. An explicit env argument
 * evaluates that env through the adapter parser instead (above).
 * Never throws — a resolution failure means "off", i.e. Firestore
 * serves.
 */
export function publicEventsSupaEnabled(env?: NodeJS.ProcessEnv): boolean {
  if (env !== undefined) return supaSurfaceEnabled(PUBLIC_EVENTS_SURFACE, env);
  try {
    return useSupa(PUBLIC_EVENTS_SURFACE);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- adapter resolve */

let injectedAdapter: PublicEventsSupaAdapter | null | undefined;

/** Test seam: inject a mock adapter (or null to force "unavailable").
 * Overrides getSupaAdapter(); the flag gate above still applies. */
export function setPublicEventsAdapterForTests(
  adapter: PublicEventsSupaAdapter | null | undefined,
): void {
  injectedAdapter = adapter;
}

/**
 * Returns the shared adapter when the 'events' surface is on AND a
 * Supabase client is configured, otherwise null. Never throws.
 */
export function resolveAdapter(): PublicEventsSupaAdapter | null {
  if (!publicEventsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  try {
    if (!getSupaClient()) return null; // unconfigured -> Firestore fallback
    return (getSupaAdapter() as unknown as PublicEventsSupaAdapter) ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- timestamp normalization */

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function toTimestampLike(seconds: number, nanoseconds: number): TimestampLike {
  return {
    seconds,
    nanoseconds,
    toDate: () => new Date(seconds * 1000 + nanoseconds / 1e6),
    toMillis: () => seconds * 1000 + nanoseconds / 1e6,
  };
}

function isoToTimestampLike(iso: string): TimestampLike | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = Math.round((ms - seconds * 1000) * 1e6);
  return toTimestampLike(seconds, nanoseconds);
}

function isSerializedTimestamp(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  const hasSeconds =
    typeof value._seconds === 'number' || typeof value.seconds === 'number';
  const hasNanos =
    typeof value._nanoseconds === 'number' || typeof value.nanoseconds === 'number';
  return (
    hasSeconds &&
    hasNanos &&
    keys.every((k) => ['_seconds', '_nanoseconds', 'seconds', 'nanoseconds'].includes(k))
  );
}

/**
 * Deep-normalize a jsonb document body into the shape Firestore
 * consumers expect: ISO instant strings and serialized Timestamp
 * objects become TimestampLike; everything else passes through.
 * (Same adjudicated deviation E1/E5 recorded: VERIFICATION_SPEC
 * section 3.4(a) prescribes ISO strings on adapter reads; the cluster
 * tasking prescribes Timestamp-like at the seam. The flip is this one
 * function; the route additionally serializes to ISO for the wire —
 * see toPublicJson.)
 */
export function normalizeSupaData<T>(value: T): T {
  if (typeof value === 'string') {
    if (ISO_INSTANT_RE.test(value)) {
      const ts = isoToTimestampLike(value);
      if (ts) return ts as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeSupaData(v)) as T;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const rec = value as Record<string, unknown>;
    if (isSerializedTimestamp(rec)) {
      const seconds = (rec._seconds ?? rec.seconds) as number;
      const nanoseconds = (rec._nanoseconds ?? rec.nanoseconds) as number;
      return toTimestampLike(seconds, nanoseconds) as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = normalizeSupaData(v);
    return out as T;
  }
  return value;
}

/**
 * Wire serialization for the public route: Timestamp-like values
 * (anything with toDate()) become ISO-8601 strings, recursively,
 * because their methods cannot cross JSON. The resulting plain shapes
 * (ISO strings, numbers, plain objects) are exactly the shapes the
 * datetime oracle and `new Date(...)` consumers already handle, and
 * for a genuine instant the ISO string denotes the same instant the
 * Firestore Timestamp did.
 */
export function toPublicJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.toDate === 'function') {
      try {
        return (rec.toDate as () => Date)().toISOString() as T;
      } catch {
        return value;
      }
    }
    if (value instanceof Date) return value.toISOString() as T;
    if (Array.isArray(value)) return value.map((v) => toPublicJson(v)) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = toPublicJson(v);
    return out as T;
  }
  return value;
}

/* ---------------------------------------------------------------- read API */

async function listEvents(
  options: Record<string, unknown>,
  label: string,
): Promise<Array<Record<string, unknown>> | null> {
  const adapter = resolveAdapter();
  if (!adapter) return null;
  try {
    const rows = await adapter.listDocs(EVENTS_COLLECTION_PATH, options);
    return rows.map((row) => normalizeSupaData(row) as Record<string, unknown>);
  } catch (err) {
    console.error(`[supa-events/public] ${label} failed; falling back to Firestore:`, err);
    return null;
  }
}

/**
 * The public list page's query (E-LST-01): events ordered by
 * createdAt desc, capped at 12, NO where clause — visibility filtering
 * stays client-side in the page, applied to this exact candidate set.
 * Returns null when Supabase is unavailable.
 */
export async function listPublicEvents(): Promise<Array<Record<string, unknown>> | null> {
  return listEvents(
    { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 12 },
    'listPublicEvents',
  );
}

/**
 * The homepage workshops section's query, verbatim: type workshop,
 * status published, limit 3. Returns null when Supabase is unavailable.
 */
export async function listWorkshops(): Promise<Array<Record<string, unknown>> | null> {
  return listEvents(
    {
      where: [
        ['type', '==', 'workshop'],
        ['status', '==', 'published'],
      ],
      limit: 3,
    },
    'listWorkshops',
  );
}

/**
 * The homepage feed's query, verbatim: status published, limit 10.
 * The component's upcoming/deleted in-memory filters and slice(3)
 * stay in the component. Returns null when Supabase is unavailable.
 */
export async function listHomepageFeed(): Promise<Array<Record<string, unknown>> | null> {
  return listEvents(
    { where: [['status', '==', 'published']], limit: 10 },
    'listHomepageFeed',
  );
}
