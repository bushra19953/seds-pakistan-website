// GET /api/blogs/latest?limit=3 - Get the 3 most recent blog posts for homepage
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { EmorationalBlogPost } from '@/lib/blog-types';

export async function GET(request: NextRequest) {
  try {
    console.log('[API:Blogs] Starting latest blogs fetch...');
    const { searchParams } = new URL(request.url);
    const limitCount = parseInt(searchParams.get('limit') || '3');

    console.log(`[API:Blogs] Requested limit: ${limitCount}`);

    if (limitCount < 1 || limitCount > 20) {
      console.error('[API:Blogs] Invalid limit parameter:', limitCount);
      return NextResponse.json(
        { error: 'Limit must be between 1 and 20' },
        { status: 400 }
      );
    }

    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      console.error('[API:Blogs] Firebase Admin initialization failed');
      return NextResponse.json(
        { error: 'Server misconfiguration: Firebase Admin not initialized' },
        { status: 500 }
      );
    }

    const db = getDb();
    if (!db) {
      console.error('[API:Blogs] Database not initialized');
      return NextResponse.json(
        { error: 'Database not initialized' },
        { status: 500 }
      );
    }

    console.log('[API:Blogs] Database connected, querying blogs...');

    // Simple query for latest published blogs - using ordering first to avoid index issues
    const query = db.collection('blogs')
      .orderBy('publishedAt', 'desc')
      .limit(limitCount);

    console.log('[API:Blogs] Executing query...');
    const querySnapshot = await query.get();
    console.log(`[API:Blogs] Query returned ${querySnapshot.docs.length} documents`);

    const blogs: EmorationalBlogPost[] = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      blogs.push({
        id: doc.id,
        title: data.title,
        body: data.content,
        authorUid: data.authorId,
        authorName: data.authorName,
        published: data.status === 'published',
        createdAt: data.createdAt?.toDate() || new Date(),
        updatedAt: data.updatedAt?.toDate() || new Date(),
        publishedAt: data.publishedAt?.toDate(),
        tags: data.tags || [],
        // Additional fields from EmorationalBlogPost
        thumbnailUrl: data.thumbnailUrl,
        summary: data.summary,
        slug: data.slug,
        metaTitle: data.metaTitle,
        metaDescription: data.metaDescription,
        keywords: data.keywords,
        newsArticleUrl: data.newsArticleUrl,
        status: data.status,
        categoryId: data.categoryId,
      } as EmorationalBlogPost);
    });

    console.log(`[API:Blogs] Returning ${blogs.length} blogs`);
    return NextResponse.json({
      blogs,
      count: blogs.length
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300'
      }
    });

  } catch (error) {
    console.error('[API:Blogs] Error fetching latest blogs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch latest blogs' },
      { status: 500 }
    );
  }
}