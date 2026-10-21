import type { Timestamp } from 'firebase/firestore';

/**
 * Platform licence record types (Workstream H-B).
 *
 * The licence record lives in its own document, governance/platform_licence,
 * NOT in settings/siteWide: settings are world-readable and writable by any
 * canManageSiteSettings holder, while the licence record carries notice
 * metadata and may only be moved by the Founder through the Admin SDK route
 * (src/app/api/admin/platform-licence/route.ts). See spec ws-h.md sections
 * 3.2 and 6.
 */

export type LicenceStatus =
  | 'none_recorded'
  | 'active'
  | 'notice_served'
  | 'revoked'
  | 'expired';

export const LICENCE_STATUSES: readonly LicenceStatus[] = [
  'none_recorded',
  'active',
  'notice_served',
  'revoked',
  'expired',
] as const;

/**
 * Stored licence document (governance/platform_licence). Timestamps are
 * Firestore Timestamps in the stored type. The document DOES NOT EXIST at
 * ship: absence IS the none_recorded state, which never blocks the site.
 */
export interface PlatformLicence {
  licensor: string;
  licensee: string;
  agreementRefId: string;
  agreementRefUrl: string;
  status: LicenceStatus;
  noticeServedAt: Timestamp | null;
  noticeServedBy: string;
  noticeReason: string;
  effectiveRevocationAt: Timestamp | null;
  licencePublicNotice: string;
  recordedBy: string;
  updatedAt: Timestamp;
}

/**
 * Plain serialisable mirror of PlatformLicence for API transport:
 * timestamps become ISO strings (or null).
 */
export interface PlatformLicenceDTO {
  licensor: string;
  licensee: string;
  agreementRefId: string;
  agreementRefUrl: string;
  status: LicenceStatus;
  noticeServedAt: string | null;
  noticeServedBy: string;
  noticeReason: string;
  effectiveRevocationAt: string | null;
  licencePublicNotice: string;
  recordedBy: string;
  updatedAt: string | null;
}

/** The projection returned when no licence document exists. */
export const NO_LICENCE_DTO: PlatformLicenceDTO = {
  licensor: '',
  licensee: '',
  agreementRefId: '',
  agreementRefUrl: '',
  status: 'none_recorded',
  noticeServedAt: null,
  noticeServedBy: '',
  noticeReason: '',
  effectiveRevocationAt: null,
  licencePublicNotice: '',
  recordedBy: '',
  updatedAt: null,
};

/**
 * Append-only history entry (governance/platform_licence/history/{autoId}).
 * History docs are only ever added, never updated or deleted.
 */
export interface LicenceHistoryEntry {
  fromStatus: LicenceStatus | null;
  toStatus: LicenceStatus;
  by: string;
  at: Timestamp;
  reason: string;
  agreementRefId: string;
}

/** Serialisable mirror of LicenceHistoryEntry for API transport. */
export interface LicenceHistoryEntryDTO {
  id?: string;
  fromStatus: LicenceStatus | null;
  toStatus: LicenceStatus;
  by: string;
  at: string | null;
  reason: string;
  agreementRefId: string;
}

/** The four modes the public site can be in. */
export type SiteStateMode = 'live' | 'maintenance' | 'disabled' | 'revoked';

/**
 * Result of the pure resolver (src/lib/site-state.ts). licencePublicNotice
 * is present ONLY when mode is 'revoked'. noticeRunning / noticeEffectiveAt
 * are the admin projection of a served-but-not-yet-effective notice.
 */
export interface EffectiveSiteState {
  mode: SiteStateMode;
  licencePublicNotice?: string;
  noticeRunning?: boolean;
  noticeEffectiveAt?: string | null;
}
