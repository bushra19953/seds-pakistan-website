import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { requireStoreAdmin, serializeWaitlistEntry } from '@/lib/server/store-admin';
import { mirrorVendorShopUpdate } from '@/lib/supa/vendor-shop-mirror';

const PATCHABLE_STATUSES = ['notified', 'fulfilled', 'closed', 'open'] as const;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStoreAdmin(request);
  if ('response' in auth) return auth.response;
  const { uid, db } = auth;
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
    }
    const extra = Object.keys(body).filter((k) => k !== 'status');
    if (extra.length > 0) {
      return NextResponse.json(
        { error: 'Only status can be updated', code: 'forbidden_field', fields: extra },
        { status: 409 },
      );
    }
    const status = body.status;
    if (typeof status !== 'string' || !(PATCHABLE_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: 'status is invalid' }, { status: 400 });
    }
    const ref = db.collection('store_waitlist').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: 'Waitlist entry not found' }, { status: 404 });

    const update = { status, statusChangedBy: uid, updatedAt: FieldValue.serverTimestamp() };
    await ref.update(update);
    await mirrorVendorShopUpdate('store_waitlist', id, { status }).catch(() => false);

    const after = await ref.get();
    return NextResponse.json({
      ok: true,
      entry: serializeWaitlistEntry(id, (after.data() ?? {}) as Record<string, unknown>),
    });
  } catch (err) {
    console.error('[waitlist API] PATCH error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
