import { NextRequest, NextResponse } from 'next/server';
import { seedGovernors } from '@/lib/server/governors/register';
import { FOUNDER_UID } from '@/lib/roles';
import {
  authenticateGovernorRequest,
  governorErrorResponse,
} from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/governors/seed (Phase 2, spec C.2.1).
 * Creates the nine seat docs (idempotent) and seats the Founder from the
 * Founder's own user record. Editors only. This route exists for local and
 * first-run setup; the crew that ran this build never executed it against
 * production data.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateGovernorRequest(request, { edit: true });
  if ('error' in auth) return auth.error;
  try {
    const founderSnap = await auth.ctx.db.collection('users').doc(FOUNDER_UID).get();
    const founderData = founderSnap.exists
      ? (founderSnap.data() as Record<string, unknown>)
      : undefined;
    const founderName =
      (typeof founderData?.displayName === 'string' && (founderData.displayName as string)) ||
      (typeof founderData?.name === 'string' && (founderData.name as string)) ||
      null;
    if (!founderName) {
      return NextResponse.json(
        { error: 'Founder user record has no display name; seed fixtures unavailable', code: 'SEED_FIXTURES_MISSING' },
        { status: 422 },
      );
    }
    const result = await seedGovernors(auth.ctx.db, auth.ctx.actor, {
      founderHolder: {
        uid: FOUNDER_UID,
        name: founderName,
        email: typeof founderData?.email === 'string' ? (founderData.email as string) : null,
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
