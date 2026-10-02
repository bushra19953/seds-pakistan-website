// PUT /api/admin/blogs/[id] - Update an existing blog post (requires canManageBlogs permission)
import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { withAuth } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

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

      const canManage = await hasServerPermission(authContext.role, 'canManageBlogs');
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

      const canManage = await hasServerPermission(authContext.role, 'canManageBlogs');
      
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
      const isAuthor = data?.authorId === authContext.userId;

      // Allow if canManageBlogs OR if user is the author
      if (!canManage && !isAuthor) {
        return NextResponse.json(
          { error: 'Unauthorized: You do not have permission to edit this post.' },
          { status: 403 }
        );
      }

      // Update the blog post
      const updateData = {
        ...body,
        updatedAt: new Date(),
        publishedAt: body.status === 'published' ? new Date() : (data?.publishedAt || null),
      };

      await docRef.update(updateData);

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

      const canManage = await hasServerPermission(authContext.role, 'canManageBlogs');

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
      const isAuthor = data?.authorId === authContext.userId;

      if (!canManage && !isAuthor) {
        return NextResponse.json(
          { error: 'Unauthorized: You do not have permission to delete this post.' },
          { status: 403 }
        );
      }

      // Soft delete by marking as deleted
      await docRef.update({
        deleted: true,
        deletedAt: new Date(),
        status: 'archived'
      });

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
