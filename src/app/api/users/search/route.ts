import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const query = (searchParams.get('q') || '').toLowerCase().trim();
        const chapterId = searchParams.get('chapterId') || '';

        if (!query || query.length < 2) {
            return NextResponse.json({ users: [] });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        // Get all users (we'll filter client-side for partial matches)
        // In production, use Algolia/Elasticsearch for proper search
        const snapshot = await db.collection('users')
            .limit(100)
            .get();

        const users: any[] = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const displayName = (data.displayName || '').toLowerCase();
            const email = (data.email || '').toLowerCase();

            // Check if matches query
            if (displayName.includes(query) || email.includes(query)) {
                const isInChapter = chapterId === 'all'
                    ? true
                    : data.chapterId === chapterId;

                users.push({
                    id: doc.id,
                    displayName: data.displayName || email.split('@')[0],
                    email: data.email,
                    photoURL: data.photoURL || null,
                    role: data.displayRole || data.role || 'member',
                    chapterId: data.chapterId || null,
                    managerId: data.managerId || null,
                    isInChapter,
                    exactMatch: email === query
                });
            }
        });

        // Sort: exact matches first, then in-chapter, then alphabetical
        users.sort((a, b) => {
            if (a.exactMatch && !b.exactMatch) return -1;
            if (!a.exactMatch && b.exactMatch) return 1;
            if (a.isInChapter && !b.isInChapter) return -1;
            if (!a.isInChapter && b.isInChapter) return 1;
            return a.displayName.localeCompare(b.displayName);
        });

        return NextResponse.json({ users: users.slice(0, 10) });

    } catch (error) {
        console.error('[User Search API] Error:', error);
        return NextResponse.json({ error: 'Search failed' }, { status: 500 });
    }
}
