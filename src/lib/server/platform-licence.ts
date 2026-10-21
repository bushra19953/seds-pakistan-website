/**
 * Platform licence + effective site state: server layer (Workstream H).
 *
 * The licence record lives in governance/platform_licence. The rules
 * candidate (spec 3.3) denies all client writes and allows direct
 * reads only to the Founder/superadmin; in practice all app access is
 * Admin SDK through this module and the admin route. Site settings
 * (settings/siteWide) supply only the maintenance/disable switches.
 *
 * FAIL-OPEN DESIGN: every read path here degrades to 'live'. A missing
 * doc, a Firestore error, or malformed data must never take the site
 * down; the switch exists to be available, not to be a new outage
 * mode. PLATFORM_GATE_BYPASS=1 short-circuits every check (deploy-time
 * escape hatch), evaluated FIRST everywhere.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { admin, getDb } from '@/lib/server/firebase-admin';
import { isFounder } from '@/lib/roles';
import { computeEffectiveSiteState, timestampToMillis } from '@/lib/site-state';
import type {
  EffectiveSiteState,
  LicenceStatus,
  PlatformLicenceDTO,
} from '@/types/platform-licence';
import { NO_LICENCE_DTO } from '@/types/platform-licence';

export const GOVERNANCE_COLLECTION = 'governance';
export const PLATFORM_LICENCE_DOC_ID = 'platform_licence';
export const LICENCE_HISTORY_SUBCOLLECTION = 'history';
export const SETTINGS_COLLECTION = 'settings';
export const SITE_WIDE_DOC_ID = 'siteWide';
export const AUDIT_LOGS_COLLECTION = 'audit_logs';

export const NOTICE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export function isGateBypassed(): boolean {
  return process.env.PLATFORM_GATE_BYPASS === '1';
}

function licenceRef(db: Firestore) {
  return db.collection(GOVERNANCE_COLLECTION).doc(PLATFORM_LICENCE_DOC_ID);
}

/** Read the raw licence doc data, or null when absent/unreadable. */
export async function readPlatformLicenceRaw(
  db: Firestore,
): Promise<Record<string, unknown> | null> {
  try {
    const snap = await licenceRef(db).get();
    if (!snap.exists) return null;
    return (snap.data() ?? {}) as Record<string, unknown>;
  } catch (err) {
    console.warn('[platform-licence] read failed, treating as none:', err);
    return null;
  }
}

function toDto(raw: Record<string, unknown> | null): PlatformLicenceDTO {
  if (!raw) return { ...NO_LICENCE_DTO };
  const iso = (v: unknown) => {
    const ms = timestampToMillis(v);
    return ms !== null ? new Date(ms).toISOString() : null;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const status = str(raw.status);
  return {
    licensor: str(raw.licensor),
    licensee: str(raw.licensee),
    agreementRefId: str(raw.agreementRefId),
    agreementRefUrl: str(raw.agreementRefUrl),
    status: (
      [
        'none_recorded',
        'active',
        'notice_served',
        'revoked',
        'expired',
      ].includes(status)
        ? status
        : 'none_recorded'
    ) as LicenceStatus,
    noticeServedAt: iso(raw.noticeServedAt),
    noticeServedBy: str(raw.noticeServedBy),
    noticeReason: str(raw.noticeReason),
    effectiveRevocationAt: iso(raw.effectiveRevocationAt),
    licencePublicNotice: str(raw.licencePublicNotice),
    recordedBy: str(raw.recordedBy),
    updatedAt: iso(raw.updatedAt),
  };
}

export async function readPlatformLicence(
  db: Firestore,
): Promise<PlatformLicenceDTO> {
  return toDto(await readPlatformLicenceRaw(db));
}

/** Read the two settings switches defensively; absent doc = live. */
export async function readSiteSwitches(
  db: Firestore,
): Promise<{ siteEnabled?: unknown; maintenanceMode?: unknown }> {
  try {
    const snap = await db
      .collection(SETTINGS_COLLECTION)
      .doc(SITE_WIDE_DOC_ID)
      .get();
    if (!snap.exists) return {};
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    return {
      siteEnabled: data.siteEnabled,
      maintenanceMode: data.maintenanceMode,
    };
  } catch (err) {
    console.warn('[platform-licence] settings read failed, treating as live:', err);
    return {};
  }
}

/**
 * The one server entry point for effective state. Fail-open: any
 * failure (no db, read error) resolves to { mode: 'live' }.
 */
export async function getEffectiveSiteState(
  db?: Firestore | null,
): Promise<EffectiveSiteState> {
  if (isGateBypassed()) return { mode: 'live' };
  const database = db ?? getDb();
  if (!database) return { mode: 'live' };
  try {
    const [switches, licence] = await Promise.all([
      readSiteSwitches(database as Firestore),
      readPlatformLicenceRaw(database as Firestore),
    ]);
    return computeEffectiveSiteState(switches, licence, Date.now());
  } catch (err) {
    console.warn('[platform-licence] state resolution failed open:', err);
    return { mode: 'live' };
  }
}

/** 503 descriptor for a blocked mode; null when live. */
export function siteNotOperationalResponse(state: EffectiveSiteState) {
  if (state.mode === 'revoked') {
    return { status: 503, body: { error: 'Site unavailable', code: 'LICENCE_REVOKED' } };
  }
  if (state.mode === 'maintenance') {
    return { status: 503, body: { error: 'Site under maintenance', code: 'SITE_MAINTENANCE' } };
  }
  if (state.mode === 'disabled') {
    return { status: 503, body: { error: 'Site disabled', code: 'SITE_DISABLED' } };
  }
  return null;
}

/**
 * For API routes that must refuse work while the site is not live.
 * Returns a { status, body } to send, or null when the request may
 * proceed. Fail-open like everything else in this module.
 */
export async function assertSiteOperational(
  db?: Firestore | null,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const state = await getEffectiveSiteState(db);
  if (state.mode === 'live') return null;
  return siteNotOperationalResponse(state);
}

/**
 * Under an effective revocation, only the Founder may proceed (the
 * founder keeps the keys to reinstate). Returns a 503 descriptor when
 * the caller is blocked, null when they may proceed.
 */
export async function assertFounderIfRevoked(
  uid: string,
  db?: Firestore | null,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const state = await getEffectiveSiteState(db);
  if (state.mode !== 'revoked') return null;
  if (isGateBypassed()) return null;
  if (isFounder(uid)) return null;
  return {
    status: 503,
    body: { error: 'Site unavailable', code: 'LICENCE_REVOKED' },
  };
}

export type LicenceAction =
  | 'record'
  | 'serve-notice'
  | 'withdraw-notice'
  | 'record-expiry'
  | 'reinstate';

export interface LicenceTransitionInput {
  licensor?: string;
  licensee?: string;
  agreementRefId?: string;
  agreementRefUrl?: string;
  noticeReason?: string;
  licencePublicNotice?: string;
}

export interface LicenceTransitionResult {
  ok: boolean;
  code?: 'INVALID_LICENCE_TRANSITION';
  licence?: PlatformLicenceDTO;
  effective?: EffectiveSiteState;
}

const AUDIT_ACTION_BY_TRANSITION: Record<LicenceAction, string> = {
  record: 'platform_licence.recorded',
  'serve-notice': 'platform_licence.notice_served',
  'withdraw-notice': 'platform_licence.notice_withdrawn',
  'record-expiry': 'platform_licence.expired',
  reinstate: 'platform_licence.reinstated',
};

/**
 * Apply one licence transition: doc write + history append + audit
 * entry in ONE batch. No action ever writes stored status 'revoked'
 * directly: revocation takes effect when the resolver sees
 * notice_served past its effective time (spec 3.2).
 */
export async function applyLicenceTransition(
  db: Firestore,
  actorUid: string,
  action: LicenceAction,
  input: LicenceTransitionInput,
  nowMs: number = Date.now(),
): Promise<LicenceTransitionResult> {
  const raw = await readPlatformLicenceRaw(db);
  const current = toDto(raw);
  const fromStatus: LicenceStatus = raw ? current.status : 'none_recorded';
  const ts = (ms: number) => admin.firestore.Timestamp.fromMillis(ms);
  const nowTs = ts(nowMs);

  let updates: Record<string, unknown> | null = null;
  let toStatus: LicenceStatus = fromStatus;
  let historyReason = '';

  switch (action) {
    case 'record': {
      if (fromStatus === 'notice_served' || fromStatus === 'revoked') {
        return { ok: false, code: 'INVALID_LICENCE_TRANSITION' };
      }
      updates = {
        licensor: input.licensor ?? current.licensor,
        licensee: input.licensee ?? current.licensee,
        agreementRefId: input.agreementRefId ?? current.agreementRefId,
        agreementRefUrl: input.agreementRefUrl ?? current.agreementRefUrl,
        status: 'active',
        recordedBy: actorUid,
        updatedAt: nowTs,
      };
      toStatus = 'active';
      historyReason = 'Licence recorded';
      break;
    }
    case 'serve-notice': {
      if (fromStatus !== 'active') {
        return { ok: false, code: 'INVALID_LICENCE_TRANSITION' };
      }
      const effectiveMs = nowMs + NOTICE_PERIOD_MS;
      updates = {
        status: 'notice_served',
        noticeServedAt: nowTs,
        noticeServedBy: actorUid,
        noticeReason: input.noticeReason ?? '',
        licencePublicNotice: input.licencePublicNotice ?? '',
        effectiveRevocationAt: ts(effectiveMs),
        updatedAt: nowTs,
      };
      toStatus = 'notice_served';
      historyReason = input.noticeReason ?? '';
      break;
    }
    case 'withdraw-notice': {
      if (fromStatus !== 'notice_served') {
        return { ok: false, code: 'INVALID_LICENCE_TRANSITION' };
      }
      const effMs = timestampToMillis(raw?.effectiveRevocationAt);
      if (effMs !== null && effMs <= nowMs) {
        // The revocation has already taken effect; withdrawing now
        // would rewrite history. Reinstate is the honest path.
        return { ok: false, code: 'INVALID_LICENCE_TRANSITION' };
      }
      updates = {
        status: 'active',
        noticeServedAt: null,
        noticeServedBy: '',
        noticeReason: '',
        licencePublicNotice: '',
        effectiveRevocationAt: null,
        updatedAt: nowTs,
      };
      toStatus = 'active';
      historyReason = 'Notice withdrawn before its effective date';
      break;
    }
    case 'record-expiry': {
      if (fromStatus !== 'active') {
        return { ok: false, code: 'INVALID_LICENCE_TRANSITION' };
      }
      updates = { status: 'expired', updatedAt: nowTs };
      toStatus = 'expired';
      historyReason = 'Licence expiry recorded';
      break;
    }
    case 'reinstate': {
      const effMs = timestampToMillis(raw?.effectiveRevocationAt);
      const effectivelyRevoked =
        fromStatus === 'revoked' ||
        (fromStatus === 'notice_served' && effMs !== null && effMs <= nowMs);
      if (!effectivelyRevoked && fromStatus !== 'expired') {
        return { ok: false, code: 'INVALID_LICENCE_TRANSITION' };
      }
      updates = {
        status: 'active',
        noticeServedAt: null,
        noticeServedBy: '',
        noticeReason: '',
        licencePublicNotice: '',
        effectiveRevocationAt: null,
        updatedAt: nowTs,
      };
      toStatus = 'active';
      historyReason = 'Licence reinstated';
      break;
    }
  }

  if (!updates) return { ok: false, code: 'INVALID_LICENCE_TRANSITION' };

  const ref = licenceRef(db);
  const batch = db.batch();
  batch.set(ref, updates, { merge: true });
  const historyRef = ref.collection(LICENCE_HISTORY_SUBCOLLECTION).doc();
  batch.set(historyRef, {
    fromStatus: raw ? fromStatus : null,
    toStatus,
    by: actorUid,
    at: nowTs,
    reason: historyReason,
    agreementRefId:
      (updates.agreementRefId as string | undefined) ?? current.agreementRefId,
  });
  const auditRef = db.collection(AUDIT_LOGS_COLLECTION).doc();
  batch.set(auditRef, {
    action: AUDIT_ACTION_BY_TRANSITION[action],
    actorUid,
    targetUidOrResource: `${GOVERNANCE_COLLECTION}/${PLATFORM_LICENCE_DOC_ID}`,
    payload: {
      fromStatus: raw ? fromStatus : null,
      toStatus,
      reason: historyReason,
    },
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();

  const after = await readPlatformLicence(db);
  const effective = await getEffectiveSiteState(db);
  return { ok: true, licence: after, effective };
}

/** Latest history entries for the admin panel (newest first). */
export async function listLicenceHistory(
  db: Firestore,
  limitN: number = 50,
): Promise<Array<Record<string, unknown>>> {
  try {
    const snap = await licenceRef(db)
      .collection(LICENCE_HISTORY_SUBCOLLECTION)
      .get();
    const entries = snap.docs.map((d) => {
      const data = (d.data() ?? {}) as Record<string, unknown>;
      const atMs = timestampToMillis(data.at);
      return {
        id: d.id,
        fromStatus:
          typeof data.fromStatus === 'string' ? data.fromStatus : null,
        toStatus: typeof data.toStatus === 'string' ? data.toStatus : null,
        by: typeof data.by === 'string' ? data.by : '',
        at: atMs !== null ? new Date(atMs).toISOString() : null,
        atMs: atMs ?? 0,
        reason: typeof data.reason === 'string' ? data.reason : '',
        agreementRefId:
          typeof data.agreementRefId === 'string' ? data.agreementRefId : '',
      };
    });
    entries.sort((a, b) => b.atMs - a.atMs);
    return entries
      .slice(0, limitN)
      .map(({ atMs: _atMs, ...rest }) => rest as Record<string, unknown>);
  } catch {
    return [];
  }
}
