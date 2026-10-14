/**
 * POST /api/client-errors: durable sink for sanitized client error logs
 * (e.g. induction submit failures). The client never writes Firestore
 * directly for logging: firestore.rules has no client_errors grant
 * (default-deny) and is deliberately not weakened.
 *
 * Privacy: the accepted schema is an allow-list of metadata fields only
 * (error code/message, operation, payload FIELD NAMES). Unknown keys are
 * dropped, never stored. The client sends no uid; this route attaches the
 * uid from the verified ID token when a Bearer token is present, or null
 * when it is missing/invalid, so logging still works when the failure
 * itself is auth-related. No 401 path: a logging endpoint that rejects
 * unauthenticated reports would lose exactly the failures it exists to
 * capture.
 *
 * Durability: every accepted report is written to server logs AND,
 * best-effort, to the `client_errors` Firestore collection via the Admin
 * SDK (which bypasses rules). An Admin SDK failure never fails the
 * request: the server log line is the durable fallback.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyIdTokenString } from '@/lib/auth/verifySession';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_STR = 2000;

function asBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.slice(0, max);
}

function asBoundedStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 100) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 128) return null;
    out.push(entry);
  }
  return out;
}

/** Pick only the allow-listed log fields out of an untrusted client body. */
export function sanitizeClientErrorBody(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;

  const kind = asBoundedString(input.kind, 64);
  const operation = asBoundedString(input.operation, 128);
  const errorCode = asBoundedString(input.errorCode, 128);
  const errorMessage = asBoundedString(input.errorMessage, MAX_STR);
  const payloadFieldNames = asBoundedStringArray(input.payloadFieldNames);
  const context = asBoundedString(input.context, 128);
  const clientBuildId = asBoundedString(input.clientBuildId, 128);
  const tabLoadedAt = asBoundedString(input.tabLoadedAt, 64);
  const clientTimestamp = asBoundedString(input.clientTimestamp, 64);
  const userAgent = asBoundedString(input.userAgent, 512);
  const pathname = asBoundedString(input.pathname, 256);
  const freshnessStatus = asBoundedString(input.freshnessStatus, 64);
  const liveBuildId =
    input.liveBuildId === null ? null : asBoundedString(input.liveBuildId, 128);
  const tabAgeMs = input.tabAgeMs;
  const isStaleTabSuspected = input.isStaleTabSuspected;

  if (
    kind === null || operation === null || errorCode === null || errorMessage === null ||
    payloadFieldNames === null || context === null || clientBuildId === null ||
    tabLoadedAt === null || clientTimestamp === null || userAgent === null || pathname === null ||
    freshnessStatus === null || liveBuildId === undefined ||
    typeof tabAgeMs !== 'number' || !Number.isFinite(tabAgeMs) ||
    typeof isStaleTabSuspected !== 'boolean'
  ) {
    return null;
  }

  return {
    kind,
    operation,
    errorCode,
    errorMessage,
    payloadFieldNames,
    context,
    clientBuildId,
    tabLoadedAt,
    tabAgeMs,
    isStaleTabSuspected,
    freshnessStatus,
    liveBuildId,
    clientTimestamp,
    userAgent,
    pathname,
  };
}

export async function POST(request: NextRequest) {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: 'Unreadable request body' }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const log = sanitizeClientErrorBody(parsed);
  if (log === null) {
    return NextResponse.json({ error: 'Invalid client error payload' }, { status: 400 });
  }

  // Best-effort caller identity: verified token uid, or null. Never 401.
  let uid: string | null = null;
  try {
    const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
    const token = header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token.length > 0) {
      const decoded = await verifyIdTokenString(token);
      uid = decoded.uid ?? null;
    }
  } catch {
    uid = null;
  }

  const stored = { ...log, uid, receivedAt: new Date().toISOString() };

  // Durable sink 1: server logs (Vercel log drain).
  try {
    console.error('[client-errors] ' + JSON.stringify(stored));
  } catch {
    // Logging must never fail the request.
  }

  // Durable sink 2: Firestore `client_errors` via Admin SDK (bypasses rules).
  // Best-effort: an Admin failure leaves the server log line as the record.
  try {
    if (ensureAdminInitialized()) {
      const db = getDb();
      if (db) {
        await db.collection('client_errors').add({
          ...stored,
          createdAt: new Date(),
        });
      }
    }
  } catch (err) {
    console.warn('[client-errors] Firestore write failed (server log kept):', err);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
