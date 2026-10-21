import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { resolveCanonicalRole } from '@/lib/server/permissions';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Shared auth + error contract for finance API routes (spec Part C 4):
 * Bearer ID token required; role resolved via resolveCanonicalRole
 * (never from a client-supplied role or the token role claim alone);
 * errors as { error } with 400/401/403/404/409/422/500.
 */

export interface FinanceCaller {
  uid: string;
  role: string;
  db: Firestore;
}

export async function authenticateFinanceCaller(
  request: NextRequest,
): Promise<{ caller: FinanceCaller } | { response: NextResponse }> {
  const db = getDb();
  if (!db) return { response: NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 }) };
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    const role = await resolveCanonicalRole(db, decoded.uid);
    return { caller: { uid: decoded.uid, role, db } };
  } catch {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
}

export function financeErrorResponse(err: unknown): NextResponse {
  const e = err as { status?: number; message?: string; code?: string; existingId?: string };
  const status = typeof e?.status === 'number' ? e.status : 500;
  return NextResponse.json(
    {
      error: e?.message || 'Internal error',
      ...(e?.code ? { code: e.code } : {}),
      ...(e?.existingId ? { existingId: e.existingId } : {}),
    },
    { status },
  );
}

export function httpError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
