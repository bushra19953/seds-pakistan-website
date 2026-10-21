/**
 * Public intake window route (Workstream E, spec 5.3).
 *
 * GET /api/public/intake-window?kind=induction
 *
 * Returns ONLY the public projection (no notes, no actor fields, no
 * audit data). Fail-safe by design: any resolution failure answers 200
 * with state 'closed' and an error code, because a silently open gate
 * is worse than a loudly closed one.
 *
 * Transition shim (parent brief): while the intake_windows collection
 * is EMPTY, kind=induction resolves from the deprecated
 * APPLICATION_DEADLINE_ISO constant so current behavior is preserved
 * exactly (X-Intake-Source: shim). Once any window doc exists, data is
 * the only source and a resolution failure is a fail-safe, not a fall
 * back to the constant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { listWindows } from '@/lib/server/intake-windows';
import {
  deriveWindowState,
  resolveWindow,
  toPublicWindow,
  windowToLike,
} from '@/lib/intake-windows/resolve';
import { APPLICATION_DEADLINE_ISO } from '@/lib/application-deadline';
import type {
  IntakeWindowKind,
  IntakeWindowLike,
  PublicIntakeWindow,
} from '@/types/intake-window';

export const dynamic = 'force-dynamic';

const VALID_KINDS: readonly string[] = [
  'induction',
  'chapter_application',
  'drive',
  'other',
];

const CACHE_CONTROL = 'public, s-maxage=30, stale-while-revalidate=30';
const SHIM_OPENS_AT_ISO = '2026-01-01T00:00:00+05:00';
const SHIM_WINDOW_ID = 'induction-legacy-shim';

function respond(body: unknown, source: 'data' | 'shim') {
  return NextResponse.json(body, {
    headers: {
      'Cache-Control': CACHE_CONTROL,
      'X-Intake-Source': source,
    },
  });
}

function failSafe(
  kind: IntakeWindowKind,
  nowMs: number,
  error: 'no_window_resolved' | 'window_malformed',
): PublicIntakeWindow & { error: string } {
  return {
    windowId: null,
    label: null,
    kind,
    opensAt: null,
    closesAt: null,
    state: 'closed',
    isDefault: false,
    serverNow: new Date(nowMs).toISOString(),
    error,
  };
}

export async function GET(request: NextRequest) {
  const kindParam = request.nextUrl.searchParams.get('kind') ?? 'induction';
  if (!VALID_KINDS.includes(kindParam)) {
    return NextResponse.json({ error: 'invalid_kind' }, { status: 400 });
  }
  const kind = kindParam as IntakeWindowKind;
  const nowMs = Date.now();

  try {
    const db = getDb();
    if (!db) throw new Error('Database not initialized');
    const windows = await listWindows(db);

    if (windows.length === 0) {
      if (kind === 'induction') {
        // Transition shim: the legacy constant, framed as a window.
        const shim: IntakeWindowLike = {
          windowId: SHIM_WINDOW_ID,
          kind: 'induction',
          opensAtMs: Date.parse(SHIM_OPENS_AT_ISO),
          closesAtMs: Date.parse(APPLICATION_DEADLINE_ISO),
          isDefault: false,
          createdAtMs: 0,
          label: 'Induction',
        };
        const pub = toPublicWindow(
          { ...shim, state: deriveWindowState(shim, nowMs) },
          nowMs,
          kind,
        );
        return respond(pub, 'shim');
      }
      return respond(failSafe(kind, nowMs, 'no_window_resolved'), 'data');
    }

    const likes = windows.map((w) =>
      windowToLike({
        ...(w as unknown as Record<string, unknown>),
        windowId: w.windowId,
      }),
    );
    const resolved = resolveWindow(likes, kind, nowMs);
    if (!resolved) {
      return respond(failSafe(kind, nowMs, 'no_window_resolved'), 'data');
    }
    if (
      !(resolved.opensAtMs > 0) ||
      !(resolved.closesAtMs > resolved.opensAtMs)
    ) {
      return respond(failSafe(kind, nowMs, 'window_malformed'), 'data');
    }
    return respond(toPublicWindow(resolved, nowMs, kind), 'data');
  } catch (err) {
    console.error('[public/intake-window] resolution failed:', err);
    return respond(failSafe(kind, nowMs, 'no_window_resolved'), 'data');
  }
}
