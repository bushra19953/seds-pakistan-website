import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { toSessionErrorResponse } from '@/lib/auth/verifySession';
import { assertFounder, FounderGateError } from '@/lib/server/founder-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import {
  getGovernanceSettings,
  PHASE2_FLAGS,
  type ConsentGateMode,
  type Phase2Flag,
} from '@/lib/server/governance-settings';

export const dynamic = 'force-dynamic';

function misconfigured() {
  return NextResponse.json(
    { error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' },
    { status: 500 },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: message, code: 'VALIDATION_FAILED' },
    { status: 400 },
  );
}

/**
 * GET /api/governance/settings - effective Phase 2 governance settings
 * (defaults merged over the governance_settings/phase2 doc). Founder only:
 * these switches are governance internals, not public config.
 */
export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) return misconfigured();
  try {
    await assertFounder(request);
  } catch (err) {
    const sessionResponse = toSessionErrorResponse(err);
    if (sessionResponse) return sessionResponse;
    if (err instanceof FounderGateError) {
      return NextResponse.json(
        { error: 'Founder only', code: 'NOT_FOUNDER' },
        { status: 403 },
      );
    }
    throw err;
  }
  const settings = await getGovernanceSettings(db);
  return NextResponse.json({ settings });
}

/**
 * POST /api/governance/settings - update the Phase 2 switches doc.
 * Founder only (assertFounder). changeReason is required (min 10 chars)
 * and recorded with updatedBy/updatedAt on every write (spec 0.1).
 */
export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) return misconfigured();

  let founder;
  try {
    founder = await assertFounder(request);
  } catch (err) {
    const sessionResponse = toSessionErrorResponse(err);
    if (sessionResponse) return sessionResponse;
    if (err instanceof FounderGateError) {
      return NextResponse.json(
        { error: 'Founder only', code: 'NOT_FOUNDER' },
        { status: 403 },
      );
    }
    throw err;
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const changeReason =
    typeof body.changeReason === 'string' ? body.changeReason.trim() : '';
  if (changeReason.length < 10) {
    return badRequest('changeReason is required (min 10 characters)');
  }

  const update: Record<string, unknown> = {};

  if (body.consentGateMode !== undefined) {
    if (
      typeof body.consentGateMode !== 'object' ||
      body.consentGateMode === null ||
      Array.isArray(body.consentGateMode)
    ) {
      return badRequest('consentGateMode must be an object');
    }
    const modes: Record<string, ConsentGateMode> = {};
    for (const [key, value] of Object.entries(
      body.consentGateMode as Record<string, unknown>,
    )) {
      if (value !== 'hard' && value !== 'record') {
        return badRequest(`consentGateMode.${key} must be 'hard' or 'record'`);
      }
      modes[key] = value;
    }
    update.consentGateMode = modes;
  }

  if (body.probationRestoreMode !== undefined) {
    if (body.probationRestoreMode !== 'auto' && body.probationRestoreMode !== 'reappoint') {
      return badRequest("probationRestoreMode must be 'auto' or 'reappoint'");
    }
    update.probationRestoreMode = body.probationRestoreMode;
  }

  if (body.warningRegistryVariant !== undefined) {
    if (body.warningRegistryVariant !== 'internal' && body.warningRegistryVariant !== 'retired') {
      return badRequest("warningRegistryVariant must be 'internal' or 'retired'");
    }
    update.warningRegistryVariant = body.warningRegistryVariant;
  }

  if (body.flags !== undefined) {
    if (typeof body.flags !== 'object' || body.flags === null || Array.isArray(body.flags)) {
      return badRequest('flags must be an object');
    }
    const flags: Partial<Record<Phase2Flag, boolean>> = {};
    for (const [key, value] of Object.entries(body.flags as Record<string, unknown>)) {
      if (!PHASE2_FLAGS.includes(key as Phase2Flag)) {
        return badRequest(`Unknown Phase 2 flag: ${key}`);
      }
      if (typeof value !== 'boolean') {
        return badRequest(`flags.${key} must be a boolean`);
      }
      flags[key as Phase2Flag] = value;
    }
    update.flags = flags;
  }

  if (Object.keys(update).length === 0) {
    return badRequest('Nothing to update');
  }

  await db
    .collection('governance_settings')
    .doc('phase2')
    .set(
      {
        ...update,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: founder.uid,
        changeReason,
      },
      { merge: true },
    );

  await writeGovernanceAuditOrThrow(db, {
    action: 'governance_settings_updated',
    actorUid: founder.uid,
    targetType: 'governance_settings',
    targetId: 'phase2',
    details: { changeReason, keys: Object.keys(update) },
  });

  const settings = await getGovernanceSettings(db);
  return NextResponse.json({ settings });
}
