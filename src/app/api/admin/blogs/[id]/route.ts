// PUT /api/admin/blogs/[id] - Update an existing blog post (requires canManageBlogs permission)
import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { withAuth } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { resolveBlogSlug } from '@/lib/blog-slug';
import { blogSupaEnabled, mirrorBlogUpdate, supaDocData, supaGetBlog } from '@/lib/server/blog-supa';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (authContext) => {
    try {
      const { id } = await params;

      if (!id) {
        return NextResponse.json(
          { error: 'Blog post ID is required' },
          { status: 400 }
        );
      }

      const canManage = await hasServerPermissionForUser(getDb()!, authContext.userId, 'canManageBlogs');
      if (!canManage) {
        return NextResponse.json(
          { error: 'Unauthorized: Insufficient permissions.' },
          { status: 403 }
        );
      }

      if (!ensureAdminInitialized()) {
        return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
      }

      const db = getDb();
      if (!db) {
        return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
      }
      // Supabase read (flag ON): admin read serves any status. Any adapter
      // error falls through to the Firestore read below.
      if (blogSupaEnabled()) {
        try {
          const row = await supaGetBlog(id);
          if (!row) {
            return NextResponse.json(
              { error: 'Blog post not found' },
              { status: 404 }
            );
          }
          return NextResponse.json({
            id: row.id,
            ...supaDocData(row),
          });
        } catch (e: any) {
          console.error('[/api/admin/blogs/[id]] Supabase read failed, falling back to Firestore:', e?.message || e);
        }
      }

      const docSnap = await db.collection('blogs').doc(id).get();

      if (!docSnap.exists) {
        return NextResponse.json(
          { error: 'Blog post not found' },
          { status: 404 }
        );
      }

      return NextResponse.json({
        id: docSnap.id,
        ...docSnap.data(),
      });

    } catch (error) {
      console.error('Error fetching blog post:', error);
      return NextResponse.json(
        { error: 'Failed to fetch blog post' },
        { status: 500 }
      );
    }
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (authContext) => {
    try {
      const { id } = await params;
      const body = await request.json();

      if (!id) {
        return NextResponse.json(
          { error: 'Blog post ID is required' },
          { status: 400 }
        );
      }

      const canManage = await hasServerPermissionForUser(getDb()!, authContext.userId, 'canManageBlogs');
      
      if (!ensureAdminInitialized()) {
        return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
      }

      const db = getDb();
      if (!db) {
        return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
      }
      const docRef = db.collection('blogs').doc(id);
      const docSnap = await docRef.get();

      if (!docSnap.exists) {
        return NextResponse.json(
          { error: 'Blog post not found' },
          { status: 404 }
        );
      }

      const data = docSnap.data();
      const isAuthor = data?.authorUid === authContext.userId || data?.authorId === authContext.userId;

      // Allow if canManageBlogs OR if user is the author
      if (!canManage && !isAuthor) {
        return NextResponse.json(
          { error: 'Unauthorized: You do not have permission to edit this post.' },
          { status: 403 }
        );
      }

      // Update the blog post. The slug is resolved, never spread
      // verbatim: a save must not leave a post slugless (every public
      // reader addresses posts by slug). An explicit slug in the body
      // wins, the stored slug is kept when the body carries none or an
      // empty one, and a record with no slug at all derives one from
      // its effective title - the same resolution POST /api/blogs
      // applies on create (src/lib/blog-slug.ts).
      const updateData = {
        ...body,
        slug: resolveBlogSlug(
          typeof body.slug === 'string' ? body.slug : undefined,
          typeof body.title === 'string' ? body.title : data?.title,
          typeof data?.slug === 'string' ? data.slug : undefined,
        ),
        updatedAt: new Date(),
        publishedAt: body.status === 'published' ? new Date() : (data?.publishedAt || null),
      };

      await docRef.update(updateData);
      await mirrorBlogUpdate(id, updateData as Record<string, any>);

      return NextResponse.json({
        id,
        message: 'Blog post updated successfully'
      });

    } catch (error) {
      console.error('Error updating blog post:', error);
      return NextResponse.json(
        { error: 'Failed to update blog post' },
        { status: 500 }
      );
    }
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (authContext) => {
    try {
      const { id } = await params;

      if (!id) {
        return NextResponse.json(
          { error: 'Blog post ID is required' },
          { status: 400 }
        );
      }

      const canManage = await hasServerPermissionForUser(getDb()!, authContext.userId, 'canManageBlogs');

      if (!ensureAdminInitialized()) {
        return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
      }

      const db = getDb();
      if (!db) {
        return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
      }
      const docRef = db.collection('blogs').doc(id);
      const docSnap = await docRef.get();

      if (!docSnap.exists) {
        return NextResponse.json(
          { error: 'Blog post not found' },
          { status: 404 }
        );
      }

      const data = docSnap.data();
      const isAuthor = data?.authorUid === authContext.userId || data?.authorId === authContext.userId;

      if (!canManage && !isAuthor) {
        return NextResponse.json(
          { error: 'Unauthorized: You do not have permission to delete this post.' },
          { status: 403 }
        );
      }

      // Soft delete by marking as deleted (canonical state, pinned)
      const deleteData = {
        deleted: true,
        deletedAt: new Date(),
        status: 'archived'
      };
      await docRef.update(deleteData);
      await mirrorBlogUpdate(id, deleteData as Record<string, any>);

      return NextResponse.json({
        id,
        message: 'Blog post deleted successfully'
      });

    } catch (error) {
      console.error('Error deleting blog post:', error);
      return NextResponse.json(
        { error: 'Failed to delete blog post' },
        { status: 500 }
      );
    }
  });
}
