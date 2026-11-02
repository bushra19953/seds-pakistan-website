// GET /api/blogs/latest?limit=3 - Get the 3 most recent blog posts for homepage
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { EmorationalBlogPost } from '@/lib/blog-types';
import { blogDateToDate, blogSupaEnabled, supaDocData, supaListBlogs } from '@/lib/server/blog-supa';
import {
  blogLatestCacheKey,
  serveBlogPublic,
} from '@/lib/server/blog-public-cache';

// Wave-2 perf (2026-10-30): same treatment as the list and post
// routes — the homepage strip read runs uncached below as
// getLatestBlogsUncached, wrapped by serveBlogPublic (in-process
// TTL cache + in-flight dedupe + last-good stale shelter; see
// src/lib/server/blog-public-cache.ts). An invalid limit delegates
// straight through so the 400 is never cached.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limitCount = parseInt(searchParams.get('limit') || '3');
  if (Number.isNaN(limitCount) || limitCount < 1 || limitCount > 20) {
    return getLatestBlogsUncached(request);
  }
  return serveBlogPublic(
    blogLatestCacheKey(limitCount),
    'public, s-maxage=60, stale-while-revalidate=300',
    () => getLatestBlogsUncached(request)
  );
}

async function getLatestBlogsUncached(request: NextRequest) {
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

    // Supabase path (flag ON): same semantics — fetch limit*3 unfiltered,
    // drop deleted, keep published only, sort publishedAt desc in memory.
    // Any adapter error falls through to the Firestore path below.
    if (blogSupaEnabled()) {
      try {
        const rows = await supaListBlogs({ limit: limitCount * 3 });
        const blogs: EmorationalBlogPost[] = [];
        for (const row of rows) {
          const data = supaDocData(row);
          if (data.deleted === true) continue;
          blogs.push({
            id: row.id,
            title: data.title,
            body: data.content,
            authorUid: data.authorUid || data.authorId || '',
            authorName: data.authorName,
            published: data.status === 'published',
            createdAt: blogDateToDate(data.createdAt) || new Date(),
            updatedAt: blogDateToDate(data.updatedAt) || new Date(),
            publishedAt: blogDateToDate(data.publishedAt) || undefined,
            tags: data.tags || [],
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
        }
        const published = blogs.filter((b) => b.status === 'published');
        published.sort((a, b) => {
          const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          return tb - ta;
        });
        const limited = published.slice(0, limitCount);
        return NextResponse.json({
          blogs: limited,
          count: limited.length
        }, {
          headers: {
            'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300'
          }
        });
      } catch (e: any) {
        console.error('[API:Blogs] Supabase read failed, falling back to Firestore:', e?.message || e);
      }
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

    // Fetch without ordering (avoids Firestore index issues), sort in memory
    const query = db.collection('blogs').limit(limitCount * 3);

    console.log('[API:Blogs] Executing query...');
    const querySnapshot = await query.get();
    console.log(`[API:Blogs] Query returned ${querySnapshot.docs.length} documents`);

    const blogs: EmorationalBlogPost[] = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      // A soft-deleted post (deleted: true) is never public, even when a
      // legacy flag-only delete left its status at 'published'.
      if ((data as any).deleted === true) return;
      blogs.push({
        id: doc.id,
        title: data.title,
        body: data.content,
        authorUid: data.authorUid || data.authorId || '',
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

    // Filter to published only, sort by publishedAt desc in memory, then limit
    const published = blogs.filter((b) => b.status === 'published');
    published.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
    const limited = published.slice(0, limitCount);

    console.log(`[API:Blogs] Returning ${limited.length} blogs`);
    return NextResponse.json({
      blogs: limited,
      count: limited.length
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