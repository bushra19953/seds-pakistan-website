/**
 * Shared helpers for the intake-window admin routes (Workstream E,
 * spec section 5). Co-located module, not a route.
 *
 * Gate: canManageApplications (spec 5.1). Time input contract: admins
 * send PKT wall time as 'YYYY-MM-DDTHH:mm' (datetime-local); the server
 * converts to a UTC instant with the fixed Asia/Karachi offset (+05:00,
 * no DST) and NEVER trusts a client-supplied offset or epoch value.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  hasServerPermissionForUser,
  resolveUserRole,
} from '@/lib/server/permissions';
import {
  deriveWindowState,
  resolveWindow,
  timestampLikeToMs,
  windowToLike,
} from '@/lib/intake-windows/resolve';
import type {
  IntakeWindow,
  IntakeWindowKind,
} from '@/types/intake-window';
import type { Firestore } from 'firebase-admin/firestore';

export const VALID_INTAKE_KINDS: readonly IntakeWindowKind[] = [
  'induction',
  'chapter_application',
  'drive',
  'other',
];

export const INTAKE_TIMEZONE = 'Asia/Karachi';
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

export type AdminGateResult =
  | { ok: true; db: Firestore; uid: string; role: string | null }
  | { ok: false; response: NextResponse };

/** Authenticate + authorize an intake admin request. */
export async function requireIntakeAdmin(
  request: NextRequest,
): Promise<AdminGateResult> {
  const db = getDb();
  if (!db) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Database not initialized' },
        { status: 500 },
      ),
    };
  }
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  const uid = auth.user.userId;
  const role = await resolveUserRole(db, uid);
  const allowed = await hasServerPermissionForUser(
    db as never,
    uid,
    'canManageApplications',
  );
  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }
  return { ok: true, db: db as unknown as Firestore, uid, role };
}

/**
 * Parse a PKT wall-time string 'YYYY-MM-DDTHH:mm' (optional ':ss') to a
 * UTC epoch ms. Returns null for anything else, including strings that
 * carry their own offset: the wire format is wall time in Asia/Karachi
 * only, so a client can never smuggle a different interpretation in.
 */
export function parsePktWallTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // Round-trip check rejects overflow dates like Feb 30.
  const dt = new Date(utcMs);
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day ||
    dt.getUTCHours() !== hour ||
    dt.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return utcMs - PKT_OFFSET_MS;
}

/**
 * Validate a targetApplications input (item 11 demand figure). Absent
 * or null means "no target" and is always valid; otherwise it must be
 * a whole number in a sane range for an application pool.
 */
export function parseTargetApplications(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 100000
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'window';
}

/**
 * Deterministic window id: {kind}-{yyyy}-{mm}-{slug(label)} where the
 * year/month are the closesAt PKT wall components (spec 5.1).
 */
export function makeWindowId(
  kind: IntakeWindowKind,
  closesAtMs: number,
  label: string,
): string {
  const pkt = new Date(closesAtMs + PKT_OFFSET_MS);
  const yyyy = pkt.getUTCFullYear();
  const mm = String(pkt.getUTCMonth() + 1).padStart(2, '0');
  return `${kind}-${yyyy}-${mm}-${slugifyLabel(label)}`;
}

function toIsoOrNull(value: unknown): string | null {
  const ms = timestampLikeToMs(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Admin serialization of one window (spec 5.1): stored fields with ISO
 * instants, plus derivedState at nowMs and whether this window is the
 * resolved one for its kind.
 */
export function toAdminWindow(
  window: IntakeWindow,
  allWindows: IntakeWindow[],
  nowMs: number,
) {
  const like = windowToLike({
    ...(window as unknown as Record<string, unknown>),
    windowId: window.windowId,
  });
  const resolved = resolveWindow(
    allWindows.map((w) =>
      windowToLike({
        ...(w as unknown as Record<string, unknown>),
        windowId: w.windowId,
      }),
    ),
    window.kind,
    nowMs,
  );
  return {
    windowId: window.windowId,
    label: window.label,
    kind: window.kind,
    opensAt: toIsoOrNull(window.opensAt),
    closesAt: toIsoOrNull(window.closesAt),
    timezone: window.timezone,
    fyLabel: window.fyLabel ?? null,
    targetApplications:
      typeof window.targetApplications === 'number'
        ? window.targetApplications
        : null,
    isDefault: window.isDefault === true,
    storedStatus: window.storedStatus ?? null,
    cancelReason: window.cancelReason ?? null,
    cancelledBy: window.cancelledBy ?? null,
    cancelledAt: toIsoOrNull(window.cancelledAt),
    source: window.source,
    templateId: window.templateId ?? null,
    notes: window.notes ?? null,
    createdBy: window.createdBy,
    createdAt: toIsoOrNull(window.createdAt),
    updatedAt: toIsoOrNull(window.updatedAt),
    derivedState: deriveWindowState(like, nowMs),
    isResolvedForKind: resolved?.windowId === window.windowId,
  };
}

export interface OverlapWarning {
  code: 'overlap_same_kind';
  windowIds: string[];
}

/**
 * Overlap is legal (spec 4.3 step 2 resolves it) but must be surfaced:
 * any non-cancelled window of the same kind whose [opensAt, closesAt)
 * intersects the candidate's range.
 */
export function collectOverlapWarnings(
  allWindows: IntakeWindow[],
  candidate: {
    kind: IntakeWindowKind;
    opensAtMs: number;
    closesAtMs: number;
    excludeWindowId?: string;
  },
): OverlapWarning[] {
  const overlapping = allWindows
    .filter((w) => {
      if (w.kind !== candidate.kind) return false;
      if (w.storedStatus === 'cancelled') return false;
      if (candidate.excludeWindowId && w.windowId === candidate.excludeWindowId) {
        return false;
      }
      const like = windowToLike({
        ...(w as unknown as Record<string, unknown>),
        windowId: w.windowId,
      });
      return like.opensAtMs < candidate.closesAtMs && candidate.opensAtMs < like.closesAtMs;
    })
    .map((w) => w.windowId);
  if (overlapping.length === 0) return [];
  return [{ code: 'overlap_same_kind', windowIds: overlapping }];
}

/** Validation failure body shape: names the offending field. */
export function validationError(field: string, message: string) {
  return NextResponse.json(
    { error: 'validation_failed', field, message },
    { status: 400 },
  );
}
