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
import { listPointsLedgerForUserFromSupa } from '@/lib/supa/gamification';
import { listDocsViaSeam } from '@/lib/supa/seam-tasks-lists';
import { tryGetProfileUser } from '@/lib/supa-seams/profile';
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

// RBT2 short server cache: 30s, matching the Cache-Control header
// this route already sends (private, max-age=30). Keyed by userId;
// only successful payloads are stored, and the cache is consulted
// AFTER the 401/403 gates below, so auth outcomes are never cached
// and a cached payload can never widen access.
const TELEMETRY_CACHE_TTL_MS = 30_000;
const telemetryCache = new Map<string, { payload: AnyRecord; timestamp: number }>();

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

  // RBT2: cache hit AFTER auth (see the cache note above).
  const cached = telemetryCache.get(userId);
  if (cached && Date.now() - cached.timestamp < TELEMETRY_CACHE_TTL_MS) {
    return NextResponse.json(cached.payload, {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' },
    });
  }

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

  try {
    // RBT2 (census 19/09): seam-first reads.
    // - tasks: both assignment forms via the tasks lists seam
    //   (limit 200 per leg, same as Firestore); if either leg misses,
    //   BOTH legs run on Firestore so the union stays atomic.
    // - points_ledger: ONE key form via the gamification seam
    //   (listPointsLedgerForUserFromSupa queries user_id == userId,
    //   limit 300, once) -- the old route DOUBLE-PAID this read with
    //   parallel snake (user_id, 300) + camel (userId, 300) queries.
    //   The Firestore fallback below keeps the dual query, because in
    //   Firestore both key generations genuinely exist; the mirror's
    //   canonical writers are snake-only.
    // - users/{userId}: the profile seam (surface 'profile').
    // HELD on Firestore: users/{userId}/warnings (no
    // fs_group_warnings landing table) and warningConfig/global.
    const [seamTasks1, seamTasks2, seamLedger, seamUser] = await Promise.all([
      listDocsViaSeam('tasks', { where: [['assigneeId', '==', userId]], limit: 200 }),
      listDocsViaSeam('tasks', { where: [['assigneeIds', 'array-contains', userId]], limit: 200 }),
      listPointsLedgerForUserFromSupa(userId, 300),
      tryGetProfileUser(userId),
    ]);

    const [s1, s2, ledgerSnake, ledgerCamel, userSnap, warningsSnap] = await Promise.all([
      seamTasks1 && seamTasks2
        ? Promise.resolve(null)
        : db.collection('tasks').where('assigneeId', '==', userId).limit(200).get(),
      seamTasks1 && seamTasks2
        ? Promise.resolve(null)
        : db.collection('tasks').where('assigneeIds', 'array-contains', userId).limit(200).get(),
      seamLedger
        ? Promise.resolve(null)
        : db.collection('points_ledger').where('user_id', '==', userId).limit(300).get(),
      seamLedger
        ? Promise.resolve(null)
        : db.collection('points_ledger').where('userId', '==', userId).limit(300).get(),
      seamUser.status === 'ok'
        ? Promise.resolve(null)
        : db.collection('users').doc(userId).get(),
      // Warnings bound: limit(50), no orderBy — discipline formal warnings
      // carry issuedAt, not createdAt, and orderBy would exclude them.
      db.collection('users').doc(userId).collection('warnings').limit(50).get(),
    ]);

    const seen = new Set<string>();
    const taskDocs: Array<{ id: string; data: () => any }> = [];
    const taskSnaps = seamTasks1 && seamTasks2 ? [seamTasks1, seamTasks2] : [s1, s2];
    for (const snap of taskSnaps) {
      if (!snap) continue;
      for (const d of snap.docs) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        taskDocs.push(d as { id: string; data: () => any });
      }
    }
    const taskById = new Map<string, AnyRecord>();
    for (const t of snapToPlain(taskDocs)) taskById.set(t.id, t);

    const ledgerSeen = new Set<string>();
    const ledger: AnyRecord[] = [];
    if (seamLedger) {
      for (const row of seamLedger) {
        const id = String((row as AnyRecord).id ?? '');
        if (!id || ledgerSeen.has(id)) continue;
        ledgerSeen.add(id);
        const { id: _rowId, ...data } = row as AnyRecord;
        void _rowId;
        ledger.push({ id, ...data });
      }
    } else {
      for (const snap of [ledgerSnake, ledgerCamel]) {
        if (!snap) continue;
        for (const d of snap.docs) {
          if (ledgerSeen.has(d.id)) continue;
          ledgerSeen.add(d.id);
          const data = d.data() || {};
          ledger.push({ id: d.id, ...data });
        }
      }
    }

    const userData = seamUser.status === 'ok'
      ? ((seamUser.value.data() as AnyRecord) ?? {})
      : userSnap && userSnap.exists ? (userSnap.data() as AnyRecord) : {};
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

    const payload = {
      userId,
      telemetry,
      missionTimeline: timeline,
      probation,
      certificates,
    };
    telemetryCache.set(userId, { payload, timestamp: Date.now() });

    return NextResponse.json(
      payload,
      { headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' } },
    );
  } catch (error) {
    console.error('[telemetry:route] error:', error);
    return NextResponse.json({ error: 'Failed to compute telemetry' }, { status: 500 });
  }
}
