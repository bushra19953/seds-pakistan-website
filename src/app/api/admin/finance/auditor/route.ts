import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { hasServerPermission } from '@/lib/server/permissions';
import type { AuditorAppointment } from '@/types/finance';
import { writeFinanceAudit } from '@/lib/server/finance-audit';
import { authenticateFinanceCaller, financeErrorResponse, httpError } from '@/lib/server/finance-http';

/**
 * External auditor appointment record (spec Part C 4.7). One record per
 * FY (auditor_appointments/{fyLabel}). An appointment by Founder fallback
 * exists precisely to be disclosed: the response always carries the
 * fallback flag, and a stale flag that contradicts appointedBy is a 422
 * rather than a silent normalization.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateFinanceCaller(request);
  if ('response' in auth) return auth.response;
  const { caller } = auth;
  try {
    const can =
      (await hasServerPermission(caller.role, 'canManageFinance')) ||
      (await hasServerPermission(caller.role, 'canApproveMoney'));
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
    if (!(await hasServerPermission(caller.role, 'canManageFinance'))) return httpError(403, 'Forbidden');
    const body = (await request.json()) as Partial<AuditorAppointment> & { fallback?: boolean };
    if (!body.fyLabel || !/^fy\d{4}-\d{2}$/.test(body.fyLabel)) return httpError(400, 'fyLabel must look like fy2026-27');
    if (!body.appointedBy || !['agm', 'board', 'founder_fallback'].includes(body.appointedBy)) {
      return httpError(400, 'appointedBy must be agm, board, or founder_fallback');
    }
    if (!body.appointedOn) return httpError(400, 'appointedOn is required');
    const computedFallback = body.appointedBy === 'founder_fallback';
    if (body.fallback !== undefined && body.fallback !== computedFallback) {
      return httpError(422, 'fallback flag contradicts appointedBy');
    }
    const ref = caller.db.collection('auditor_appointments').doc(body.fyLabel);
    const batch = caller.db.batch();
    batch.set(ref, {
      fyLabel: body.fyLabel,
      firmName: body.firmName ?? '',
      engagementLetterDriveId: body.engagementLetterDriveId ?? '',
      appointedBy: body.appointedBy,
      appointedOn: body.appointedOn,
      fallback: computedFallback,
      feePkr: body.feePkr ?? null,
      status: body.status ?? 'engaged',
      recordedBy: caller.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeFinanceAudit(caller.db, batch, {
      action: 'AUDITOR_APPOINTMENT_RECORDED',
      actorUid: caller.uid,
      targetUidOrResource: `auditor_appointments/${body.fyLabel}`,
      payload: { firmName: body.firmName ?? '', appointedBy: body.appointedBy, fallback: computedFallback },
    });
    await batch.commit();
    return NextResponse.json({ fyLabel: body.fyLabel, fallback: computedFallback });
  } catch (err) {
    return financeErrorResponse(err);
  }
}
