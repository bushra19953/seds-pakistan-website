/** Shared HTTP plumbing for the cadetship API routes. */

import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SessionError } from '@/lib/auth/verifySession';

/** Authenticated caller uid, or throws SessionError (401). */
export async function requireUid(req: NextRequest): Promise<string> {
  const decoded = await verifySession(req);
  return decoded.uid;
}

export function sessionErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SessionError) {
    return NextResponse.json({ error: err.message }, { status: err.statusCode });
  }
  return null;
}

export function errorJson(status: number, code: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: code, ...extra }, { status });
}
