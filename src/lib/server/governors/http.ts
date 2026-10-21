/**
 * Governors API plumbing (Phase 2, spec C.3): session authentication against
 * the register reader/editor sets, GovernorOpError -> HTTP mapping, and a
 * JSON serializer that renders Firestore Timestamps and Dates as ISO strings
 * so register responses never leak driver objects.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { canEditRegister, isRegisterReader } from '@/lib/server/governors/access';
import { GovernorOpError, type GovernorActor } from '@/lib/server/governors/register';
import type { Firestore } from 'firebase-admin/firestore';

export interface GovernorRequestContext {
  db: Firestore;
  actor: GovernorActor;
  canEdit: boolean;
}

export async function authenticateGovernorRequest(
  request: NextRequest,
  opts: { edit: boolean },
): Promise<{ ctx: GovernorRequestContext } | { error: NextResponse }> {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const uid = String((auth.user as any).userId || '');
  const role = ((auth.user as any).role as string | undefined) ?? null;
  const name = ((auth.user as any).displayName as string | undefined) ?? null;

  if (!isRegisterReader(uid, role)) {
    return {
      error: NextResponse.json(
        { error: 'Forbidden: the Board register is restricted to the Founder, the National General Secretary, the Founder Patron, and seated Governors' },
        { status: 403 },
      ),
    };
  }
  const canEdit = canEditRegister(uid, role);
  if (opts.edit && !canEdit) {
    return {
      error: NextResponse.json(
        { error: 'Forbidden: only the Founder and the National General Secretary may change the register' },
        { status: 403 },
      ),
    };
  }
  const db = getDb();
  if (!db) {
    return { error: NextResponse.json({ error: 'Database unavailable' }, { status: 500 }) };
  }
  return {
    ctx: {
      db: db as unknown as Firestore,
      actor: { uid, name, role, authorized: canEdit },
      canEdit,
    },
  };
}

export function governorErrorResponse(err: unknown): NextResponse {
  if (err instanceof GovernorOpError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
  }
  console.error('[governors-api] unexpected error', err);
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}

/** Deep-serialize Dates and Firestore Timestamps to ISO strings. */
export function serializeValue(value: unknown): unknown {
  if (value == null) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date };
    if (typeof v.toDate === 'function') {
      const d = v.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(val);
    }
    return out;
  }
  return value;
}
