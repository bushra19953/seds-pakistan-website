/**
 * Store-admin caller gate for GG's founder-side routes (waitlist list,
 * vendor summary). Copies the products route pattern verbatim: Bearer
 * token, verifyIdToken, hasServerPermissionForUser(canManageStore).
 */
import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';

export async function requireStoreAdmin(
  request: NextRequest,
): Promise<{ uid: string; db: Firestore } | { response: NextResponse }> {
  const db = getDb();
  if (!db) return { response: NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 }) };
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    uid = decoded.uid;
  } catch {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const can = await hasServerPermissionForUser(db, uid, 'canManageStore');
  if (!can) return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { uid, db };
}

export function serializeWaitlistEntry(id: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    productId: data.productId ?? null,
    requestedText: data.requestedText ?? null,
    searchQuery: data.searchQuery ?? null,
    userId: data.userId ?? null,
    contactName: data.contactName ?? null,
    contactPhone: data.contactPhone ?? null,
    contactEmail: data.contactEmail ?? null,
    source: data.source ?? null,
    status: data.status ?? null,
    statusChangedBy: data.statusChangedBy ?? null,
    createdAt: isoOrNull(data.createdAt),
    updatedAt: isoOrNull(data.updatedAt),
  };
}

export function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  const v = value as { toDate?: () => Date; seconds?: number };
  if (typeof v.toDate === 'function') {
    try {
      return v.toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
  return null;
}
