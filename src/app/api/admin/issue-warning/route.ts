import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { notificationService } from '@/lib/server/notification-service';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  DEFAULT_WARNING_SETTINGS,
  WarningSettings,
  WarningType,
} from '@/types/user';
import {
  assertConsentFor,
  canonicaliseRoleKey,
  consentGateHttpError,
  isCategoryBRole,
} from '@/lib/server/consent-gate';

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
 *     bumps totalPenalties, writes a points_audit doc (reason
 *     'manual_warning_penalty', actorId = caller) and sends a
 *     'penalty_applied' notification,
 *  4. applies the blacklist threshold: reaching it sets BOTH isBlacklisted
 *     and isBanned (mirrors the buildBlacklistThresholdUpdate helper used by
 *     the client dialogs, with admin timestamps),
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
    // Same fields as buildBlacklistThresholdUpdate in
    // issue-warning-dialog.tsx, with admin timestamps. A user who hits the
    // threshold must be BOTH blacklisted and banned: blacklist alone does not
    // block re-entry, but isBanned is enforced by the auth middleware.
    userUpdate.isBlacklisted = true;
    userUpdate.blacklistReason = `Reached ${blacklistThreshold} active warnings.`;
    userUpdate.blacklistedAt = now;
    userUpdate.isBanned = true;
    userUpdate.banReason = `Reached ${blacklistThreshold} warnings. Blacklisted and banned permanently.`;
  }

  // Phase 2 consent gate (spec B.3a.4): a warning-driven demotion of a
  // Category B office holder is a removal act on a Reserved Matter. The gate
  // runs before ANY write in this request: if it blocks, the whole request
  // fails with the gate's response - no warning, no points deduction, nothing
  // applied. This closes the discipline bypass where a demotion could strip
  // a Category B office holder without any consent check; the warning modal
  // must collect demote-to-Category-B through the consent flow instead.
  if (demoteToRole) {
    const targetRoleSnap = await db.collection('roles').doc(userUid).get();
    const targetCurrentRole = targetRoleSnap.exists
      ? canonicaliseRoleKey(
          String((targetRoleSnap.data() as Record<string, unknown>)?.role ?? 'member')
        )
      : canonicaliseRoleKey(String(userData.role ?? 'member'));
    if (await isCategoryBRole(db, targetCurrentRole)) {
      try {
        await assertConsentFor({
          db,
          actorUid: callerUid,
          matterKey: 'catb_officer',
          consentRequestId:
            typeof body.consentRequestId === 'string' ? body.consentRequestId : null,
          subjectRef: {
            type: 'user_role',
            targetUid: userUid,
            roleKey: targetCurrentRole,
            action: 'remove',
          },
          actSummary: `Warning demotion of ${userUid} from ${targetCurrentRole} to ${demoteToRole}`,
        });
      } catch (err) {
        const { status, body: errBody } = consentGateHttpError(err);
        return NextResponse.json(errBody, { status });
      }
    }
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

  let auditRef: FirebaseFirestore.DocumentReference | null = null;
  if (penaltyPoints > 0) {
    auditRef = db.collection('points_audit').doc();
    batch.set(auditRef, {
      userId: userUid,
      delta: -penaltyPoints,
      reason: 'manual_warning_penalty',
      timestamp: now,
      actorId: callerUid,
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

  if (penaltyPoints > 0) {
    void notify({
      type: 'penalty_applied',
      title: 'Warning Issued, Points Deducted',
      body: `A warning was issued for: ${reason}. ${penaltyPoints} point${
        penaltyPoints === 1 ? '' : 's'
      } deducted from your account.`,
      link: `/profile/unified?uid=${userUid}`,
      metadata: { warningId: warningRef.id },
    });
  }

  if (shouldBlacklist) {
    void notify({
      type: 'account_blacklisted',
      title: 'Account Blacklisted',
      body: `Your account has been blacklisted after reaching ${blacklistThreshold} warnings.`,
      link: '/banned',
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
    auditId: auditRef ? auditRef.id : null,
  });
}
