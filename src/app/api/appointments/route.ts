/**
 * GET /api/appointments (Workstream G, spec G.5.1).
 *
 * Admin list for the instruments queue: filters ratificationState,
 * acceptance.status, category, chapterId, free-text q (name/role);
 * cursor pagination on appointedAt desc in the positions GET shape
 * (cursor = appointedAt epoch ms). The mirror fields are refreshed
 * lazily on read from the Phase 2 read model (F-G2 option b,
 * read-repair: one write per stale row; G runs no cron of its own).
 *
 * Appointee variant: ?mine=1 returns only the caller's instruments,
 * sanitised to the G.7.2 card fields.
 */

import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/server/firebase-admin';
import { lifecycleStateProvider } from '@/lib/appointments/register-adapter';
import {
  INSTRUMENTS_COLLECTION,
  ratificationPlainLine,
  refusalDateLine,
  requireAppointmentsAdmin,
  requireAuthenticated,
  serializeInstrument,
  tsToIso,
  tsToMs,
} from './shared';
import type { AppointmentInstrument } from '@/types/appointment-instrument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Refresh one instrument's ratification mirror if it has drifted. */
async function readRepairMirror(
  db: import('firebase-admin/firestore').Firestore,
  instrument: AppointmentInstrument,
): Promise<AppointmentInstrument> {
  const lifecycle = await lifecycleStateProvider.getLifecycleState(db, {
    roleHistoryId: instrument.roleHistoryId,
    ratificationRequired: instrument.ratificationRequired,
    appointedAtMs: tsToMs(instrument.appointedAt),
  });
  const deadlineMs = tsToMs(instrument.ratificationDeadline);
  const drifted =
    lifecycle.state !== instrument.ratificationState ||
    (lifecycle.deadlineMs ?? 0) !== deadlineMs ||
    (lifecycle.decisionId ?? null) !== (instrument.ratificationDecisionId ?? null);
  if (!drifted) return instrument;
  const updates = {
    ratificationState: lifecycle.state,
    ratificationDeadline: lifecycle.deadlineMs
      ? admin.firestore.Timestamp.fromMillis(lifecycle.deadlineMs)
      : null,
    ratificationDecisionId: lifecycle.decisionId,
    updatedAt: admin.firestore.Timestamp.fromMillis(Date.now()),
  };
  try {
    await db
      .collection(INSTRUMENTS_COLLECTION)
      .doc(instrument.id)
      .update(updates);
  } catch {
    // Read-repair is best-effort; the Phase 2 record stays authoritative.
  }
  return { ...instrument, ...updates } as unknown as AppointmentInstrument;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mine = params.get('mine') === '1';

  if (mine) {
    const gate = await requireAuthenticated(request);
    if (!gate.ok) return gate.response;
    const snap = await gate.db
      .collection(INSTRUMENTS_COLLECTION)
      .where('appointeeUid', '==', gate.uid)
      .get();
    const instruments = snap.docs.map((d) => ({
      ...((d.data() ?? {}) as unknown as AppointmentInstrument),
      id: d.id,
    }));
    const cards = [];
    for (const instrument of instruments) {
      const repaired = await readRepairMirror(gate.db, instrument);
      const refused = await refusalDateLine(gate.db, repaired);
      cards.push({
        id: repaired.id,
        roleDisplayName: repaired.roleDisplayName,
        roleKey: repaired.roleKey,
        chapterId: repaired.chapterId,
        effectiveFrom: tsToIso(repaired.effectiveFrom),
        appointedAt: tsToIso(repaired.appointedAt),
        letterIssued: repaired.letter !== null,
        letterStatus: repaired.letter?.status ?? null,
        verificationCode: repaired.letter?.verificationCode ?? null,
        ratificationState: repaired.ratificationState,
        ratificationLine: ratificationPlainLine(repaired, refused),
        // Wording rule (G.4.2 step 5): "acceptance outstanding",
        // never "not yet in office".
        acceptanceStatus: repaired.acceptance?.status ?? 'awaiting_upload',
        acceptanceCheckNote: repaired.acceptance?.checkNote ?? null,
      });
    }
    cards.sort(
      (a, b) =>
        (b.appointedAt ? Date.parse(b.appointedAt) : 0) -
        (a.appointedAt ? Date.parse(a.appointedAt) : 0),
    );
    return NextResponse.json({ instruments: cards });
  }

  const gate = await requireAppointmentsAdmin(request);
  if (!gate.ok) return gate.response;
  const { db } = gate;

  const limitParam = Math.max(
    1,
    Math.min(100, Number(params.get('limit') || 50)),
  );
  const cursorMs = Number(params.get('cursor') || 0);

  type QueryLike = {
    where: (field: string, op: string, value: unknown) => QueryLike;
    get: () => Promise<{
      docs: Array<{ id: string; data: () => Record<string, unknown> | undefined }>;
    }>;
  };
  let query = db.collection(INSTRUMENTS_COLLECTION) as unknown as QueryLike;
  const ratificationState = params.get('ratificationState');
  if (ratificationState) query = query.where('ratificationState', '==', ratificationState);
  const acceptanceStatus = params.get('acceptanceStatus');
  if (acceptanceStatus) query = query.where('acceptance.status', '==', acceptanceStatus);
  const category = params.get('category');
  if (category) query = query.where('category', '==', category);
  const chapterId = params.get('chapterId');
  if (chapterId) query = query.where('chapterId', '==', chapterId);

  const snap = await query.get();
  let instruments: AppointmentInstrument[] = snap.docs.map((d) => ({
    ...((d.data() ?? {}) as unknown as AppointmentInstrument),
    id: d.id,
  }));

  const q = (params.get('q') || '').trim().toLowerCase();
  if (q) {
    instruments = instruments.filter(
      (i) =>
        i.appointeeDisplayName.toLowerCase().includes(q) ||
        i.roleDisplayName.toLowerCase().includes(q) ||
        i.roleKey.toLowerCase().includes(q),
    );
  }

  instruments.sort((a, b) => tsToMs(b.appointedAt) - tsToMs(a.appointedAt));
  if (Number.isFinite(cursorMs) && cursorMs > 0) {
    instruments = instruments.filter((i) => tsToMs(i.appointedAt) < cursorMs);
  }
  const page = instruments.slice(0, limitParam);
  const repairedPage: AppointmentInstrument[] = [];
  for (const instrument of page) {
    repairedPage.push(await readRepairMirror(db, instrument));
  }
  const nextCursor =
    instruments.length > limitParam && page.length > 0
      ? String(tsToMs(page[page.length - 1].appointedAt))
      : null;

  return NextResponse.json({
    instruments: repairedPage.map(serializeInstrument),
    nextCursor,
  });
}
