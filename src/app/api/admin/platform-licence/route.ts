/**
 * Platform licence admin API (Workstream H, spec 4.4).
 *
 * GET: Founder only. Returns the licence DTO, the effective state
 * (including the admin-only noticeRunning projection), and history.
 * POST: Founder only. Actions: record, serve-notice (requires
 * confirmation 'SERVE NOTICE' plus a non-empty noticeReason and
 * licencePublicNotice), withdraw-notice, record-expiry, reinstate.
 * Invalid transitions return 409 INVALID_LICENCE_TRANSITION.
 *
 * There is deliberately NO way to type a revocation date directly:
 * the effective date is always servedAt + 7 days (spec 3.2).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { isFounder } from '@/lib/roles';
import {
  applyLicenceTransition,
  getEffectiveSiteState,
  listLicenceHistory,
  readPlatformLicence,
  type LicenceAction,
} from '@/lib/server/platform-licence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS: readonly LicenceAction[] = [
  'record',
  'serve-notice',
  'withdraw-notice',
  'record-expiry',
  'reinstate',
];

type FounderGate =
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse };

async function requireFounder(request: NextRequest): Promise<FounderGate> {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  const uid = auth.user.userId;
  if (!isFounder(uid)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Platform licence is Founder-only', code: 'FOUNDER_ONLY' },
        { status: 403 },
      ),
    };
  }
  return { ok: true, uid };
}

export async function GET(request: NextRequest) {
  const gate = await requireFounder(request);
  if (!gate.ok) return gate.response;
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Database not available' },
      { status: 500 },
    );
  }
  const [licence, effective, history] = await Promise.all([
    readPlatformLicence(db),
    getEffectiveSiteState(db),
    listLicenceHistory(db),
  ]);
  return NextResponse.json({ licence, effective, history });
}

export async function POST(request: NextRequest) {
  const gate = await requireFounder(request);
  if (!gate.ok) return gate.response;
  const uid = gate.uid;
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Database not available' },
      { status: 500 },
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const action = body.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: 'Unknown licence action', code: 'UNKNOWN_ACTION' },
      { status: 400 },
    );
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  if (action === 'serve-notice') {
    if (body.confirmation !== 'SERVE NOTICE') {
      return NextResponse.json(
        {
          error: 'Serving notice requires typing SERVE NOTICE to confirm',
          code: 'CONFIRMATION_REQUIRED',
        },
        { status: 400 },
      );
    }
    const noticeReason = str(body.noticeReason);
    const licencePublicNotice = str(body.licencePublicNotice);
    if (!noticeReason || !licencePublicNotice) {
      return NextResponse.json(
        {
          error: 'A notice reason and a public notice are both required',
          code: 'NOTICE_FIELDS_REQUIRED',
        },
        { status: 400 },
      );
    }
  }

  const result = await applyLicenceTransition(db, uid, action as LicenceAction, {
    licensor: str(body.licensor) || undefined,
    licensee: str(body.licensee) || undefined,
    agreementRefId: str(body.agreementRefId) || undefined,
    agreementRefUrl: str(body.agreementRefUrl) || undefined,
    noticeReason: str(body.noticeReason) || undefined,
    licencePublicNotice: str(body.licencePublicNotice) || undefined,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: 'That licence transition is not allowed from the current state',
        code: result.code ?? 'INVALID_LICENCE_TRANSITION',
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ licence: result.licence, effective: result.effective });
}
