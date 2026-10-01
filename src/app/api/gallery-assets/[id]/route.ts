import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasPermission } from '@/config/permissions';

export const dynamic = 'force-dynamic';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(auth.user.role, 'manageGallery')) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    
    const body = await request.json();
    const now = new Date();
    const update: any = { updatedAt: now };
    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 });
      if (t.length > 140) return NextResponse.json({ error: 'Title too long (max 140 chars)' }, { status: 400 });
      update.title = t;
    }
    if (body.assetUrl !== undefined) {
      const a = String(body.assetUrl).trim();
      if (!(a.toLowerCase().endsWith('.glb') || a.toLowerCase().endsWith('.gltf'))) {
        return NextResponse.json({ error: 'assetUrl must point to a .glb or .gltf file' }, { status: 400 });
      }
      update.assetUrl = a;
    }
    if (body.thumbnailUrl !== undefined) {
      update.thumbnailUrl = body.thumbnailUrl ? String(body.thumbnailUrl).trim() : null;
    }
    if (body.description !== undefined) {
      const d = String(body.description).trim();
      if (d.length > 4000) return NextResponse.json({ error: 'Description too long (max 4000 chars)' }, { status: 400 });
      update.description = d;
    }
    if (body.status !== undefined) {
      update.status = String(body.status);
    }
    await db.collection('galleryAssets').doc(id).set(update, { merge: true });
    try {
      await db.collection('audit_logs').add({
        action: 'gallery_asset_updated',
        actorUid: auth.user.userId,
        targetUidOrResource: id,
        payload: update,
        timestamp: now,
      });
    } catch (_) {}
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to update asset' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(auth.user.role, 'manageGallery')) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    
    await db.collection('galleryAssets').doc(id).delete();
    try {
      await db.collection('audit_logs').add({
        action: 'gallery_asset_deleted',
        actorUid: auth.user.userId,
        targetUidOrResource: id,
        payload: {},
        timestamp: new Date(),
      });
    } catch (_) {}
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to delete asset' }, { status: 500 });
  }
}
