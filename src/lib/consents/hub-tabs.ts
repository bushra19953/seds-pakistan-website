// Tab logic for the combined Consents hub (/admin/consents).
//
// The hub replaces the four separate consent nav surfaces (My Requests,
// New, Founder Inbox, Register) with one page and three tabs. The server
// APIs keep their own gates (inbox is Founder-only, the register is
// Founder / National General Secretary only); these helpers only decide
// which tab triggers the hub shows and which tab a ?tab= deep link
// selects, so an ineligible tab is hidden rather than landing the user
// on a forbidden page. A tab named explicitly in the URL is always
// rendered (the panel itself shows the API's refusal), so redirects and
// deep links can never strand a user the client mis-identified.

import { LEGACY_TO_CATALOG } from '@/lib/role-catalog';

export type ConsentHubTab = 'my' | 'awaiting' | 'register';

export const CONSENT_HUB_TABS: readonly ConsentHubTab[] = ['my', 'awaiting', 'register'];

export const DEFAULT_CONSENT_HUB_TAB: ConsentHubTab = 'my';

/** Resolve a raw ?tab= value to a hub tab; anything unknown is My Requests. */
export function resolveConsentHubTab(raw: string | null | undefined): ConsentHubTab {
  return (CONSENT_HUB_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as ConsentHubTab)
    : DEFAULT_CONSENT_HUB_TAB;
}

/**
 * Map a client-side role string (legacy token or catalog key) to the
 * catalog role key, mirroring LEGACY_TO_CATALOG. Unknown values pass
 * through unchanged; null stays null.
 */
export function toCatalogRoleKey(role: string | null | undefined): string | null {
  if (!role) return null;
  return LEGACY_TO_CATALOG[role] ?? role;
}

export interface ConsentHubViewer {
  isFounder: boolean;
  /** Catalog role key of the viewer, e.g. 'national_general_secretary'. */
  catalogRoleKey: string | null;
}

/**
 * Tabs the viewer should see as triggers:
 * - My Requests: everyone who can reach the hub.
 * - Awaiting Decision: the Founder only (the only Consent decider).
 * - Register: the Founder and the National General Secretary.
 */
export function visibleConsentHubTabs(viewer: ConsentHubViewer): ConsentHubTab[] {
  const tabs: ConsentHubTab[] = ['my'];
  if (viewer.isFounder) tabs.push('awaiting');
  if (viewer.isFounder || viewer.catalogRoleKey === 'national_general_secretary') {
    tabs.push('register');
  }
  return tabs;
}
