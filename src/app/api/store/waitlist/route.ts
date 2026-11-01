import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { createWaitlistEntry } from '@/lib/server/vendor-shop';
import { requireStoreAdmin, serializeWaitlistEntry } from '@/lib/server/store-admin';
import type { WaitlistSource } from '@/types/store-catalogue';

export const dynamic = 'force-dynamic';

const SOURCES: WaitlistSource[] = [
  'product_page_oos',
  'product_page_rail',
  'store_search_empty',
  'order_confirmation',
];

const PHONE_PATTERN = /^\+?[0-9\s-]{7,20}$/;

/**
 * POST /api/store/waitlist (PLAN-gd Section 7). GD owns POST only;
 * the admin GET and PATCH routes are GG's.
 *
 * No login required. A present Authorization header must verify, and
 * its uid is the only source of userId; a userId sent in the body is
 * never read. Writes: 1 add to store_waitlist, plus at most 1 product
 * get when productId is present. The collection stays default-deny
 * for clients; this Admin SDK route is the only writer.
 */
export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    let userId: string | null = null;
    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      if (!authHeader.startsWith('Bearer ')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        userId = decoded.uid;
      } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const contactName = typeof body?.contactName === 'string' ? body.contactName.trim() : '';
    if (!contactName) {
      return NextResponse.json({ error: 'contactName is required' }, { status: 400 });
    }
    if (contactName.length > 100) {
      return NextResponse.json({ error: 'contactName is too long' }, { status: 400 });
    }

    const contactPhone = typeof body?.contactPhone === 'string' ? body.contactPhone.trim() : '';
    if (!contactPhone) {
      return NextResponse.json({ error: 'contactPhone is required' }, { status: 400 });
    }
    if (!PHONE_PATTERN.test(contactPhone)) {
      return NextResponse.json(
        { error: 'contactPhone is not a valid phone number' },
        { status: 400 },
      );
    }

    const source = body?.source as WaitlistSource;
    if (!SOURCES.includes(source)) {
      return NextResponse.json({ error: 'source is invalid' }, { status: 400 });
    }

    const productId = typeof body?.productId === 'string' && body.productId ? body.productId : null;
    let requestedText = typeof body?.requestedText === 'string' ? body.requestedText.trim() : '';
    if (requestedText.length > 500) {
      return NextResponse.json({ error: 'requestedText is too long' }, { status: 400 });
    }
    if (!productId && !requestedText) {
      return NextResponse.json(
        { error: 'productId or requestedText is required' },
        { status: 400 },
      );
    }
    if (productId) {
      // One product get: an unknown id is a 400; an existing product
      // (even since deactivated) lends its name as the requested text.
      const productSnap = await db.collection('products').doc(productId).get();
      if (!productSnap.exists) {
        return NextResponse.json({ error: 'Product not found' }, { status: 400 });
      }
      if (!requestedText) {
        const name = productSnap.data()?.name;
        requestedText = typeof name === 'string' ? name : '';
      }
    }

    let contactEmail: string | null = null;
    if (typeof body?.contactEmail === 'string' && body.contactEmail.trim()) {
      const email = body.contactEmail.trim();
      if (!email.includes('@') || email.length > 200) {
        return NextResponse.json(
          { error: 'contactEmail is not a valid email' },
          { status: 400 },
        );
      }
      contactEmail = email;
    }

    let searchQuery: string | null = null;
    if (typeof body?.searchQuery === 'string' && body.searchQuery) {
      if (body.searchQuery.length > 200) {
        return NextResponse.json({ error: 'searchQuery is too long' }, { status: 400 });
      }
      searchQuery = body.searchQuery;
    }

    // R-21 (coordinator): write through GA's createWaitlistEntry so the
    // entry mirrors to fs_store_waitlist; GD's direct add did not mirror.
    const entry = await createWaitlistEntry(db, {
      productId,
      requestedText,
      searchQuery,
      userId,
      contactName,
      contactPhone,
      contactEmail,
      source,
      status: 'open',
    });
    return NextResponse.json({ ok: true, id: entry.id }, { status: 201 });
  } catch (e: any) {
    console.error('[waitlist API] POST error:', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

/**
 * Waitlist admin list (GG). Union resolution at the GG merge: GD's POST
 * above (with the R-21 mirror write) plus GG's GET here; the PATCH lives
 * on the [id] route.
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
