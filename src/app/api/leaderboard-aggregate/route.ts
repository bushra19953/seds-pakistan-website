import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const pageNum = parseInt(searchParams.get('page') || '1') || 1;
    const size = Math.min(parseInt(searchParams.get('pageSize') || '10') || 10, 50);
    const chapterId = searchParams.get('chapterId');
    const offset = (pageNum - 1) * size;

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
