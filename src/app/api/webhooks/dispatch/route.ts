/**
 * Server-side webhook proxy for client background syncs.
 *
 * The client firestore-wrapper cannot hold FIRESTORE_WEBHOOK_SECRET (it would
 * leak into the browser bundle), so it calls this route with the user's
 * Firebase ID token instead. This route verifies the caller via the shared
 * session helper, then forwards the payload to the internal Firestore webhook
 * handler with the secret injected server-side. The secret never leaves the
 * server, and the original /api/webhooks/firestore route is untouched for
 * external callers that present the secret directly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { POST as firestoreWebhookPOST } from '../firestore/route';
import { verifySession, toSessionErrorResponse } from '@/lib/auth/verifySession';

export async function POST(request: NextRequest) {
  // 1. Authenticate the caller with their Firebase ID token.
  try {
    await verifySession(request);
  } catch (err) {
    const mapped = toSessionErrorResponse(err);
    return mapped ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Fail closed when the server secret is not configured.
  const secret = process.env.FIRESTORE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhooks:dispatch] FIRESTORE_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  // 3. Rebuild the request for the inner handler with the secret injected.
  // An unreadable body is a client error (400), never a 500.
  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json({ error: 'Unreadable request body' }, { status: 400 });
  }
  const proxied = new Request(request.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': secret,
    },
    body,
  });

  // 4. Hand off to the real webhook logic and return its response unchanged.
  // The inner handler catches its own errors, so a throw here means the
  // handoff itself failed: report 502 (upstream failure), not 500.
  try {
    return await firestoreWebhookPOST(proxied);
  } catch (err) {
    console.error('[webhooks:dispatch] Inner webhook handler threw:', err);
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 502 });
  }
}
