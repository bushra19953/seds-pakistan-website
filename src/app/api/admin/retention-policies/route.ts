import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  getRetentionPolicies,
  saveRetentionPolicy,
} from '@/lib/retention/policies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Real retention settings (Workstream F), replacing the placebo toast
// on the audit-logs page. Reads/writes retention_policies overrides
// merged over the F-G defaults. Governance classes are flag-for-review
// only and reject automatic actions (enforced in policies.ts too).
async function authorize(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user?.role) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const allowed = await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canViewAuditLogs');
  if (!allowed) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { uid: auth.user.userId };
}

export async function GET(request: NextRequest) {
  const gate = await authorize(request);
  if (gate.error) return gate.error;
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  const policies = await getRetentionPolicies(db as never);
  return NextResponse.json({ policies });
}

export async function PUT(request: NextRequest) {
  const gate = await authorize(request);
  if (gate.error) return gate.error;
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  const key = typeof body?.key === 'string' ? body.key : '';
  if (!key) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  for (const field of [
    'archiveAfterDays',
    'scrubAfterDays',
    'deleteAfterDays',
  ] as const) {
    if (field in (body ?? {})) {
      const v = body?.[field];
      if (v !== null && (typeof v !== 'number' || v < 0)) {
        return NextResponse.json(
          { error: `${field} must be a non-negative number of days or null` },
          { status: 400 },
        );
      }
      patch[field] = v;
    }
  }
  if (typeof body?.flagForReviewOnly === 'boolean') {
    patch.flagForReviewOnly = body.flagForReviewOnly;
  }
  try {
    const policy = await saveRetentionPolicy(
      db as never,
      key,
      patch as never,
      gate.uid,
    );
    await db.collection('audit_logs').add({
      type: 'RETENTION_POLICY_UPDATED',
      actorId: gate.uid,
      targetId: key,
      data: { fields: Object.keys(patch) },
      timestamp: new Date(),
    });
    return NextResponse.json({ policy });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to save policy' },
      { status: 400 },
    );
  }
}
