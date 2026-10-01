import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';

export async function GET() {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        const snapshot = await db.collection('events')
            .where('deleted', '!=', true)
            .orderBy('deleted') // Required for != query
            .orderBy('createdAt', 'desc')
            .limit(3)
            .get();

        const events = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                title: data.title,
                slug: data.slug,
                description: data.description,
                valueProposition: data.valueProposition,
                imageUrl: data.imageUrl,
                startDate: data.startDate || null,
                location: data.location || null,
            };
        });

        return NextResponse.json({ ok: true, events });
    } catch (err: any) {
        console.error('[events upcoming API] GET error:', err);
        return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
    }
}
