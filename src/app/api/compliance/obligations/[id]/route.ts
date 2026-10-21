/**
 * GET /api/compliance/obligations/[id] (phase2_spec.md G.7).
 *
 * Readers: the CURRENT office holder (resolved live), holders of the
 * template's reviewer office, the Founder, and the NGS. Everyone else
 * gets a 403 - including a FORMER holder: the duty and its record follow
 * the office. The response carries the obligation, its template facts,
 * the linked default notice (if any), and the governance audit trail
 * for the state timeline.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isNgs, loadObligation } from '@/lib/server/compliance/access';
import { resolveObligationRecipients } from '@/lib/server/compliance/owner-resolution';
import { resolveRoleHolders } from '@/lib/server/role-holders';
import { isFounderUid } from '@/lib/server/founder-gate';
import { obligationToJson, noticeToJson, datesToIso } from '@/lib/server/compliance/serialize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const obligation = await loadObligation(db, id);
    if (!obligation) return errorJson(404, 'OBLIGATION_NOT_FOUND');
    const data = obligation.data;

    const templateSnap = await db.collection('compliance_templates').doc(data.templateKey as string).get();
    const template = templateSnap.exists ? (templateSnap.data() as Record<string, any>) : null;

    const resolved = await resolveObligationRecipients(
      data.officeRole as string,
      (data.chapterId as string | null) ?? null,
    );
    const reviewerHolders = template?.reviewerRole
      ? await resolveRoleHolders(template.reviewerRole as string, (data.chapterId as string | null) ?? null)
      : [];
    const allowed =
      resolved.holderUid === uid ||
      reviewerHolders.includes(uid) ||
      isFounderUid(uid) ||
      (await isNgs(uid));
    if (!allowed) return errorJson(403, 'FORBIDDEN');

    let notice: Record<string, unknown> | null = null;
    if (data.defaultNoticeId) {
      const noticeSnap = await db.collection('default_notices').doc(data.defaultNoticeId as string).get();
      if (noticeSnap.exists) notice = noticeToJson(noticeSnap.id, noticeSnap.data() as Record<string, any>);
    }

    const auditSnap = await db
      .collection('audit_logs')
      .where('subjectId', '==', id)
      .get()
      .catch(() => null);
    const auditTrail = auditSnap
      ? auditSnap.docs
          .map((d): Record<string, unknown> => ({ id: d.id, ...(datesToIso(d.data()) as Record<string, unknown>) }))
          .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
      : [];

    return NextResponse.json({
      obligation: obligationToJson(id, data),
      template: template
        ? {
            templateKey: data.templateKey,
            reviewerRole: template.reviewerRole ?? null,
            proofTypes: template.proofTypes ?? [],
            evidenceChecklist: template.evidenceChecklist ?? [],
          }
        : null,
      currentHolderUid: resolved.holderUid,
      officeVacant: resolved.vacant,
      notice,
      auditTrail,
    });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/obligations/get] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
