import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasPermission } from '@/config/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'published';
    const listAll = status === 'all';

    let snap;
    try {
      const base = db.collection('galleryAssets');
      if (listAll) {
        snap = await base.orderBy('updatedAt', 'desc').limit(200).get();
      } else {
        // Prefer status filter with sort; if index missing, fall back to filter-only
        try {
          snap = await base.where('status', '==', status).orderBy('updatedAt', 'desc').limit(200).get();
        } catch (_e) {
          snap = await base.where('status', '==', status).limit(200).get();
        }
      }
    } catch (err) {
      return NextResponse.json({ error: 'Query failed', details: String((err as any)?.message || err) }, { status: 500 });
    }

    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to list assets' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
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
    const title = String(body.title || '').trim();
    const assetUrl = String(body.assetUrl || '').trim();
    const thumbnailUrl = body.thumbnailUrl ? String(body.thumbnailUrl).trim() : null;
    const description = String(body.description || '').trim();
    const status = String(body.status || 'published');

    if (!title || !assetUrl || !description) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!(assetUrl.toLowerCase().endsWith('.glb') || assetUrl.toLowerCase().endsWith('.gltf'))) {
      return NextResponse.json({ error: 'assetUrl must point to a .glb or .gltf file' }, { status: 400 });
    }
    if (title.length > 140) {
      return NextResponse.json({ error: 'Title too long (max 140 chars)' }, { status: 400 });
    }
    if (description.length > 4000) {
      return NextResponse.json({ error: 'Description too long (max 4000 chars)' }, { status: 400 });
    }

    const now = new Date();
    const payload = {
      title,
      assetUrl,
      thumbnailUrl,
      description,
      status,
      createdBy: auth.user.userId,
      createdAt: now,
      updatedAt: now,
    };

    const ref = await db.collection('galleryAssets').add(payload);
    // Audit log (best effort)
    try {
      await db.collection('audit_logs').add({
        action: 'gallery_asset_created',
        actorUid: auth.user.userId,
        targetUidOrResource: ref.id,
        payload,
        timestamp: now,
      });
    } catch (_) {}
    return NextResponse.json({ id: ref.id }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to create asset' }, { status: 500 });
  }
}
