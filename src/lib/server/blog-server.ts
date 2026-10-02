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
      return toBlogPost(doc.id, doc.data());
    }

    // Fallback: try document ID directly
    const docRef = db.collection('blogs').doc(slug);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      return toBlogPost(docSnap.id, docSnap.data() || {});
    }

    return null;
  } catch (error) {
    console.error('[getBlogBySlug] error:', error);
    return null;
  }
}
