import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  projectsSupaServerEnabled,
  supaDeleteProject,
  supaListProjectRows,
  supaSetProject,
  supaUpdateProject,
} from '@/lib/projects-supa';

/**
 * /api/admin/projects/supa — the admin mirror/read endpoint for the
 * projects Supabase surface (see src/lib/projects-supa.ts).
 *
 *   GET  -> { rows: Array<{ id, data }> }
 *     Raw fs_projects rows for the admin projects list, consumed by
 *     the seam's fetchAdminProjectRowsViaRoute. The rows carry the
 *     stored jsonb bodies (timestamps as ISO strings or the
 *     Admin-dump {_seconds,_nanoseconds} shape); the client restores
 *     Timestamp instances via the seam's restoreProjectTimestamps.
 *
 *   POST { op: 'set' | 'update' | 'delete', id, data? } -> { ok: true }
 *     One mirror write, consumed by mirrorProjectViaRoute after the
 *     primary Firestore write lands, and by the client-actions
 *     create path. 'update' on a row the mirror does not hold
 *     writes nothing (the seam's boolean contract) and answers
 *     { ok: true, applied: false } rather than an error: a missed
 *     mirror is a stale read copy, never a failed admin write.
 *
 * Gate, in order: server flag (SUPA_SURFACES must name 'projects',
 * else 404 and every client falls back / skips), verified Firebase
 * session (401), and the canManageProjects permission resolved
 * server-side for the caller (403) — the same permission the admin
 * page's AuthorizationGate checks client-side and the pattern the
 * announcements admin supa route follows. Adapter failures surface
 * as 503; GET callers throw and fall back to Firestore, POST mirror
 * callers ignore the response by contract.
 */

export const dynamic = 'force-dynamic';

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

async function gate(req: NextRequest): Promise<NextResponse | { uid: string }> {
  if (!projectsSupaServerEnabled()) {
    return fail(404, 'Projects Supabase surface is not enabled');
  }
  if (!ensureAdminInitialized()) {
    return fail(500, 'Server misconfiguration');
  }
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return fail(401, 'Unauthorized');
  }
  const db = getDb();
  if (!db) return fail(500, 'Server misconfiguration');
  let allowed = false;
  try {
    allowed = await hasServerPermissionForUser(
      db as never,
      auth.user.userId,
      'canManageProjects',
    );
  } catch {
    allowed = false;
  }
  if (!allowed) return fail(403, 'Forbidden');
  return { uid: auth.user.userId };
}

export async function GET(req: NextRequest) {
  const gated = await gate(req);
  if (gated instanceof NextResponse) return gated;
  try {
    const rows = await supaListProjectRows();
    return NextResponse.json({ rows });
  } catch (err) {
    console.error('[api/admin/projects/supa] list failed:', err);
    return fail(503, 'Projects read unavailable');
  }
}

const MIRROR_OPS: ReadonlySet<string> = new Set(['set', 'update', 'delete']);

export async function POST(req: NextRequest) {
  const gated = await gate(req);
  if (gated instanceof NextResponse) return gated;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const op = typeof body.op === 'string' ? body.op : '';
  const id = typeof body.id === 'string' ? body.id : '';
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, any>)
      : undefined;
  if (!MIRROR_OPS.has(op) || !id) return fail(400, 'Invalid mirror write');
  if (op !== 'delete' && !data) return fail(400, 'Invalid mirror write');

  try {
    if (op === 'set') {
      await supaSetProject(id, data as Record<string, any>);
      return NextResponse.json({ ok: true });
    }
    if (op === 'update') {
      const applied = await supaUpdateProject(id, data as Record<string, any>);
      return NextResponse.json({ ok: true, applied });
    }
    await supaDeleteProject(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/admin/projects/supa] mirror failed:', err);
    return fail(503, 'Projects mirror unavailable');
  }
}
