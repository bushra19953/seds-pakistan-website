/**
 * settings-mirror — Supabase mirror for the ADMIN SETTINGS cluster
 * (surface 'admin-settings'): settings/discipline, settings/siteWide
 * (both in fs_settings) and governance_settings/phase2
 * (fs_governance_settings).
 *
 * CONTRACT (cluster-admin parity table, sections 4–6): Firestore stays
 * PRIMARY. After a successful primary write the caller mirrors the same
 * document through this module. A mirror failure is INVISIBLE: this
 * module never throws, returns false on any failure (flag off, adapter
 * unavailable/unconfigured, adapter error), and callers ignore the
 * result — the response and error paths of the primary routes are
 * byte-identical to the pre-migration behavior. The governance audit
 * entry is NOT mirrored: it stays Firestore-only and still fails the
 * governance request when it fails (oracle asymmetry, preserved).
 *
 * Adapter resolution follows the sibling lazy-require seam pattern
 * (notifications-supa-seam): the real adapter lives at src/lib/supa/
 * on the merged tree, not on this branch, so resolution is a lazy
 * require inside try/catch and any miss resolves to "no adapter".
 *
 * Timestamps: the mirror carries ISO strings (the adapter's storage
 * shape). For discipline the primary write already uses an ISO string,
 * so the mirror payload is byte-identical. For governance the primary
 * write uses FieldValue.serverTimestamp(); the mirror payload carries
 * an ISO string of the same instant — the route passes a payload whose
 * updatedAt is `new Date().toISOString()` taken at the route's clock in
 * the same request (see buildSettingsMirrorPayload for the sentinel
 * conversion applied if a raw payload crosses here instead).
 */

export interface SettingsSupaAdapter {
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
}

/* --------------------------------------------------------------- flag gate */

/**
 * useSupa('admin-settings') equivalent, mirroring src/lib/supa/flags.ts
 * semantics (SUPA_SURFACES comma list, case-insensitive, '*' = all,
 * unset/empty = OFF) without importing a module absent on this branch.
 */
export function settingsSupaEnabled(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes('*')) return true;
  return surfaces.includes('admin-settings');
}

/* -------------------------------------------------------- adapter plumbing */

let injectedAdapter: SettingsSupaAdapter | null | undefined;

/** Test-only injection point (fake adapter; no live Supabase in tests). */
export function setSettingsSupaAdapterForTests(
  adapter: SettingsSupaAdapter | null,
): void {
  injectedAdapter = adapter;
}

function resolveRealAdapter(): SettingsSupaAdapter | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adapterModule = require('@/lib/supa/adapter');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clientModule = require('@/lib/supa/client');
    if (typeof clientModule?.getSupaClient !== 'function') return null;
    if (!clientModule.getSupaClient()) return null; // unconfigured
    if (typeof adapterModule?.getSupaAdapter !== 'function') return null;
    return adapterModule.getSupaAdapter() as SettingsSupaAdapter;
  } catch {
    return null;
  }
}

export function getSettingsSupaAdapter(): SettingsSupaAdapter | null {
  if (!settingsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  return resolveRealAdapter();
}

/* ------------------------------------------------------------ payload build */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function timestampLikeToIso(value: Record<string, unknown>): string | null {
  const toDate = (value as { toDate?: unknown }).toDate;
  if (typeof toDate === 'function') {
    try {
      const d = (toDate as () => Date).call(value);
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
    } catch {
      return null;
    }
  }
  const seconds =
    typeof value.seconds === 'number'
      ? value.seconds
      : typeof value._seconds === 'number'
        ? (value._seconds as number)
        : null;
  const nanos =
    typeof value.nanoseconds === 'number'
      ? value.nanoseconds
      : typeof value._nanoseconds === 'number'
        ? (value._nanoseconds as number)
        : 0;
  const keys = Object.keys(value);
  if (
    seconds !== null &&
    keys.every((k) => ['seconds', 'nanoseconds', '_seconds', '_nanoseconds'].includes(k))
  ) {
    return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
  }
  return null;
}

function serializeValue(value: unknown, now: Date): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) return value.map((v) => serializeValue(v, now));
  if (value !== null && typeof value === 'object') {
    const iso = timestampLikeToIso(value as Record<string, unknown>);
    if (iso !== null) return iso;
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v, now);
      return out;
    }
    // Non-plain object without toDate: a FieldValue sentinel
    // (serverTimestamp). Its resolved value is the write instant,
    // approximated by `now` (the caller's clock for this request).
    return now.toISOString();
  }
  return value;
}

/**
 * Pure payload builder: the exact document body the mirror writes for a
 * given primary payload. Plain values pass through unchanged (so for
 * discipline / siteWide, whose primary payloads already carry ISO
 * strings, mirror payload === primary payload); Date / Timestamp-like
 * values become ISO strings; a serverTimestamp sentinel becomes `now`.
 */
export function buildSettingsMirrorPayload(
  data: Record<string, unknown>,
  now: Date = new Date(),
): Record<string, unknown> {
  return serializeValue(data, now) as Record<string, unknown>;
}

/* -------------------------------------------------------------- mirror ops */

/**
 * Mirror one settings document to its fs_* table (merge). Never throws:
 * returns true only when a Supabase write actually happened.
 */
export async function mirrorSettingsDoc(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const adapter = getSettingsSupaAdapter();
  if (!adapter) return false;
  try {
    await adapter.setDoc(collection, id, buildSettingsMirrorPayload(data), {
      merge: true,
    });
    return true;
  } catch (err) {
    console.warn(`[settings-mirror] mirror failed for ${collection}/${id}:`, err);
    return false;
  }
}

/** Mirror governance_settings/{id} (fs_governance_settings). Never throws. */
export async function mirrorGovernanceDoc(
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  return mirrorSettingsDoc('governance_settings', id, data);
}

/* ------------------------------------------------------------- primacy */
/* WRITE PRIMACY (cutover W4): isSupaPrimary('admin-settings') — token
 * in BOTH SUPA_SURFACES and SUPA_PRIMARY, same comma-token rules as
 * settingsSupaEnabled above. setSettingsDocPrimaryFirst writes the
 * adapter FIRST (merge-set, the same payload builder as the mirror)
 * and THROWS on failure; the caller then runs its Firestore set as
 * the best-effort post-commit mirror. OFF (default): returns false,
 * callers run today's Firestore-first flow + mirror byte-identically.
 * Callers converted: discipline-settings PUT and governance/settings
 * POST. The site-settings/mirror route is a mirror ENDPOINT for
 * browser writes (client-direct class) and is NOT converted — the
 * 'admin-settings' token must not flip until that path is
 * server-routed (w4-census.md). */

export function settingsSupaPrimary(): boolean {
  if (!settingsSupaEnabled()) return false;
  const raw = process.env.SUPA_PRIMARY;
  if (!raw) return false;
  const tokens = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.includes('*')) return true;
  return tokens.includes('admin-settings');
}

export async function setSettingsDocPrimaryFirst(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!settingsSupaPrimary()) return false;
  const adapter = getSettingsSupaAdapter();
  if (!adapter) return false;
  await adapter.setDoc(collection, id, buildSettingsMirrorPayload(data), {
    merge: true,
  });
  return true;
}

/** Governance-named arm of setSettingsDocPrimaryFirst. Throws on failure. */
export async function setGovernanceDocPrimaryFirst(
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  return setSettingsDocPrimaryFirst('governance_settings', id, data);
}
