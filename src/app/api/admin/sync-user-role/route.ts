import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { FieldValue } from 'firebase-admin/firestore';
import {
  effectiveRoleOf,
  isCatalogRoleKey,
  isReservedTitle,
  normalizeToCanonical,
  CUSTOM_TITLE_MAX_LENGTH,
  type CatalogRoleKey,
} from '@/lib/role-catalog';
import {
  assertConsentFor,
  consentGateHttpError,
  isCategoryBRole,
} from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Custom-title endpoint + mirror repair (Phase 1, spec B.2 item 2).
 *
 * This route NO LONGER sets roles. Role changes go through
 * POST /api/admin/roles/write (the single write path). It honors:
 * - customTitle: always, after reserved-title and length validation.
 * - role / displayRole / additionalRoles: ONLY when they exactly equal
 *   the effective role computed from the roles/{uid} doc (a repair write,
 *   equivalent to setMirror). A divergent role field is rejected 409:
 *   silently mirroring an arbitrary role is how the stores diverged.
 */
export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermission(callerRole, 'canManageRoles'))) {
    return NextResponse.json({ error: 'Forbidden: role management permission required' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
  if (!uid) {
    return NextResponse.json({ error: 'uid is required' }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if (typeof body.customTitle === 'string') {
    const customTitle = body.customTitle.trim();
    if (customTitle.length > CUSTOM_TITLE_MAX_LENGTH) {
      return NextResponse.json(
        { error: `customTitle exceeds ${CUSTOM_TITLE_MAX_LENGTH} characters` },
        { status: 400 },
      );
    }
    if (customTitle && isReservedTitle(customTitle)) {
      return NextResponse.json(
        { error: 'customTitle uses a reserved office title' },
        { status: 400 },
      );
    }
    update.customTitle = customTitle;
  }

  const wantsRoleMirror =
    typeof body.role === 'string' || typeof body.displayRole === 'string' || body.additionalRoles !== undefined;
  if (wantsRoleMirror) {
    const roleSnap = await db.collection('roles').doc(uid).get();
    if (!roleSnap.exists) {
      return NextResponse.json(
        { error: 'No roles record exists for this user; role changes go through /api/admin/roles/write', code: 'no_roles_record' },
        { status: 409 },
      );
    }
    const data = roleSnap.data() as Record<string, unknown>;
    const rawPrimary = data.role as CatalogRoleKey;
    const additional = Array.isArray(data.additionalRoles)
      ? (data.additionalRoles as CatalogRoleKey[])
      : [];
    // A legacy stored token that resolves through LEGACY_TO_CATALOG is
    // repairable here (the repair canonicalises the mirror); only a
    // token that does not resolve at all is refused (integration step 4).
    const primary = (
      isCatalogRoleKey(rawPrimary) ? rawPrimary : normalizeToCanonical(String(rawPrimary ?? ''))
    ) as CatalogRoleKey | null;
    if (!primary) {
      return NextResponse.json(
        { error: 'Stored roles record holds a non-catalog role; repair it through reconciliation', code: 'non_catalog_role' },
        { status: 409 },
      );
    }
    const effective = effectiveRoleOf(primary, additional);
    // Canonicalise the requested tokens before comparing (integration
    // step 4): effectiveRoleOf returns the CANONICAL key, so a raw
    // legacy token in the body ('chair_events') would never equal it
    // ('chapter_events_chair') and mirror repair would be impossible
    // for every legacy-stored role - the exact population repair exists
    // for. Unresolvable tokens fall back to the raw value and mismatch.
    const canonicalRequested = (value: unknown): string =>
      typeof value === 'string'
        ? (normalizeToCanonical(value.trim().toLowerCase()) ?? value.trim().toLowerCase())
        : effective;
    const requestedRole = canonicalRequested(body.role);
    const requestedDisplay = canonicalRequested(body.displayRole);
    if (requestedRole !== effective || requestedDisplay !== effective) {
      // Phase 2 gate probe (integration step 4, gates spec B.7 case 7):
      // when the REQUESTED role is a Category B office, the consent gate
      // is consulted first - a missing consent answers CONSENT_REQUIRED
      // rather than the plain refusal. Either way this route writes
      // nothing: role changes go through /api/admin/roles/write. Note
      // the gates crew's consumption warning: in hard mode a gate PASS
      // consumes the consent (single-use), even though the write is
      // still refused here.
      if (await isCategoryBRole(db, requestedRole)) {
        const actorUid = String((auth.user as any).uid || (auth.user as any).userId || '');
        try {
          await assertConsentFor({
            db,
            actorUid,
            matterKey: 'catb_officer',
            consentRequestId:
              typeof body.consentRequestId === 'string' ? body.consentRequestId : null,
            subjectRef: {
              type: 'user_role',
              targetUid: uid,
              roleKey: requestedRole,
              action: 'appoint',
            },
            actSummary: `Appoint ${uid} to ${requestedRole} (probed via sync-user-role)`,
          });
        } catch (err) {
          const { status, body: errBody } = consentGateHttpError(err);
          return NextResponse.json(errBody, { status });
        }
      }
      return NextResponse.json(
        {
          error: 'Requested mirror does not match the roles record; role changes go through /api/admin/roles/write',
          code: 'ROLE_WRITE_ROUTE_REQUIRED',
          effectiveRole: effective,
        },
        { status: 409 },
      );
    }
    update.role = effective;
    update.displayRole = effective;
    update.roleSource = 'roles';
    if (additional.length > 0) update.additionalRoles = additional;
    else update.additionalRoles = FieldValue.delete();
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // Governance audit (integration step 4): a mirror repair is a
  // governance write; it is audited or it does not happen. (Custom-title
  // -only updates keep their Phase 1 behavior and are not audited here.)
  if (wantsRoleMirror) {
    const actorUid = String((auth.user as any).uid || (auth.user as any).userId || '');
    await writeGovernanceAuditOrThrow(db, {
      action: 'role_mirror_repair',
      actorUid,
      actorRole: callerRole,
      targetType: 'user',
      targetId: uid,
      details: {
        role: typeof update.role === 'string' ? update.role : null,
        consentRequestId: typeof body.consentRequestId === 'string' ? body.consentRequestId : null,
      },
    });
  }

  await db.collection('users').doc(uid).set(update, { merge: true });
  return NextResponse.json({ ok: true, uid });
}
