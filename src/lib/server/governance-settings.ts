// Phase 2 governance switches (spec Section 0.1).
// Singleton doc governance_settings/phase2. Deliberately NOT in the
// existing `settings` collection, which has a public-read rules block.
// Missing doc = defaults computed in memory; nothing changes behaviour
// until the doc exists AND the relevant flag is flipped.
//
// CACHING (perf program, 2026-10-30 — supersedes the former no-cache
// note for the READ accessors below): this doc sits on hot request
// chains (the board route, the universal-review queue, the cadetship
// stanza) and every uncached read costs the day's Firestore latency
// (0.5–6 s on a degraded day), so getGovernanceSettings /
// getConsentGateMode / isPhase2Live now share ONE in-process cache of
// the raw doc, keyed by the caller's db handle (the role-definitions-
// cache pattern), TTL GOVERNANCE_SETTINGS_CACHE_TTL_MS (30 s — the
// identity-cache program's staleness bound). Discipline:
//   - Only a SUCCESSFUL read of an EXISTING doc is ever cached. A
//     missing doc and a failed read are never cached: creating the
//     doc, or Firestore recovering, takes effect on the very next
//     call — a degraded or empty result can never be served stale
//     (the cached-empty failure mode is forbidden platform-wide).
//   - Concurrent loads for the same handle coalesce behind one
//     in-flight promise, evicted the moment it settles.
//   - The settings POST route (the only in-app write path) calls
//     invalidateGovernanceSettingsCache(db) synchronously after its
//     write, so a flag flip through the API still takes effect on
//     the next request, exactly as the uncached reads behaved. An
//     out-of-band (console) edit becomes visible within the TTL.
//   - getConsentMatterSettings below is deliberately NOT routed
//     through this cache: spec B.8 requires a gate-mode flip to take
//     effect on the next attempted act, and that reader keeps its
//     own per-call read (see src/lib/server/request-cache.ts).

import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from './firebase-admin';
import { currentComplianceDb } from './cron/compliance-db-context';
import {
  FIRESTORE_DOC_DEADLINE_MS,
  withReadDeadline,
} from './read-deadline';

/**
 * Every read of the singleton doc below goes through this helper, so
 * no read is ever UNBOUNDED — on a degraded Firestore the bare .get()
 * rode the GAPIC retry budget (60 s per RPC, 600 s total) on every
 * gated act. The 8 s deadline makes the read fail into each caller's
 * existing fail-closed handling in seconds (perf program,
 * 2026-10-30). Both the cached loader (loadPhase2Raw) and the
 * deliberately uncached per-matter reader route through here.
 */
function readPhase2Doc(db: Firestore) {
  return withReadDeadline('governance_settings/phase2', FIRESTORE_DOC_DEADLINE_MS, () =>
    db.collection('governance_settings').doc('phase2').get(),
  );
}

export const GOVERNANCE_SETTINGS_CACHE_TTL_MS = 30_000;

type Phase2RawOutcome =
  | { kind: 'doc'; raw: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'error' };

interface Phase2RawCacheEntry {
  fetchedAt: number;
  raw: Record<string, unknown>;
}

const phase2RawCache = new WeakMap<object, Phase2RawCacheEntry>();
const phase2Inflight = new WeakMap<object, Promise<Phase2RawOutcome>>();

/**
 * The one raw read of governance_settings/phase2 behind the cached
 * accessors. Never rejects: a failed read resolves to { kind:
 * 'error' } and each accessor applies its own fail-closed handling,
 * exactly as the uncached reads behaved. Successful existing-doc
 * reads are cached per db handle; missing/error outcomes are not.
 */
function loadPhase2Raw(db: Firestore): Promise<Phase2RawOutcome> {
  const key = db as unknown as object;
  const entry = phase2RawCache.get(key);
  if (entry && Date.now() - entry.fetchedAt < GOVERNANCE_SETTINGS_CACHE_TTL_MS) {
    return Promise.resolve({ kind: 'doc', raw: entry.raw });
  }
  const pending = phase2Inflight.get(key);
  if (pending) return pending;
  const promise = (async (): Promise<Phase2RawOutcome> => {
    try {
      const snap = await readPhase2Doc(db);
      if (!snap || !snap.exists) return { kind: 'missing' };
      const raw = (snap.data() ?? {}) as Record<string, unknown>;
      phase2RawCache.set(key, { fetchedAt: Date.now(), raw });
      return { kind: 'doc', raw };
    } catch (err) {
      // Fail closed AND loud: a degraded read silently serving
      // defaults is indistinguishable from the doc genuinely saying
      // so (the false-empty lesson of 2026-10-30); operators need
      // the signal that governance is running on defaults right now.
      console.error(
        '[governance-settings] governance_settings/phase2 read failed; serving fail-closed defaults',
        err,
      );
      return { kind: 'error' };
    } finally {
      // Identity-checked cleanup: only evict our own in-flight entry.
      if (phase2Inflight.get(key) === promise) phase2Inflight.delete(key);
    }
  })();
  phase2Inflight.set(key, promise);
  return promise;
}

/**
 * Drop the cached phase2 doc for one db handle. Called by the
 * settings write path immediately after a successful write so the
 * flip is visible on the next read, not at TTL expiry.
 */
export function invalidateGovernanceSettingsCache(db: Firestore): void {
  phase2RawCache.delete(db as unknown as object);
}

export type ConsentGateMode = 'hard' | 'record';

export type Phase2Flag =
  | 'consentLive'
  | 'boardLive'
  | 'disciplineLive'
  | 'cadetshipLive'
  | 'complianceLive';

export const PHASE2_FLAGS: Phase2Flag[] = [
  'consentLive',
  'boardLive',
  'disciplineLive',
  'cadetshipLive',
  'complianceLive',
];

export interface GovernanceSettings {
  consentGateMode: Record<string, ConsentGateMode>;
  probationRestoreMode: 'auto' | 'reappoint';
  warningRegistryVariant: 'internal' | 'retired';
  flags: Record<Phase2Flag, boolean>;
  updatedAt?: unknown;
  updatedBy?: string;
  changeReason?: string;
}

export const DEFAULT_GOVERNANCE_SETTINGS: GovernanceSettings = {
  consentGateMode: {
    category_b_appointment: 'hard',
    chapter_lifecycle: 'hard',
    catalog_amendment: 'hard',
    sponsor_partner: 'record',
    other_reserved: 'record',
  },
  probationRestoreMode: 'auto',
  warningRegistryVariant: 'internal',
  flags: {
    consentLive: false,
    boardLive: false,
    disciplineLive: false,
    cadetshipLive: false,
    complianceLive: false,
  },
};

function cloneDefaults(): GovernanceSettings {
  return {
    consentGateMode: { ...DEFAULT_GOVERNANCE_SETTINGS.consentGateMode },
    probationRestoreMode: DEFAULT_GOVERNANCE_SETTINGS.probationRestoreMode,
    warningRegistryVariant: DEFAULT_GOVERNANCE_SETTINGS.warningRegistryVariant,
    flags: { ...DEFAULT_GOVERNANCE_SETTINGS.flags },
  };
}

export async function getGovernanceSettings(
  db: Firestore,
): Promise<GovernanceSettings> {
  const settings = cloneDefaults();
  const outcome = await loadPhase2Raw(db);
  // Missing doc and failed reads both fail closed to defaults, exactly
  // as the uncached read behaved; neither outcome is ever cached.
  if (outcome.kind !== 'doc') return settings;
  const data = outcome.raw;
  if (data.consentGateMode && typeof data.consentGateMode === 'object') {
    for (const [key, value] of Object.entries(
      data.consentGateMode as Record<string, unknown>,
    )) {
      if (value === 'hard' || value === 'record') {
        settings.consentGateMode[key] = value;
      }
    }
  }
  if (data.probationRestoreMode === 'auto' || data.probationRestoreMode === 'reappoint') {
    settings.probationRestoreMode = data.probationRestoreMode;
  }
  if (data.warningRegistryVariant === 'internal' || data.warningRegistryVariant === 'retired') {
    settings.warningRegistryVariant = data.warningRegistryVariant;
  }
  if (data.flags && typeof data.flags === 'object') {
    for (const flag of PHASE2_FLAGS) {
      const value = (data.flags as Record<string, unknown>)[flag];
      if (typeof value === 'boolean') settings.flags[flag] = value;
    }
  }
  if (data.updatedAt !== undefined) settings.updatedAt = data.updatedAt;
  if (typeof data.updatedBy === 'string') settings.updatedBy = data.updatedBy;
  if (typeof data.changeReason === 'string') settings.changeReason = data.changeReason;
  return settings;
}

// A missing key means 'hard' (fail closed), per spec 0.1.
export async function getConsentGateMode(
  db: Firestore,
  matterClass: string,
): Promise<ConsentGateMode> {
  const settings = await getGovernanceSettings(db);
  return settings.consentGateMode[matterClass] ?? 'hard';
}

export async function isPhase2Live(
  dbOrFlag: Firestore | Phase2Flag | string,
  flag?: Phase2Flag | string,
): Promise<boolean> {
  // Dual call shape (integration step 7): Workstream A's consumers call
  // isPhase2Live(db, flag); the Cadetship+Compliance crew's module bound
  // getDb() internally and its consumers call isPhase2Live(flag). Both
  // shapes are supported; the string form resolves the db itself.
  let db: Firestore | null;
  let flagName: string;
  if (typeof dbOrFlag === 'string') {
    flagName = dbOrFlag;
    // Seam (cutover, compliance-db-context): ONLY this self-acquiring
    // string form consults the compliance cron's scoped handle; the
    // db-first form and every other caller are untouched, and outside
    // the cron context this is exactly the getDb() it always used.
    db = currentComplianceDb() ?? getDb();
    if (!db) return false;
  } else {
    db = dbOrFlag;
    flagName = String(flag ?? '');
  }
  const settings = await getGovernanceSettings(db);
  if (settings.flags[flagName as Phase2Flag] === true) return true;
  // Workstream B flag names (e.g. 'boardLive' from the board route) live
  // as top-level booleans on the same doc; check the raw doc too. This
  // reuses the SAME cached load getGovernanceSettings just performed —
  // the uncached version read the doc a second time on every call.
  const outcome = await loadPhase2Raw(db);
  if (outcome.kind !== 'doc') return false;
  return outcome.raw[flagName] === true;
}

// ---------------------------------------------------------------------------
// Workstream B per-matter gate settings (integration step 4). The gates
// branch read these from settings/governance; the canonical doc is
// governance_settings/phase2 (spec 0.1), so this reader is implemented
// over the accessor above - the "one-line swap" the gates crew isolated
// for. Contract preserved from the gates implementation:
// - doc missing or matter key absent -> mode 'record', source 'missing'
//   (deploying the gate before the doc is seeded degrades to record-only);
// - mode present in consentGateMode -> source 'doc';
// - validityDays: no canonical per-matter field exists; the optional
//   matterValidityDays map on the doc is honored when present, else the
//   90-day default. NOTE the deliberate default difference from
//   getConsentGateMode above (absent -> 'hard'): getConsentMatterSettings
//   serves Workstream B's assertConsentFor, whose spec'd degraded state
//   is record-only. Both contracts are kept as their specs wrote them;
//   the divergence is recorded in the integration log.
// ---------------------------------------------------------------------------

export const GOVERNANCE_SETTINGS_PATH = {
  collection: 'governance_settings',
  doc: 'phase2',
} as const;

export interface ConsentMatterSettings {
  mode: ConsentGateMode;
  validityDays: number;
  source: 'doc' | 'missing' | 'malformed';
}

export const DEFAULT_VALIDITY_DAYS = 90;

export async function getConsentMatterSettings(
  db: Firestore,
  matterKey: string,
): Promise<ConsentMatterSettings> {
  // Deliberately NOT served from the loadPhase2Raw cache above (perf
  // program, 2026-10-30): spec B.8 requires a gate-mode flip to take
  // effect on the next attempted act, so this reader keeps its own
  // per-call Firestore read. See src/lib/server/request-cache.ts,
  // which records the same decision for the request-scoped memo.
  let raw: Record<string, unknown> | null = null;
  try {
    const snap = await readPhase2Doc(db);
    if (snap && snap.exists) raw = (snap.data() ?? {}) as Record<string, unknown>;
  } catch {
    return { mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing' };
  }
  if (!raw) {
    return { mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing' };
  }
  const validityMap = raw.matterValidityDays as Record<string, unknown> | undefined;
  const rawValidity = validityMap?.[matterKey];
  const validityDays =
    typeof rawValidity === 'number' && rawValidity > 0 ? rawValidity : DEFAULT_VALIDITY_DAYS;
  const modes = raw.consentGateMode as Record<string, unknown> | undefined;
  const mode = modes?.[matterKey];
  if (mode === 'hard' || mode === 'record') {
    return { mode, validityDays, source: 'doc' };
  }
  if (mode === undefined) {
    return { mode: 'record', validityDays, source: 'missing' };
  }
  return { mode: 'record', validityDays, source: 'malformed' };
}
