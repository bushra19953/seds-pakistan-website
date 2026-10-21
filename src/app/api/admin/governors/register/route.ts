import { NextRequest, NextResponse } from 'next/server';
import { getRegister } from '@/lib/server/governors/register';
import {
  authenticateGovernorRequest,
  governorErrorResponse,
  serializeValue,
} from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/governors/register (Phase 2, spec C.3).
 * Readers: Founder (UID), NGS, Founder Patron, seated Governors.
 * canAccessAdmin alone does NOT grant read. Reading materialises lapsed
 * terms first (via getRegister -> term sweep).
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateGovernorRequest(request, { edit: false });
  if ('error' in auth) return auth.error;
  try {
    const register = await getRegister(auth.ctx.db, new Date());
    return NextResponse.json({
      seats: serializeValue(register.seats),
      stats: register.stats,
      canEdit: auth.ctx.canEdit,
    });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
