import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    const skillId = request.nextUrl.searchParams.get('skillId');
    if (!skillId) return NextResponse.json({ items: [] });
    const snap = await db.collection('users').where('skillIds', 'array-contains', skillId).get();
    const items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load users' }, { status: 500 });
  }
}

