import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { resolveUserEmails } from '@/lib/server/user-contact';
import { Timestamp } from 'firebase-admin/firestore';
import {
  hasExpulsionRecord,
  isThresholdBanReason,
} from '@/lib/server/threshold-ban';
import { DEFAULT_WARNING_SETTINGS, WarningSettings } from '@/types/user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/banned-restore-report
 *
 * ONE-TIME report (Item 3, B10/R10): lists every banned member the
 * Phase 0 restoration paths cannot auto-restore, for case-by-case
 * decision by the Founder. A member is listed when isBanned is true
 * AND (isBlacklisted is not true OR warningCount is below the
 * blacklist threshold): the live expiry/revoke paths no longer reach
 * these cases, so they need a human decision (uphold / convert /
 * reinstate). This route decides nothing.
 *
 * The route NEVER writes to a user doc: no mass unban, no partial
 * unban, no flag changes, no notifications. Its only side effect is
 * ONE audit_logs entry (action banned_restore_report_generated) so the
 * org can prove when the list was produced and by whom. Running it
 * twice is safe.
 *
 * LIFECYCLE: this is one-time tooling. After the decisions on the
 * listed cases are taken and resolved, a follow-up change DELETES this
 * route. Do not build new features on it.
 *
 * Gated on the canManageUsers server permission, identical to
 * /api/admin/issue-warning.
 */
export async function GET(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const callerRole = String((auth.user as any).role || '');
  const callerUid = String((auth.user as any).userId || '');
  if (!(await hasServerPermissionForUser(getDb()!, callerUid, 'canManageUsers'))) {
    return NextResponse.json(
      { error: 'Forbidden: user management permission required' },
      { status: 403 }
    );
  }
  const callerName =
    typeof (auth.user as any).displayName === 'string'
      ? (auth.user as any).displayName
      : '';

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }

  // Blacklist threshold from the same config doc every warning path reads.
  let warnSettings: WarningSettings = { ...DEFAULT_WARNING_SETTINGS };
  try {
    const settingsSnap = await db.collection('warningConfig').doc('global').get();
    if (settingsSnap.exists) {
      warnSettings = {
        ...DEFAULT_WARNING_SETTINGS,
        ...(settingsSnap.data() as Partial<WarningSettings>),
      };
    }
  } catch (e) {
    console.warn(
      '[api/admin/banned-restore-report] Failed to load warningConfig, using defaults:',
      e
    );
  }
  const blacklistThreshold = warnSettings.blacklistThreshold ?? 3;

  const bannedSnap = await db
    .collection('users')
    .where('isBanned', '==', true)
    .get();

  // Contact doorway: email no longer lives on the user record;
  // resolve the reported users' addresses in one batch through the
  // gated contact records (Firebase Auth fallback).
  const emailMap = await resolveUserEmails(db, bannedSnap.docs.map(d => d.id))
    .catch(() => new Map<string, string>());

  const rows: Array<Record<string, unknown>> = [];
  for (const doc of bannedSnap.docs) {
    const data = (doc.data() || {}) as Record<string, any>;
    const warningCount = Number(data.warningCount ?? 0);
    const isBlacklisted = data.isBlacklisted === true;

    // Keep only the cases the live paths cannot reach: not blacklisted
    // (already cleared or never set) or count below threshold. A banned
    // member who is still blacklisted at/above threshold is owned by
    // the expiry/revoke paths and is excluded.
    if (isBlacklisted && warningCount >= blacklistThreshold) continue;

    const banReason = typeof data.banReason === 'string' ? data.banReason : '';
    const classification = isThresholdBanReason(banReason)
      ? 'threshold-pattern'
      : banReason === 'Manually banned by admin'
        ? 'manual'
        : 'unknown';

    rows.push({
      uid: doc.id,
      displayName: typeof data.displayName === 'string' ? data.displayName : null,
      email: emailMap.get(doc.id) ?? null,
      warningCount,
      isBlacklisted,
      blacklistReason:
        typeof data.blacklistReason === 'string' ? data.blacklistReason : null,
      banReason: banReason || null,
      classification,
      hasExpulsionRecord: await hasExpulsionRecord(db, doc.id),
    });
  }

  // The only write this route performs: one audit_logs entry.
  await db.collection('audit_logs').add({
    action: 'banned_restore_report_generated',
    actorId: callerUid,
    actorName: callerName || null,
    targetUid: 'banned_restore_report',
    data: { count: rows.length, threshold: blacklistThreshold },
    timestamp: Timestamp.now(),
  });

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    threshold: blacklistThreshold,
    count: rows.length,
    rows,
  });
}
