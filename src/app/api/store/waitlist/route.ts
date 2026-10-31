import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { createWaitlistEntry } from '@/lib/server/vendor-shop';
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
