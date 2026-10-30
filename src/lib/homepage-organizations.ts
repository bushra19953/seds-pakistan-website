/**
 * Shared homepage organizations fetch (read-bleed fix train 2,
 * census 01 item 2).
 *
 * The induction hero orbit and the credibility marquee used to each
 * run an unbounded Firestore getDocs over the organizations collection
 * on every homepage load — and the marquee ALSO fetched
 * /api/organizations?showOnHomepage=true just to use its ids as a
 * gate, paying for both reads. Both components now consume this one
 * fetch of the gated API response instead: the route is seam-first
 * server-side (fs_organizations when the surface is on, the Firestore
 * read otherwise), applies the isActive + showOnHomepageMarquee
 * filter and the related-party logo gate (CH-20) itself, and returns
 * the organizations sorted by displayOrder.
 *
 * The fetch is shared through a module-level memo with the same
 * 5-minute TTL as the announcements memo (ANNOUNCEMENT_FETCH_MEMO_TTL_MS),
 * so components that co-mount on the homepage pay a single request
 * per TTL window. A rejected fetch evicts itself so the next caller
 * retries instead of serving a cached failure for the whole window.
 * Field normalization mirrors the marquee's former Firestore mapper
 * default-for-default, so consumers render identical content.
 */

export interface HomepageOrganization {
  id: string;
  name: string;
  logoUrl: string;
  websiteUrl: string;
  type: 'National Chapter' | 'International Chapter' | 'Institutional Partner' | 'Sponsor' | 'University';
  showOnHomepageMarquee: boolean;
  displayOrder: number;
  isActive: boolean;
  isGlobal: boolean;
  description?: string;
}

export const HOMEPAGE_ORGANIZATIONS_TTL_MS = 5 * 60 * 1000;

let homepageOrganizationsCache: {
  fetchedAt: number;
  promise: Promise<HomepageOrganization[]>;
} | null = null;

function normalizeHomepageOrganization(raw: any): HomepageOrganization {
  return {
    id: raw.id,
    name: raw.name || '',
    logoUrl: raw.logoUrl || '',
    websiteUrl: raw.websiteUrl || '',
    type: raw.type || 'Institutional Partner',
    showOnHomepageMarquee: raw.showOnHomepageMarquee || false,
    displayOrder: raw.displayOrder || 0,
    isActive: raw.isActive !== undefined ? raw.isActive : true,
    isGlobal: raw.isGlobal !== undefined ? raw.isGlobal : true,
    description: raw.description || '',
  };
}

async function fetchHomepageOrganizationsFromApi(): Promise<HomepageOrganization[]> {
  const res = await fetch('/api/organizations?showOnHomepage=true');
  if (!res.ok) {
    throw new Error('Failed to load organizations');
  }
  const data = await res.json();
  const rows: any[] = Array.isArray(data?.organizations) ? data.organizations : [];
  return rows.map(normalizeHomepageOrganization);
}

/** Drop the memoized fetch (e.g. after an organization mutation). */
export function invalidateHomepageOrganizationsCache(): void {
  homepageOrganizationsCache = null;
}

export function fetchHomepageOrganizations(): Promise<HomepageOrganization[]> {
  const nowMs = Date.now();
  if (
    homepageOrganizationsCache &&
    nowMs - homepageOrganizationsCache.fetchedAt < HOMEPAGE_ORGANIZATIONS_TTL_MS
  ) {
    return homepageOrganizationsCache.promise;
  }
  const promise = fetchHomepageOrganizationsFromApi();
  // A failed fetch must not poison the window: evict this entry so
  // the next caller retries. Never rethrows, so it cannot surface as
  // an unhandled rejection.
  promise.catch(() => {
    if (homepageOrganizationsCache?.promise === promise) {
      homepageOrganizationsCache = null;
    }
  });
  homepageOrganizationsCache = { fetchedAt: nowMs, promise };
  return promise;
}
