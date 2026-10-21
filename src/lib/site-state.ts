/**
 * Pure effective-site-state resolver (Workstream H, spec section 1.3 / 4.1).
 *
 * No Firebase imports: this runs identically in unit tests, server routes,
 * and anywhere else. FAIL-SAFE PRINCIPLE: the site is ENABLED unless an
 * affirmative, well-formed record says otherwise. Absent settings, absent
 * licence, malformed licence (unknown status, unparseable timestamps),
 * all resolve to mode 'live'. 'expired' and 'notice_served' before its
 * effective time NEVER block. Only an effective 'revoked' blocks.
 */

import type {
  EffectiveSiteState,
  LicenceStatus,
  SiteStateMode,
} from '@/types/platform-licence';
import { LICENCE_STATUSES } from '@/types/platform-licence';

export type { EffectiveSiteState, SiteStateMode };

/** Minimal settings shape the resolver reads (defensively typed). */
export interface SiteStateSettingsInput {
  siteEnabled?: unknown;
  maintenanceMode?: unknown;
}

/** Minimal licence shape the resolver reads (defensively typed). */
export interface SiteStateLicenceInput {
  status?: unknown;
  effectiveRevocationAt?: unknown;
  licencePublicNotice?: unknown;
  [key: string]: unknown;
}

type LicenceLike = SiteStateLicenceInput | null | undefined;
type SettingsLike = SiteStateSettingsInput | null | undefined;
type NowLike = Date | number | string | null | undefined;

/**
 * Normalise a timestamp-ish value to epoch milliseconds.
 * Accepts ms numbers, ISO strings, Dates, and Timestamp-like objects
 * (toMillis(), toDate(), seconds/_seconds + nanoseconds). Returns null
 * for anything unparseable. Never throws.
 */
export function timestampToMillis(value: unknown): number | null {
  try {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    }
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      if (typeof rec.toMillis === 'function') {
        const ms = (rec.toMillis as () => unknown).call(value);
        return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
      }
      if (typeof rec.toDate === 'function') {
        const d = (rec.toDate as () => unknown).call(value);
        if (d instanceof Date) {
          const ms = d.getTime();
          return Number.isFinite(ms) ? ms : null;
        }
        return null;
      }
      const seconds =
        typeof rec.seconds === 'number'
          ? rec.seconds
          : typeof rec._seconds === 'number'
            ? rec._seconds
            : null;
      if (seconds !== null) {
        const nanos =
          typeof rec.nanoseconds === 'number'
            ? rec.nanoseconds
            : typeof rec._nanoseconds === 'number'
              ? rec._nanoseconds
              : 0;
        return seconds * 1000 + Math.floor(nanos / 1_000_000);
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveNow(now: NowLike): number {
  const ms = timestampToMillis(now instanceof Date || typeof now === 'number' || typeof now === 'string' ? now : null);
  return ms !== null ? ms : Date.now();
}

/**
 * Compute the effective site state.
 *
 * Precedence: effective revoked > siteEnabled === false ('disabled')
 * > maintenanceMode === true ('maintenance') > 'live'.
 *
 * A licence with an unknown status string, or a notice_served licence
 * whose effectiveRevocationAt is missing/unparseable, is treated as
 * none_recorded (never blocks, no notice flagged). Never throws.
 */
export function computeEffectiveSiteState(
  settings: SettingsLike,
  licence: LicenceLike,
  now?: NowLike,
): EffectiveSiteState {
  try {
    const nowMs = resolveNow(now);

    let licenceRevoked = false;
    let noticeRunning = false;
    let noticeEffectiveAt: string | null = null;
    let publicNotice: string | undefined;

    if (licence && typeof licence === 'object') {
      const rawStatus = licence.status;
      const status: LicenceStatus | null =
        typeof rawStatus === 'string' &&
        (LICENCE_STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as LicenceStatus)
          : null;

      if (status === 'revoked') {
        licenceRevoked = true;
      } else if (status === 'notice_served') {
        const effMs = timestampToMillis(licence.effectiveRevocationAt);
        if (effMs !== null) {
          if (effMs <= nowMs) {
            licenceRevoked = true;
          } else {
            noticeRunning = true;
            noticeEffectiveAt = new Date(effMs).toISOString();
          }
        }
        // effMs === null: malformed notice record -> treated as
        // none_recorded (fail-open, never blocks, no notice flagged).
      }
      // 'none_recorded' | 'active' | 'expired' | unknown: never block.

      if (licenceRevoked && typeof licence.licencePublicNotice === 'string') {
        publicNotice = licence.licencePublicNotice;
      }
    }

    let mode: SiteStateMode = 'live';
    if (licenceRevoked) {
      mode = 'revoked';
    } else if (settings && typeof settings === 'object' && settings.siteEnabled === false) {
      mode = 'disabled';
    } else if (settings && typeof settings === 'object' && settings.maintenanceMode === true) {
      mode = 'maintenance';
    }

    const result: EffectiveSiteState = { mode };
    if (mode === 'revoked' && publicNotice) {
      result.licencePublicNotice = publicNotice;
    }
    if (noticeRunning) {
      result.noticeRunning = true;
      result.noticeEffectiveAt = noticeEffectiveAt;
    }
    return result;
  } catch {
    // The resolver itself must never throw its way into blocking the site.
    return { mode: 'live' };
  }
}
