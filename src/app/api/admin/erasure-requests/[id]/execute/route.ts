import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { executeErasure } from '@/lib/retention/erasure';
import { createErasureDeps } from '@/lib/retention/server-deps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST: execute an erasure whose cooling-off has ended (Workstream F).
// This is the ONLY path in the platform that deletes a Firebase Auth
// account; Departed members are never erased. Gated canManageUsers.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user?.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const allowed = await hasServerPermission(auth.user.role, 'canManageUsers');
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const deps = createErasureDeps();
    const result = await executeErasure(deps, params.id, auth.user.userId);
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Erasure failed' },
      { status: 400 },
    );
  }
}
