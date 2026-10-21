/**
 * GET/PATCH /api/admin/compliance/templates/[key] (phase2_spec.md G.7).
 * Founder/NGS only. PATCH bumps templateVersion by 1 - instances pin the
 * version they were generated from, so a correction never silently
 * rewrites history. NO DELETE: a wrong template is corrected by PATCH or
 * deactivated (active: false), never removed.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isNgs } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { datesToIso } from '@/lib/server/compliance/serialize';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EDITABLE = [
  'title',
  'deadlineRule',
  'reminderOffsetsDays',
  'proofTypes',
  'evidenceChecklist',
  'alsoNotifiedRoles',
  'alsoRecordableBy',
  'reviewerRole',
  'active',
] as const;

async function gate(uid: string): Promise<boolean> {
  return isFounderUid(uid) || (await isNgs(uid));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const uid = await requireUid(req);
    const { key } = await params;
    const db = dbOrThrow();
    if (!(await gate(uid))) return errorJson(403, 'FORBIDDEN');
    const snap = await db.collection('compliance_templates').doc(key).get();
    if (!snap.exists) return errorJson(404, 'TEMPLATE_NOT_FOUND');
    return NextResponse.json({ template: { id: key, ...(datesToIso(snap.data()) as Record<string, unknown>) } });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[admin/compliance/templates/get] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const uid = await requireUid(req);
    const { key } = await params;
    const db = dbOrThrow();
    if (!(await gate(uid))) return errorJson(403, 'FORBIDDEN');

    const ref = db.collection('compliance_templates').doc(key);
    const snap = await ref.get();
    if (!snap.exists) return errorJson(404, 'TEMPLATE_NOT_FOUND');

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of EDITABLE) {
      if (field in body) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) return errorJson(400, 'NO_EDITABLE_FIELDS');

    const nextVersion = ((snap.data()?.templateVersion as number) ?? 1) + 1;
    await ref.update({
      ...patch,
      templateVersion: nextVersion,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.template_updated',
      subjectType: 'compliance_template',
      subjectId: key,
      details: { fields: Object.keys(patch), templateVersion: nextVersion },
    });
    return NextResponse.json({ ok: true, templateVersion: nextVersion });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[admin/compliance/templates/patch] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
