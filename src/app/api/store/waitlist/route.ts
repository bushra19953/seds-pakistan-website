import { NextRequest, NextResponse } from 'next/server';
import { requireStoreAdmin, serializeWaitlistEntry } from '@/lib/server/store-admin';

/**
 * Waitlist admin list (GG). The POST create handler on this same path is
 * GD's (R-12 split: GD owns POST only; GG owns GET/PATCH and the tab).
 */
const WAITLIST_STATUSES = ['open', 'notified', 'fulfilled', 'closed'] as const;

export async function GET(request: NextRequest) {
  const auth = await requireStoreAdmin(request);
  if ('response' in auth) return auth.response;
  const { db } = auth;
  try {
    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status') ?? 'all';
    if (statusParam !== 'all' && !(WAITLIST_STATUSES as readonly string[]).includes(statusParam)) {
      return NextResponse.json({ error: 'status is invalid' }, { status: 400 });
    }
    const limitRaw = Number(url.searchParams.get('limit') ?? '50');
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
    const cursor = url.searchParams.get('cursor');

    let q = db.collection('store_waitlist').orderBy('createdAt', 'desc');
    if (statusParam !== 'all') q = db.collection('store_waitlist').where('status', '==', statusParam).orderBy('createdAt', 'desc');
    if (cursor) {
      const cursorDoc = await db.collection('store_waitlist').doc(cursor).get();
      if (cursorDoc.exists) q = q.startAfter(cursorDoc);
    }
    const snap = await q.limit(limit + 1).get();
    const hasMore = snap.docs.length > limit;
    const page = hasMore ? snap.docs.slice(0, limit) : snap.docs;
    const entries = page.map((d) => serializeWaitlistEntry(d.id, d.data() as Record<string, unknown>));
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
    return NextResponse.json({ ok: true, entries, count: entries.length, hasMore, nextCursor });
  } catch (err) {
    console.error('[waitlist API] GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
