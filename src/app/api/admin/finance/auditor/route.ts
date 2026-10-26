import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { AuditorAppointment } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';
// MIGRATION SEAM: finance finance-auditor
import { mirrorAuditorSet, supaAuditorDoc } from '@/lib/finance/supa/routes-core-seam';
// CUTOVER: finance write-primary (SUPA_PRIMARY=finance) — see
// src/lib/finance/supa/primary.ts.
import { callFinanceTx, financePayloadHash, financePrimaryEnabled } from '@/lib/finance/supa/primary';

/**
 * External auditor appointment record (spec Part C 3.8 + 4.8). One record
 * per FY (auditor_appointments/{fyLabel}), owned by Finance and consumed
 * by the AGM workstream. `fallback` is stored as its own field as well as
 * implied by appointedBy, because the AGM checklist reads a flag: the API
 * keeps them consistent, and a body whose fallback contradicts appointedBy
 * is a 422 rather than a silent normalization. An appointment made by
 * Founder fallback exists precisely to be disclosed.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance')) ||
      (await hasServerPermissionForUser(caller.db, caller.uid, 'canApproveMoney'));
    if (!can) return httpError(403, 'Forbidden');
    const fy = new URL(request.url).searchParams.get('fy');
    if (!fy) return httpError(400, 'fy is required');
    // MIGRATION SEAM: finance finance-auditor (R7)
    const snap = (await supaAuditorDoc(fy)) ?? (await caller.db.collection('auditor_appointments').doc(fy).get());
    if (!snap.exists) return NextResponse.json({ auditor: null, fyLabel: fy });
    const a = snap.data() as AuditorAppointment;
    return NextResponse.json({
      auditor: { ...a, fallback: a.appointedBy === 'founder_fallback' },
      fyLabel: fy,
    });
  } catch (err) {
    return financeErrorResponse(err);
  }
}

export async function PUT(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    if (!(await hasServerPermissionForUser(caller.db, caller.uid, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as Partial<AuditorAppointment> & { fallback?: boolean };
    if (!body.fyLabel || !/^fy\d{4}-\d{2}$/.test(body.fyLabel)) return httpError(400, 'fyLabel must look like fy2026-27');
    if (!body.appointedBy || !['board', 'founder_fallback'].includes(body.appointedBy)) {
      return httpError(400, 'appointedBy must be board or founder_fallback');
    }
    if (!body.appointedAt) return httpError(400, 'appointedAt (ISO date) is required');
    if (!body.auditorName) return httpError(400, 'auditorName is required');
    const computedFallback = body.appointedBy === 'founder_fallback';
    if (body.fallback !== undefined && body.fallback !== computedFallback) {
      return httpError(422, 'fallback flag contradicts appointedBy');
    }
    // CUTOVER (F5i): the function upserts auditor_appointments/{fyLabel}
    // and writes AUDITOR_APPOINTMENT_RECORDED in one tx.
    if (financePrimaryEnabled()) {
      const appointmentDoc = {
        fyLabel: body.fyLabel,
        auditorName: body.auditorName,
        firmName: body.firmName ?? null,
        appointedAt: body.appointedAt,
        appointedBy: body.appointedBy,
        fallback: computedFallback,
        appointedByUid: caller.uid,
        engagementLetterDriveId: body.engagementLetterDriveId ?? null,
        recordedBy: caller.uid,
      };
      const res = await callFinanceTx(
        'finance_auditor_record',
        'tx_finance_auditor_record',
        {
          p_caller_uid: caller.uid,
          p_fy_label: body.fyLabel,
          p_appointment: appointmentDoc,
          p_audit_action: 'AUDITOR_APPOINTMENT_RECORDED',
          p_audit_payload: {
            auditorName: body.auditorName,
            firmName: body.firmName ?? null,
            appointedBy: body.appointedBy,
            fallback: computedFallback,
          },
        },
        `auditor_record:${body.fyLabel}:${caller.uid}:${financePayloadHash(appointmentDoc)}`,
      );
      if (!res || res.ok !== true) return httpError(res?.httpStatus ?? 500, res?.message ?? 'Internal error');
      return NextResponse.json({ fyLabel: body.fyLabel, fallback: computedFallback });
    }
    const ref = caller.db.collection('auditor_appointments').doc(body.fyLabel);
    const appointment = {
      fyLabel: body.fyLabel,
      auditorName: body.auditorName,
      firmName: body.firmName ?? null,
      appointedAt: body.appointedAt,
      appointedBy: body.appointedBy,
      fallback: computedFallback,
      appointedByUid: caller.uid,
      engagementLetterDriveId: body.engagementLetterDriveId ?? null,
      recordedBy: caller.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    const batch = caller.db.batch();
    batch.set(ref, appointment);
    await writeFinanceAudit(caller.db, batch, {
      action: 'AUDITOR_APPOINTMENT_RECORDED',
      actorUid: caller.uid,
      targetUidOrResource: `auditor_appointments/${body.fyLabel}`,
      payload: { auditorName: body.auditorName, firmName: body.firmName ?? null, appointedBy: body.appointedBy, fallback: computedFallback },
    });
    await batch.commit();
    // MIGRATION SEAM: finance finance-auditor (W3 mirror, MANUAL_LIST M-FG123-4)
    await mirrorAuditorSet(body.fyLabel, appointment as unknown as Record<string, unknown>);
    return NextResponse.json({ fyLabel: body.fyLabel, fallback: computedFallback });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
