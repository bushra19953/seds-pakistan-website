import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/users/picker (Item 6, Phase 0).
 *
 * A narrow, authenticated, server-side member picker that replaces
 * direct client-side LIST reads of the users collection for the
 * consumers the Phase 0 rules change cannot cover with a permission
 * grant (shared pickers and the one non-admin list, projects/new).
 * Once the Batch 1 rules are published, a plain signed-in account
 * can no longer list users or roles from the client; this API is
 * what those pickers call instead.
 *
 * Field allowlist is exhaustive and deliberate: uid, displayName,
 * photoURL, chapterId, role, isOnVacation. NEVER email, NEVER
 * whatsapp/whatsappNumber, NEVER points, warning, or ban fields.
 * Consumers that need email (e.g. the certificates recipient picker)
 * stay on their privileged client lists under the rules grant; they
 * do not belong on this API.
 *
 * Params: q (optional substring on displayName, minimum 2 chars,
 * mirroring /api/users/search), chapterId (optional plain filter;
 * this is a picker, not a register - register scoping lives in
 * /api/admin/users), limit (default 100, max 1000).
 */
export async function GET(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim().toLowerCase();
  const chapterId = (searchParams.get('chapterId') || '').trim();
  const limitParam = parseInt(searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), 1000)
    : 100;

  // Mirrors /api/users/search: a supplied query shorter than 2 chars
  // matches nothing rather than dumping the directory.
  if (q && q.length < 2) {
    return NextResponse.json({ users: [] });
  }

  let usersQuery: any = db.collection('users');
  if (chapterId) {
    usersQuery = usersQuery.where('chapterId', '==', chapterId);
  }
  const snap = await usersQuery.get();

  const baseUsers = snap.docs.map((d: any) => ({ id: d.id, data: d.data() || {} }));

  // Roles overlay, roles-first (roles/{uid} is the source of truth;
  // the users mirror is the fallback), in chunks of 30 by document
  // id - the pattern /api/admin/users already uses.
  const rolesMap: Record<string, string> = {};
  const uids = baseUsers.map((u) => u.id);
  for (let i = 0; i < uids.length; i += 30) {
    const chunk = uids.slice(i, i + 30);
    if (chunk.length === 0) continue;
    try {
      const rolesSnap = await db.collection('roles').where('__name__', 'in', chunk).get();
      rolesSnap.docs.forEach((doc: any) => {
        if (doc.data()?.role) rolesMap[doc.id] = String(doc.data().role);
      });
    } catch (e) {
      console.warn('[api/users/picker] roles overlay failed for a chunk:', e);
    }
  }

  let users = baseUsers.map((u) => ({
    uid: u.id,
    displayName: String(u.data.displayName || u.data.name || ''),
    photoURL: u.data.photoURL || null,
    chapterId: u.data.chapterId || u.data.chapter || null,
    role: rolesMap[u.id] || u.data.role || null,
    isOnVacation: u.data.isOnVacation === true || u.data.vacationMode === true,
  }));

  if (q) {
    users = users.filter((u) => u.displayName.toLowerCase().includes(q));
  }

  users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  users = users.slice(0, limit);

  return NextResponse.json({ users });
}
