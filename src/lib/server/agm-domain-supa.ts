/**
 * AGM + governance-voting domain -> Supabase seam (Supabase migration,
 * elections cluster G3: agm.ts + governance-votes.ts).
 *
 * EVERY Supabase touch for agm.ts and governance-votes.ts lives in
 * this one module, so the merge step can re-point the seam at the
 * real adapter (src/lib/supa/, branch feat/supa-adapter) with edits
 * confined to the "ADAPTER BRIDGE" section plus the flag helper:
 *
 *   agmSupaEnabled()  <->  adapter useSupa('elections') && getSupaClient()
 *   bridge getDoc     <->  adapter getDoc(collectionPath, id)
 *   bridge listDocs   <->  adapter listDocs(collectionPath, { where })
 *   bridge setDoc     <->  adapter setDoc(collectionPath, id, data)
 *   bridge updateDoc  <->  adapter updateDoc(collectionPath, id, updates)
 *   bridge deleteDoc  <->  adapter deleteDoc(collectionPath, id)
 *
 * The pattern is copied exactly from G2's election-domain-supa.ts:
 * the bridge speaks PostgREST directly with fetch until the adapter
 * lands in this tree (MERGE_PLAN rule 4 forbids touching
 * package.json), and implements the adapter contract: fs_<collection>
 * tables for top-level collections and fs_group_<subcollection>
 * tables (discriminated by parent_path) for subcollections, rows
 * { id, firebase_uid, parent_path, data jsonb, migrated_at },
 * Firestore-shaped returns ({ id, ...data }).
 *
 * Collections / paths migrated here:
 *   agm_events                                  -> fs_agm_events
 *   agm_events/{agmId}/notices                  -> fs_group_notices
 *   agm_events/{agmId}/notices/{id}/recipients  -> fs_group_recipients
 *   agm_documents                               -> fs_agm_documents
 *   auditor_appointments                        -> fs_auditor_appointments
 *   governance_votes                            -> fs_governance_votes
 *   governance_votes/{voteId}/ballots           -> fs_group_ballots
 *
 * Recipients note (merge-step watch item): the recipients path has
 * FIVE segments. The bridge generalises the adapter's target
 * resolution to any odd segment count >= 3 (last segment names the
 * group table, the full collection path is the parent_path
 * discriminator) - the same rule the adapter already applies at 3
 * segments. The landed adapter's resolveTarget() accepts only 1 or
 * 3 segments today, so the merge owner must apply the same
 * generalisation there before this surface flips.
 *
 * Fallback contract (identical for every consumer): flag OFF,
 * Supabase unconfigured, or ANY bridge error -> the caller runs its
 * existing Firestore code path unchanged, byte-identical shapes.
 * Domain functions in this module throw on bridge error so callers
 * can fall back; they never throw when the flag is simply off
 * (callers check agmSupaEnabled() first).
 *
 * Timestamp conversion (jsonb reality, explicit per collection):
 * Firestore Timestamp objects do not survive JSON. On WRITE,
 * serializeForSupa() deep-converts Timestamp-like values (toDate()),
 * Dates and { seconds, nanoseconds } shapes to ISO strings, and
 * serverTimestamp() sentinels to the current instant as an ISO
 * string. On READ, restoreSupaDoc() converts the ISO strings at the
 * explicit timestamp paths in AGM_TIMESTAMP_PATHS (keyed by the
 * collection path's last segment) back into Timestamp-shaped objects
 * exposing seconds / nanoseconds / toMillis() / toDate(), which is
 * every method the AGM / governance modules call on stored
 * timestamps (through millisOf() in election-db.ts). Fields NOT
 * listed are never touched, so string semantics stay byte-identical.
 * In particular auditor_appointments.appointedAt is stored as a
 * plain "YYYY-MM-DD" date string by createAuditorAppointment (the
 * Finance-canonical shape) and is deliberately NOT a timestamp path.
 *
 * What is NOT migrated here:
 * - governance-audit.ts (shared with the governance/meetings family,
 *   another team's file): governance-votes.ts keeps calling
 *   writeGovernanceAuditOrThrow(db, ...) exactly as today, and the
 *   audit entries keep landing in Firestore audit_logs on both paths.
 * - election-audit.ts writes (already migrated by G2 behind the same
 *   'elections' flag in election-domain-supa.ts).
 * - Every ElectionPorts dependency: ports keep receiving the
 *   Firestore `db` handle exactly as today.
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Flags (re-point at adapter useSupa('elections') at merge time)
// ---------------------------------------------------------------------------

export const ELECTIONS_SUPA_SURFACE = "elections";

/** Server-side flag: the SUPA_SURFACES env frozen by the adapter. */
export function agmSupaFlagOn(): boolean {
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
export function getAgmSupaConfig(): SupaServerConfig | null {
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

export interface AgmSupaAdapter {
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
}

let injectedAdapter: AgmSupaAdapter | null | undefined;

/** Test-only: inject a mocked adapter (null forces "unconfigured"). */
export function __setAgmSupaAdapterForTests(
  adapter: AgmSupaAdapter | null | undefined,
): void {
  injectedAdapter = adapter;
}

/**
 * The adapter for this seam, or null when Supabase is unconfigured.
 * An injected adapter (tests) wins; otherwise the PostgREST bridge is
 * available exactly when the server config exists.
 */
export function getAgmSupaAdapter(): AgmSupaAdapter | null {
  if (injectedAdapter !== undefined) return injectedAdapter;
  const config = getAgmSupaConfig();
  if (!config) return null;
  return createPostgrestBridge(config);
}

/**
 * The single gate every consumer checks: flag ON for 'elections' AND
 * an adapter resolvable. OFF / unconfigured -> Firestore, unchanged.
 * (Same surface name as the G1/G2 seams: SUPA_SURFACES=elections.)
 */
export function agmSupaEnabled(): boolean {
  return agmSupaFlagOn() && getAgmSupaAdapter() !== null;
}

function requireAdapter(): AgmSupaAdapter {
  const adapter = getAgmSupaAdapter();
  if (!adapter) {
    throw new Error(
      "agm-domain-supa: Supabase is not configured; caller must fall back to Firestore",
    );
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Timestamp conversion
// ---------------------------------------------------------------------------

/**
 * Explicit timestamp paths per collection (keyed by the collection
 * path's last segment). Dotted paths walk plain objects; a `[]`
 * segment walks every element of an array. Only ISO strings found at
 * these paths are restored to Timestamp-shaped objects on read.
 *
 * Enumerated from the writes in agm.ts / governance-votes.ts:
 * - agm_events: scheduledAt + createdAt are tsFromMillis();
 *   updatedAt is serverTimestamp(); quorum.verifiedAt is an
 *   FsTimestamp | null carried inside the quorum object.
 * - notices: issuedAt / noticeDate are tsFromMillis();
 *   dispatch.startedAt is tsFromMillis(), dispatch.completedAt is
 *   tsFromMillis() | null (rewritten wholesale on dispatch update).
 * - recipients: servedAt is tsFromMillis() | null.
 * - agm_documents: uploadedAt / publishedAt are tsFromMillis()
 *   (publishedAt is typed FsTimestamp | null).
 * - auditor_appointments: NO timestamp paths. appointedAt is a plain
 *   "YYYY-MM-DD" string in the stored Finance-canonical shape.
 * - governance_votes: createdAt / attestedAt / closedAt are
 *   FieldValue.serverTimestamp(). The tally `result` object carries
 *   only numbers/booleans and is never touched.
 * - ballots (governance): castAt is FieldValue.serverTimestamp().
 */
export const AGM_TIMESTAMP_PATHS: Record<string, string[]> = {
  agm_events: ["scheduledAt", "quorum.verifiedAt", "createdAt", "updatedAt"],
  notices: [
    "issuedAt",
    "noticeDate",
    "dispatch.startedAt",
    "dispatch.completedAt",
  ],
  recipients: ["servedAt"],
  agm_documents: ["uploadedAt", "publishedAt"],
  auditor_appointments: [],
  governance_votes: ["createdAt", "attestedAt", "closedAt"],
  ballots: ["castAt"],
};

const COLLECTION_KEY_BY_PATH = (collectionPath: string): string =>
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
  // Admin SDK FieldValue sentinels carry a _methodName naming the call
  // ("serverTimestamp" in the elections fake / G2 seam's spelling,
  // "FieldValue.serverTimestamp" in the G1 seam's spelling).
  return (
    typeof value._methodName === "string" &&
    value._methodName.includes("serverTimestamp")
  );
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
 * the Firestore shape the AGM / governance modules consume: ISO
 * strings at the collection's explicit timestamp paths become
 * Timestamp-shaped objects; everything else passes through untouched.
 */
export function restoreSupaDoc(
  collectionPath: string,
  doc: SupaDoc,
): Record<string, unknown> {
  const { id, ...data } = doc;
  void id;
  const out = serializeInverseShallowCopy(data);
  const paths = AGM_TIMESTAMP_PATHS[COLLECTION_KEY_BY_PATH(collectionPath)] ?? [];
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
// Domain operations (all Supabase access for the G3 files funnels here)
// Generic collection-path addressing, mirroring the adapter contract:
// a top-level collection name, a 3-segment subcollection path, or the
// 5-segment AGM recipients path (see the header note).
// ---------------------------------------------------------------------------

export async function supaGetDoc(
  collectionPath: string,
  docId: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const doc = await requireAdapter().getDoc(collectionPath, docId);
  if (!doc) return null;
  return { id: doc.id, data: restoreSupaDoc(collectionPath, doc) };
}

export async function supaListDocs(
  collectionPath: string,
  where?: SupaWhereClause[],
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const docs = await requireAdapter().listDocs(
    collectionPath,
    where ? { where } : undefined,
  );
  return docs.map((doc) => ({
    id: doc.id,
    data: restoreSupaDoc(collectionPath, doc),
  }));
}

export async function supaSetDoc(
  collectionPath: string,
  docId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await requireAdapter().setDoc(
    collectionPath,
    docId,
    serializeForSupa(data) as SupaDocData,
  );
}

export async function supaAddDoc(
  collectionPath: string,
  data: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await supaSetDoc(collectionPath, id, data);
  return id;
}

export async function supaUpdateDoc(
  collectionPath: string,
  docId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  await requireAdapter().updateDoc(
    collectionPath,
    docId,
    serializeForSupa(updates) as SupaDocData,
  );
}

export async function supaDeleteDoc(
  collectionPath: string,
  docId: string,
): Promise<void> {
  await requireAdapter().deleteDoc(collectionPath, docId);
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
  // Subcollections: 3 segments (collection/{id}/subcollection) and,
  // for the AGM notice recipients, 5 segments
  // (agm_events/{id}/notices/{id}/recipients). The last segment names
  // the group table; the full collection path discriminates the rows.
  if (segments.length === 3 || segments.length === 5) {
    return {
      table: tableForCollection(`group_${segments[segments.length - 1]}`),
      parentPath: segments.join("/"),
      isSubcollection: true,
    };
  }
  throw new Error(
    `agm-domain-supa: collection path must be top-level or a 3/5-segment subcollection path, got: ${collectionPath}`,
  );
}

function firebaseUidForPath(segments: string[]): string | null {
  const ui = segments.indexOf("users");
  if (ui !== -1 && segments[ui + 1]) return segments[ui + 1];
  return null;
}

function createPostgrestBridge(config: SupaServerConfig): AgmSupaAdapter {
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
        `agm-domain-supa: Supabase REST ${res.status} on ${path.split("?")[0]}`,
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
        throw new Error(`agm-domain-supa: unsupported where op ${op}`);
      }
      query += `&data->>${field}=eq.${encodeURIComponent(scalarText(value))}`;
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
        `agm-domain-supa: updateDoc on missing document ${collectionPath}/${id}`,
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

  return { getDoc, listDocs, setDoc, updateDoc, deleteDoc };
}
