import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { notificationService } from '@/lib/server/notification-service';
import {
  evaluateRestoration,
  hasExpulsionRecord,
  isThresholdBanReason,
} from '@/lib/server/threshold-ban';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { DEFAULT_WARNING_SETTINGS, WarningSettings } from '@/types/user';

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
 *   - warningCount decremented by the number of archived warnings (mirrors
 *     the manual-revoke path in /admin/defaulters),
 *   - activeWarningCount recomputed from the remaining live warnings,
 *   - isBlacklisted cleared when the decremented count falls below the
 *     configured blacklist threshold (again mirroring manual revoke),
 *   - when the blacklist clears, a ban the warning threshold itself
 *     created (banReason matching a threshold pattern, and no expulsion
 *     record) is cleared in the SAME batch (isBanned false, banReason
 *     ""), so restoration actually restores. Manual bans and
 *     unknown-reason bans are never cleared here,
 *   - the 'probation_cleared' "standing restored" notification is sent
 *     only after the batch commits AND a fresh re-read of the user doc
 *     confirms isBanned !== true and isBlacklisted !== true. When the
 *     re-read still shows a ban, nothing is sent to the member; the doc
 *     is flagged restorationReviewNeeded and a restoration_blocked
 *     audit_logs entry is written instead. A failed re-read also sends
 *     nothing (fail closed).
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
    const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
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
    const adminDb = getDb();
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
    // isActive warnings), plus banned members (the orphan shape: isBanned
    // true with isBlacklisted false and warningCount 0, reachable here so
    // an expired live warning can still drive the restoration rule).
    const [warnedSnap, blacklistedSnap, bannedSnap] = await Promise.all([
      usersRef.where('warningCount', '>', 0).get(),
      usersRef.where('isBlacklisted', '==', true).get(),
      usersRef.where('isBanned', '==', true).get(),
    ]);
    const userDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const snap of [warnedSnap, blacklistedSnap, bannedSnap]) {
      for (const doc of snap.docs) {
        if (!userDocs.has(doc.id)) userDocs.set(doc.id, doc);
      }
    }

    let warningsCleared = 0;
    let usersTouched = 0;
    let usersFullyCleared = 0;
    let unblacklistedCount = 0;
    let unbannedCount = 0;
    const restorationBlockedUids: string[] = [];
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

        const currentCount = Number(userData.warningCount || 0);
        const newCount = Math.max(0, currentCount - expired.length);

        // Restoration evaluation (Item 3, R5). The expulsion lookup runs
        // only when the blacklist is clearing AND a threshold-pattern ban
        // is present (cheap short-circuit), before the batch is built.
        const thresholdBanReason = isThresholdBanReason(userData.banReason);
        let expulsionRecord = false;
        if (
          userData.isBlacklisted === true &&
          newCount < blacklistThreshold &&
          userData.isBanned === true &&
          thresholdBanReason
        ) {
          expulsionRecord = await hasExpulsionRecord(adminDb, uid);
        }
        const { clearBlacklist: shouldUnblacklist, clearBan } =
          evaluateRestoration(userData, newCount, blacklistThreshold, {
            isThresholdBanReason: thresholdBanReason,
            hasExpulsionRecord: expulsionRecord,
          });

        // Archive each expired warning and repair the member doc atomically.
        // Fields first, notification after, never the reverse: when the
        // blacklist clears, the threshold-created ban clears in the SAME
        // batch (R5), so a ban never survives a commit that cleared its
        // blacklist.
        const batch = adminDb.batch();
        for (const wdoc of expired) {
          batch.update(wdoc.ref, {
            isActive: false,
            status: 'probation_cleared',
            expiredAt: now,
            updatedAt: now,
          });
        }
        const userUpdate: Record<string, unknown> = {
          warningCount: FieldValue.increment(-expired.length),
          activeWarningCount: remainingActive,
          updatedAt: now,
        };
        if (shouldUnblacklist) {
          userUpdate.isBlacklisted = false;
          userUpdate.blacklistReason = '';
          userUpdate.blacklistStatus = null;
          userUpdate.blacklistClearedAt = now;
        }
        if (clearBan) {
          userUpdate.isBanned = false;
          userUpdate.banReason = '';
        }
        batch.update(userDoc.ref, userUpdate);
        await batch.commit();

        warningsCleared += expired.length;
        usersTouched++;
        if (remainingActive === 0) usersFullyCleared++;
        if (shouldUnblacklist) unblacklistedCount++;
        if (clearBan) unbannedCount++;

        // Notification guard (Item 3, R6). Order is mandatory: (1) batch
        // commit (done above), (2) re-read the user doc, (3) decide,
        // (4) notify or queue. A re-read failure throws into the per-user
        // catch below: nothing is sent and the user lands in
        // failedDetails (fail closed).
        const freshSnap = await userDoc.ref.get();
        const freshData = (freshSnap.data() || {}) as Record<string, any>;

        if (freshData.isBanned === true) {
          // Still banned (manual ban, unknown-reason ban, or expulsion
          // record): send NOTHING to the member. Queue the case for
          // admin review and record why the restore was blocked.
          restorationBlockedUids.push(uid);
          const followUp = adminDb.batch();
          followUp.update(userDoc.ref, {
            restorationReviewNeeded: true,
            updatedAt: now,
          });
          followUp.set(adminDb.collection('audit_logs').doc(), {
            action: 'restoration_blocked',
            actorId: 'system',
            actorName: null,
            targetUid: uid,
            data: {
              warningsCleared: expired.length,
              banReason: freshData.banReason ?? userData.banReason ?? null,
              reason:
                'Standing restoration blocked: the member remains banned after warning expiry, so no restored-standing notification was sent.',
            },
            timestamp: now,
          });
          await followUp.commit();
        } else if (freshData.isBlacklisted === true) {
          // Count is still at or above the threshold: a normal
          // still-blacklisted state, not a defect. No restored-standing
          // wording, no queue flag, no notification.
        } else {
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
                link: '/warning-registry',
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
        }
      } catch (userError: any) {
        failedDetails.push({
          uid,
          error: userError?.message || String(userError),
        });
      }
    }

    const skippedCount = skippedDetails.length;
    const failedCount = failedDetails.length;

    return NextResponse.json({
      success: true,
      usersChecked: userDocs.size,
      warningsCleared,
      usersTouched,
      usersFullyCleared,
      unblacklisted: unblacklistedCount,
      unbanned: unbannedCount,
      restorationBlocked: restorationBlockedUids,
      restorationBlockedCount: restorationBlockedUids.length,
      skipped: skippedCount,
      failed: failedCount,
      failedDetails,
      message:
        warningsCleared === 0 && failedCount === 0
          ? `Checked ${userDocs.size} member(s); no expired active warnings found. Nothing to archive.`
          : `Checked ${userDocs.size} member(s): ${warningsCleared} warning(s) archived across ${usersTouched} member(s), ${unblacklistedCount} unblacklisted, ${skippedCount} skipped, ${failedCount} failed.`,
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
