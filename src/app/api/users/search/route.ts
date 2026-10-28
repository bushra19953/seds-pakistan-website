import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { canUnmaskContacts } from '@/lib/privacy';
import { resolveUserEmails } from '@/lib/server/user-contact';

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

        // Contact doorway: email no longer lives on the user record.
        // The window's addresses resolve through the gated contact
        // records (Firebase Auth fallback) and matching/serialization
        // run against that map; the canUnmaskContacts serialization
        // gate below is unchanged.
        const emailMap = await resolveUserEmails(db, snapshot.docs.map(d => d.id))
            .catch(() => new Map<string, string>());

        const users: any[] = [];

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const displayName = (data.displayName || '').toLowerCase();
            const email = (emailMap.get(doc.id) || '').toLowerCase();

            // Check if matches query
            if (displayName.includes(query) || email.includes(query)) {
                const isInChapter = chapterId === 'all'
                    ? true
                    : data.chapterId === chapterId;

                users.push({
                    id: doc.id,
                    displayName: data.displayName || '',
                    // Privacy shielding (spec section 5): raw email is only
                    // serialized for chairs/presidents (unmask-privileged
                    // roles). Everyone else gets no email field at all; the
                    // UI renders a dash placeholder in that case.
                    email: canUnmaskContacts(auth.user.role) ? (emailMap.get(doc.id) || null) : null,
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
