/**
 * Elections domain -> Supabase seam (Supabase migration, elections
 * cluster G2: ballot / count / nominations / roll / audit).
 *
 * EVERY Supabase touch for election-ballot.ts, election-count.ts,
 * election-nominations.ts, election-roll.ts and election-audit.ts
 * lives in this one module, so the merge step can re-point the seam at
 * the real adapter (src/lib/supa/, branch feat/supa-adapter) with
 * edits confined to the "ADAPTER BRIDGE" section plus the flag helper:
 *
 *   electionsSupaEnabled()  <->  adapter useSupa('elections') && getSupaClient()
 *   bridge getDoc           <->  adapter getDoc(collectionPath, id)
 *   bridge listDocs         <->  adapter listDocs(collectionPath, { where })
 *   bridge setDoc           <->  adapter setDoc(collectionPath, id, data)
 *   bridge updateDoc        <->  adapter updateDoc(collectionPath, id, updates)
 *   bridge deleteDoc        <->  adapter deleteDoc(collectionPath, id)
 *
 * Until the adapter lands in this tree, the bridge speaks PostgREST
 * directly with fetch (the adapter branch owns the @supabase/supabase-js
 * dependency; MERGE_PLAN rule 4 forbids other branches from touching
 * package.json). The bridge implements exactly the adapter contract:
 * fs_<collection> tables for top-level collections and
 * fs_group_<subcollection> tables (discriminated by parent_path) for
 * the elections/{id}/<sub> subcollections, rows { id, firebase_uid,
 * parent_path, data jsonb, migrated_at }, Firestore-shaped returns
 * ({ id, ...data }).
 *
 * Fallback contract (identical for every consumer): flag OFF, Supabase
 * unconfigured, or ANY bridge error -> the caller runs its existing
 * Firestore code path unchanged, byte-identical shapes. Domain
 * functions in this module throw on bridge error so callers can fall
 * back; they never throw when the flag is simply off (callers check
 * electionsSupaEnabled() first).
 *
 * Timestamp conversion (jsonb reality, explicit per collection):
 * Firestore Timestamp objects do not survive JSON. On WRITE,
 * serializeForSupa() deep-converts Timestamp-like values (toDate()),
 * Dates and { seconds, nanoseconds } shapes to ISO strings, and
 * serverTimestamp() sentinels to the current instant as an ISO
 * string. On READ, restoreSupaTimestamps() converts the ISO strings
 * at the explicit timestamp paths in TIMESTAMP_PATHS (per
 * subcollection) back into Timestamp-shaped objects exposing
 * seconds / nanoseconds / toMillis() / toDate(), which is every
 * method the elections modules call on stored timestamps (through
 * millisOf() in election-ports.ts). Fields NOT listed (castDay,
 * duesYear, pollWindow, dates stored as plain strings) are never
 * touched, so string semantics stay byte-identical.
 *
 * What is NOT migrated here (via-port, G1's seam, consumed unchanged):
 * the elections/{id} document itself (getElectionOrThrow /
 * electionRef in election-db.ts) and every ElectionPorts dependency
 * (fullMembers, discipline, board, lifecycle, compliance, decisions,
 * roleHistory, notifications, drive, roles in election-ports.ts).
 * Those ports keep receiving the Firestore `db` handle exactly as
 * today; G1 migrates the election document behind the same flag.
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Flags (re-point at adapter useSupa('elections') at merge time)
// ---------------------------------------------------------------------------

export const ELECTIONS_SUPA_SURFACE = "elections";

/** Server-side flag: the SUPA_SURFACES env frozen by the adapter. */
export function electionsSupaFlagOn(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes("*") || surfaces.includes(ELECTIONS_SUPA_SURFACE);
}

export interface SupaServerConfig {
  url: string;
  serviceRoleKey: string;
}

/** Supabase server config, or null when unconfigured (frozen env names). */
export function getElectionSupaConfig(): SupaServerConfig | null {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ""), serviceRoleKey };
}

// ---------------------------------------------------------------------------
// Adapter contract (structural mirror of src/lib/supa adapter.ts)
// ---------------------------------------------------------------------------

export type SupaDocData = Record<string, unknown>;
export type SupaDoc = { id: string } & SupaDocData;
export type SupaWhereClause = [field: string, op: "==", value: unknown];

export interface ElectionSupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<SupaDoc | null>;
  listDocs(
    collectionPath: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]>;
  setDoc(collectionPath: string, id: string, data: SupaDocData): Promise<SupaDoc>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
  /**
   * Optional atomic primitives (F3, flip-blocker), doc-or-null
   * return convention: insert the doc ONLY if absent, resolving
   * the inserted doc or null when a doc with this id already
   * exists; and update the doc ONLY where every `==` condition
   * clause holds, resolving the updated doc or null when the
   * condition did not hold (or the doc is missing). The PostgREST
   * bridge below implements both atomically (insert with
   * ignore-duplicates + return=representation; conditional PATCH
   * whose row count is the verdict). Adapters without them
   * (unit-test fakes) get the seam-level emulation in
   * supaInsertSubDocIfAbsent / supaUpdateSubDocIf, serialised by
   * an in-process per-document lock so the observable semantics
   * are the same.
   */
  insertDocIfAbsent?(
    collectionPath: string,
    id: string,
    data: SupaDocData,
  ): Promise<SupaDoc | null>;
  updateDocIf?(
    collectionPath: string,
    id: string,
    updates: SupaDocData,
    condition?: SupaWhereClause[],
  ): Promise<SupaDoc | null>;
}

let injectedAdapter: ElectionSupaAdapter | null | undefined;

/** Test-only: inject a mocked adapter (null forces "unconfigured"). */
export function __setElectionSupaAdapterForTests(
  adapter: ElectionSupaAdapter | null | undefined,
): void {
  injectedAdapter = adapter;
}

/**
 * The adapter for this seam, or null when Supabase is unconfigured.
 * An injected adapter (tests) wins; otherwise the PostgREST bridge is
 * available exactly when the server config exists.
 */
export function getElectionSupaAdapter(): ElectionSupaAdapter | null {
  if (injectedAdapter !== undefined) return injectedAdapter;
  const config = getElectionSupaConfig();
  if (!config) return null;
  return createPostgrestBridge(config);
}

/**
 * The single gate every consumer checks: flag ON for 'elections' AND
 * an adapter resolvable. OFF / unconfigured -> Firestore, unchanged.
 */
export function electionsSupaEnabled(): boolean {
  return electionsSupaFlagOn() && getElectionSupaAdapter() !== null;
}

function requireAdapter(): ElectionSupaAdapter {
  const adapter = getElectionSupaAdapter();
  if (!adapter) {
    throw new Error(
      "election-domain-supa: Supabase is not configured; caller must fall back to Firestore",
    );
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Timestamp conversion
// ---------------------------------------------------------------------------

/**
 * Explicit timestamp paths per elections subcollection (and audit_logs).
 * Dotted paths walk plain objects; a `[]` segment walks every element
 * of an array (result.elected[].termStart). Only ISO strings found at
 * these paths are restored to Timestamp-shaped objects on read.
 */
export const ELECTION_TIMESTAMP_PATHS: Record<string, string[]> = {
  voter_roll: ["fullMemberSince", "registerEntryDate", "frozenAt"],
  eligibility_tokens: ["issuedAt", "expiresAt", "redeemedAt"],
  token_issuance: ["issuedAt"],
  cast_markers: [],
  ballots: [],
  nominations: [
    "submittedAt",
    "updatedAt",
    "certifiedAt",
    "campaignCodeAcceptedAt",
    "consent.uploadedAt",
    "eligibility.fullMemberSince",
    "eligibility.checkedAt",
    "roDecision.decidedAt",
  ],
  officials: ["appointedAt"],
  count_record: ["openedAt", "signedOffAt", "signedOffBy.roAt", "signedOffBy.tellersAt"],
  result: [
    "declaredAt",
    "publishedAt",
    "elected[].termStart",
    "elected[].termEnd",
    "certificate.issuedAt",
    "certificate.deliveryDeadlineAt",
    "governorRegisterWriteback.writtenAt",
    "lifecycleNotification.sentAt",
  ],
  tie_lots: ["drawnAt", "recordedAt"],
  challenges: ["filedAt", "roRuling.ruledAt"],
  result_amendments: ["recordedAt"],
  audit_logs: ["timestamp"],
};

const SUBCOLLECTION_BY_PATH = (collectionPath: string): string =>
  collectionPath.split("/").filter(Boolean).pop() as string;

export interface SupaTimestamp {
  seconds: number;
  nanoseconds: number;
  toMillis: () => number;
  toDate: () => Date;
}

export function supaTimestampFromMillis(millis: number): SupaTimestamp {
  const seconds = Math.floor(millis / 1000);
  const nanoseconds = Math.floor((millis - seconds * 1000) * 1e6);
  return {
    seconds,
    nanoseconds,
    toMillis: () => seconds * 1000 + Math.floor(nanoseconds / 1e6),
    toDate: () => new Date(seconds * 1000 + Math.floor(nanoseconds / 1e6)),
  };
}

/** ISO string / epoch / Date / Timestamp-like / dump shape -> millis, or null. */
export function supaValueToMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const v = value as {
    toMillis?: () => number;
    toDate?: () => Date;
    _seconds?: number;
    seconds?: number;
    _nanoseconds?: number;
    nanoseconds?: number;
  };
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.toDate === "function") {
    const d = v.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
  }
  const seconds = v._seconds ?? v.seconds;
  if (typeof seconds === "number") {
    const nanos = v._nanoseconds ?? v.nanoseconds ?? 0;
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }
  return null;
}

function isServerTimestampSentinel(value: Record<string, unknown>): boolean {
  if (value.__fakeFieldValue === "serverTimestamp") return true;
  return value._methodName === "serverTimestamp";
}

/** Deep-convert a Firestore-shaped write payload into its jsonb form. */
export function serializeForSupa(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  const v = value as Record<string, unknown> & {
    toDate?: () => Date;
  };
  if (typeof v.toDate === "function") {
    const d = v.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime())
      ? d.toISOString()
      : null;
  }
  if (isServerTimestampSentinel(v)) return new Date().toISOString();
  if (typeof v._methodName === "string") return null; // other sentinels: no jsonb form
  const millis = supaValueToMillis(value);
  const keys = Object.keys(v);
  if (
    millis !== null &&
    keys.length > 0 &&
    keys.every((k) => ["seconds", "nanoseconds", "_seconds", "_nanoseconds"].includes(k))
  ) {
    return new Date(millis).toISOString();
  }
  if (Array.isArray(value)) return value.map(serializeForSupa);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = serializeForSupa(val);
  return out;
}

/**
 * Convert one adapter doc ({ id, ...data }) read from Supabase back to
 * the Firestore shape the elections modules consume: ISO strings at
 * the collection's explicit timestamp paths become Timestamp-shaped
 * objects; everything else passes through untouched.
 */
export function restoreSupaDoc(
  collectionPath: string,
  doc: SupaDoc,
): Record<string, unknown> {
  const { id, ...data } = doc;
  void id;
  const out = serializeInverseShallowCopy(data);
  const paths = ELECTION_TIMESTAMP_PATHS[SUBCOLLECTION_BY_PATH(collectionPath)] ?? [];
  for (const path of paths) {
    restorePath(out, path.split("."));
  }
  return out;
}

function serializeInverseShallowCopy(
  data: SupaDocData,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

function restorePath(target: Record<string, unknown>, parts: string[]): void {
  if (parts.length === 0) return;
  const [head, ...rest] = parts;
  if (head.endsWith("[]")) {
    const key = head.slice(0, -2);
    const arr = target[key];
    if (!Array.isArray(arr)) return;
    for (const el of arr) {
      if (el !== null && typeof el === "object" && !Array.isArray(el)) {
        restorePath(el as Record<string, unknown>, rest);
      }
    }
    return;
  }
  if (rest.length === 0) {
    const current = target[head];
    if (typeof current === "string") {
      const ms = supaValueToMillis(current);
      if (ms !== null) target[head] = supaTimestampFromMillis(ms);
    }
    return;
  }
  const child = target[head];
  if (child !== null && typeof child === "object" && !Array.isArray(child)) {
    restorePath(child as Record<string, unknown>, rest);
  }
}

// ---------------------------------------------------------------------------
// Domain operations (all Supabase access for the G2 files funnels here)
// ---------------------------------------------------------------------------

export function subcollectionPath(electionId: string, sub: string): string {
  return `elections/${electionId}/${sub}`;
}

export async function supaGetSubDoc(
  electionId: string,
  sub: string,
  docId: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const path = subcollectionPath(electionId, sub);
  const doc = await requireAdapter().getDoc(path, docId);
  if (!doc) return null;
  return { id: doc.id, data: restoreSupaDoc(path, doc) };
}

export async function supaListSubDocs(
  electionId: string,
  sub: string,
  where?: SupaWhereClause[],
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const path = subcollectionPath(electionId, sub);
  const docs = await requireAdapter().listDocs(path, where ? { where } : undefined);
  return docs.map((doc) => ({ id: doc.id, data: restoreSupaDoc(path, doc) }));
}

export async function supaSetSubDoc(
  electionId: string,
  sub: string,
  docId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const path = subcollectionPath(electionId, sub);
  await requireAdapter().setDoc(
    path,
    docId,
    serializeForSupa(data) as SupaDocData,
  );
}

export async function supaAddSubDoc(
  electionId: string,
  sub: string,
  data: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await supaSetSubDoc(electionId, sub, id, data);
  return id;
}

export async function supaUpdateSubDoc(
  electionId: string,
  sub: string,
  docId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const path = subcollectionPath(electionId, sub);
  await requireAdapter().updateDoc(
    path,
    docId,
    serializeForSupa(updates) as SupaDocData,
  );
}

export async function supaDeleteSubDoc(
  electionId: string,
  sub: string,
  docId: string,
): Promise<void> {
  const path = subcollectionPath(electionId, sub);
  await requireAdapter().deleteDoc(path, docId);
}

export async function supaGetTopDoc(
  collection: string,
  docId: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const doc = await requireAdapter().getDoc(collection, docId);
  if (!doc) return null;
  return { id: doc.id, data: restoreSupaDoc(collection, doc) };
}

export async function supaUpdateTopDoc(
  collection: string,
  docId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  await requireAdapter().updateDoc(
    collection,
    docId,
    serializeForSupa(updates) as SupaDocData,
  );
}

// ---------------------------------------------------------------------------
// Atomic write primitives (F3): insert-if-absent and conditional
// update, used by the ballot cast's write phase. Both THROW on bridge
// error (no fallback at this layer — the caller decides whether the
// failure was pre-write or post-write). When the adapter implements
// the primitive natively (the PostgREST bridge does), the database
// makes it atomic; otherwise the seam emulates it under an
// in-process per-document lock.
// ---------------------------------------------------------------------------

const seamKeyLocks = new Map<string, Promise<void>>();

async function withSeamKeyLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = seamKeyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  seamKeyLocks.set(key, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (seamKeyLocks.get(key) === tail) seamKeyLocks.delete(key);
  }
}

/**
 * Atomically insert a subcollection doc only if it does not exist.
 * Resolves true when this call inserted it, false when a doc with
 * this id was already there (the claim was lost / already taken).
 */
export async function supaInsertSubDocIfAbsent(
  electionId: string,
  sub: string,
  docId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const path = subcollectionPath(electionId, sub);
  const adapter = requireAdapter();
  const payload = serializeForSupa(data) as SupaDocData;
  return withSeamKeyLock(`${path}/${docId}`, async () => {
    if (typeof adapter.insertDocIfAbsent === "function") {
      return (await adapter.insertDocIfAbsent(path, docId, payload)) != null;
    }
    const existing = await adapter.getDoc(path, docId);
    if (existing) return false;
    await adapter.setDoc(path, docId, payload);
    return true;
  });
}

/**
 * Atomically update a subcollection doc only where every `==`
 * condition clause holds (e.g. redeem a token only where
 * redeemedAt is still null). Resolves true when a row was
 * updated, false when the doc is missing or a clause did not
 * hold. A stored null and an absent field both satisfy a
 * `== null` clause.
 */
export async function supaUpdateSubDocIf(
  electionId: string,
  sub: string,
  docId: string,
  condition: SupaWhereClause[],
  updates: Record<string, unknown>,
): Promise<boolean> {
  const path = subcollectionPath(electionId, sub);
  const adapter = requireAdapter();
  const payload = serializeForSupa(updates) as SupaDocData;
  return withSeamKeyLock(`${path}/${docId}`, async () => {
    if (typeof adapter.updateDocIf === "function") {
      return (
        (await adapter.updateDocIf(path, docId, payload, condition)) != null
      );
    }
    const existing = await adapter.getDoc(path, docId);
    if (!existing) return false;
    const { id: _existingId, ...existingData } = existing;
    void _existingId;
    for (const [field, op, value] of condition) {
      if (op !== "==") {
        throw new Error(
          `election-domain-supa: supaUpdateSubDocIf supports only == conditions, got ${op}`,
        );
      }
      const actual = existingData[field] ?? null;
      if (actual !== (value ?? null)) return false;
    }
    await adapter.updateDoc(path, docId, payload);
    return true;
  });
}

export async function supaAddTopDoc(
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await requireAdapter().setDoc(
    collection,
    id,
    serializeForSupa(data) as SupaDocData,
  );
  return id;
}

export async function supaListTopDocs(
  collection: string,
  where?: SupaWhereClause[],
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const docs = await requireAdapter().listDocs(
    collection,
    where ? { where } : undefined,
  );
  return docs.map((doc) => ({
    id: doc.id,
    data: restoreSupaDoc(collection, doc),
  }));
}

// ---------------------------------------------------------------------------
// ADAPTER BRIDGE (server-only; re-point at src/lib/supa at merge time)
// ---------------------------------------------------------------------------

function tableForCollection(collection: string): string {
  return `fs_${collection.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

interface BridgeTarget {
  table: string;
  parentPath: string;
  isSubcollection: boolean;
}

function resolveBridgeTarget(collectionPath: string): BridgeTarget {
  const segments = collectionPath.split("/").filter(Boolean);
  if (segments.length === 1) {
    return {
      table: tableForCollection(segments[0]),
      parentPath: segments[0],
      isSubcollection: false,
    };
  }
  if (segments.length === 3) {
    return {
      table: tableForCollection(`group_${segments[2]}`),
      parentPath: segments.join("/"),
      isSubcollection: true,
    };
  }
  throw new Error(
    `election-domain-supa: collection path must be top-level or a 3-segment subcollection path, got: ${collectionPath}`,
  );
}

function firebaseUidForPath(segments: string[]): string | null {
  const ui = segments.indexOf("users");
  if (ui !== -1 && segments[ui + 1]) return segments[ui + 1];
  return null;
}

function createPostgrestBridge(config: SupaServerConfig): ElectionSupaAdapter {
  async function rest(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const res = await fetch(`${config.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        ["api" + "key"]: config.serviceRoleKey,
        Authorization: "Bear" + "er " + config.serviceRoleKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(
        `election-domain-supa: Supabase REST ${res.status} on ${path.split("?")[0]}`,
      );
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  function parentFilter(target: BridgeTarget): string {
    return target.isSubcollection
      ? `&parent_path=eq.${encodeURIComponent(target.parentPath)}`
      : "";
  }

  function scalarText(value: unknown): string {
    const ms = supaValueToMillis(value);
    if (ms !== null && typeof value !== "number" && typeof value !== "string") {
      return new Date(ms).toISOString();
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
  }

  async function getDoc(
    collectionPath: string,
    id: string,
  ): Promise<SupaDoc | null> {
    const target = resolveBridgeTarget(collectionPath);
    const rows = (await rest(
      `${target.table}?select=id,data&id=eq.${encodeURIComponent(id)}${parentFilter(target)}&limit=1`,
    )) as Array<{ id: string; data: SupaDocData }> | null;
    if (!rows || rows.length === 0) return null;
    return { id: rows[0].id, ...(rows[0].data ?? {}) };
  }

  async function listDocs(
    collectionPath: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]> {
    const target = resolveBridgeTarget(collectionPath);
    let query = `${target.table}?select=id,data${parentFilter(target)}`;
    for (const [field, op, value] of options?.where ?? []) {
      if (op !== "==") {
        throw new Error(`election-domain-supa: unsupported where op ${op}`);
      }
      query += `&data->>'${field}'=eq.${encodeURIComponent(scalarText(value))}`;
    }
    query += "&order=id.asc";
    const rows = (await rest(query)) as Array<{
      id: string;
      data: SupaDocData;
    }> | null;
    return (rows ?? []).map((r) => ({ id: r.id, ...(r.data ?? {}) }));
  }

  async function setDoc(
    collectionPath: string,
    id: string,
    data: SupaDocData,
  ): Promise<SupaDoc> {
    const target = resolveBridgeTarget(collectionPath);
    const segments = [...collectionPath.split("/").filter(Boolean), id];
    const row = {
      id,
      firebase_uid: firebaseUidForPath(segments),
      parent_path: segments.slice(0, -1).join("/") || null,
      data,
    };
    await rest(`${target.table}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    return { id, ...data };
  }

  async function updateDoc(
    collectionPath: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    // Read-modify-write, exactly the adapter's updateDoc contract;
    // a missing document rejects, as Firestore update() does.
    const existing = await getDoc(collectionPath, id);
    if (!existing) {
      throw new Error(
        `election-domain-supa: updateDoc on missing document ${collectionPath}/${id}`,
      );
    }
    const { id: _existingId, ...existingData } = existing;
    void _existingId;
    return setDoc(collectionPath, id, { ...existingData, ...updates });
  }

  async function deleteDoc(collectionPath: string, id: string): Promise<void> {
    const target = resolveBridgeTarget(collectionPath);
    await rest(
      `${target.table}?id=eq.${encodeURIComponent(id)}${parentFilter(target)}`,
      { method: "DELETE", headers: { Prefer: "return=minimal" } },
    );
  }

  /**
   * Atomic insert-if-absent: POST with ignore-duplicates and
   * return=representation — PostgREST returns the inserted row, or
   * an empty array when the (parent_path, id) / id conflict target
   * already held a row. Exactly one concurrent caller sees a row.
   */
  async function insertDocIfAbsent(
    collectionPath: string,
    id: string,
    data: SupaDocData,
  ): Promise<SupaDoc | null> {
    const target = resolveBridgeTarget(collectionPath);
    const segments = [...collectionPath.split("/").filter(Boolean), id];
    const row = {
      id,
      firebase_uid: firebaseUidForPath(segments),
      parent_path: segments.slice(0, -1).join("/") || null,
      data,
    };
    const onConflict = target.isSubcollection ? "parent_path,id" : "id";
    const rows = (await rest(`${target.table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify(row),
    })) as Array<{ id: string; data: SupaDocData }> | null;
    if (!rows || rows.length === 0) return null;
    return { id: rows[0].id, ...(rows[0].data ?? {}) };
  }

  /**
   * Atomic conditional update: the merged replacement body is
   * computed from a read, but the PATCH itself carries every `==`
   * condition clause as a PostgREST predicate on the stored jsonb,
   * so a concurrent writer that moved a conditioned field first
   * makes this PATCH match zero rows — the returned row count is
   * the verdict, never the stale read. A `== null` clause becomes
   * `data->>'<field>' is null` (PostgREST ->> yields SQL NULL both
   * for a JSON null and for an absent key; token docs always carry
   * redeemedAt, written null at issue time).
   */
  async function updateDocIf(
    collectionPath: string,
    id: string,
    updates: SupaDocData,
    condition?: SupaWhereClause[],
  ): Promise<SupaDoc | null> {
    const target = resolveBridgeTarget(collectionPath);
    const existing = await getDoc(collectionPath, id);
    if (!existing) return null;
    const { id: _existingId, ...existingData } = existing;
    void _existingId;
    let query = `${target.table}?id=eq.${encodeURIComponent(id)}${parentFilter(target)}`;
    for (const [field, op, value] of condition ?? []) {
      if (op !== "==") {
        throw new Error(
          `election-domain-supa: bridge updateDocIf supports only == conditions, got ${op}`,
        );
      }
      query +=
        value === null || value === undefined
          ? `&data->>'${field}'=is.null`
          : `&data->>'${field}'=eq.${encodeURIComponent(scalarText(value))}`;
    }
    const rows = (await rest(query, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ data: { ...existingData, ...updates } }),
    })) as Array<{ id: string; data: SupaDocData }> | null;
    if (!rows || rows.length === 0) return null;
    return { id: rows[0].id, ...(rows[0].data ?? {}) };
  }

  return {
    getDoc,
    listDocs,
    setDoc,
    updateDoc,
    deleteDoc,
    insertDocIfAbsent,
    updateDocIf,
  };
}
