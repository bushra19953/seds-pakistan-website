// GET /api/blogs - Retrieve a paginated list of all published blog posts
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { EmorationalBlogPost } from '@/lib/blog-types';
import { withAuth } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limitCount = parseInt(searchParams.get('limit') || '12');
    const category = searchParams.get('category');
    const author = searchParams.get('author');
    const search = searchParams.get('search');
    const cursorParam = searchParams.get('cursor');

    if (limitCount < 1 || limitCount > 50) {
      return NextResponse.json(
        { error: 'Invalid limit' },
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

    // Fetch without composite ordering (avoids Firestore index issues).
    // Category/author filtering and publishedAt sorting happen in memory below.
    let q = db.collection('blogs').where('status', '==', 'published');

    const fetchLimit = search && search.trim() ? Math.min(limitCount * 3, 100) : limitCount;
    // Fetch extra to allow in-memory filtering/sorting/pagination
    q = q.limit(Math.min(fetchLimit * 3, 150));

    let snapshot;
    try {
      const t0 = Date.now();
      snapshot = await q.get();
      const ms = Date.now() - t0;
      console.log('[/api/blogs] primary_query_ms:', ms, 'docs:', snapshot.size);
    } catch (err: any) {
      console.error('[/api/blogs] primary query failed, using fallback:', err?.message || err);
      const fq = db.collection('blogs').limit(fetchLimit);
      const t1 = Date.now();
      snapshot = await fq.get();
      const fm = Date.now() - t1;
      console.log('[/api/blogs] fallback_query_ms:', fm, 'docs:', snapshot.size);
    }
    const items: EmorationalBlogPost[] = snapshot.docs.map((doc) => {
      const data = doc.data() as any;
      const createdAt = data.createdAt?.toDate?.() || null;
      const updatedAt = data.updatedAt?.toDate?.() || null;
      const publishedAt = data.publishedAt?.toDate?.() || null;
      return {
        id: doc.id,
        title: data.title || 'Untitled',
        body: data.content || '',
        authorUid: data.authorId || '',
        authorName: data.authorName || 'Unknown Author',
        published: true,
        createdAt: createdAt || new Date(),
        updatedAt: updatedAt || createdAt || new Date(),
        publishedAt: publishedAt,
        tags: Array.isArray(data.tags) ? data.tags : [],
        thumbnailUrl: data.thumbnailUrl || null,
        summary: data.summary || '',
        slug: data.slug || '',
        metaTitle: data.metaTitle || '',
        metaDescription: data.metaDescription || '',
        keywords: data.keywords || '',
        newsArticleUrl: data.newsArticleUrl || null,
        status: 'published',
        categoryId: data.categoryId || '',
      } as EmorationalBlogPost;
    });

    let filtered = items;

    // In-memory category/author filters (avoids Firestore composite indexes)
    if (category && category.trim() && category !== 'all') {
      const c = category.trim();
      filtered = filtered.filter((b) => (b.categoryId || '') === c);
    }
    if (author && author.trim() && author !== 'all') {
      const a = author.trim();
      filtered = filtered.filter((b) => (b.authorUid || '') === a);
    }

    // Sort by publishedAt desc in memory
    filtered.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });

    // Cursor pagination: skip items newer than the cursor timestamp
    if (cursorParam) {
      const ts = Number(cursorParam);
      if (!isNaN(ts) && ts > 0) {
        filtered = filtered.filter((b) => {
          const t = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          return t < ts;
        });
      }
    }

    if (search && search.trim()) {
      const s = search.trim().toLowerCase();
      filtered = filtered.filter((b) => (
        (b.title || '').toLowerCase().includes(s) ||
        (b.summary || '').toLowerCase().includes(s) ||
        (b.keywords || '').toLowerCase().includes(s)
      ));
    }

    const hasMore = filtered.length > limitCount;
    const limited = filtered.slice(0, limitCount);

    // If there's more data, the cursor is the publishedAt of the last visible item
    const last = limited[limited.length - 1];
    const nextCursor = hasMore && last && last.publishedAt
      ? String(new Date(last.publishedAt).getTime())
      : null;

    return NextResponse.json(
      {
        blogs: limited,
        pagination: {
          limit: limitCount,
          nextCursor,
          count: limited.length
        }
      },
      {
        headers: {
          'Cache-Control': 's-maxage=600, stale-while-revalidate=86400'
        }
      }
    );

  } catch (error) {
    console.error('[/api/blogs] Error fetching blogs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch blogs' },
      { status: 500 }
    );
  }
}

// POST /api/blogs - Create a new blog post (requires canManageBlogs permission)
export async function POST(request: NextRequest) {
  return withAuth(request, async (authContext) => {
    try {
      // Check for module-level management permission
      const canManage = await hasServerPermission(authContext.role, 'canManageBlogs');
      if (!canManage) {
        return NextResponse.json(
          { error: 'Unauthorized: Insufficient permissions to create blog posts.' },
          { status: 403 }
        );
      }

      const body = await request.json();

      const {
        title,
        slug,
        content,
        summary,
        thumbnailUrl,
        authorId,
        authorName,
        categoryId,
        status,
        tags,
        metaTitle,
        metaDescription,
        keywords,
        newsArticleUrl,
        publishDate,
        unpublishDate,
      } = body;

      // Validation
      if (!title || !content || !authorId) {
        return NextResponse.json(
          { error: 'Title, content, and author ID are required' },
          { status: 400 }
        );
      }

      const db = getDb();
      if (!db) {
        return NextResponse.json(
          { error: 'Database not initialized' },
          { status: 500 }
        );
      }

      // Create the blog post document
      const blogData = {
        title,
        slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        content,
        summary: summary || content.substring(0, 150) + '...',
        thumbnailUrl: thumbnailUrl || null,
        authorId,
        authorName: authorName || 'Unknown Author',
        categoryId: categoryId || null,
        status: status || 'draft',
        tags: tags || [],
        metaTitle: metaTitle || title,
        metaDescription: metaDescription || summary || content.substring(0, 150),
        keywords: keywords || '',
        newsArticleUrl: newsArticleUrl || null,
        publishDate: publishDate ? new Date(publishDate) : null,
        unpublishDate: unpublishDate ? new Date(unpublishDate) : null,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishedAt: status === 'published' ? new Date() : null,
      };

      // Add to Firestore
      const docRef = await db.collection('blogs').add(blogData);

      return NextResponse.json({
        id: docRef.id,
        ...blogData,
        message: 'Blog post created successfully'
      });

    } catch (error) {
      console.error('Error creating blog post:', error);
      return NextResponse.json(
        { error: 'Failed to create blog post' },
        { status: 500 }
      );
    }
  });
}
