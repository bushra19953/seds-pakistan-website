import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

/**
 * POST /api/analytics/track — WS10 route for the two client
 * analytics trackers (PageVisitTracker + AnalyticsEventTracker),
 * previously client writes to `pageVisits` (through
 * firestore-wrapper) and `analyticsEvents` (direct SDK). Neither
 * collection is a webhook-dispatch collection and no Supabase write
 * mirror exists for them today: Firestore-only parity.
 *
 * Both trackers only ever run for signed-in users, so the route
 * requires a verified session and derives userId from the token.
 *
 * Kinds:
 *   { kind: 'pageVisit', path } — replicates the tracker's
 *     update-with-increment / not-found-then-set-merge logic for
 *     BOTH docs: pageVisits/{pageId} (pageId = path with '/'
 *     replaced by '_', or 'home') carrying { path, visits,
 *     lastVisit }, and pageVisits/site_total_visits carrying
 *     { visits, lastVisit } (no path field — the client's total
 *     update had none).
 *   { kind: 'analyticsEvent', event } — an Admin add to
 *     analyticsEvents with the tracker's exact per-type field set
 *     (page_view: referrer + ua; click: targetId + label + href),
 *     string fields length-capped to the client's own caps
 *     (ua 128, label 64) plus sane bounds elsewhere.
 */

export const dynamic = 'force-dynamic';

function cap(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  return v.slice(0, max);
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  const uid = auth.user.userId;

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.kind === 'pageVisit') {
    const path = typeof body.path === 'string' ? body.path : '';
    if (!path) return NextResponse.json({ error: 'path is required' }, { status: 400 });
    const pageId = path.replace(/\//g, '_') || 'home';
    const st = () => FieldValue.serverTimestamp();
    const bump = async (ref: FirebaseFirestore.DocumentReference, withPath: boolean) => {
      try {
        await ref.update({
          ...(withPath ? { path } : {}),
          visits: FieldValue.increment(1),
          lastVisit: st(),
        });
      } catch (err: any) {
        if (err?.code === 'not-found' || err?.code === 5) {
          await ref.set(
            { ...(withPath ? { path } : {}), visits: 1, lastVisit: st() },
            { merge: true },
          );
        } else {
          throw err;
        }
      }
    };
    await bump(db.collection('pageVisits').doc(pageId), true);
    await bump(db.collection('pageVisits').doc('site_total_visits'), false);
    return NextResponse.json({ ok: true });
  }

  if (body.kind === 'analyticsEvent') {
    const event = (body.event ?? {}) as Record<string, any>;
    const type = event.type === 'click' ? 'click' : event.type === 'page_view' ? 'page_view' : '';
    if (!type) return NextResponse.json({ error: 'Invalid event type' }, { status: 400 });
    const base: Record<string, any> = {
      type,
      path: cap(event.path, 512),
      userId: uid,
      timestamp: FieldValue.serverTimestamp(),
    };
    const data =
      type === 'page_view'
        ? { ...base, referrer: cap(event.referrer, 512), ua: cap(event.ua, 128) }
        : {
            ...base,
            targetId: cap(event.targetId, 128),
            label: cap(event.label, 64),
            href: cap(event.href, 512),
          };
    // Field order in the stored docs was type, path, userId,
    // <type fields>, timestamp; rebuild in that order for tidiness
    // (Firestore field order is not semantic).
    const ordered: Record<string, any> = {
      type: data.type,
      path: data.path,
      userId: data.userId,
      ...(type === 'page_view'
        ? { referrer: data.referrer, ua: data.ua }
        : { targetId: data.targetId, label: data.label, href: data.href }),
      timestamp: data.timestamp,
    };
    await db.collection('analyticsEvents').add(ordered);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Invalid kind' }, { status: 400 });
}
