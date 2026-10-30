/**
 * POST /api/admin/resources/candidates — RBT2-B2 route for the admin
 * resources page's competition-notify candidate refresh.
 *
 * The page used to run the candidate scan in the browser: a full
 * getDocs(users) (257 reads per click when no chapter filter was
 * set), or a chapter-filtered users query, plus one roles query per
 * selected role — all client-side Firestore reads with no seam. This
 * route performs the identical selection server-side, seam-first
 * through the users/roles seams (getUsersSupaAdapter /
 * supaListAllUsers / supaListRolesWhereRole), with the exact former
 * client queries as the Firestore fallback arm.
 *
 * Selection semantics preserved byte-for-byte from the page:
 *   - chapterIds length 1  -> users where chapterId == that chapter
 *   - chapterIds length >1 -> users where chapterId in first 10
 *   - chapterIds empty     -> all users
 *   - roles non-empty      -> keep only uids whose roles/{uid} doc
 *                             has role == one of the selected slugs
 *   - each candidate is { uid, displayName, chapterId, role } taken
 *     from the user doc (contact fields are never mapped, as before).
 *
 * Gate: founder or canManageResources (the same gate as the sibling
 * notify route). Body: { chapterIds?: string[], roles?: string[] }.
 * Response: { users: Candidate[] }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import {
  getUsersSupaAdapter,
  supaListAllUsers,
  supaListRolesWhereRole,
} from '@/lib/supa-seams/users-directory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Candidate {
  uid: string;
  displayName: unknown;
  chapterId: unknown;
  role: unknown;
}

export async function POST(request: NextRequest) {
  const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await verifyIdTokenString(token);
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  if (!isFounder(decoded.uid)) {
    const allowed = await hasServerPermissionForUser(db, decoded.uid, 'canManageResources');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const chapterIds: string[] = Array.isArray(body.chapterIds)
    ? body.chapterIds.filter((c: unknown): c is string => typeof c === 'string' && c.length > 0)
    : [];
  const roles: string[] = Array.isArray(body.roles)
    ? body.roles.filter((r: unknown): r is string => typeof r === 'string' && r.length > 0)
    : [];

  try {
    let baseUsers: Candidate[] | null = null;
    let roleUidSet: Set<string> | null = null;

    // Seam-first arm (users/roles seams). Any seam error discards the
    // whole arm and takes the Firestore fallback below, so a partial
    // seam answer can never narrow the candidate set.
    const adapter = getUsersSupaAdapter();
    if (adapter) {
      try {
        const rows =
          chapterIds.length === 1
            ? await supaListAllUsers(adapter, chapterIds[0])
            : await supaListAllUsers(adapter);
        const chapterFilter =
          chapterIds.length > 1 ? new Set(chapterIds.slice(0, 10)) : null;
        baseUsers = rows
          .filter((row) => !chapterFilter || chapterFilter.has(String(row.data.chapterId ?? '')))
          .map((row) => ({
            uid: row.id,
            displayName: row.data.displayName,
            chapterId: row.data.chapterId,
            role: row.data.role,
          }));
        if (roles.length > 0) {
          roleUidSet = new Set<string>();
          for (const role of roles) {
            const roleRows = await supaListRolesWhereRole(adapter, role);
            for (const row of roleRows) roleUidSet.add(row.id);
          }
        }
      } catch {
        baseUsers = null;
        roleUidSet = null;
      }
    }

    // Firestore fallback arm: the page's former client queries,
    // verbatim, now through the Admin SDK.
    if (baseUsers === null) {
      const usersRef = db.collection('users');
      let usersSnap;
      if (chapterIds.length === 1) {
        usersSnap = await usersRef.where('chapterId', '==', chapterIds[0]).get();
      } else if (chapterIds.length > 1) {
        usersSnap = await usersRef.where('chapterId', 'in', chapterIds.slice(0, 10)).get();
      } else {
        usersSnap = await usersRef.get();
      }
      baseUsers = usersSnap.docs.map((d) => {
        const data = d.data() as any;
        return { uid: d.id, displayName: data.displayName, chapterId: data.chapterId, role: data.role };
      });
      if (roles.length > 0) {
        roleUidSet = new Set<string>();
        for (const role of roles) {
          const snap = await db.collection('roles').where('role', '==', role).get();
          snap.docs.forEach((doc) => roleUidSet!.add(doc.id));
        }
      }
    }

    const filtered =
      roles.length > 0 && roleUidSet ? baseUsers.filter((u) => roleUidSet!.has(u.uid)) : baseUsers;

    return NextResponse.json({ users: filtered });
  } catch (err) {
    console.error('[admin/resources/candidates] failed:', err);
    return NextResponse.json({ error: 'candidates_failed' }, { status: 500 });
  }
}
