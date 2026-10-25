/**
 * Blogs -> Supabase seam (Cluster D). Every Supabase touch for the `blogs`
 * collection lives here; routes and blog-server.ts call these helpers and
 * keep their Firestore code paths untouched for the flag-OFF case.
 *
 * Gate: useSupa('blog') && getSupaClient() (SUPA_SURFACES env, default OFF).
 * Flag OFF, client unconfigured, or ANY adapter error => callers fall back
 * to Firestore and behave byte-identically to the pre-migration code.
 *
 * Date shapes: rows in fs_blogs carry ISO strings (the migration kit and
 * the adapter both normalize Timestamps to ISO on write); legacy dumps may
 * carry {_seconds,_nanoseconds}, which the adapter rehydrates to a
 * SupaTimestamp (toDate()/toMillis()). blogDateToDate/blogDateToIso accept
 * every shape the Firestore serializers accepted, plus those two.
 *
 * Writes: Firestore stays primary. mirror* helpers copy a completed
 * Firestore write into Supabase best-effort — they never throw, so a mirror
 * failure can never fail a request that Firestore already served.
 */
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
import type { SupaDoc } from '@/lib/supa';

export const BLOG_SUPA_SURFACE = 'blog';
export const BLOGS_COLLECTION = 'blogs';

export function blogSupaEnabled(): boolean {
  try {
    return useSupa(BLOG_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

/** Any stored blog date shape -> Date (or null). Mirrors the Firestore
 * serializers' acceptance set and adds ISO strings + dumped shapes. */
export function blogDateToDate(v: any): Date | null {
  if (!v) return null;
  if (typeof v.toDate === 'function') {
    try { return v.toDate(); } catch { return null; }
  }
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'number') return new Date(v);
  const seconds = v._seconds ?? v.seconds;
  if (typeof seconds === 'number') {
    const nanos = v._nanoseconds ?? v.nanoseconds ?? 0;
    return new Date(seconds * 1000 + nanos / 1_000_000);
  }
  return null;
}

export function blogDateToIso(v: any): string | null {
  const d = blogDateToDate(v);
  return d ? d.toISOString() : null;
}

/** A SupaDoc as the plain data record the route serializers consume. */
export function supaDocData(doc: SupaDoc): Record<string, any> {
  const { id: _id, ...data } = doc as Record<string, any>;
  return data;
}

export async function supaListBlogs(options?: Parameters<ReturnType<typeof getSupaAdapter>['listDocs']>[1]): Promise<SupaDoc[]> {
  return getSupaAdapter().listDocs(BLOGS_COLLECTION, options);
}

export async function supaGetBlog(id: string): Promise<SupaDoc | null> {
  return getSupaAdapter().getDoc(BLOGS_COLLECTION, id);
}

export async function supaFindBlogBySlug(slug: string): Promise<SupaDoc | null> {
  const rows = await getSupaAdapter().listDocs(BLOGS_COLLECTION, {
    where: [['slug', '==', slug]],
    limit: 1,
  });
  return rows[0] ?? null;
}

/** Best-effort mirror of a Firestore create (setDoc) — never throws. */
export async function mirrorBlogCreate(id: string, data: Record<string, any>): Promise<void> {
  if (!blogSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(BLOGS_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[blog-supa] mirror create failed:', e?.message || e);
  }
}

/** Best-effort mirror of a Firestore update — never throws. A not-found
 * mirror row falls back to a merged setDoc so the mirror converges. */
export async function mirrorBlogUpdate(id: string, data: Record<string, any>): Promise<void> {
  if (!blogSupaEnabled()) return;
  try {
    await getSupaAdapter().updateDoc(BLOGS_COLLECTION, id, data);
  } catch (e: any) {
    if (e?.code === 'not-found') {
      try {
        await getSupaAdapter().setDoc(BLOGS_COLLECTION, id, data, { merge: true });
        return;
      } catch (e2: any) {
        console.error('[blog-supa] mirror update setDoc fallback failed:', e2?.message || e2);
        return;
      }
    }
    console.error('[blog-supa] mirror update failed:', e?.message || e);
  }
}
