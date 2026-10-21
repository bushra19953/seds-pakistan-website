/**
 * Intake config route (Workstream E, spec 5.1/5.2): the
 * intake_config/current mirror status and the enforcement toggle.
 *
 * Gate E-2: enforcement may only turn ON while the mirror is healthy
 * (the mirrored window id and source timestamp match a fresh local
 * resolution). Turning OFF is never refused: an admin must always be
 * able to fall back to mirror mode instantly.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  resolveWindow,
  timestampLikeToMs,
  windowToLike,
} from '@/lib/intake-windows/resolve';
import {
  INTAKE_CONFIG_COLLECTION,
  INTAKE_CONFIG_DOC_ID,
  listWindows,
  writeIntakeAudit,
} from '@/lib/server/intake-windows';
import { requireIntakeAdmin } from '../shared';

export const dynamic = 'force-dynamic';

interface MirrorHealth {
  mirrorHealthy: boolean;
  resolvedWindowId: string | null;
  mirroredWindowId: string | null;
}

/**
 * Healthy means: a config doc exists, its mirrored window id equals the
 * freshly resolved induction window id, and mirrorSourceUpdatedAt
 * equals that window's stored updatedAt (i.e. the mirror was written
 * from the current version of the window). When nothing resolves, the
 * mirror is healthy only if it also mirrors nothing.
 */
async function computeMirrorHealth(
  db: import('firebase-admin/firestore').Firestore,
): Promise<{ health: MirrorHealth; config: Record<string, unknown> | null }> {
  const configRef = db
    .collection(INTAKE_CONFIG_COLLECTION)
    .doc(INTAKE_CONFIG_DOC_ID);
  const configSnap = await configRef.get();
  const config = configSnap.exists
    ? ((configSnap.data() ?? {}) as Record<string, unknown>)
    : null;

  const windows = await listWindows(db);
  const nowMs = Date.now();
  const resolved = resolveWindow(
    windows.map((w) =>
      windowToLike({
        ...(w as unknown as Record<string, unknown>),
        windowId: w.windowId,
      }),
    ),
    'induction',
    nowMs,
  );

  const mirroredWindowId =
    config && typeof config.currentInductionWindowId === 'string'
      ? config.currentInductionWindowId
      : null;

  let healthy = false;
  if (config) {
    if (!resolved && mirroredWindowId === null) {
      healthy = true;
    } else if (resolved && mirroredWindowId === resolved.windowId) {
      const source = windows.find((w) => w.windowId === resolved.windowId);
      const sourceUpdatedMs = source ? timestampLikeToMs(source.updatedAt) : 0;
      const mirrorSourceMs = timestampLikeToMs(config.mirrorSourceUpdatedAt);
      healthy = sourceUpdatedMs > 0 && sourceUpdatedMs === mirrorSourceMs;
    }
  }

  return {
    health: {
      mirrorHealthy: healthy,
      resolvedWindowId: resolved ? resolved.windowId : null,
      mirroredWindowId,
    },
    config,
  };
}

function serializeConfig(config: Record<string, unknown> | null) {
  if (!config) return null;
  const iso = (v: unknown) => {
    const ms = timestampLikeToMs(v);
    return ms > 0 ? new Date(ms).toISOString() : null;
  };
  return {
    currentInductionWindowId:
      typeof config.currentInductionWindowId === 'string'
        ? config.currentInductionWindowId
        : null,
    currentInductionOpensAt: iso(config.currentInductionOpensAt),
    currentInductionClosesAt: iso(config.currentInductionClosesAt),
    currentInductionState:
      typeof config.currentInductionState === 'string'
        ? config.currentInductionState
        : 'none',
    enforcementEnabled: config.enforcementEnabled === true,
    mirrorUpdatedAt: iso(config.mirrorUpdatedAt),
    mirrorUpdatedBy:
      typeof config.mirrorUpdatedBy === 'string' ? config.mirrorUpdatedBy : null,
    mirrorSourceUpdatedAt: iso(config.mirrorSourceUpdatedAt),
    mirrorVersion:
      typeof config.mirrorVersion === 'number' ? config.mirrorVersion : 0,
  };
}

export async function GET(request: NextRequest) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  try {
    const { health, config } = await computeMirrorHealth(gate.db);
    return NextResponse.json({
      config: serializeConfig(config),
      ...health,
      serverNow: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[intake-windows] config get failed:', err);
    return NextResponse.json({ error: 'config_get_failed' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  const { db, uid } = gate;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (typeof body.enforcementEnabled !== 'boolean') {
    return NextResponse.json(
      {
        error: 'validation_failed',
        field: 'enforcementEnabled',
        message: 'enforcementEnabled must be a boolean.',
      },
      { status: 400 },
    );
  }
  const target = body.enforcementEnabled;

  try {
    const { health, config } = await computeMirrorHealth(db);
    if (target === true && !health.mirrorHealthy) {
      // Gate E-2: never arm enforcement against a stale mirror.
      return NextResponse.json(
        { error: 'mirror_unhealthy', ...health },
        { status: 409 },
      );
    }
    const before = config?.enforcementEnabled === true;
    const configRef = db
      .collection(INTAKE_CONFIG_COLLECTION)
      .doc(INTAKE_CONFIG_DOC_ID);
    const batch = db.batch();
    batch.set(
      configRef,
      { enforcementEnabled: target },
      { merge: true },
    );
    await writeIntakeAudit(
      db,
      {
        action: 'intake_enforcement_toggled',
        actorUid: uid,
        targetUidOrResource: `${INTAKE_CONFIG_COLLECTION}/${INTAKE_CONFIG_DOC_ID}`,
        payload: { before, after: target, mirrorHealthy: health.mirrorHealthy },
      },
      batch,
    );
    await batch.commit();

    const after = await computeMirrorHealth(db);
    return NextResponse.json({
      config: serializeConfig(after.config),
      ...after.health,
      serverNow: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[intake-windows] config patch failed:', err);
    return NextResponse.json({ error: 'config_update_failed' }, { status: 500 });
  }
}
