import { isCronRequest } from '@/lib/server/cron-auth';
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { getG3Db } from '@/lib/server/cron/g3-data';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { notificationService } from '@/lib/server/notification-service';
import { Timestamp } from 'firebase-admin/firestore';
import { DEFAULT_WARNING_SETTINGS, WarningSettings } from '@/types/user';
import { computeDerivedWarningCount } from '@/lib/server/discipline/derived-counter';
import { runDefenceWindowSweeps, runDraftExpiry, runSuspensionLifts } from '@/lib/server/discipline/stanzas';
import { processProbationRestores } from '@/lib/server/discipline/adapters-probation';
import {
  identityPrimaryFlagOn,
  primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';

export const dynamic = 'force-dynamic';

/**
 * GET/POST /api/cron/clear-probation
 *
 * Auto-archives expired probation warnings. Runs daily via Vercel Cron
 * (see vercel.json). For every warning doc in users/{uid}/warnings with
 * isActive == true that is not permanent and whose expiry has passed, the
 * cron marks it archived:
 *
 *   isActive: false, status: 'probation_cleared', expiredAt: <now>
 *
 * and repairs the member's derived state so their badge returns to good
 * standing:
 *
 *   - warningCount is set to the DERIVED count of decided disciplinary
 *     cases (Phase 2 spec E.4.7/E.6.5): legacy warnings no longer move
 *     the counter at all, and the old decrement-per-archived-warning
 *     repair is deleted,
 *   - activeWarningCount recomputed from the remaining live warnings,
 *   - isBlacklisted is NEVER cleared here: the threshold machinery is
 *     retired, and only a Founder reinstatement clears a ban,
 *   - a best-effort 'probation_cleared' notification is sent to the member.
 *
 * This route is also the INTERIM host for two discipline stanzas until
 * the daily governance cron (Workstream D) lands: expired Strike 2
 * suspension lifts (E.4.8) and pending probation role restores (D.10,
 * via the adapter - roles are restored from the recorded pre-probation
 * role, never recomputed from warning state).
 *
 * Idempotency: archived warnings carry isActive == false, so a rerun can
 * never select them again; a rerun with nothing expired performs zero
 * writes. One failing user does not abort the rest of the batch.
 *
 * Authorization follows the /api/cron/check-deadlines convention: Vercel
 * Cron supplies Authorization: Bearer <CRON_SECRET>; an authenticated admin
 * session may also trigger it manually (POST).
 */

type MillisLike =
  | { toMillis?: () => number; toDate?: () => Date; seconds?: number }
  | Date
  | string
  | number
  | null
  | undefined;

function toMillisSafe(val: MillisLike): number {
  if (val === null || val === undefined) return 0;
  const v: any = val;
  if (typeof v.toMillis === 'function') {
    try {
      const ms = v.toMillis();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  if (typeof v.toDate === 'function') {
    try {
      const ms = v.toDate().getTime();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  if (typeof v === 'object' && typeof v.seconds === 'number') {
    return v.seconds * 1000 + (v.nanoseconds || 0) / 1000000;
  }
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

// Resolve a warning's expiry: stored expiresAt, else createdAt plus the
// configured expiration window (same fallback the public registry uses).
function getWarningExpiryMillis(
  w: Record<string, any>,
  expirationDays: number
): number {
  const exp = toMillisSafe(w.expiresAt);
  if (exp > 0) return exp;
  const created = toMillisSafe(w.createdAt);
  if (created > 0) return created + expirationDays * 24 * 60 * 60 * 1000;
  return 0;
}

async function runClearProbation(req: NextRequest) {
  try {
    // 1. Authorization: Vercel Cron (Bearer CRON_SECRET) or authenticated admin.
    const authHeader = req.headers.get('Authorization');
    const isCron = isCronRequest(authHeader);
    if (!isCron) {
      const auth = await verifyAuthentication(req);
      if (!auth.authenticated || !auth.user?.role) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    if (!ensureAdminInitialized()) {
      return NextResponse.json(
        { error: 'Firebase Admin not initialized' },
        { status: 500 }
      );
    }
    const adminDb = getG3Db();
    if (!adminDb) {
      return NextResponse.json(
        { error: 'Firestore not initialized' },
        { status: 500 }
      );
    }

    // 2. Load configurable warning settings.
    let warnSettings: WarningSettings = { ...DEFAULT_WARNING_SETTINGS };
    try {
      const settingsSnap = await adminDb
        .collection('warningConfig')
        .doc('global')
        .get();
      if (settingsSnap.exists) {
        warnSettings = {
          ...DEFAULT_WARNING_SETTINGS,
          ...(settingsSnap.data() as Partial<WarningSettings>),
        };
      }
    } catch (e) {
      console.warn(
        '[cron/clear-probation] Failed to load warningConfig, using defaults:',
        e
      );
    }
    const expirationDays = warnSettings.expirationDays ?? 90;
    const blacklistThreshold = warnSettings.blacklistThreshold ?? 3;

    const now = Timestamp.now();
    const nowMillis = now.toMillis();
    const usersRef = adminDb.collection('users');

    // 3. Candidate members: anyone with a recorded warning, plus blacklisted
    // members (they may carry warningCount = 0 after expiry but still hold
    // isActive warnings). Same set the admin defaulters panel queries.
    const [warnedSnap, blacklistedSnap] = await Promise.all([
      usersRef.where('warningCount', '>', 0).get(),
      usersRef.where('isBlacklisted', '==', true).get(),
    ]);
    const userDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const snap of [warnedSnap, blacklistedSnap]) {
      for (const doc of snap.docs) {
        if (!userDocs.has(doc.id)) userDocs.set(doc.id, doc);
      }
    }

    let warningsCleared = 0;
    let usersTouched = 0;
    let usersFullyCleared = 0;
    const skippedDetails: Array<{ uid: string; reason: string }> = [];
    const failedDetails: Array<{ uid: string; error: string }> = [];

    for (const userDoc of userDocs.values()) {
      const uid = userDoc.id;
      const userData = (userDoc.data() || {}) as Record<string, any>;
      try {
        const warnSnap = await userDoc.ref
          .collection('warnings')
          .where('isActive', '==', true)
          .get();

        const expired: FirebaseFirestore.DocumentSnapshot[] = [];
        let remainingActive = 0;
        for (const wdoc of warnSnap.docs) {
          const w = (wdoc.data() || {}) as Record<string, any>;
          if (w.isPermanent === true) {
            remainingActive++;
            continue;
          }
          const expMillis = getWarningExpiryMillis(w, expirationDays);
          if (expMillis > 0 && expMillis <= nowMillis) {
            expired.push(wdoc);
          } else {
            remainingActive++;
          }
        }

        if (expired.length === 0) {
          skippedDetails.push({
            uid,
            reason: 'no expired active warnings',
          });
          continue;
        }

        // Archive each expired warning and repair the member doc atomically.
        const batch = adminDb.batch();
        for (const wdoc of expired) {
          batch.update(wdoc.ref, {
            isActive: false,
            status: 'probation_cleared',
            expiredAt: now,
            updatedAt: now,
          });
        }
        // Derived counter (E.4.7): the stored warningCount is a cache of
        // the count of decided, non-revoked strike cases. Legacy warning
        // archival does not move it; the recompute simply re-syncs it.
        const derivedCount = await computeDerivedWarningCount(adminDb, uid);
        const userUpdate: Record<string, unknown> = {
          warningCount: derivedCount,
          activeWarningCount: remainingActive,
          updatedAt: now,
        };
        batch.update(userDoc.ref, userUpdate);
        // PRIMACY (G-USER-4, U-52): under isSupaPrimary('users') the
        // users counter repair lands on the adapter first; the batch
        // (warnings archival S-25 — G-SUB-2 residue, stays Firestore —
        // plus the users update as its reverse mirror) then commits.
        if (await identityPrimaryFlagOn('users')) {
          await primaryIdentityUpdate('users', 'users', uid, userUpdate);
        }
        await batch.commit();

        warningsCleared += expired.length;
        usersTouched++;
        if (remainingActive === 0) usersFullyCleared++;

        // Best-effort member notification (never fails the run).
        notificationService
          .send(
            uid,
            {
              type: 'probation_cleared',
              title: 'Probation Cleared',
              body:
                expired.length === 1
                  ? 'Your probation period has ended and the warning on your account has been cleared. Your standing is restored.'
                  : `Your probation period has ended and ${expired.length} warnings on your account have been cleared. Your standing is restored.`,
              link: '/profile',
              metadata: { warningsCleared: expired.length },
            },
            'P1'
          )
          .catch((err) =>
            console.error(
              `[cron/clear-probation] Notification failed for ${uid}:`,
              err
            )
          );
      } catch (userError: any) {
        failedDetails.push({
          uid,
          error: userError?.message || String(userError),
        });
      }
    }

    // Discipline stanzas (interim home until the governance cron
    // lands): expired Strike 2 suspensions lift automatically, and
    // pending probation role restores are processed from the recorded
    // pre-probation role.
    const nowDate = now.toDate();
    const lifts = await runSuspensionLifts(adminDb, nowDate).catch((e) => {
      console.error('[cron/clear-probation] suspension lifts failed:', e);
      return { lifted: 0, uids: [] as string[] };
    });
    const restores = await processProbationRestores(adminDb, nowDate).catch((e) => {
      console.error('[cron/clear-probation] probation restores failed:', e);
      return { restored: 0, pending: 0, failed: 0 };
    });
    const draftExpiry = await runDraftExpiry(adminDb, nowDate).catch((e) => {
      console.error('[cron/clear-probation] draft expiry failed:', e);
      return { expired: 0, caseIds: [] as string[] };
    });
    const defenceSweeps = await runDefenceWindowSweeps(adminDb, nowDate).catch((e) => {
      console.error('[cron/clear-probation] defence sweeps failed:', e);
      return { closed: 0, caseIds: [] as string[] };
    });

    const skippedCount = skippedDetails.length;
    const failedCount = failedDetails.length;

    return NextResponse.json({
      success: true,
      usersChecked: userDocs.size,
      warningsCleared,
      usersTouched,
      usersFullyCleared,
      suspensionsLifted: lifts.lifted,
      probationRestores: restores,
      draftsExpired: draftExpiry.expired,
      defenceWindowsClosed: defenceSweeps.closed,
      skipped: skippedCount,
      failed: failedCount,
      failedDetails,
      message:
        warningsCleared === 0 && failedCount === 0
          ? `Checked ${userDocs.size} member(s); no expired active warnings found. Nothing to archive.`
          : `Checked ${userDocs.size} member(s): ${warningsCleared} warning(s) archived across ${usersTouched} member(s), ${lifts.lifted} suspension(s) lifted, ${skippedCount} skipped, ${failedCount} failed.`,
      settings: { expirationDays, blacklistThreshold },
    });
  } catch (error: any) {
    console.error('[cron/clear-probation] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to clear probation' },
      { status: 500 }
    );
  }
}

// Vercel Cron Jobs invoke the path with GET.
export async function GET(req: NextRequest) {
  return runClearProbation(req);
}

// Manual / admin-triggered invocation.
export async function POST(req: NextRequest) {
  return runClearProbation(req);
}
