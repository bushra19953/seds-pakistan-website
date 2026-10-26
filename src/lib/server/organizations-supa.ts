/**
 * Organizations -> Supabase seam (migration step 6, Cluster E).
 *
 * Every Supabase touch for the `organizations` collection lives here.
 * Consumers:
 *   src/app/api/organizations/route.ts          (GET list, POST create)
 *   src/app/api/organizations/homepage/route.ts (GET homepage sections)
 *
 * Gate: useSupa('organizations') && getSupaClient() (SUPA_SURFACES env,
 * default OFF). Flag OFF, client unconfigured, or ANY adapter error =>
 * callers fall back to Firestore and behave byte-identically to the
 * pre-migration code.
 *
 * Known seam boundary (deliberate): the related-party logo gate
 * (filterPublicOrganizations, CRM/consent clusters) still reads
 * sponsors_partners + consent views from Firestore in BOTH modes. This
 * seam moves only the organizations collection read; the gate is
 * another cluster's surface and is not re-pointed here.
 *
 * Writes: Firestore stays primary. mirrorOrganizationCreate copies a
 * completed Firestore create into Supabase best-effort — it never
 * throws, so a mirror failure can never fail a request Firestore
 * already served. (No server update/delete route for organizations
 * exists in the tree; the admin UI writes client-side, the same
 * client-direct blocker recorded by the chapters seam.)
 */
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
import type { SupaDoc } from '@/lib/supa';
import { publicMiscDateToDate } from './public-misc-supa-shared';

export const ORGANIZATIONS_SUPA_SURFACE = 'organizations';
export const ORGANIZATIONS_COLLECTION = 'organizations';

export function organizationsSupaEnabled(): boolean {
  try {
    return useSupa(ORGANIZATIONS_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export type OrganizationsRead =
  | { status: 'fallback' }
  | { status: 'ok'; docs: SupaDoc[] };

/** All organizations, unfiltered — both routes filter in memory today. */
export async function readOrganizationsViaSupa(): Promise<OrganizationsRead> {
  if (!organizationsSupaEnabled()) return { status: 'fallback' };
  try {
    const docs = await getSupaAdapter().listDocs(ORGANIZATIONS_COLLECTION);
    return { status: 'ok', docs };
  } catch (err) {
    console.error('[organizations-supa] adapter read failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

/**
 * Map a SupaDoc to the exact object shape GET /api/organizations builds
 * from a Firestore doc (defaults included). Dates: Firestore used
 * `data.createdAt?.toDate() || new Date()`; Supa rows carry ISO strings
 * (or rehydrated SupaTimestamps), which publicMiscDateToDate parses —
 * an absent/unparseable value still falls back to `new Date()`.
 */
export function mapSupaOrganizationForList(doc: SupaDoc): Record<string, any> {
  const data = doc as Record<string, any>;
  return {
    id: doc.id,
    name: data.name || '',
    logoUrl: data.logoUrl || '',
    websiteUrl: data.websiteUrl || '',
    type: data.type || 'National Chapter',
    showOnHomepageMarquee: data.showOnHomepageMarquee || false,
    displayOrder: data.displayOrder || 0,
    isActive: data.isActive || false,
    isGlobal: data.isGlobal !== undefined ? data.isGlobal : true,
    partnerId: data.partnerId || null,
    logoUseGranted: data.logoUseGranted === true,
    description: data.description || '',
    createdAt: publicMiscDateToDate(data.createdAt) || new Date(),
    updatedAt: publicMiscDateToDate(data.updatedAt) || new Date(),
  };
}

/**
 * Map a SupaDoc to the shape GET /api/organizations/homepage builds.
 * The Firestore mapper's defaults are preserved verbatim, including
 * `isActive: data?.isActive || true` (which yields true for a stored
 * false — a pre-existing quirk, not translated blindly but kept so the
 * flag-ON response matches the flag-OFF response). Dates pass through
 * raw in the Firestore path (Timestamp objects); Supa rows carry ISO
 * strings / SupaTimestamps, which JSON-serialize to ISO text — the one
 * accepted wire difference on this surface.
 */
export function mapSupaOrganizationForHomepage(doc: SupaDoc): Record<string, any> {
  const data = doc as Record<string, any>;
  return {
    id: doc.id,
    name: data?.name || '',
    logoUrl: data?.logoUrl || '',
    websiteUrl: data?.websiteUrl || '',
    type: data?.type || 'Institutional Partner',
    showOnHomepageMarquee: data?.showOnHomepageMarquee || false,
    displayOrder: data?.displayOrder || 0,
    isActive: data?.isActive || true,
    isGlobal: data?.isGlobal !== undefined ? data.isGlobal : true,
    partnerId: data?.partnerId || null,
    logoUseGranted: data?.logoUseGranted === true,
    createdAt: data?.createdAt,
    updatedAt: data?.updatedAt,
  };
}

/** Best-effort mirror of a Firestore create — never throws. */
export async function mirrorOrganizationCreate(id: string, data: Record<string, any>): Promise<void> {
  if (!organizationsSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(ORGANIZATIONS_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[organizations-supa] mirror create failed:', e?.message || e);
  }
}

/** Best-effort mirror of a Firestore update — never throws. (WS10) */
export async function mirrorOrganizationUpdate(id: string, data: Record<string, any>): Promise<void> {
  if (!organizationsSupaEnabled()) return;
  try {
    await getSupaAdapter().updateDoc(ORGANIZATIONS_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[organizations-supa] mirror update failed:', e?.message || e);
  }
}

/** Best-effort mirror of a Firestore delete — never throws. (WS10) */
export async function mirrorOrganizationDelete(id: string): Promise<void> {
  if (!organizationsSupaEnabled()) return;
  try {
    await getSupaAdapter().deleteDoc(ORGANIZATIONS_COLLECTION, id);
  } catch (e: any) {
    console.error('[organizations-supa] mirror delete failed:', e?.message || e);
  }
}
