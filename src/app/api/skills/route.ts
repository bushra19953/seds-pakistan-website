import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function authenticate(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return { decoded };
  } catch {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
}

async function canManage(decoded: admin.auth.DecodedIdToken, db: FirebaseFirestore.Firestore) {
  const claims: any = decoded || {};
  if (claims.manageSkills === true || (claims.permissions && claims.permissions.manageSkills === true)) return true;
  try {
    const roleSnap = await db.collection('roles').doc(decoded.uid).get();
    const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
    if (!role) return false;
    const permSnap = await db.collection('permissions').doc(role).get();
    const ok = !!(permSnap.exists && (permSnap.data() as any)?.canManageSkills === true);
    return ok;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  const auth = await authenticate(request);
  if ('error' in auth) return auth.error;
  const ok = await canManage(auth.decoded, db);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  
  const idsParam = request.nextUrl.searchParams.get('ids');
  const slugParam = request.nextUrl.searchParams.get('slug');
  let items: any[] = [];
  
  if (idsParam) {
    const ids = idsParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 10);
    if (ids.length > 0) {
      const snap = await db.collection('skills').where(admin.firestore.FieldPath.documentId(), 'in', ids).get();
      items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
  } else if (slugParam) {
    const snap = await db.collection('skills').where('slug', '==', slugParam).get();
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    const snap = await db.collection('skills').get();
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // ==========================================
  // SERVER-SIDE AGGREGATION ENGINE
  // ==========================================
  // We perform a highly optimized select() query to gather only the necessary arrays 
  // from users and events, then aggregate them in-memory before sending to the client.
  try {
    const [usersSnap, eventsSnap] = await Promise.all([
      db.collection('users').select('skillIds').get(),
      db.collection('events').select('grantedSkillIds').get()
    ]);

    const userCounts: Record<string, number> = {};
    usersSnap.docs.forEach(doc => {
      const skillIds = doc.data().skillIds || [];
      if (Array.isArray(skillIds)) {
        skillIds.forEach(id => { userCounts[id] = (userCounts[id] || 0) + 1; });
      }
    });

    const eventCounts: Record<string, number> = {};
    eventsSnap.docs.forEach(doc => {
      const grantedSkillIds = doc.data().grantedSkillIds || [];
      if (Array.isArray(grantedSkillIds)) {
        grantedSkillIds.forEach(id => { eventCounts[id] = (eventCounts[id] || 0) + 1; });
      }
    });

    // Augment items with aggregated metrics
    items = items.map(item => ({
      ...item,
      assignedUserCount: userCounts[item.id] || 0,
      linkedEventCount: eventCounts[item.id] || 0
    }));

  } catch (error) {
    console.error('[API:Skills] Aggregation failure:', error);
    // If aggregation fails, default to 0 rather than crashing the route
    items = items.map(item => ({
      ...item,
      assignedUserCount: item.assignedUserCount || 0,
      linkedEventCount: item.linkedEventCount || 0
    }));
  }

  return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  const auth = await authenticate(request);
  if ('error' in auth) return auth.error;
  const ok = await canManage(auth.decoded, db);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await request.json();
  const name = String(body?.name || '').trim();
  const slug = String(body?.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  const category = String(body?.category || '');
  const status = String(body?.status || 'active');
  const payload: Record<string, any> = { name, slug, category, status };
  if (typeof body?.isFeatured === 'boolean') payload.isFeatured = body.isFeatured;
  if (typeof body?.iconKey === 'string') payload.iconKey = String(body.iconKey);
  if (typeof body?.image_url === 'string') payload.image_url = String(body.image_url);
  if (typeof body?.displayOrder === 'number') payload.displayOrder = body.displayOrder;
  const docRef = await db.collection('skills').add(payload);
  return NextResponse.json({ id: docRef.id });
}

export async function PATCH(request: NextRequest) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  const auth = await authenticate(request);
  if ('error' in auth) return auth.error;
  const ok = await canManage(auth.decoded, db);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await request.json();
  const id = String(body?.id || '');
  const updates: Record<string, any> = {};
  if (body?.name) updates.name = String(body.name);
  if (body?.slug) updates.slug = String(body.slug);
  if (body?.category !== undefined) updates.category = String(body.category || '');
  if (body?.status) updates.status = String(body.status);
  if (typeof body?.isFeatured === 'boolean') updates.isFeatured = body.isFeatured;
  if (typeof body?.iconKey === 'string') updates.iconKey = String(body.iconKey);
  if (typeof body?.image_url === 'string') updates.image_url = String(body.image_url);
  if (typeof body?.displayOrder === 'number') updates.displayOrder = body.displayOrder;
  await db.collection('skills').doc(id).set(updates, { merge: true });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  const auth = await authenticate(request);
  if ('error' in auth) return auth.error;
  const ok = await canManage(auth.decoded, db);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await request.json();
  const id = String(body?.id || '');
  const ref = db.collection('skills').doc(id);
  const snap = await ref.get();
  
  if (snap.exists) {
    const usersSnap = await db.collection('users').where('skillIds', 'array-contains', id).get();
    const docs = usersSnap.docs;
    const chunkSize = 400; // Keep safely below 500 limit
    
    if (docs.length === 0) {
      await ref.delete();
    } else {
      for (let i = 0; i < docs.length; i += chunkSize) {
        const chunk = docs.slice(i, i + chunkSize);
        const batch = db.batch();
        chunk.forEach((d) => {
          batch.set(d.ref, { skillIds: admin.firestore.FieldValue.arrayRemove(id) }, { merge: true });
        });
        
        // Add the skill deletion to the final batch
        if (i + chunkSize >= docs.length) {
          batch.delete(ref);
        }
        
        await batch.commit();
      }
    }
  }
  return NextResponse.json({ success: true });
}
