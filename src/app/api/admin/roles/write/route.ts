import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission, hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounderUid } from '@/config/founder';
import { ADMIN_PERMISSIONS, type PermissionKey } from '@/config/permission-registry';
import {
  assignRole,
  removeRole,
  validateAssignRoleInput,
  validateRemoveRoleInput,
  RoleWriteError,
  type RoleWriteSource,
} from '@/lib/server/role-writes';
import {
  assertConsentFor,
  canonicaliseRoleKey,
  consentGateHttpError,
  isCategoryBRole,
} from '@/lib/server/consent-gate';
import { seamDocGet } from '@/lib/server/supa-roles-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Subset rule + self-assignment ban (adoption pack items 4-5 / RP-05):
// a non-founder actor can only assign a role whose permissions are a
// subset of the actor's own effective set (holder-scoped union via
// hasServerPermissionForUser), and a non-founder may never assign a
// permission-bearing role to themselves at all. Founder actors
// (founder UID, or the founder_patron role) are exempt. Both checks run
// before the consent gate so a rejection never consumes a consent.
// The granted set of a role is resolved through hasServerPermission
// itself (definition array, then boolean map, then static config), so
// catalog and custom roles are measured the same way gates measure
// them.
// ---------------------------------------------------------------------------

function isFounderActor(actorUid: string, actorRole: string): boolean {
  return isFounderUid(actorUid) || actorRole === 'founder_patron';
}

async function permissionsGrantedByRoles(roleSlugs: string[]): Promise<string[]> {
  const keys = Object.keys(ADMIN_PERMISSIONS) as PermissionKey[];
  const granted = new Set<string>();
  for (const slug of roleSlugs) {
    if (!slug) continue;
    for (const key of keys) {
      if (await hasServerPermission(slug, key)) granted.add(key);
    }
  }
  return Array.from(granted);
}

async function findSubsetViolations(
  db: ReturnType<typeof getDb>,
  actorUid: string,
  actorRole: string,
  grantedKeys: string[],
): Promise<string[]> {
  const violations: string[] = [];
  for (const key of grantedKeys) {
    const held =
      db && typeof hasServerPermissionForUser === 'function'
        ? await hasServerPermissionForUser(db as never, actorUid, key as PermissionKey)
        : await hasServerPermission(actorRole, key as PermissionKey);
    if (!held) violations.push(key);
  }
  return violations;
}

/**
 * POST /api/admin/roles/write (Phase 1, spec B.2 item 1).
 *
 * The single role-change endpoint. The actor is resolved from the
 * authenticated profile via the Admin SDK, never trusted from the body.
 * Actor authorization: the Founder, or a holder of canManageRoles reached
 * through the mirror role; R5/R4 grants additionally require the Founder
 * (enforced inside assignRole as well).
 *
 * Body:
 *   { action: 'assign', uid, role, additionalRoles?, chapterId?, reason, idempotencyKey? }
 *   { action: 'remove', uid, reason, idempotencyKey? }
 *   { action: 'set-custom-title', uid, customTitle }  -> 410 (use sync-user-role)
 */
export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Actor resolution mirrors the working sibling routes
  // (role-permissions, roles/[slug]): verifyAuthentication returns the
  // uid at `userId`; there is no top-level `uid` on the returned
  // AuthContext (the decoded token carrying `uid` is nested at
  // auth.user.user). Reading only `.uid` resolved every actor to ''
  // and 401'd every caller (live verification, 2026-10-23).
  const actorUid = String((auth.user as any).userId || (auth.user as any).uid || '');
  if (!actorUid) {
    return NextResponse.json({ error: 'Actor could not be resolved' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'set-custom-title') {
    return NextResponse.json(
      { error: 'customTitle is not a role change; use POST /api/admin/sync-user-role' },
      { status: 410 },
    );
  }
  if (action !== 'assign' && action !== 'remove') {
    return NextResponse.json({ error: 'action must be "assign" or "remove"' }, { status: 400 });
  }

  // Actor authorization via the Admin-SDK mirror profile.
  if (!isFounderUid(actorUid)) {
    const actorSnap = await db.collection('users').doc(actorUid).get();
    const actorRole = String(actorSnap.data()?.role || '');
    if (!(await hasServerPermission(actorRole, 'canManageRoles'))) {
      return NextResponse.json(
        { error: 'Forbidden: role management permission required' },
        { status: 403 },
      );
    }
  }

  const uid = typeof body.uid === 'string' ? body.uid.trim() : '';

  // Founder immutability (moved from the retired verbatim-write route
  // /api/admin/roles/assign, which enforced it at its :71-75): nobody but
  // the Founder's own session may alter the Founder's role record, by
  // assign or by remove. Placed BEFORE the consent gate (which consumes
  // consents in hard mode) so a refused founder write never burns one.
  // role-writes' validateActorForRole gates the GRANTED role only; this
  // is the server-side protection for the Founder's OWN record.
  if (isFounderUid(uid) && !isFounderUid(actorUid)) {
    return NextResponse.json(
      { error: 'The Founder role is immutable' },
      { status: 403 },
    );
  }

  // Subset rule + self-assignment ban (RP-05, pack items 4-5). Assign
  // only: a remove grants nothing. Runs before the founder pre-gate
  // validation and before the consent gate.
  if (action === 'assign') {
    const actorRole = String((auth.user as any).role || '');
    if (!isFounderActor(actorUid, actorRole)) {
      const targetSlugs: string[] = [
        ...(typeof body.role === 'string' && body.role.trim() ? [body.role.trim()] : []),
        ...(Array.isArray(body.additionalRoles)
          ? (body.additionalRoles as unknown[]).filter(
              (r): r is string => typeof r === 'string' && !!r.trim(),
            )
          : []),
      ];
      const grantedKeys = await permissionsGrantedByRoles(targetSlugs);
      if (actorUid === uid && grantedKeys.length > 0) {
        return NextResponse.json(
          {
            error: 'Non-founder actors cannot assign a permission-bearing role to themselves',
            code: 'SELF_ASSIGNMENT_FORBIDDEN',
          },
          { status: 403 },
        );
      }
      const violations = await findSubsetViolations(db, actorUid, actorRole, grantedKeys);
      if (violations.length > 0) {
        return NextResponse.json(
          {
            error: `Cannot grant permissions you do not hold: ${violations.join(', ')}`,
            code: 'SUBSET_VIOLATION',
            missingPermissions: violations,
          },
          { status: 403 },
        );
      }
    }
  }

  const reason = typeof body.reason === 'string' ? body.reason : '';
  const source: RoleWriteSource =
    body.source === 'authority_inspector' || body.source === 'superadmin_page'
      ? body.source
      : 'admin_ui';
  const idempotencyKey =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

  // Grant expiry passthrough (contracts 3.2; expiry-core E2), computed
  // here so the founder pre-gate validation below and the assign call
  // share the exact same values: an ISO string becomes a Date, JSON
  // null stays null (explicit clear), absent stays undefined
  // (preserve). An unparseable string becomes an Invalid Date ON
  // PURPOSE: role-writes is the single validation point and rejects it
  // as invalid_expiry.
  const expiresAtRaw: unknown = body.expiresAt;
  const expiresAt =
    typeof expiresAtRaw === 'string'
      ? new Date(expiresAtRaw)
      : expiresAtRaw === null
        ? null
        : undefined;
  const expiresRoleKey =
    typeof body.expiresRoleKey === 'string' ? body.expiresRoleKey : undefined;

  // Founder-scoped pre-gate validation (spec-auditor defect,
  // 2026-10-24): for a founder actor the consent gate below MINTS a
  // founder-act consent record plus audits inside assertConsentFor, so
  // every validation assignRole / removeRole will run must pass BEFORE
  // the gate is reached — otherwise an invalid founder request (empty
  // uid, reason under 10 chars, unknown/custom/expiry failure) minted
  // the record and only then returned 400, with no rollback. The
  // DELETE route (roles/[slug]) is the model: all validation first,
  // gate last. Non-founder actors skip this block entirely and keep
  // the pre-fix flow byte-identical (the gate consumes nothing for
  // them on a request role-writes later rejects beyond the pre-existing
  // hard-mode consumption, which is out of this defect's scope).
  if (isFounderUid(actorUid)) {
    try {
      if (action === 'assign') {
        await validateAssignRoleInput(db, {
          uid,
          role: body.role,
          additionalRoles: Array.isArray(body.additionalRoles)
            ? body.additionalRoles
            : undefined,
          chapterId: typeof body.chapterId === 'string' ? body.chapterId : undefined,
          actorUid,
          reason,
          source,
          idempotencyKey,
          expiresAt,
          expiresRoleKey,
        });
      } else {
        validateRemoveRoleInput({ uid, actorUid, reason, source, idempotencyKey });
      }
    } catch (err) {
      if (err instanceof RoleWriteError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.httpStatus },
        );
      }
      console.error('[roles/write] pre-gate validation failed:', err);
      return NextResponse.json({ error: 'Role write failed' }, { status: 500 });
    }
  }

  // Phase 2 consent gate (integration step 4): Category B appointments
  // and removals are Reserved Matters. The gate is enforced HERE, at the
  // single write path, so no caller (UI, inspector, or direct API) can
  // bypass it - the gates crew's per-route interceptions on the legacy
  // routes remain as second layers. In record mode the gate passes with
  // a warning stamp; in hard mode a decided consent is required and a
  // pass consumes it (single-use).
  try {
    // Supabase seam (group 2): a remove's gate key comes from the
    // roles/{uid} record — flag ON reads it from the adapter, flag
    // OFF / adapter error -> the Firestore get. The actor's users
    // read above and the assignRole/removeRole writes (inside
    // role-writes.ts) are untouched by this route migration.
    const gateRoleKey =
      action === 'assign'
        ? canonicaliseRoleKey(typeof body.role === 'string' ? body.role : '')
        : canonicaliseRoleKey(
            String(
              (await seamDocGet('roles', uid, () => db.collection('roles').doc(uid).get())).data()
                ?.role || '',
            ),
          );
    if (gateRoleKey && (await isCategoryBRole(db, gateRoleKey))) {
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
            roleKey: gateRoleKey,
            action: action === 'assign' ? 'appoint' : 'remove',
          },
          actSummary:
            action === 'assign'
              ? `Appoint ${uid} to ${gateRoleKey} (roles/write)`
              : `Remove ${uid} from ${gateRoleKey} (roles/write)`,
        });
      } catch (err) {
        const { status, body: errBody } = consentGateHttpError(err);
        return NextResponse.json(errBody, { status });
      }
    }
  } catch (err) {
    console.error('[roles/write] consent gate check failed:', err);
    return NextResponse.json({ error: 'Consent gate check failed' }, { status: 500 });
  }

  try {
    if (action === 'assign') {
      // expiresAt / expiresRoleKey are computed once, above the
      // consent gate (see the passthrough comment there).
      const result = await assignRole(db, {
        uid,
        role: body.role,
        additionalRoles: Array.isArray(body.additionalRoles) ? body.additionalRoles : undefined,
        chapterId: typeof body.chapterId === 'string' ? body.chapterId : undefined,
        actorUid,
        reason,
        source,
        idempotencyKey,
        expiresAt,
        expiresRoleKey,
      });
      const stamped = result.roleDoc.expiresAt;
      const expiresAtIso =
        stamped instanceof Date
          ? stamped.toISOString()
          : stamped &&
              typeof stamped === 'object' &&
              typeof (stamped as { toDate?: unknown }).toDate === 'function'
            ? (stamped as { toDate: () => Date }).toDate().toISOString()
            : null;
      return NextResponse.json({
        ok: true,
        uid,
        effectiveRole: result.newEffectiveRole,
        alreadyApplied: result.alreadyApplied,
        expiresAt: expiresAtIso,
      });
    }
    const result = await removeRole(db, {
      uid,
      actorUid,
      reason,
      source,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      uid,
      previousEffectiveRole: result.previousEffectiveRole,
      alreadyApplied: result.alreadyApplied,
    });
  } catch (err) {
    if (err instanceof RoleWriteError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    console.error('[roles/write] unexpected error:', err);
    return NextResponse.json({ error: 'Role write failed' }, { status: 500 });
  }
}
