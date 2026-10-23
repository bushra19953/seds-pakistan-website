/**
 * Intake window item route (Workstream E, spec 5.1).
 *
 * GET   /api/admin/intake-windows/[windowId]
 * PATCH /api/admin/intake-windows/[windowId]
 *   - editable: label, opensAt, closesAt, fyLabel, notes, isDefault,
 *     targetApplications (null clears the demand figure)
 *   - cancel:   { storedStatus: 'cancelled', cancelReason } (>= 3 chars)
 *   - uncancel: { storedStatus: null } - superadmin only
 *
 * Cancelled is a one-way door for ordinary edits: a cancelled window
 * rejects every other PATCH with 409 until a superadmin uncancels it,
 * so the audit trail of why a window died is never quietly edited away.
 */

import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/server/firebase-admin';
import { isFounderUid } from '@/config/founder';
import { timestampLikeToMs } from '@/lib/intake-windows/resolve';
import {
  INTAKE_WINDOWS_COLLECTION,
  getWindow,
  listWindows,
  recomputeAndMirrorConfig,
  writeIntakeAudit,
} from '@/lib/server/intake-windows';
import {
  INTAKE_TIMEZONE,
  collectOverlapWarnings,
  parsePktWallTime,
  parseTargetApplications,
  requireIntakeAdmin,
  toAdminWindow,
  validationError,
} from '../shared';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ windowId: string }> },
) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  const { db } = gate;
  const { windowId } = await params;

  try {
    const win = await getWindow(db, windowId);
    if (!win) {
      return NextResponse.json({ error: 'window_not_found' }, { status: 404 });
    }
    const all = await listWindows(db);
    return NextResponse.json({
      window: toAdminWindow(win, all, Date.now()),
    });
  } catch (err) {
    console.error('[intake-windows] get failed:', err);
    return NextResponse.json({ error: 'get_failed' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ windowId: string }> },
) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  const { db, uid, role } = gate;
  const { windowId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const existing = await getWindow(db, windowId);
    if (!existing) {
      return NextResponse.json({ error: 'window_not_found' }, { status: 404 });
    }
    const isCancelled = existing.storedStatus === 'cancelled';
    const wantsCancel = body.storedStatus === 'cancelled';
    const wantsUncancel =
      'storedStatus' in body && body.storedStatus === null;

    // Uncancel is its own privileged transition.
    if (wantsUncancel) {
      if (!isCancelled) {
        return validationError('storedStatus', 'Window is not cancelled.');
      }
      if (role !== 'founder_patron' && !isFounderUid(uid)) {
        return NextResponse.json(
          { error: 'superadmin_required' },
          { status: 403 },
        );
      }
      const batch = db.batch();
      batch.update(db.collection(INTAKE_WINDOWS_COLLECTION).doc(windowId), {
        storedStatus: null,
        cancelReason: null,
        cancelledBy: null,
        cancelledAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await writeIntakeAudit(
        db,
        {
          action: 'intake_window_updated',
          actorUid: uid,
          targetUidOrResource: windowId,
          payload: { transition: 'uncancelled' },
        },
        batch,
      );
      await batch.commit();
      await recomputeAndMirrorConfig(db, uid);
      const after = await listWindows(db);
      const updated = after.find((w) => w.windowId === windowId) ?? existing;
      return NextResponse.json({
        window: toAdminWindow(updated, after, Date.now()),
        warnings: [],
      });
    }

    // A cancelled window rejects every other edit.
    if (isCancelled) {
      return NextResponse.json({ error: 'window_cancelled' }, { status: 409 });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const ref = db.collection(INTAKE_WINDOWS_COLLECTION).doc(windowId);

    // Cancel transition.
    if (wantsCancel) {
      const reason =
        typeof body.cancelReason === 'string' ? body.cancelReason.trim() : '';
      if (reason.length < 3) {
        return validationError(
          'cancelReason',
          'A cancel reason of at least 3 characters is required.',
        );
      }
      const batch = db.batch();
      batch.update(ref, {
        storedStatus: 'cancelled',
        cancelReason: reason,
        cancelledBy: uid,
        cancelledAt: now,
        updatedAt: now,
      });
      await writeIntakeAudit(
        db,
        {
          action: 'intake_window_cancelled',
          actorUid: uid,
          targetUidOrResource: windowId,
          payload: { cancelReason: reason },
        },
        batch,
      );
      await batch.commit();
      await recomputeAndMirrorConfig(db, uid);
      const after = await listWindows(db);
      const updated = after.find((w) => w.windowId === windowId) ?? existing;
      return NextResponse.json({
        window: toAdminWindow(updated, after, Date.now()),
        warnings: [],
      });
    }

    // Ordinary field edit.
    const updates: Record<string, unknown> = { updatedAt: now };
    const before: Record<string, unknown> = {};
    const afterPayload: Record<string, unknown> = {};

    let opensAtMs = timestampLikeToMs(existing.opensAt);
    let closesAtMs = timestampLikeToMs(existing.closesAt);

    if ('label' in body) {
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (label.length < 3 || label.length > 120) {
        return validationError('label', 'Label must be 3 to 120 chars.');
      }
      updates.label = label;
      before.label = existing.label;
      afterPayload.label = label;
    }
    if ('opensAt' in body) {
      const parsed = parsePktWallTime(body.opensAt);
      if (parsed === null) {
        return validationError('opensAt', "opensAt must be PKT wall time 'YYYY-MM-DDTHH:mm'.");
      }
      opensAtMs = parsed;
      updates.opensAt = admin.firestore.Timestamp.fromMillis(parsed);
      before.opensAt = new Date(timestampLikeToMs(existing.opensAt)).toISOString();
      afterPayload.opensAt = new Date(parsed).toISOString();
    }
    if ('closesAt' in body) {
      const parsed = parsePktWallTime(body.closesAt);
      if (parsed === null) {
        return validationError('closesAt', "closesAt must be PKT wall time 'YYYY-MM-DDTHH:mm'.");
      }
      closesAtMs = parsed;
      updates.closesAt = admin.firestore.Timestamp.fromMillis(parsed);
      before.closesAt = new Date(timestampLikeToMs(existing.closesAt)).toISOString();
      afterPayload.closesAt = new Date(parsed).toISOString();
    }
    if (closesAtMs <= opensAtMs) {
      return validationError('closesAt', 'closesAt must be after opensAt.');
    }
    if ('timezone' in body && body.timezone !== INTAKE_TIMEZONE) {
      return validationError('timezone', `Only ${INTAKE_TIMEZONE} is supported.`);
    }
    if ('fyLabel' in body) {
      const fyLabel =
        typeof body.fyLabel === 'string' && body.fyLabel.trim()
          ? body.fyLabel.trim()
          : null;
      if (fyLabel !== null && fyLabel.length > 20) {
        return validationError('fyLabel', 'fyLabel is too long.');
      }
      updates.fyLabel = fyLabel;
      before.fyLabel = existing.fyLabel ?? null;
      afterPayload.fyLabel = fyLabel;
    }
    if ('notes' in body) {
      const notesValue =
        typeof body.notes === 'string' ? body.notes.slice(0, 1000) : null;
      updates.notes = notesValue;
      afterPayload.notes = notesValue;
    }
    if ('targetApplications' in body) {
      const parsedTarget = parseTargetApplications(body.targetApplications);
      if (!parsedTarget.ok) {
        return validationError(
          'targetApplications',
          'targetApplications must be a whole number between 1 and 100000, or null to clear it.',
        );
      }
      updates.targetApplications = parsedTarget.value;
      before.targetApplications = existing.targetApplications ?? null;
      afterPayload.targetApplications = parsedTarget.value;
    }

    const all = await listWindows(db);
    const warnings = collectOverlapWarnings(all, {
      kind: existing.kind,
      opensAtMs,
      closesAtMs,
      excludeWindowId: windowId,
    });

    const batch = db.batch();

    let displacedDefaults: string[] = [];
    if ('isDefault' in body) {
      const isDefault = body.isDefault === true;
      updates.isDefault = isDefault;
      before.isDefault = existing.isDefault === true;
      afterPayload.isDefault = isDefault;
      if (isDefault) {
        for (const other of all) {
          if (
            other.kind === existing.kind &&
            other.windowId !== windowId &&
            other.isDefault &&
            other.storedStatus !== 'cancelled'
          ) {
            batch.update(
              db.collection(INTAKE_WINDOWS_COLLECTION).doc(other.windowId),
              { isDefault: false, updatedAt: now },
            );
            displacedDefaults.push(other.windowId);
          }
        }
      }
    }

    batch.update(ref, updates);

    await writeIntakeAudit(
      db,
      {
        action: 'intake_window_updated',
        actorUid: uid,
        targetUidOrResource: windowId,
        payload: { before, after: afterPayload },
      },
      batch,
    );
    if (displacedDefaults.length > 0) {
      await writeIntakeAudit(
        db,
        {
          action: 'intake_window_default_set',
          actorUid: uid,
          targetUidOrResource: windowId,
          payload: { kind: existing.kind, displacedWindowIds: displacedDefaults },
        },
        batch,
      );
    }
    await batch.commit();
    await recomputeAndMirrorConfig(db, uid);

    const afterAll = await listWindows(db);
    const updated = afterAll.find((w) => w.windowId === windowId) ?? existing;
    return NextResponse.json({
      window: toAdminWindow(updated, afterAll, Date.now()),
      warnings,
    });
  } catch (err) {
    console.error('[intake-windows] patch failed:', err);
    return NextResponse.json({ error: 'update_failed' }, { status: 500 });
  }
}
