import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import {
  PUBLIC_STALE_CACHE_CONTROL,
  getLastGoodPublic,
  rememberLastGoodPublic,
} from '@/lib/server/public-stale-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Founder shelter (2026-10-30 outage follow-up): the per-skill member
// list is public (public fields only - see the projection below),
// slow-changing, and neither auth-gated nor money-adjacent, so it
// gets the site-state treatment: successes carry s-maxage +
// stale-while-revalidate and are remembered per skillId; a failed
// read serves the last-good body for the SAME skillId with an
// X-Served-Stale marker instead of a 500. With no last-good on hand
// the failure stays a loud 500.
function staleKey(request: NextRequest): string {
  return `public/skills-users|skillId=${request.nextUrl.searchParams.get('skillId') ?? ''}`;
}

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    const skillId = request.nextUrl.searchParams.get('skillId');
    if (!skillId) return NextResponse.json({ items: [] });
    const snap = await db.collection('users').where('skillIds', 'array-contains', skillId).get();
    // Project only public fields. Never leak email, phone, or other PII.
    const items = snap.docs.map((d) => {
      const data = d.data() as any;
      return {
        id: d.id,
        displayName: data.displayName || 'SEDS Member',
        photoURL: data.photoURL || null,
        chapterId: data.chapterId || null,
        skillIds: Array.isArray(data.skillIds) ? data.skillIds : [],
      };
    });
    const body = { items };
    rememberLastGoodPublic(staleKey(request), body);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': PUBLIC_STALE_CACHE_CONTROL },
    });
  } catch (e: any) {
    const stale = getLastGoodPublic(staleKey(request));
    if (stale !== undefined) {
      return NextResponse.json(stale, {
        headers: {
          'Cache-Control': PUBLIC_STALE_CACHE_CONTROL,
          'X-Served-Stale': 'last-good',
        },
      });
    }
    return NextResponse.json({ error: e?.message || 'Failed to load users' }, { status: 500 });
  }
}
