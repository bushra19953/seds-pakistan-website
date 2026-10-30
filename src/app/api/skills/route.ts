import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';
import {
  mirrorSkillCreate,
  mirrorSkillDelete,
  mirrorSkillUpdate,
  mirrorUserSkillRevoke,
  supaListSkillsAdmin,
  supaSkillGrantCounts,
} from '@/lib/server/skills-supa';
import {
  flushPendingUsersPrimaryOps,
  identityPrimaryFlagOn,
} from '@/lib/server/supa-identity-primary';

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
    return hasServerPermission(role, 'canManageSkills');
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

  // Supabase path (cluster G): flag ON + adapter configured serves the list
  // and the holder/grant counts from the mirrored tables; any seam failure
  // returns null and execution falls through to the Firestore path below,
  // unchanged. Flag OFF never reaches the seam (it returns null immediately).
  {
    const parsedIds = idsParam
      ? idsParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 10)
      : undefined;
    const supaItems = await supaListSkillsAdmin({
      ids: parsedIds,
      slug: slugParam || undefined,
    });
    if (supaItems !== null) {
      const counts = await supaSkillGrantCounts();
      const items = supaItems.map((item) => ({
        ...item,
        assignedUserCount: counts ? counts.userCounts[item.id] || 0 : item.assignedUserCount || 0,
        linkedEventCount: counts ? counts.eventCounts[item.id] || 0 : item.linkedEventCount || 0,
      }));
      return NextResponse.json({ items });
    }
  }

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
  // SERVER-SIDE AGGREGATION ENGINE (Firestore fallback only)
  // ==========================================
  // This block runs only when the Supabase seam above did not serve
  // (flag OFF or adapter fault). It previously scanned EVERY users
  // and events doc to count skill holders/grants (~290-360 reads per
  // admin skills load). It now asks, per requested skill, only for
  // the docs that actually carry that skill: an array-contains
  // predicate per item, so Firestore reads only holder/grant docs
  // and users/events with no skills are never read. The counts are
  // exact (the predicate returns every holder), so the aggregated
  // response is identical to the old full-scan response.
  try {
    const userCounts: Record<string, number> = {};
    const eventCounts: Record<string, number> = {};
    await Promise.all(
      items.map(async (item) => {
        const [holdersSnap, grantsSnap] = await Promise.all([
          db.collection('users').where('skillIds', 'array-contains', item.id).get(),
          db.collection('events').where('grantedSkillIds', 'array-contains', item.id).get(),
        ]);
        userCounts[item.id] = holdersSnap.docs.length;
        eventCounts[item.id] = grantsSnap.docs.length;
      }),
    );

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
  // WS10 (client-direct elimination): the register-capability modal's
  // payload carries explicit nulls for cleared optional fields; the
  // client write stored those nulls, so the route stores them too
  // instead of silently dropping the key.
  if (typeof body?.iconKey === 'string' || body?.iconKey === null) payload.iconKey = body.iconKey;
  if (typeof body?.image_url === 'string' || body?.image_url === null) payload.image_url = body.image_url;
  if (typeof body?.displayOrder === 'number' || body?.displayOrder === null) payload.displayOrder = body.displayOrder;
  const docRef = await db.collection('skills').add(payload);
  await mirrorSkillCreate(docRef.id, payload);
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
  // WS10: explicit nulls from the modal clear the field, as the client
  // updateDoc did (see the POST note above).
  if (typeof body?.iconKey === 'string' || body?.iconKey === null) updates.iconKey = body.iconKey;
  if (typeof body?.image_url === 'string' || body?.image_url === null) updates.image_url = body.image_url;
  if (typeof body?.displayOrder === 'number' || body?.displayOrder === null) updates.displayOrder = body.displayOrder;
  await db.collection('skills').doc(id).set(updates, { merge: true });
  await mirrorSkillUpdate(id, updates);
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
      const usersPrimary = await identityPrimaryFlagOn('users');
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

        // WRITE PRIMACY (G-USER-7, U-49): chunk-wise, the RMW
        // arrayRemove lands on the adapter before this chunk's batch
        // commits (loud); the batch's native arrayRemove is the
        // reverse mirror, and the skills-token mirror below is stood
        // down for these rows under users primacy (H-01).
        if (usersPrimary) {
          await flushPendingUsersPrimaryOps(
            chunk.map((d) => ({
              uid: d.id,
              payload: { skillIds: admin.firestore.FieldValue.arrayRemove(id) },
            })),
          );
        }
        await batch.commit();
      }
    }
    // Mirror the detach + delete best-effort (never throws): each holder's
    // fs_users row loses the skill id, then the fs_skills row is removed.
    // Under users primacy the detach already landed as the primary
    // write above, so the skills-token mirror is stood down (H-01);
    // the fs_skills delete mirror (skills surface) still runs.
    if (!(await identityPrimaryFlagOn('users'))) {
      for (const d of docs) {
        await mirrorUserSkillRevoke(d.id, id);
      }
    }
    await mirrorSkillDelete(id);
  }
  return NextResponse.json({ success: true });
}
