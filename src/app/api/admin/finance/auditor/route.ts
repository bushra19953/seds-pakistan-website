import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { AuditorAppointment } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

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
    const snap = await caller.db.collection('auditor_appointments').doc(fy).get();
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
    const ref = caller.db.collection('auditor_appointments').doc(body.fyLabel);
    const batch = caller.db.batch();
    batch.set(ref, {
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
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'AUDITOR_APPOINTMENT_RECORDED',
      actorUid: caller.uid,
      targetUidOrResource: `auditor_appointments/${body.fyLabel}`,
      payload: { auditorName: body.auditorName, firmName: body.firmName ?? null, appointedBy: body.appointedBy, fallback: computedFallback },
    });
    await batch.commit();
    return NextResponse.json({ fyLabel: body.fyLabel, fallback: computedFallback });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
