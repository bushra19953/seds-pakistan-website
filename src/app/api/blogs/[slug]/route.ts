// GET /api/blogs/[slug] - Fetch a single blog post by its unique slug
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { EmorationalBlogPost } from '@/lib/blog-types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> } // NEXT.JS 15 FIX: params is a promise
) {
  try {
    const { slug } = await params; // NEXT.JS 15 FIX: await params


    if (!slug) {
      return NextResponse.json(
        { error: 'Slug is required' },
        { status: 400 }
      );
    }

    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      return NextResponse.json(
        { error: 'Server misconfiguration: Firebase Admin not initialized' },
        { status: 500 }
      );
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'Database not initialized' },
        { status: 500 }
      );
    }

    const blogsQuery = db.collection('blogs')
      .where('slug', '==', slug)
      .limit(1);

    let querySnapshot;
    try {
      querySnapshot = await blogsQuery.get();
    } catch (e: any) {
      if (e.message && e.message.includes('FAILED_PRECONDITION')) {
        console.error('\n\n======================================================');
        console.error('🔥 CRITICAL FIRESTORE INDEX MISSING 🔥');
        console.error('The blog query requires a composite index to run efficiently.');
        console.error('If you do not create this index, load times will spike to 30+ seconds due to full collection scans.');
        console.error('\nACTION REQUIRED: CLICK THE LINK BELOW TO BUILD THE INDEX:');
        console.error(`=> ${e.message.split('https://')[1] ? 'https://' + e.message.split('https://')[1].trim() : e.message}`);
        console.error('======================================================\n\n');
      }
      querySnapshot = { empty: true, docs: [] } as any;
    }

    if (querySnapshot.empty) {
      // If not found by slug, try by document ID
      const documentRef = db.collection('blogs').doc(slug);
      const documentSnap = await documentRef.get();

      if (!documentSnap.exists) {
        return NextResponse.json(
          { error: 'Blog post not found' },
          { status: 404 }
        );
      }

      const data = documentSnap.data() || {};
      const blogPost: EmorationalBlogPost = {
        id: documentSnap.id,
        title: data.title || 'Untitled',
        body: data.content || '',
        authorUid: data.authorId || '',
        authorName: data.authorName || 'Unknown Author',
        published: data.status === 'published',
        createdAt: data.createdAt?.toDate?.() || new Date(),
        updatedAt: data.updatedAt?.toDate?.() || new Date(),
        publishedAt: data.publishedAt?.toDate?.(),
        tags: data.tags || [],
        thumbnailUrl: data.thumbnailUrl,
        summary: data.summary || '',
        slug: data.slug || '',
        metaTitle: data.metaTitle || '',
        metaDescription: data.metaDescription || '',
        keywords: data.keywords || '',
        newsArticleUrl: data.newsArticleUrl,
        status: data.status || 'draft',
        categoryId: data.categoryId || '',
        launchReadiness: (data.launchReadiness || data.launch_readiness) || undefined,
        dataShowcase: (data.dataShowcase || data.data_showcase) || undefined,
        authorProfile: (data.authorProfile || data.author_profile) || undefined,
        analogArchive: (data.analogArchive || data.analog_archive) || undefined,
        futureHorizons: (data.futureHorizons || data.future_horizons) || undefined,
      } as EmorationalBlogPost;

      const related: Array<{ id: string; title: string; slug: string; thumbnailUrl?: string | null; publishedAt?: Date | null }> = [];
      const cat = blogPost.categoryId || null;
      try {
        let rq = db.collection('blogs').where('status', '==', 'published');
        if (cat) rq = rq.where('categoryId', '==', cat);
        rq = rq.orderBy('publishedAt', 'desc').limit(4);
        const rSnap = await rq.get();
        rSnap.forEach((d) => {
          if (d.id === blogPost.id) return;
          const rd = d.data() as any;
          related.push({
            id: d.id,
            title: rd.title || 'Untitled',
            slug: rd.slug || '',
            thumbnailUrl: rd.thumbnailUrl || null,
            publishedAt: rd.publishedAt?.toDate?.() || null
          });
        });
      } catch (e: any) {
        const fq = db.collection('blogs').orderBy('publishedAt', 'desc').limit(8);
        const rSnap = await fq.get();
        rSnap.forEach((d) => {
          const rd = d.data() as any;
          const matchesCat = !cat || rd.categoryId === cat;
          if (d.id === blogPost.id || !matchesCat) return;
          related.push({
            id: d.id,
            title: rd.title || 'Untitled',
            slug: rd.slug || '',
            thumbnailUrl: rd.thumbnailUrl || null,
            publishedAt: rd.publishedAt?.toDate?.() || null
          });
        });
      }

      return NextResponse.json(
        {
          blog: blogPost,
          related
        },
        {
          headers: {
            'Cache-Control': 's-maxage=600, stale-while-revalidate=86400'
          }
        }
      );
    }

    const blogDoc = querySnapshot.docs[0];
    const data = blogDoc.data() || {};
    const blogPost: EmorationalBlogPost = {
      id: blogDoc.id,
      title: data.title || 'Untitled',
      body: data.content || '',
      authorUid: data.authorId || '',
      authorName: data.authorName || 'Unknown Author',
      published: data.status === 'published',
      createdAt: data.createdAt?.toDate?.() || new Date(),
      updatedAt: data.updatedAt?.toDate?.() || new Date(),
      publishedAt: data.publishedAt?.toDate?.(),
      tags: data.tags || [],
      thumbnailUrl: data.thumbnailUrl,
      summary: data.summary || '',
      slug: data.slug || '',
      metaTitle: data.metaTitle || '',
      metaDescription: data.metaDescription || '',
      keywords: data.keywords || '',
      newsArticleUrl: data.newsArticleUrl,
      status: data.status || 'draft',
      categoryId: data.categoryId || '',
      launchReadiness: (data.launchReadiness || data.launch_readiness) || undefined,
      dataShowcase: (data.dataShowcase || data.data_showcase) || undefined,
      authorProfile: (data.authorProfile || data.author_profile) || undefined,
      analogArchive: (data.analogArchive || data.analog_archive) || undefined,
      futureHorizons: (data.futureHorizons || data.future_horizons) || undefined,
    } as EmorationalBlogPost;

    const related: Array<{ id: string; title: string; slug: string; thumbnailUrl?: string | null; publishedAt?: Date | null }> = [];
    const cat = blogPost.categoryId || null;
    try {
      let rq = db.collection('blogs').where('status', '==', 'published');
      if (cat) rq = rq.where('categoryId', '==', cat);
      rq = rq.orderBy('publishedAt', 'desc').limit(4);
      const rSnap = await rq.get();
      rSnap.forEach((d) => {
        if (d.id === blogPost.id) return;
        const rd = d.data() as any;
        related.push({
          id: d.id,
          title: rd.title || 'Untitled',
          slug: rd.slug || '',
          thumbnailUrl: rd.thumbnailUrl || null,
          publishedAt: rd.publishedAt?.toDate?.() || null
        });
      });
    } catch (e: any) {
      const fq = db.collection('blogs').orderBy('publishedAt', 'desc').limit(8);
      const rSnap = await fq.get();
      rSnap.forEach((d) => {
        const rd = d.data() as any;
        const matchesCat = !cat || rd.categoryId === cat;
        if (d.id === blogPost.id || !matchesCat) return;
        related.push({
          id: d.id,
          title: rd.title || 'Untitled',
          slug: rd.slug || '',
          thumbnailUrl: rd.thumbnailUrl || null,
          publishedAt: rd.publishedAt?.toDate?.() || null
        });
      });
    }

    return NextResponse.json(
      {
        blog: blogPost,
        related
      },
      {
        headers: {
          'Cache-Control': 's-maxage=600, stale-while-revalidate=86400'
        }
      }
    );

  } catch (error) {
    console.error('Error fetching blog post:', error);
    return NextResponse.json(
      { error: 'Failed to fetch blog post' },
      { status: 500 }
    );
  }
}
