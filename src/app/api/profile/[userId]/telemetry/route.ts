/**
 * WS3 — GET /api/profile/[userId]/telemetry
 *
 * Private member-profile telemetry. Returns:
 * - telemetry: aggregated from the `tasks` collection and `points_ledger`
 *   (read-only aggregation; no writes)
 * - missionTimeline: chronological completed tasks with proof links
 * - probation: active warnings, expiry countdown, redemption checklist
 *
 * Access: the member themselves, or admins (superadmin /
 * president_national roles, or the founder). Every 401/403 path returns
 * before any Firestore read. Warnings never leave this route: the public
 * portfolio route does not call it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { isFounder } from '@/lib/roles';
import {
  buildMissionTimeline,
  computeTelemetry,
  sanitizeCertificateForVault,
  summarizeWarnings,
  type AnyRecord,
} from '@/lib/profile-hub/telemetry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ADMIN_ROLE_TOKENS = new Set(['superadmin', 'president_national', 'founder_patron']);

function isAdminAuth(authUser: AnyRecord | undefined): boolean {
  if (!authUser) return false;
  if (isFounder(authUser.userId)) return true;
  const role = String(authUser.role || '').toLowerCase();
  if (ADMIN_ROLE_TOKENS.has(role)) return true;
  const claims = authUser.user?.claims || {};
  if (claims.superadmin === true || claims.admin === true) return true;
  return false;
}

function snapToPlain(docs: Array<{ id: string; data: () => any }>): AnyRecord[] {
  return docs.map((d) => {
    const data = d.data() || {};
    const out: AnyRecord = { id: d.id };
    for (const [k, v] of Object.entries(data)) {
      out[k] = v && typeof v === 'object' && typeof (v as any).toDate === 'function'
        ? (v as any).toDate().toISOString()
        : v;
    }
    return out;
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  if (!userId) return NextResponse.json({ error: 'User ID is required' }, { status: 400 });

  const authResult = await verifyAuthentication(request);
  if (!authResult.authenticated || !authResult.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const isOwner = authResult.user.userId === userId;
  if (!isOwner && !isAdminAuth(authResult.user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

  try {
    // Union both assignment forms (same as /api/profile/[userId]).
    const [s1, s2, ledgerSnake, ledgerCamel, userSnap, warningsSnap] = await Promise.all([
      db.collection('tasks').where('assigneeId', '==', userId).limit(200).get(),
      db.collection('tasks').where('assigneeIds', 'array-contains', userId).limit(200).get(),
      db.collection('points_ledger').where('user_id', '==', userId).limit(300).get(),
      db.collection('points_ledger').where('userId', '==', userId).limit(300).get(),
      db.collection('users').doc(userId).get(),
      db.collection('users').doc(userId).collection('warnings').get(),
    ]);

    const seen = new Set<string>();
    const taskDocs: Array<{ id: string; data: () => any }> = [];
    for (const snap of [s1, s2]) {
      for (const d of snap.docs) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        taskDocs.push(d);
      }
    }
    const taskById = new Map<string, AnyRecord>();
    for (const t of snapToPlain(taskDocs)) taskById.set(t.id, t);

    const ledgerSeen = new Set<string>();
    const ledger: AnyRecord[] = [];
    for (const snap of [ledgerSnake, ledgerCamel]) {
      for (const d of snap.docs) {
        if (ledgerSeen.has(d.id)) continue;
        ledgerSeen.add(d.id);
        const data = d.data() || {};
        ledger.push({ id: d.id, ...data });
      }
    }

    const userData = userSnap.exists ? (userSnap.data() as AnyRecord) : {};
    const rawWarnings = warningsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    let blacklistThreshold = 3;
    try {
      const settingsSnap = await db.collection('warningConfig').doc('global').get();
      if (settingsSnap.exists) {
        const n = Number((settingsSnap.data() as AnyRecord)?.blacklistThreshold);
        if (Number.isFinite(n) && n > 0) blacklistThreshold = n;
      }
    } catch {
      // Global warning settings are optional; the default holds.
    }

    const telemetry = computeTelemetry({
      tasks: Array.from(taskById.values()),
      ledgerEntries: ledger,
      counters: userData,
    });
    const timeline = buildMissionTimeline(Array.from(taskById.values()));
    const probation = summarizeWarnings(rawWarnings, userData, new Date(), blacklistThreshold);

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_BASE_URL || '';
    let certificates: AnyRecord[] = [];
    try {
      const certSnap = await db
        .collection('certificates')
        .where('userId', '==', userId)
        .limit(100)
        .get();
      certificates = certSnap.docs.map((d) =>
        sanitizeCertificateForVault({ id: d.id, ...(d.data() || {}) }, baseUrl),
      );
    } catch (e) {
      console.warn('[telemetry:route] certificates fetch failed:', e instanceof Error ? e.message : e);
    }

    return NextResponse.json(
      {
        userId,
        telemetry,
        missionTimeline: timeline,
        probation,
        certificates,
      },
      { headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' } },
    );
  } catch (error) {
    console.error('[telemetry:route] error:', error);
    return NextResponse.json({ error: 'Failed to compute telemetry' }, { status: 500 });
  }
}
