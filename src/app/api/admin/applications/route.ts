import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  resolveApplicationsSupaAdapter,
  listApplications,
} from '@/lib/applications-supa';
import {
  FIRESTORE_LIST_DEADLINE_MS,
  withReadDeadline,
} from '@/lib/server/read-deadline';

async function verifyAdmin(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const token = authHeader.split('Bearer ')[1];
  if (!ensureAdminInitialized()) throw Object.assign(new Error('Server error'), { status: 500 });
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}

// The applications timestamp fields, serialized to ISO strings exactly
// like the chapter-applications template route serializes its own
// (`.toDate().toISOString()`, null when absent/unparseable).
const TIMESTAMP_FIELDS = [
  'created_at',
  'updated_at',
  'last_saved_at',
  'createdAt',
  'updatedAt',
  'dateCreated',
  'dateUpdated',
  'reviewedAt',
  'reviewed_at',
] as const;

function serializeTimestamps(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...data };
  for (const field of TIMESTAMP_FIELDS) {
    out[field] = (data[field] as any)?.toDate?.()?.toISOString() || null;
  }
  return out;
}

// GET: List applications (with optional status filter). Unlike the
// chapter-applications twin there is NO orderBy and NO limit here:
// the admin list's status counts, CSV export and intake pace cohort
// all consume the full filtered set, and ordering stays client-side
// by created_at, exactly as the Firestore listener path behaves.
export async function GET(request: NextRequest) {
  try {
    const decoded = await verifyAdmin(request);
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageApplications');

    if (!canManage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const url = new URL(request.url);
    const statusFilter = url.searchParams.get('status');

    // Supa read path (flag-gated seam): flag OFF / adapter unavailable
    // resolves null and the Firestore query below runs unchanged.
    // An adapter FAULT (adapter resolved, list threw) FAILS LOUD with
    // a 502 instead of silently falling back to the unbounded
    // Firestore scan below (P1 loudness doctrine, read-bleed census
    // 25): a degraded seam must surface as an error, never as a
    // full-collection read the operator cannot see.
    const supaAdapter = await resolveApplicationsSupaAdapter();
    if (supaAdapter) {
      try {
        const docs = await listApplications(supaAdapter, statusFilter);
        const applications = docs.map((data) => serializeTimestamps(data));
        return NextResponse.json({ applications });
      } catch (supaErr) {
        console.error('[admin/applications API] Supa list failed; failing loud (no Firestore fallback scan):', supaErr);
        return NextResponse.json(
          { error: 'Applications data source unavailable' },
          { status: 502 },
        );
      }
    }

    let q: any = db.collection('applications');
    if (statusFilter && statusFilter !== 'all') {
      q = q.where('status', '==', statusFilter);
    }

    // Fail-fast deadline (perf program, 2026-10-30): this fallback
    // scan is the route's heaviest Firestore read; on a degraded
    // Firestore it rode the GAPIC retry budget (60s/RPC, 600s total)
    // and pinned the single instance. It now races a 10s app-level
    // deadline and fails loud through the outer catch (500 with the
    // deadline message) instead of hanging the request.
    const snap = await withReadDeadline<any>(
      'admin-applications:list',
      FIRESTORE_LIST_DEADLINE_MS,
      () => q.get(),
    );
    const applications = snap.docs.map((d: any) => {
      const data = d.data();
      return serializeTimestamps({ id: d.id, ...data });
    });

    return NextResponse.json({ applications });
  } catch (err: any) {
    console.error('[admin/applications API] GET error:', err);
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
