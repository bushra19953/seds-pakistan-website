import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    console.log('[API:Skills] Starting skills fetch...');

    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      console.error('[API:Skills] Firebase Admin initialization failed');
      return NextResponse.json({
        error: 'Server misconfiguration: Firebase Admin not initialized'
      }, { status: 500 });
    }

    const db = getDb();
    if (!db) {
      console.error('[API:Skills] Firestore not initialized');
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }
    
    const status = request.nextUrl.searchParams.get('status');
    const category = request.nextUrl.searchParams.get('category');
    const featured = request.nextUrl.searchParams.get('featured');
    const q = request.nextUrl.searchParams.get('q');
    
    console.log('[API:Skills] Query params:', { status, category, featured, q });
    
    const snap = await db.collection('skills').get();
    let items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
    
    console.log(`[API:Skills] Found ${items.length} total skills`);
    
    if (typeof status === 'string' && status && status !== '_all') items = items.filter((s) => String(s.status || 'active') === status);
    if (typeof category === 'string' && category && category !== '_all') items = items.filter((s) => String(s.category || '') === category);
    if (featured === '1') items = items.filter((s) => !!s.isFeatured === true);
    if (typeof q === 'string' && q.trim()) {
      const qq = q.trim().toLowerCase();
      items = items.filter((s) => String(s.name || '').toLowerCase().includes(qq));
    }
    
    items = items.sort((a: any, b: any) => {
      const ao = typeof a.displayOrder === 'number' ? a.displayOrder : 1e9;
      const bo = typeof b.displayOrder === 'number' ? b.displayOrder : 1e9;
      if (ao !== bo) return ao - bo;
      const an = String(a.name || '');
      const bn = String(b.name || '');
      return an.localeCompare(bn);
    });
    
    console.log(`[API:Skills] Returning ${items.length} filtered skills`);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error('[API:Skills] Error fetching skills:', e);
    return NextResponse.json({ error: e?.message || 'Failed to load skills' }, { status: 500 });
  }
}
