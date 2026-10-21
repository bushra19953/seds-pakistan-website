import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { notificationService } from '@/lib/server/notification-service';
import { buildThresholdBlacklistUpdate } from '@/lib/server/threshold-ban';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  DEFAULT_WARNING_SETTINGS,
  WarningSettings,
  WarningType,
} from '@/types/user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_WARNING_TYPES: WarningType[] = [
  'misconduct',
  'missed-deadline',
  'insubordination',
  'attendance',
  'policy-violation',
  'other',
];

const VALID_SEVERITIES = ['low', 'medium', 'high'] as const;

/**
 * POST /api/admin/issue-warning
 *
 * Issues a formal warning to a user entirely server-side (Admin SDK bypasses
 * Firestore rules, so no new client rules are needed for points_audit or the
 * penalty writes). On every call the route:
 *  1. creates the warning doc in users/{uid}/warnings (with penaltyPoints),
 *  2. increments warningCount on users/{uid},
 *  3. when penaltyPoints > 0: deducts points via FieldValue.increment(-n),
 *     bumps totalPenalties and writes a points_audit doc (reason
 *     'manual_warning_penalty', actorId = caller). Every warning, including
 *     a 0-point one, sends the member a 'warning_issued' notification (P0),
 *  4. applies the blacklist threshold: reaching it sets isBlacklisted
 *     only, labelled blacklistStatus 'pending_review' (shared helper
 *     buildThresholdBlacklistUpdate in src/lib/server/threshold-ban.ts).
 *     The threshold NEVER sets isBanned or banReason; bans come only
 *     from a manual admin toggle or a future Board expulsion workflow,
 *  5. when demoteToRole is provided: writes BOTH role stores
 *     (roles/{uid}.role and users/{uid}.role + displayRole), per the repo
 *     demotion-staleness rule (AGENTS.md): server permission checks read
 *     roles/{uid} first, so a demotion that only touches users/{uid} is
 *     silently ignored.
 *
 * Gated on the canManageUsers server permission (same convention as
 * /api/admin/sync-user-role).
 */
export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermission(callerRole, 'canManageUsers'))) {
    return NextResponse.json(
      { error: 'Forbidden: user management permission required' },
      { status: 403 }
    );
  }
  const callerUid = String((auth.user as any).userId || '');
  const callerName =
    typeof (auth.user as any).displayName === 'string'
      ? (auth.user as any).displayName
      : '';

  const body = await request.json().catch(() => ({}));
  const userUid =
    typeof body.userUid === 'string' ? body.userUid.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const warningType: WarningType = VALID_WARNING_TYPES.includes(body.warningType)
    ? body.warningType
    : 'misconduct';
  const isPermanent = body.isPermanent === true;
  const expiresDaysRaw = Number(body.expiresDays);
  const penaltyPoints = Math.max(0, Math.floor(Number(body.penaltyPoints) || 0));
  const demoteToRole =
    typeof body.demoteToRole === 'string' ? body.demoteToRole.trim().toLowerCase() : '';
  const severity: (typeof VALID_SEVERITIES)[number] = (
    VALID_SEVERITIES as readonly string[]
  ).includes(body.severity)
    ? body.severity
    : 'medium';
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '';

  if (!userUid) {
    return NextResponse.json({ error: 'userUid is required' }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }

  // Load configurable warning settings (blacklist threshold lives here).
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
      '[api/admin/issue-warning] Failed to load warningConfig, using defaults:',
      e
    );
  }
  const blacklistThreshold = warnSettings.blacklistThreshold ?? 3;

  const userRef = db.collection('users').doc(userUid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  const userData = userSnap.data() || {};
  const currentWarnings = Number(userData.warningCount || 0);
  const newWarningCount = currentWarnings + 1;
  const shouldBlacklist =
    newWarningCount >= blacklistThreshold && !userData.isBlacklisted;

  const now = Timestamp.now();
  // Permanent warnings never expire organically (100-year sentinel, same as
  // the client dialogs); otherwise use the caller-supplied expiry.
  const days = isPermanent
    ? 36500
    : Math.max(
        1,
        Number.isFinite(expiresDaysRaw) && expiresDaysRaw > 0
          ? expiresDaysRaw
          : warnSettings.expirationDays ?? 90
      );
  const expiresAt = Timestamp.fromMillis(now.toMillis() + days * 24 * 60 * 60 * 1000);

  const warningData = {
    userId: userUid,
    reason,
    type: warningType,
    severity,
    notes,
    createdBy: callerUid,
    createdByName: callerName || null,
    createdAt: now,
    expiresAt,
    isActive: true,
    isPermanent,
    appealStatus: 'none',
    penaltyPoints,
  };

  const historyEntry = {
    date: new Date().toISOString(),
    reason,
    revoked: false,
  };

  const userUpdate: Record<string, unknown> = {
    warningCount: FieldValue.increment(1),
    warningHistory: FieldValue.arrayUnion(historyEntry),
    updatedAt: now,
  };

  if (penaltyPoints > 0) {
    userUpdate.points = FieldValue.increment(-penaltyPoints);
    userUpdate.totalPenalties = FieldValue.increment(penaltyPoints);
  }

  if (shouldBlacklist) {
    // Threshold rule (Item 3, R1): blacklist only, labelled pending
    // review. isBanned and banReason are NOT written here.
    Object.assign(
      userUpdate,
      buildThresholdBlacklistUpdate(blacklistThreshold, now)
    );
  }

  const batch = db.batch();
  const warningRef = userRef.collection('warnings').doc();
  batch.set(warningRef, warningData);

  if (demoteToRole) {
    // Repo demotion-staleness rule (AGENTS.md): the canonical role store is
    // roles/{uid}.role and the legacy mirror is users/{uid}.role; both must
    // be written, otherwise server permission checks honor the stale role.
    batch.set(
      db.collection('roles').doc(userUid),
      { role: demoteToRole, updatedAt: now },
      { merge: true }
    );
    userUpdate.role = demoteToRole;
    userUpdate.displayRole = demoteToRole;
  }

  batch.update(userRef, userUpdate);

  let pointsAuditRef: FirebaseFirestore.DocumentReference | null = null;
  if (penaltyPoints > 0) {
    pointsAuditRef = db.collection('points_audit').doc();
    batch.set(pointsAuditRef, {
      userId: userUid,
      delta: -penaltyPoints,
      reason: 'manual_warning_penalty',
      timestamp: now,
      actorId: callerUid,
    });
  }

  // Audit trail (Item 3, R9): one audit_logs entry per warning in the
  // same batch, plus a second entry when the warning also demotes.
  // Shape: { action, actorId, actorName, targetUid, data, timestamp }.
  const auditLogRef = db.collection('audit_logs').doc();
  batch.set(auditLogRef, {
    action: 'warning_issued',
    actorId: callerUid,
    actorName: callerName || null,
    targetUid: userUid,
    data: {
      warningId: warningRef.id,
      reason,
      type: warningType,
      severity,
      penaltyPoints,
      warningCount: newWarningCount,
      blacklisted: shouldBlacklist,
      source: 'manual',
    },
    timestamp: now,
  });
  if (demoteToRole) {
    batch.set(db.collection('audit_logs').doc(), {
      action: 'warning_demotion',
      actorId: callerUid,
      actorName: callerName || null,
      targetUid: userUid,
      data: {
        warningId: warningRef.id,
        demoteToRole,
      },
      timestamp: now,
    });
  }

  await batch.commit();

  // Best-effort notifications after the writes land (cron route convention).
  const notify = (
    payload: Parameters<typeof notificationService.send>[1],
    priority: 'P0' | 'P1' = 'P0'
  ) =>
    notificationService
      .send(userUid, payload, priority)
      .catch((err) =>
        console.error('[api/admin/issue-warning] Notification failed:', err)
      );

  // Every warning notifies the member (Item 3, R7), including 0-point
  // warnings: type warning_issued at P0 (in-app always, email where the
  // user doc has an email). The body states the reason verbatim, the new
  // count against the threshold, the expiry, and, only when points were
  // deducted, the deduction sentence.
  const expirySentence = isPermanent
    ? 'This is a permanent warning.'
    : `This warning expires in ${days} day${days === 1 ? '' : 's'}.`;
  const pointsSentence =
    penaltyPoints > 0
      ? ` ${penaltyPoints} point${penaltyPoints === 1 ? '' : 's'} deducted from your account.`
      : '';
  void notify({
    type: 'warning_issued',
    title: 'Warning Issued',
    body: `A warning was issued for: ${reason}. Warning ${newWarningCount} of ${blacklistThreshold}. ${expirySentence}${pointsSentence}`,
    link: `/profile/unified?uid=${userUid}`,
    metadata: { warningId: warningRef.id },
  });

  if (shouldBlacklist) {
    void notify({
      type: 'account_blacklisted',
      title: 'Account Blacklisted - Pending Review',
      body: `Your account has been blacklisted pending review after reaching ${blacklistThreshold} warnings. Blacklisting blocks event registration and related actions while it is in place.`,
      link: `/profile/unified?uid=${userUid}`,
      metadata: { warningId: warningRef.id },
    });
  }

  if (demoteToRole) {
    void notify(
      {
        type: 'role_changed',
        title: 'Role Changed',
        body: `Your role has been changed to ${demoteToRole} following a warning.`,
        link: `/profile/unified?uid=${userUid}`,
        metadata: { warningId: warningRef.id, newRole: demoteToRole },
      },
      'P1'
    );
  }

  return NextResponse.json({
    ok: true,
    warningId: warningRef.id,
    userUid,
    warningCount: newWarningCount,
    penaltyPoints,
    blacklisted: shouldBlacklist,
    demotedTo: demoteToRole || null,
    auditId: pointsAuditRef ? pointsAuditRef.id : null,
    auditLogId: auditLogRef.id,
  });
}
