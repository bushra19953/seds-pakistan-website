import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import {
  announcementAudienceValuesForViewer,
  resolveAnnouncementViewer,
  type VisibleAnnouncementQueryOptions,
} from '@/lib/announcements';
import {
  announcementsSupaServerEnabled,
  selectVisibleAnnouncements,
  supaListPublishedAnnouncementRows,
} from '@/lib/announcements-supa';

/**
 * GET /api/announcements/visible — the visible-announcements read for
 * client callers, served from fs_announcements through the Supabase
 * adapter (src/lib/announcements-supa.ts bridge over src/lib/supa).
 *
 * Contract (assumed by fetchVisibleAnnouncementsViaRoute in the seam):
 *   200 { announcements: AnnouncementDoc[], audienceValues: string[] }
 * where audienceValues is the tier set THIS route resolved for the
 * caller; the client compares it against the tier set it computed for
 * its viewer and falls back to Firestore on any mismatch.
 *
 * Gating: the route serves only when the server flag names the
 * announcements surface (SUPA_SURFACES via useSupa('announcements'));
 * otherwise 404, and every client falls back to its Firestore path —
 * so flag OFF is byte-identical to the pre-migration app. Adapter
 * failures surface as 503, which the client likewise treats as "fall
 * back", never as an empty feed.
 *
 * Auth is OPTIONAL and tier-raising only: no token (and no __session
 * cookie) resolves the anonymous viewer (public + legacy 'all'). A
 * presented token that fails verification is a 401, not a silent
 * downgrade — the client asked for a signed-in read and must fall
 * back rather than render a narrowed set as if it were complete.
 * The viewer's role comes from verifyAuthentication (the same
 * canonical resolution every other route uses) and is interpreted by
 * resolveAnnouncementViewer, so the officer set here is exactly the
 * Item 10 set the Firestore split queries enforce client-side.
 */

export const dynamic = 'force-dynamic';

/**
 * HOTFIX (fix/supa-read-fallback): the Firestore read of the visible
 * set, used only when the Supabase selection comes back empty. The
 * adapter's data-field where clause (`data->>'status'`) silently
 * matches nothing against PostgREST, so the flipped route returned a
 * 200 with an empty list while Firestore held the published
 * announcements. The Admin documents are converted to the seam's row
 * shape and run through the SAME selection function, so the fallback
 * serves exactly the set the split queries would produce. Returns
 * null when Firestore is unavailable or also yields nothing visible.
 */
async function firestoreVisibleAnnouncements(
  audienceValues: string[],
  options: VisibleAnnouncementQueryOptions,
): Promise<ReturnType<typeof selectVisibleAnnouncements> | null> {
  try {
    if (!ensureAdminInitialized()) return null;
    const db = getDb();
    if (!db) return null;
    const snap = await db.collection('announcements').get();
    const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const selected = selectVisibleAnnouncements(rows, audienceValues, options);
    if (selected.length === 0) return null;
    console.warn(
      '[api/announcements/visible] Supabase selection empty; served Firestore fallback',
      { count: selected.length },
    );
    return selected;
  } catch (err) {
    console.error('[api/announcements/visible] Firestore fallback failed:', err);
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!announcementsSupaServerEnabled()) {
    return NextResponse.json(
      { error: 'Announcements Supabase surface is not enabled' },
      { status: 404 },
    );
  }

  let viewer = resolveAnnouncementViewer({ signedIn: false });
  const presentedCredentials =
    req.headers.get('authorization') !== null ||
    req.cookies.get('__session') !== undefined;
  if (presentedCredentials) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    viewer = resolveAnnouncementViewer({
      uid: auth.user.userId,
      role: auth.user.role,
      signedIn: true,
    });
  }

  const params = req.nextUrl.searchParams;
  const options: VisibleAnnouncementQueryOptions = {};
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    const limitCount = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(limitCount) && limitCount > 0) {
      options.limitCount = limitCount;
    }
  }
  if (params.get('featured') === '1') options.isFeatured = true;

  const audienceValues = announcementAudienceValuesForViewer(viewer);
  try {
    const rows = await supaListPublishedAnnouncementRows();
    const announcements = selectVisibleAnnouncements(
      rows,
      audienceValues,
      options,
    );
    if (announcements.length > 0) {
      return NextResponse.json({ announcements, audienceValues });
    }
    // Empty selection: not proof the feed is empty (see the fallback
    // helper above). Serve Firestore when it has visible rows.
    const fallback = await firestoreVisibleAnnouncements(audienceValues, options);
    if (fallback) {
      return NextResponse.json({ announcements: fallback, audienceValues });
    }
    return NextResponse.json({ announcements, audienceValues });
  } catch (err) {
    console.error('[api/announcements/visible] Supabase read failed:', err);
    return NextResponse.json(
      { error: 'Announcements read unavailable' },
      { status: 503 },
    );
  }
}
