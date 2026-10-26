// Server-side blog fetching — queries Firestore directly via Firebase Admin.
// Used by the blog slug page (generateMetadata + page component) to avoid
// HTTP self-fetch, which breaks on Vercel (VERCEL_URL lacks protocol,
// Deployment Protection returns 401 for server-to-self requests).
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { EmorationalBlogPost } from '@/lib/blog-types';
import { serializeBlogDate } from '@/lib/blog-data-utils';
import {
  blogSupaEnabled,
  mirrorBlogCreate,
  mirrorBlogUpdate,
  setBlogPrimaryFirst,
  updateBlogPrimaryFirst,
  supaDocData,
  supaFindBlogBySlug,
  supaGetBlog,
  supaListBlogs,
} from '@/lib/server/blog-supa';

function toBlogPost(id: string, data: FirebaseFirestore.DocumentData): EmorationalBlogPost {
  // Serialize Firestore Timestamps to ISO strings for client hydration
  // (raw Timestamps are not serializable and cause hydration crashes).
  // serializeBlogDate also accepts the Supabase shapes (ISO strings,
  // {_seconds,_nanoseconds} dumps, SupaTimestamps) so this serializer is
  // backend-agnostic.
  const serializeDate = serializeBlogDate;

  return {
    id,
    title: data.title || 'Untitled',
    body: data.content || data.body || '',
    authorUid: data.authorId || data.authorUid || '',
    authorName: data.authorName || 'Anonymous',
    published: data.published ?? data.status === 'published',
    createdAt: serializeDate(data.createdAt),
    updatedAt: serializeDate(data.updatedAt),
    publishedAt: serializeDate(data.publishedAt),
    tags: data.tags || [],
    thumbnailUrl: data.thumbnailUrl || null,
    summary: data.summary || '',
    slug: data.slug || id,
    metaTitle: data.metaTitle || '',
    metaDescription: data.metaDescription || '',
    keywords: data.keywords || '',
    status: data.status || 'draft',
    categoryId: data.categoryId || '',
    authorProfile: data.authorProfile || null,
    // Rich immersive payloads (may be JSON strings or objects)
    launchReadiness: data.launchReadiness,
    dataShowcase: data.dataShowcase,
    analogArchive: data.analogArchive,
    futureHorizons: data.futureHorizons,
  } as unknown as EmorationalBlogPost;
}

// Public visibility rule (Issue 11): the slug page is unauthenticated, so
// only a published, non-deleted post may be served. Drafts, pending-review,
// archived and soft-deleted posts resolve to null (the page then 404s),
// mirroring the guard on GET /api/blogs/[slug]. There is no caller identity
// on this path, so there is no privileged preview exception here.
function isPublicBlogPost(data: FirebaseFirestore.DocumentData): boolean {
  return data.status === 'published' && data.deleted !== true;
}

export interface RelatedBlogItem {
  id: string;
  title: string;
  slug: string;
  thumbnailUrl?: string | null;
  publishedAt?: string | null;
}

// Related posts for the canonical post page: same computation the slug
// API route performs (GET /api/blogs/[slug]) — same category, published,
// newest first, up to 4, excluding the post itself and soft-deleted
// docs, with the same unfiltered-scan fallback when the composite
// query fails. Dates are serialized to ISO strings like toBlogPost so
// the items can cross the server-to-client boundary.
export async function getRelatedBlogs(blog: EmorationalBlogPost): Promise<RelatedBlogItem[]> {
  // Supabase path (flag ON): same semantics — published, same category,
  // publishedAt desc, up to 4, excluding self + soft-deleted. Any adapter
  // error falls through to the Firestore path below.
  if (blogSupaEnabled()) {
    try {
      const cat = blog.categoryId || null;
      const rows = await supaListBlogs({
        where: cat
          ? [['status', '==', 'published'], ['categoryId', '==', cat]]
          : [['status', '==', 'published']],
        orderBy: { field: 'publishedAt', direction: 'desc' },
        limit: 8,
      });
      const related: RelatedBlogItem[] = [];
      for (const row of rows) {
        if (related.length >= 4) break;
        if (row.id === blog.id) continue;
        const rd = supaDocData(row);
        if (rd.deleted) continue;
        related.push({
          id: row.id,
          title: rd.title || 'Untitled',
          slug: rd.slug || '',
          thumbnailUrl: rd.thumbnailUrl || null,
          publishedAt: serializeBlogDate(rd.publishedAt),
        });
      }
      if (related.length > 0) return related;
      // HOTFIX (fix/supa-read-fallback): an empty Supabase result
      // here is the same silent where-clause failure as the list
      // route — fall through to the Firestore computation below.
      console.warn('[getRelatedBlogs] Supabase returned no related posts; falling back to Firestore');
    } catch (e: any) {
      console.error('[getRelatedBlogs] Supabase read failed, falling back to Firestore:', e?.message || e);
    }
  }
  try {
    if (!ensureAdminInitialized()) {
      console.error('[getRelatedBlogs] Firebase Admin not initialized');
      return [];
    }
    const db = getDb();
    if (!db) {
      console.error('[getRelatedBlogs] Firestore DB not available');
      return [];
    }

    const serializeDate = serializeBlogDate;

    const toItem = (id: string, data: FirebaseFirestore.DocumentData): RelatedBlogItem => ({
      id,
      title: data.title || 'Untitled',
      slug: data.slug || '',
      thumbnailUrl: data.thumbnailUrl || null,
      publishedAt: serializeDate(data.publishedAt),
    });

    const related: RelatedBlogItem[] = [];
    const cat = blog.categoryId || null;
    try {
      let rq = db.collection('blogs').where('status', '==', 'published');
      if (cat) rq = rq.where('categoryId', '==', cat);
      rq = rq.orderBy('publishedAt', 'desc').limit(4);
      const rSnap = await rq.get();
      rSnap.forEach((d) => {
        if (d.id === blog.id) return;
        const rd = d.data() as any;
        if (rd.deleted) return;
        related.push(toItem(d.id, rd));
      });
    } catch (e: any) {
      const fq = db.collection('blogs').orderBy('publishedAt', 'desc').limit(8);
      const rSnap = await fq.get();
      rSnap.forEach((d) => {
        const rd = d.data() as any;
        const matchesCat = !cat || rd.categoryId === cat;
        if (d.id === blog.id || !matchesCat || rd.status !== 'published' || rd.deleted) return;
        related.push(toItem(d.id, rd));
      });
    }

    return related;
  } catch (error) {
    console.error('[getRelatedBlogs] error:', error);
    return [];
  }
}

/**
 * Shared write helper for the blogs collection: Firestore is the primary
 * write; when the blog Supabase surface is ON the write is mirrored into
 * fs_blogs (best-effort, never throws). Returns the Firestore doc id.
 */
export async function createBlogPost(data: Record<string, any>): Promise<string | null> {
  if (!ensureAdminInitialized()) return null;
  const db = getDb();
  if (!db) return null;
  // WRITE PRIMACY (cutover W4): under isSupaPrimary('blog') the adapter
  // write lands FIRST (id pre-generated) and throws on failure; the
  // Firestore set then runs as the best-effort post-commit mirror.
  // OFF: the original .add() flow runs byte-identically.
  const candidateRef = db.collection('blogs').doc();
  if (await setBlogPrimaryFirst(candidateRef.id, data)) {
    try {
      await candidateRef.set(data);
    } catch (e) {
      console.warn('[blog-server] Firestore mirror after primary create failed:', e);
    }
    return candidateRef.id;
  }
  const ref = await db.collection('blogs').add(data);
  await mirrorBlogCreate(ref.id, data);
  return ref.id;
}

export async function updateBlogPost(id: string, data: Record<string, any>): Promise<boolean> {
  if (!ensureAdminInitialized()) return false;
  const db = getDb();
  if (!db) return false;
  if (await updateBlogPrimaryFirst(id, data)) {
    try {
      await db.collection('blogs').doc(id).update(data);
    } catch (e) {
      console.warn('[blog-server] Firestore mirror after primary update failed:', e);
    }
    return true;
  }
  await db.collection('blogs').doc(id).update(data);
  await mirrorBlogUpdate(id, data);
  return true;
}

export async function getBlogBySlug(slug: string): Promise<EmorationalBlogPost | null> {
  // Supabase path (flag ON): slug query -> doc-id fallback, same public
  // guard. Any adapter error falls through to the Firestore path below.
  if (blogSupaEnabled()) {
    try {
      const bySlug = await supaFindBlogBySlug(slug);
      if (bySlug) {
        const data = supaDocData(bySlug);
        return isPublicBlogPost(data as any) ? toBlogPost(bySlug.id, data) : null;
      }
      const byId = await supaGetBlog(slug);
      if (byId) {
        const data = supaDocData(byId);
        return isPublicBlogPost(data as any) ? toBlogPost(byId.id, data) : null;
      }
      // HOTFIX (fix/supa-read-fallback): a Supabase miss is not proof
      // the post does not exist — the adapter's slug where clause
      // silently matches nothing in production. Fall through to the
      // Firestore path below instead of returning null.
      console.warn('[getBlogBySlug] Supabase found no post; falling back to Firestore:', slug);
    } catch (e: any) {
      console.error('[getBlogBySlug] Supabase read failed, falling back to Firestore:', e?.message || e);
    }
  }
  try {
    if (!ensureAdminInitialized()) {
      console.error('[getBlogBySlug] Firebase Admin not initialized');
      return null;
    }
    const db = getDb();
    if (!db) {
      console.error('[getBlogBySlug] Firestore DB not available');
      return null;
    }

    // Try slug query first
    let snapshot: FirebaseFirestore.QuerySnapshot | null = null;
    try {
      snapshot = await db.collection('blogs').where('slug', '==', slug).limit(1).get();
    } catch (e: any) {
      // Missing composite index — fall through to doc-ID lookup
      console.warn('[getBlogBySlug] slug query failed, trying doc ID:', e?.message?.slice(0, 120));
    }

    if (snapshot && !snapshot.empty) {
      const doc = snapshot.docs[0];
      const data = doc.data();
      return isPublicBlogPost(data) ? toBlogPost(doc.id, data) : null;
    }

    // Fallback: try document ID directly
    const docRef = db.collection('blogs').doc(slug);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      const data = docSnap.data() || {};
      return isPublicBlogPost(data) ? toBlogPost(docSnap.id, data) : null;
    }

    return null;
  } catch (error) {
    console.error('[getBlogBySlug] error:', error);
    return null;
  }
}
