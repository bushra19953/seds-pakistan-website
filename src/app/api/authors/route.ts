// GET /api/authors - Retrieve a list of all authors
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const authorId = searchParams.get('id');

    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      console.error('[/api/authors] Firebase Admin initialization failed');
      return NextResponse.json({
        authors: [],
        totalCount: 0,
        error: 'Server misconfiguration: Firebase Admin not initialized'
      }, { status: 500 });
    }

    const db = getDb();
    if (!db) {
      console.error('[/api/authors] Database connection failed');
      // Return empty array instead of error to prevent frontend crashes
      return NextResponse.json({
        authors: [],
        totalCount: 0,
        error: 'Database connection unavailable'
      }, { status: 200 }); // Return 200 with empty data instead of 500
    }

    if (authorId) {
      // Get a specific author by ID with their posts
      const usersRef = db.collection('users');
      const userQuery = usersRef.where('uid', '==', authorId).limit(1);
      const userSnapshot = await userQuery.get();

      if (userSnapshot.empty) {
        return NextResponse.json(
          {
            error: 'Author not found',
            authors: [],
            totalCount: 0
          },
          { status: 404 }
        );
      }

      const userDoc = userSnapshot.docs[0];
      const userData = userDoc.data() as any;

      // Get author's blog posts
      const blogsRef = db.collection('blogs');
      const blogsQuery = blogsRef
        .where('authorId', '==', authorId)
        .where('status', '==', 'published')
        .orderBy('publishedAt', 'desc');
      const blogsSnapshot = await blogsQuery.get();

      const posts = blogsSnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          title: data.title || 'Untitled',
          slug: data.slug || '',
          publishedAt: data.publishedAt?.toDate() || new Date(),
          summary: data.summary || (data.content ? data.content.substring(0, 150) + '...' : ''),
          thumbnailUrl: data.thumbnailUrl || '',
        };
      });

      return NextResponse.json({
        author: {
          id: userDoc.id,
          name: userData.name || 'Unknown Author',
          bio: userData.bio || '',
          avatarUrl: userData.avatarUrl || '',
          role: userData.role || 'contributor',
        },
        posts,
        postCount: posts.length
      }, { headers: { 'Cache-Control': 's-maxage=600, stale-while-revalidate=86400' } });
    } else {
      // Get all unique authors from published blogs
      const blogsRef = db.collection('blogs');
      const q = blogsRef.where('status', '==', 'published');
      const querySnapshot = await q.get();

      const authorsMap = new Map();

      querySnapshot.forEach((doc) => {
        const data = doc.data() as any;
        const authorId = data.authorId;
        const authorName = data.authorName || 'Unknown Author';

        // Only add valid, non-empty author IDs
        if (authorId && typeof authorId === 'string' && authorId.trim() !== '') {
          const sanitizedId = authorId.trim();
          const sanitizedName = (authorName || 'Unknown Author').trim();
          
          if (!authorsMap.has(sanitizedId)) {
            authorsMap.set(sanitizedId, {
              id: sanitizedId,
              name: sanitizedName,
              postCount: 0,
              lastPostDate: null,
            });
          }

          const author = authorsMap.get(sanitizedId);
          author.postCount++;

          const publishedAt = data.publishedAt?.toDate();
          if (publishedAt && (!author.lastPostDate || publishedAt > author.lastPostDate)) {
            author.lastPostDate = publishedAt;
          }
        }
      });

      const authors = Array.from(authorsMap.values()).sort((a, b) => {
        if (!a.lastPostDate) return 1;
        if (!b.lastPostDate) return -1;
        return b.lastPostDate.getTime() - a.lastPostDate.getTime();
      });

      // CRITICAL SERVER-SIDE VALIDATION: Verify all authors have valid IDs before sending to client

      const validAuthors = authors.filter(author => {
        const isValid = author &&
                       author.id &&
                       typeof author.id === 'string' &&
                       author.id.trim().length > 0;

        if (!isValid) {
          console.error('🚨🚨🚨 SERVER-SIDE CRITICAL: FOUND INVALID AUTHOR OBJECT IN API RESPONSE !!!', {
            author,
            authorType: typeof author,
            authorId: author?.id,
            authorIdType: typeof author?.id
          });
        }

        return isValid;
      });

      // Silent validation; keep error logging below for unexpected failures
      // Intentionally avoiding verbose server-side logs in production

      // Always return a valid response structure with only validated authors
      return NextResponse.json({
        authors: validAuthors,
        totalCount: validAuthors.length
      }, { status: 200, headers: { 'Cache-Control': 's-maxage=600, stale-while-revalidate=86400' } });
    }

  } catch (error) {
    console.error('[/api/authors] Error fetching authors:', error);
    // Return a valid structure even on error to prevent frontend crashes
    return NextResponse.json(
      {
        authors: [],
        totalCount: 0,
        error: error instanceof Error ? error.message : 'Failed to fetch authors'
      },
      { status: 200 } // Return 200 with empty data instead of 500 to allow graceful degradation
    );
  }
}
