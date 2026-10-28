import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { listLeaderboardFromSupa } from '@/lib/supa/gamification';

// Pinned leaderboard entry (the Founder and Patron-in-Chief), resolved
// SERVER-side. It used to be resolved in the browser from the settings
// doc plus a direct users/{uid} Firestore read; the security rules deny
// user-doc reads to signed-out visitors (verified 2026-10-28: anonymous
// GET on users/{founderUid} returns 403 while chapters/badges return
// 200), so the pinned row silently vanished for exactly the public
// audience it exists for. The Admin SDK read here has no such limit.
// The uid comes from settings/leaderboard (same candidate keys the old
// client code accepted), falling back to the founder env var and then
// the founder uid constant the client used to hardcode.
const PIN_SETTING_KEYS = [
  'presidentUid', 'featuredPresidentUid', 'presidentId',
  'featuredPresidentId', 'topPresidentUid', 'topPresidentId',
];
const FOUNDER_FALLBACK_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

async function resolvePinnedUsers(db: ReturnType<typeof getDb>): Promise<any[]> {
  try {
    if (!db) return [];
    let uid: string | null = null;
    const settingsSnap = await db.collection('settings').doc('leaderboard').get();
    if (settingsSnap.exists) {
      const data = settingsSnap.data() as any;
      uid = PIN_SETTING_KEYS
        .map((k) => (typeof data?.[k] === 'string' ? String(data[k]) : null))
        .find(Boolean) || null;
    }
    if (!uid) uid = process.env.NEXT_PUBLIC_FIREBASE_FOUNDER_UID || FOUNDER_FALLBACK_UID;
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return [];
    const data = snap.data() as any;
    const row: any = {
      id: snap.id,
      displayName: data.displayName || data.name || 'Anonymous',
      photoURL: data.photoURL || undefined,
      points: Number(data.points || 0),
      totalHoursWorked: Number(data.totalHoursWorked || 0),
      chapterId: data.chapterId || undefined,
      tasksAssignedCount: Number(data.tasksAssignedCount || 0),
      tasksCompletedOnTimeCount: Number(data.tasksCompletedOnTimeCount || 0),
      university: data.university || undefined,
      upvotes: Number(data.upvotes || 0),
      downvotes: Number(data.downvotes || 0),
      badges: Array.isArray(data.badges) ? data.badges.slice(0, 5) : [],
      role: data.displayRole || null,
      isOnVacation: data.isOnVacation || false,
    };
    if (row.chapterId) {
      const chSnap = await db.collection('chapters').doc(row.chapterId).get();
      if (chSnap.exists) {
        const ch = chSnap.data() as any;
        row.chapter = { name: String(ch?.name || ch?.title || '') };
      }
    }
    return [row];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const pageNum = parseInt(searchParams.get('page') || '1') || 1;
    const size = Math.min(parseInt(searchParams.get('pageSize') || '10') || 10, 50);
    const chapterId = searchParams.get('chapterId');
    const offset = (pageNum - 1) * size;

    // The pin belongs to the Overall first page only, matching where the
    // client renders it (above the ranked rows of the Overall table).
    const pinned = pageNum === 1 && !chapterId ? await resolvePinnedUsers(getDb()) : [];

    // Cluster Q (step 14): Supabase read behind useSupa('gamification').
    // Seam returns null on flag OFF / unconfigured / adapter error, and
    // the Firestore path below then serves byte-identically.
    const supaPage = await listLeaderboardFromSupa({ page: pageNum, pageSize: size, chapterId });
    if (supaPage) {
      const totalPages = Math.ceil(supaPage.totalUsers / size);
      return NextResponse.json({
        users: supaPage.users,
        pinned,
        pagination: {
          page: pageNum,
          pageSize: size,
          totalUsers: supaPage.totalUsers,
          totalPages,
          hasNext: pageNum < totalPages,
          hasPrev: pageNum > 1,
        },
        timestamp: new Date().toISOString(),
      }, {
        headers: {
          'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
        },
      });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    // Build query
    let query: FirebaseFirestore.Query = db.collection('users');
    if (chapterId) {
      query = query.where('chapterId', '==', chapterId);
    }

    // Get paginated results
    const snapshot = await query
      .orderBy('points', 'desc')
      .offset(offset)
      .limit(size)
      .get();

    const rawUsers = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        displayName: data.displayName || data.name || 'Anonymous',
        photoURL: data.photoURL || undefined,
        points: Number(data.points || 0),
        totalHoursWorked: Number(data.totalHoursWorked || 0),
        chapterId: data.chapterId || undefined,
        tasksAssignedCount: Number(data.tasksAssignedCount || 0),
        tasksCompletedOnTimeCount: Number(data.tasksCompletedOnTimeCount || 0),
        university: data.university || undefined,
        upvotes: Number(data.upvotes || 0),
        downvotes: Number(data.downvotes || 0),
        badges: Array.isArray(data.badges) ? data.badges.slice(0, 5) : [],
        role: data.displayRole || null,
        isOnVacation: data.isOnVacation || false,
      };
    });

    // Resolve chapter names
    const chapterIds = [...new Set(rawUsers.map(u => u.chapterId).filter(Boolean))] as string[];
    const chapterNameMap: Record<string, string> = {};
    if (chapterIds.length > 0) {
      const snaps = await Promise.all(chapterIds.map(id => db.collection('chapters').doc(id).get()));
      snaps.forEach((snap, idx) => {
        if (snap.exists) {
          const d = snap.data() as any;
          chapterNameMap[chapterIds[idx]] = String(d?.name || d?.title || '');
        }
      });
    }

    const users = rawUsers.map(u => ({
      ...u,
      chapter: u.chapterId ? { name: chapterNameMap[u.chapterId] || '' } : undefined,
    }));

    // Get total count
    const totalQuery = chapterId
      ? db.collection('users').where('chapterId', '==', chapterId)
      : db.collection('users');
    const totalSnap = await totalQuery.count().get();
    const totalUsers = totalSnap.data().count;
    const totalPages = Math.ceil(totalUsers / size);

    return NextResponse.json({
      users,
      pinned,
      pagination: {
        page: pageNum,
        pageSize: size,
        totalUsers,
        totalPages,
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1,
      },
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to aggregate leaderboard data', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
