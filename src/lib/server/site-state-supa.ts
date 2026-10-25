/**
 * Site-state -> Supabase seam (migration step 6, Cluster E).
 *
 * The effective site state is computed from exactly two documents:
 *   settings/siteWide          (the maintenance/disable switches)
 *   governance/platform_licence (the licence record)
 * Both are read by src/lib/server/platform-licence.ts, whose
 * getEffectiveSiteState() is the one server entry point; this seam is
 * consumed there and nowhere else.
 *
 * Gate: useSupa('site-state') && getSupaClient() (default OFF). Flag
 * OFF, client unconfigured, or ANY adapter error => the caller uses
 * its Firestore reads and behaves byte-identically. FAIL-OPEN is
 * preserved in both modes: platform-licence resolves any failure to
 * { mode: 'live' }, and a seam failure is just another fallback.
 *
 * Writes: the settings/siteWide write side is ALREADY mirrored by the
 * admin-settings cluster (src/lib/server/settings-mirror.ts, surface
 * 'admin-settings'), so this seam adds no second mirror for it. The
 * licence write (applyLicenceTransition in platform-licence.ts) is
 * mirrored here, best-effort, after its Firestore batch commits.
 */
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';

export const SITE_STATE_SUPA_SURFACE = 'site-state';
export const SETTINGS_COLLECTION = 'settings';
export const SITE_WIDE_DOC_ID = 'siteWide';
export const GOVERNANCE_COLLECTION = 'governance';
export const PLATFORM_LICENCE_DOC_ID = 'platform_licence';

export function siteStateSupaEnabled(): boolean {
  try {
    return useSupa(SITE_STATE_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export type SiteStateDocsRead =
  | { status: 'fallback' }
  | {
      status: 'ok';
      /** Raw settings/siteWide body, or {} when the doc is absent
       * (platform-licence treats an absent doc as "live"). */
      switches: { siteEnabled?: unknown; maintenanceMode?: unknown };
      /** Raw governance/platform_licence body, or null when absent. */
      licenceRaw: Record<string, unknown> | null;
    };

export async function readSiteStateDocsViaSupa(): Promise<SiteStateDocsRead> {
  if (!siteStateSupaEnabled()) return { status: 'fallback' };
  try {
    const adapter = getSupaAdapter();
    const [settingsDoc, licenceDoc] = await Promise.all([
      adapter.getDoc(SETTINGS_COLLECTION, SITE_WIDE_DOC_ID),
      adapter.getDoc(GOVERNANCE_COLLECTION, PLATFORM_LICENCE_DOC_ID),
    ]);
    const switches = settingsDoc
      ? {
          siteEnabled: (settingsDoc as Record<string, unknown>).siteEnabled,
          maintenanceMode: (settingsDoc as Record<string, unknown>).maintenanceMode,
        }
      : {};
    let licenceRaw: Record<string, unknown> | null = null;
    if (licenceDoc) {
      const { id: _id, ...rest } = licenceDoc as Record<string, unknown>;
      licenceRaw = rest;
    }
    return { status: 'ok', switches, licenceRaw };
  } catch (err) {
    console.error('[site-state-supa] adapter read failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

/** Best-effort mirror of a licence transition — never throws. The
 * caller passes the same field set it committed to Firestore; the
 * adapter normalizes Timestamp values to ISO on write. */
export async function mirrorPlatformLicence(updates: Record<string, unknown>): Promise<void> {
  if (!siteStateSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(GOVERNANCE_COLLECTION, PLATFORM_LICENCE_DOC_ID, updates, { merge: true });
  } catch (e: any) {
    console.error('[site-state-supa] mirror licence failed:', e?.message || e);
  }
}
