import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { isConsentDecider } from '@/lib/consents/consent-config';
import {
  ConsentServiceError,
  listInbox,
} from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/consents/inbox - the Founder's decision queue.
 * Founder only: non-deciders get 403 NOT_FOUNDER and NO queue data.
 * Pending requests are ordered by decisionDeadlineAt asc, urgent first;
 * further_information_requested requests are listed separately (spec A.7).
 */
export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) {
    return NextResponse.json(
      { error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' },
      { status: 500 },
    );
  }

  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const decider = await isConsentDecider(db, auth.user.userId);
  if (!decider) {
    return NextResponse.json(
      { error: 'Only the Founder decides Consent requests', code: 'NOT_FOUNDER' },
      { status: 403 },
    );
  }

  try {
    const inbox = await listInbox(db);
    return NextResponse.json(inbox);
  } catch (err) {
    if (err instanceof ConsentServiceError) {
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err.fields) body.fields = err.fields;
      return NextResponse.json(body, { status: err.status });
    }
    console.error('[api/consents/inbox] unexpected error', err);
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
