import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  projectsSupaServerEnabled,
  supaDeleteProject,
  supaSetProject,
  supaUpdateProject,
} from '@/lib/projects-supa';

/**
 * POST /api/admin/projects — WS10 primary-write route for the admin
 * projects page (previously: client setDoc/deleteDoc through
 * firestore-wrapper + a client audit_logs write + a separate mirror
 * route call).
 *
 * Body: { op: 'set' | 'delete', id?, data?, timestampFields?,
 *         mirrorOp?: 'set' | 'update' | 'delete',
 *         audit?: { action, target, payload } }
 *
 * Effects, in order (the exact effects the client flow produced):
 *   1. Firestore primary write (Admin SDK). `timestampFields` names
 *      the client's serverTimestamp() fields: they land as real
 *      serverTimestamp on Firestore and as ISO strings in the mirror
 *      payload (the shape the seam's mirrors already store).
 *   2. audit_logs entry, server-side, in logAuditEntry's stored shape
 *      ({ action, actorUid, targetUidOrResource, payload, timestamp })
 *      — the client logAuditEntry call it replaces wrote the same doc
 *      through the wrapper. Best-effort, as logAuditEntry was (it
 *      never threw into the caller).
 *   3. Supabase mirror via the projects seam's server bridge,
 *      best-effort, only when the projects surface is enabled — the
 *      same contract mirrorProjectViaRoute had.
 *
 * `projects` is not a webhook-dispatch collection, so no replica
 * effect exists for these writes. Gate: verified session +
 * canManageProjects (the mirror route's gate; the page's
 * AuthorizationGate checks the same permission).
 */

export const dynamic = 'force-dynamic';

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) return fail(500, 'Server misconfiguration');
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return fail(401, 'Unauthorized');
  const db = getDb();
  if (!db) return fail(500, 'Server misconfiguration');
  let allowed = false;
  try {
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageProjects');
  } catch {
    allowed = false;
  }
  if (!allowed) return fail(403, 'Forbidden');

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const op = body.op === 'delete' ? 'delete' : body.op === 'set' ? 'set' : '';
  if (!op) return fail(400, 'Invalid op');
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, any>)
      : undefined;
  if (op === 'set' && !data) return fail(400, 'Invalid data');
  const id =
    typeof body.id === 'string' && body.id
      ? body.id
      : db.collection('projects').doc().id;

  const timestampFields: string[] = Array.isArray(body.timestampFields)
    ? body.timestampFields.filter((f: unknown): f is string => typeof f === 'string')
    : [];
  const nowIso = new Date().toISOString();
  const firestoreData: Record<string, any> = { ...(data || {}) };
  const mirrorData: Record<string, any> = { ...(data || {}) };
  for (const field of timestampFields) {
    firestoreData[field] = FieldValue.serverTimestamp();
    mirrorData[field] = nowIso;
  }

  try {
    if (op === 'set') {
      await db.collection('projects').doc(id).set(firestoreData, { merge: true });
    } else {
      await db.collection('projects').doc(id).delete();
    }
  } catch (err) {
    console.error('[api/admin/projects] primary write failed:', err);
    return fail(500, 'Project write failed');
  }

  // Audit (best-effort, logAuditEntry's contract).
  const audit = body.audit as
    | { action?: unknown; target?: unknown; payload?: unknown }
    | undefined;
  if (audit && typeof audit.action === 'string') {
    try {
      await db.collection('audit_logs').add({
        action: audit.action,
        actorUid: auth.user.userId,
        targetUidOrResource: typeof audit.target === 'string' ? audit.target : id,
        // The client flow's payload always carried projectId (the
        // doc id, which for a create is only known here).
        ...(audit.payload !== undefined
          ? {
              payload: {
                ...(typeof audit.payload === 'object' && audit.payload !== null
                  ? (audit.payload as Record<string, any>)
                  : {}),
                projectId: id,
              },
            }
          : { payload: { projectId: id } }),
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error('[api/admin/projects] audit write failed (non-fatal):', err);
    }
  }

  // Mirror (best-effort; never fails the primary write).
  if (projectsSupaServerEnabled()) {
    try {
      const mirrorOp = body.mirrorOp || (op === 'delete' ? 'delete' : 'set');
      if (mirrorOp === 'delete') await supaDeleteProject(id);
      else if (mirrorOp === 'update') await supaUpdateProject(id, mirrorData);
      else await supaSetProject(id, mirrorData);
    } catch (err) {
      console.error('[api/admin/projects] mirror failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, id });
}
