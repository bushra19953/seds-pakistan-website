import type { Firestore, DocumentData, CollectionReference, FirestoreDataConverter, Query } from 'firebase/firestore';
import { collection, query, where, orderBy, limit, Timestamp } from 'firebase/firestore';
import {
  FOUNDER_UID,
  isFounder,
} from './roles';

// Stored audience values. 'public', 'members', and 'officers' are the
// canonical values written after Item 10; 'all' and 'team_leaders' are
// legacy values that stay in the type so stored documents still parse.
// Everywhere a stored value is interpreted it goes through
// normalizeAudience: 'all' means public, 'team_leaders' means officers,
// and a missing or unknown value means public.
export type AnnouncementAudience = 'public' | 'members' | 'officers' | 'all' | 'team_leaders';
export type NormalizedAnnouncementAudience = 'public' | 'members' | 'officers';

export interface AnnouncementDoc {
  id: string;
  title?: string;
  content?: string;
  audience?: AnnouncementAudience | string;
  status?: string;
  isFeatured?: boolean;
  priority?: number;
  ctaText?: string;
  ctaLink?: string;
  ctaExpiredText?: string;
  expiresAt?: any; // Firestore Timestamp or ISO string
  publish_date?: any; // Firestore Timestamp or ISO string or null
  updated_at?: any; // Firestore Timestamp or ISO string
}

export interface AnnouncementViewer {
  signedIn: boolean;
  isOfficer?: boolean;
  role?: string | null;
  uid?: string | null;
}

export const announcementConverter: FirestoreDataConverter<AnnouncementDoc> = {
  toFirestore(data: AnnouncementDoc): DocumentData {
    return {
      title: data.title,
      content: data.content,
      audience: data.audience,
      status: data.status,
      isFeatured: data.isFeatured ?? false,
      priority: data.priority ?? 0,
      ctaText: data.ctaText,
      ctaLink: data.ctaLink,
      ctaExpiredText: data.ctaExpiredText,
      expiresAt: data.expiresAt ?? null,
      publish_date: data.publish_date ?? null,
      updated_at: data.updated_at ?? null,
    };
  },
  fromFirestore(snapshot): AnnouncementDoc {
    const d = snapshot.data();
    return {
      id: snapshot.id,
      title: d.title,
      content: d.content,
      audience: d.audience,
      status: d.status,
      isFeatured: d.isFeatured,
      priority: d.priority ?? 0,
      ctaText: d.ctaText,
      ctaLink: d.ctaLink,
      ctaExpiredText: d.ctaExpiredText,
      expiresAt: d.expiresAt,
      publish_date: d.publish_date ?? null,
      updated_at: d.updated_at,
    };
  },
};

export function announcementsCollection(db: Firestore): CollectionReference<AnnouncementDoc> {
  return collection(db, 'announcements').withConverter(announcementConverter);
}

// ---------------------------------------------------------------------------
// Visibility helpers (Item 10). The logic lives here once so every consumer
// (homepage carousel, public page, notification bell, notifications page,
// featured banner) enforces publish_date and audience identically. The
// Firestore rules delta carries the same predicate at the database layer;
// these helpers are the client correctness layer and defense in depth.
// ---------------------------------------------------------------------------

export function normalizeAudience(a: unknown): NormalizedAnnouncementAudience {
  if (a === 'members') return 'members';
  if (a === 'officers' || a === 'team_leaders') return 'officers';
  // 'public', 'all', undefined, null, and any unknown value are public.
  return 'public';
}

// Safely normalize any Firestore Timestamp, Date, ISO string, or epoch
// number into a JS Date. Mirrors the toDate helpers previously duplicated
// in the carousel and the featured banner.
function announcementDate(value: any): Date | null {
  try {
    if (!value) return null;
    const d = value?.toDate ? value.toDate() : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function toNowMs(now?: Date | number): number {
  if (now === undefined || now === null) return Date.now();
  return now instanceof Date ? now.getTime() : new Date(now).getTime();
}

// True when the announcement is due: publish_date absent, null, or <= now.
export function isAnnouncementDue(a: Pick<AnnouncementDoc, 'publish_date'> | null | undefined, now?: Date | number): boolean {
  if (!a) return true;
  const d = announcementDate(a.publish_date);
  if (!d) return true;
  return d.getTime() <= toNowMs(now);
}

function isAnnouncementExpired(a: AnnouncementDoc, nowMs: number): boolean {
  const d = announcementDate(a.expiresAt);
  return d ? d.getTime() < nowMs : false;
}

// Officer status for announcement reading is the Phase 0 Item 10 set:
// the 19 stored tokens of the Batch 1 rules isOfficer() helper (which
// evaluates currentRole(), the raw stored token), plus the founder UID
// as a separate check. INTEGRATION (step 2 merge): this must stay a
// raw-token set, NOT the Phase 1 catalog predicates - Phase 1 made
// isChapterExecutive rank-driven (chapter_design_chair is R2, which
// would silently widen this set against Item 10's locked exclusion) and
// its normalizer deliberately does not map the invented lead_* /
// national_vp_* tokens (phase1_spec A.3), which would silently shrink
// it. chapter_design_chair and chapter_faculty_advisor are deliberately
// NOT officers here.
const ANNOUNCEMENT_OFFICER_TOKENS: ReadonlySet<string> = new Set([
  'superadmin', 'founder_patron', 'president_national',
  'national_vp_engineering', 'national_vp_operations',
  'national_vp_marketing', 'national_vp_finance',
  'national_vp_membership',
  'chapter_president', 'chapter_vp_technical',
  'chapter_vp_operations', 'chapter_vp_marketing',
  'chapter_treasurer', 'chapter_general_secretary',
]);

export function viewerIsOfficer(viewer: AnnouncementViewer | null | undefined): boolean {
  if (!viewer || !viewer.signedIn) return false;
  if (viewer.isOfficer === true) return true;
  if (viewer.uid && isFounder(viewer.uid)) return true;
  if (viewer.role) {
    return ANNOUNCEMENT_OFFICER_TOKENS.has(String(viewer.role).toLowerCase().trim());
  }
  return false;
}

export function resolveAnnouncementViewer(input: {
  uid?: string | null;
  role?: string | null;
  signedIn?: boolean;
} | null | undefined): AnnouncementViewer {
  const uid = input?.uid ?? null;
  const role = input?.role ?? null;
  const signedIn = input?.signedIn ?? !!uid;
  const viewer: AnnouncementViewer = { signedIn, role, uid };
  viewer.isOfficer = viewerIsOfficer(viewer);
  return viewer;
}

export { FOUNDER_UID };

// The single visibility predicate for non-admin viewers: published, due,
// audience tier passes for the viewer, and not expired.
export function isAnnouncementVisibleTo(
  a: AnnouncementDoc | null | undefined,
  viewer: AnnouncementViewer | null | undefined,
  now?: Date | number,
): boolean {
  if (!a) return false;
  if (a.status !== 'published') return false;
  const nowMs = toNowMs(now);
  if (!isAnnouncementDue(a, nowMs)) return false;
  const tier = normalizeAudience(a.audience);
  if (tier === 'members' && !viewer?.signedIn) return false;
  if (tier === 'officers' && !viewerIsOfficer(viewer)) return false;
  if (isAnnouncementExpired(a, nowMs)) return false;
  return true;
}

// The stored audience values a viewer may enumerate, per tier. Public tier
// covers both the canonical 'public' and legacy 'all'; the officers tier
// covers canonical 'officers' and legacy 'team_leaders'.
export function announcementAudienceValuesForViewer(viewer: AnnouncementViewer | null | undefined): string[] {
  const values: string[] = ['public', 'all'];
  if (viewer?.signedIn) values.push('members');
  if (viewerIsOfficer(viewer)) values.push('officers', 'team_leaders');
  return values;
}

export interface VisibleAnnouncementQueryOptions {
  isFeatured?: boolean;
  limitCount?: number;
}

// Split queries a consumer must run for the viewer's tiers. Firestore list
// rules deny a whole query that could return a document the caller may not
// read, so a single status == published query is not provable under the
// Item 10 rules. For each audience value in the viewer's tier set this
// emits one due query (publish_date <= now); consumers merge the results
// and dedupe by id.
// A document with no publish_date field or no audience field matches no
// query here by design; both writers always write both fields explicitly,
// and the admin writer stores Timestamp.now() when no date is picked
// ("publish immediately"), never null. The former publish_date == null
// split query was removed 2026-10-22: Firestore cannot prove a list query
// with an equality-on-null filter against the visibility rule, so that
// split returned PERMISSION_DENIED and, via Promise.all, took down every
// consumer (homepage carousel, announcements page, banner) even though
// every published doc carried a real date.
export function visibleAnnouncementQueries(
  ref: CollectionReference<AnnouncementDoc>,
  viewer: AnnouncementViewer | null | undefined,
  now?: Date | number,
  options: VisibleAnnouncementQueryOptions = {},
): Query<AnnouncementDoc>[] {
  const nowDate = new Date(toNowMs(now));
  const queries: Query<AnnouncementDoc>[] = [];
  for (const value of announcementAudienceValuesForViewer(viewer)) {
    const constraints: any[] = [
      where('status', '==', 'published'),
      where('audience', '==', value),
      where('publish_date', '<=', Timestamp.fromDate(nowDate)),
      orderBy('updated_at', 'desc'),
    ];
    if (options.isFeatured) constraints.push(where('isFeatured', '==', true));
    if (options.limitCount) constraints.push(limit(options.limitCount));
    queries.push(query(ref, ...constraints));
  }
  return queries;
}
