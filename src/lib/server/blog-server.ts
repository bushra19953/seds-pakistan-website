// Server-side blog fetching — queries Firestore directly via Firebase Admin.
// Used by the blog slug page (generateMetadata + page component) to avoid
// HTTP self-fetch, which breaks on Vercel (VERCEL_URL lacks protocol,
// Deployment Protection returns 401 for server-to-self requests).
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { EmorationalBlogPost } from '@/lib/blog-types';

function toBlogPost(id: string, data: FirebaseFirestore.DocumentData): EmorationalBlogPost {
  // Serialize Firestore Timestamps to ISO strings for client hydration
  // (raw Timestamps are not serializable and cause hydration crashes)
  const serializeDate = (v: any): string | null => {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
    return null;
  };

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

    const serializeDate = (v: any): string | null => {
      if (!v) return null;
      if (typeof v.toDate === 'function') return v.toDate().toISOString();
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'string') return v;
      if (typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
      return null;
    };

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

export async function getBlogBySlug(slug: string): Promise<EmorationalBlogPost | null> {
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
