/**
 * Intake windows admin collection route (Workstream E, spec 5.1).
 *
 * GET  /api/admin/intake-windows[?kind=]  list with derived state
 * POST /api/admin/intake-windows          create (PKT wall-time input)
 *
 * All writes go through one batch (window + default-clearing + audit),
 * then the intake_config/current mirror is recomputed (spec 4.5).
 * Overlap with a same-kind window is a 201 warning, never an error:
 * resolution precedence in spec 4.3 handles it deterministically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/server/firebase-admin';
import {
  INTAKE_WINDOWS_COLLECTION,
  listWindows,
  recomputeAndMirrorConfig,
  writeIntakeAudit,
} from '@/lib/server/intake-windows';
import type {
  IntakeWindow,
  IntakeWindowKind,
} from '@/types/intake-window';
import {
  INTAKE_TIMEZONE,
  VALID_INTAKE_KINDS,
  collectOverlapWarnings,
  makeWindowId,
  parsePktWallTime,
  requireIntakeAdmin,
  toAdminWindow,
  validationError,
} from './shared';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  const { db } = gate;

  const kindParam = request.nextUrl.searchParams.get('kind');
  if (
    kindParam !== null &&
    !VALID_INTAKE_KINDS.includes(kindParam as IntakeWindowKind)
  ) {
    return validationError('kind', `Unknown intake window kind: ${kindParam}`);
  }

  try {
    const nowMs = Date.now();
    const all = await listWindows(db);
    const visible = kindParam
      ? all.filter((w) => w.kind === (kindParam as IntakeWindowKind))
      : all;
    return NextResponse.json({
      windows: visible.map((w) => toAdminWindow(w, all, nowMs)),
      serverNow: new Date(nowMs).toISOString(),
    });
  } catch (err) {
    console.error('[intake-windows] list failed:', err);
    return NextResponse.json({ error: 'list_failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  const { db, uid } = gate;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Validate everything before any write.
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length < 3 || label.length > 120) {
    return validationError('label', 'Label is required (3 to 120 chars).');
  }
  const kind = body.kind as IntakeWindowKind;
  if (!VALID_INTAKE_KINDS.includes(kind)) {
    return validationError('kind', 'Kind must be one of: ' + VALID_INTAKE_KINDS.join(', '));
  }
  const opensAtMs = parsePktWallTime(body.opensAt);
  if (opensAtMs === null) {
    return validationError('opensAt', "opensAt must be PKT wall time 'YYYY-MM-DDTHH:mm'.");
  }
  const closesAtMs = parsePktWallTime(body.closesAt);
  if (closesAtMs === null) {
    return validationError('closesAt', "closesAt must be PKT wall time 'YYYY-MM-DDTHH:mm'.");
  }
  if (closesAtMs <= opensAtMs) {
    return validationError('closesAt', 'closesAt must be after opensAt.');
  }
  if (body.timezone !== undefined && body.timezone !== INTAKE_TIMEZONE) {
    return validationError('timezone', `Only ${INTAKE_TIMEZONE} is supported.`);
  }
  const fyLabel =
    typeof body.fyLabel === 'string' && body.fyLabel.trim()
      ? body.fyLabel.trim()
      : undefined;
  if (fyLabel !== undefined && fyLabel.length > 20) {
    return validationError('fyLabel', 'fyLabel is too long.');
  }
  const notes =
    typeof body.notes === 'string' ? body.notes.slice(0, 1000) : undefined;
  const isDefault = body.isDefault === true;

  try {
    const existing = await listWindows(db);
    const windowId = makeWindowId(kind, closesAtMs, label);
    if (existing.some((w) => w.windowId === windowId)) {
      return NextResponse.json(
        { error: 'window_id_conflict', windowId },
        { status: 409 },
      );
    }

    const warnings = collectOverlapWarnings(existing, {
      kind,
      opensAtMs,
      closesAtMs,
    });

    const now = admin.firestore.FieldValue.serverTimestamp();
    const windowData: Record<string, unknown> = {
      windowId,
      label,
      kind,
      opensAt: admin.firestore.Timestamp.fromMillis(opensAtMs),
      closesAt: admin.firestore.Timestamp.fromMillis(closesAtMs),
      timezone: INTAKE_TIMEZONE,
      isDefault,
      storedStatus: null,
      source: 'manual',
      templateId: null,
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    };
    if (fyLabel !== undefined) windowData.fyLabel = fyLabel;
    if (notes !== undefined) windowData.notes = notes;

    const batch = db.batch();
    batch.set(db.collection(INTAKE_WINDOWS_COLLECTION).doc(windowId), windowData);

    // At most one default per kind: clear siblings in the same batch so
    // the invariant never depends on a second write landing.
    const displacedDefaults: string[] = [];
    if (isDefault) {
      for (const other of existing) {
        if (other.kind === kind && other.isDefault && other.storedStatus !== 'cancelled') {
          batch.update(db.collection(INTAKE_WINDOWS_COLLECTION).doc(other.windowId), {
            isDefault: false,
            updatedAt: now,
          });
          displacedDefaults.push(other.windowId);
        }
      }
    }

    await writeIntakeAudit(
      db,
      {
        action: 'intake_window_created',
        actorUid: uid,
        targetUidOrResource: windowId,
        payload: {
          kind,
          label,
          opensAt: new Date(opensAtMs).toISOString(),
          closesAt: new Date(closesAtMs).toISOString(),
          isDefault,
        },
      },
      batch,
    );
    if (isDefault) {
      await writeIntakeAudit(
        db,
        {
          action: 'intake_window_default_set',
          actorUid: uid,
          targetUidOrResource: windowId,
          payload: { kind, displacedWindowIds: displacedDefaults },
        },
        batch,
      );
    }
    await batch.commit();

    await recomputeAndMirrorConfig(db, uid);

    const created: IntakeWindow = {
      ...(windowData as unknown as IntakeWindow),
      windowId,
    };
    const after = await listWindows(db);
    return NextResponse.json(
      {
        window: toAdminWindow(
          after.find((w) => w.windowId === windowId) ?? created,
          after,
          Date.now(),
        ),
        warnings,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[intake-windows] create failed:', err);
    return NextResponse.json({ error: 'create_failed' }, { status: 500 });
  }
}
