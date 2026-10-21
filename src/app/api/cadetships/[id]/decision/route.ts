/**
 * POST /api/cadetships/[id]/decision (phase2_spec.md Sections F.3, F.5, F.7).
 *
 * Body: { outcome: 'confirm' | 'extend' | 'exit', note?, memberNote?,
 *         exitReason?, resolutionOf?, chosenRecommendation? }
 *
 * The deliberate actor split: the Chapter President judges "needs more
 * time" (extend, round 1 only); the National Membership Director judges
 * "in or out" (confirm / exit). No route moves a cadetship backwards.
 *
 * Confirm recomputes the checklist server-side from the stored doc (never
 * a client-sent flag) and takes a dues snapshot on EVERY attempt: a
 * blocked snapshot is stored on the cadetship and returned as 409
 * DUES_UNPAID with NO decision recorded (Z-15: absence of a dues record is
 * not evidence of payment, so 'no_record' blocks). On pass, the cadetship
 * commits as confirmed FIRST and setMembershipClass runs post-commit; a
 * failed class write leaves membershipClassWritePending for the cron
 * stanza to retry - never the reverse order.
 *
 * Disagreements escalate to the NMD, who chooses one of the two SUBMITTED
 * recommendations (resolutionOf 'disagreement' + chosenRecommendation);
 * a round-2 'extend' choice is rejected (one extension maximum).
 * Evaluator consensus cannot be overridden: when both evaluators agree,
 * only the agreed outcome may fire.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/cadetship/http';
import {
  dbOrThrow,
  getCallerRole,
  isChapterPresidentOf,
  isNmd,
  loadCadetshipDoc,
} from '@/lib/server/cadetship/access';
import { cadetshipFromFirestore, evaluationFromFirestore } from '@/lib/server/cadetship/serialize';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import {
  getDuesStatusForConfirmation,
  setMembershipClass,
} from '@/lib/server/cadetship/dues-adapter';
import { probationWindow, EXTENSION_DAYS } from '@/lib/server/cadetship/clock';
import {
  checklistComplete,
  checklistDoneCount,
  evaluationOutcome,
  cadetshipEffectiveStatus,
  isDecisionDue,
} from '@/lib/cadetship/checklist';
import { EXIT_REASONS, type ExitReason } from '@/lib/cadetship/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Dues values that count as RECORDED AS PAID / settled (F.7). Fail-closed otherwise. */
const DUES_PASS_VALUES = new Set(['paid', 'recorded_paid', 'settled', 'zero_dues', 'no_dues_owed']);

const DAY_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const loaded = await loadCadetshipDoc(db, id);
    if (!loaded) return errorJson(404, 'CADETSHIP_NOT_FOUND');
    // Bind the ref to a plain const: closures below capture it after
    // several awaits, where TS drops the null narrowing on `loaded`.
    const cadetshipRef = loaded.ref;
    const doc = cadetshipFromFirestore(id, loaded.raw);

    if (doc.status === 'confirmed' || doc.status === 'exited' || doc.status === 'superseded') {
      return errorJson(409, 'ALREADY_DECIDED');
    }

    const body = (await req.json().catch(() => ({}))) as {
      outcome?: string;
      note?: string;
      memberNote?: string;
      exitReason?: string;
      resolutionOf?: string;
      chosenRecommendation?: string;
    };
    const outcome = body.outcome;
    if (outcome !== 'confirm' && outcome !== 'extend' && outcome !== 'exit') {
      return errorJson(400, 'UNKNOWN_OUTCOME');
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const memberNote = typeof body.memberNote === 'string' ? body.memberNote : null;
    const resolving = body.resolutionOf === 'disagreement';
    const chosen = body.chosenRecommendation;

    const now = new Date();
    const caller = await getCallerRole(db, uid);
    const round: 1 | 2 = doc.status === 'extended' ? 2 : 1;
    const due = isDecisionDue(doc, now);
    const eff = cadetshipEffectiveStatus(doc, now);

    const evalSnap = await cadetshipRef.collection('evaluations').get();
    const evals = evalSnap.docs.map((d) => evaluationFromFirestore(d.data() as Record<string, any>));
    const agreement = evaluationOutcome(evals, round);

    const stamp = () => admin.firestore.FieldValue.serverTimestamp();

    async function recordDecision(decision: Record<string, unknown>, extra: Record<string, unknown>) {
      await cadetshipRef.update({
        ...extra,
        decision,
        updatedAt: stamp(),
        updatedBy: uid,
      });
    }

    async function mirrorApplication(outcomeValue: 'confirmed' | 'exited') {
      if (!doc.applicationId) return;
      await db.collection('applications').doc(doc.applicationId).set(
        { cadetshipOutcome: outcomeValue },
        { merge: true },
      );
    }

    // ------------------------------------------------------------- confirm
    if (outcome === 'confirm') {
      if (!isNmd(caller)) return errorJson(403, 'FORBIDDEN');
      if (!due) return errorJson(409, 'NOT_UNDER_REVIEW');
      if (!checklistComplete(doc)) return errorJson(409, 'CHECKLIST_INCOMPLETE');
      if (agreement === 'incomplete') return errorJson(409, 'EVALUATIONS_INCOMPLETE');
      if (agreement === 'extendable' || agreement === 'exitable') {
        // Evaluator consensus: the agreed outcome is the only path.
        return errorJson(409, 'EVALUATION_CONSENSUS', { agreement });
      }
      if (agreement === 'escalated' && !(resolving && chosen === 'confirm')) {
        return errorJson(409, 'EVALUATION_DISAGREEMENT');
      }

      // Dues gate: snapshot on EVERY confirmation attempt (F.7).
      const snapshot = await getDuesStatusForConfirmation(doc.personUid, doc.chapterId);
      const passes = DUES_PASS_VALUES.has(snapshot.duesStatus.toLowerCase());
      const duesGate = {
        status: passes ? 'passed' : 'blocked',
        lastCheckedAt: now,
        duesStatus: snapshot.duesStatus,
      };
      if (!passes) {
        await cadetshipRef.update({ duesGate, updatedAt: stamp(), updatedBy: uid });
        await writeGovernanceAuditOrThrow({
          actorUid: uid,
          action: 'cadetship.confirm_blocked_dues',
          subjectType: 'cadetship',
          subjectId: id,
          details: { personUid: doc.personUid, duesStatus: snapshot.duesStatus },
        });
        return errorJson(409, 'DUES_UNPAID', { duesGate: { ...duesGate, lastCheckedAt: now.toISOString() } });
      }

      const decision = {
        outcome: 'confirmed',
        decidedBy: uid,
        decidedByRole: 'national_membership_director',
        decidedAt: now,
        round,
        note: note || null,
        memberNote,
        exitReason: null,
        resolutionOf: agreement === 'escalated' ? 'disagreement' : null,
        chosenRecommendation: agreement === 'escalated' ? 'confirm' : null,
      };
      await recordDecision(decision, { status: 'confirmed', duesGate });

      // Post-commit chained class write (F.7): failure leaves a durable
      // pending flag for the governance cron stanza - never a silent pass.
      let classPending = false;
      try {
        await setMembershipClass(doc.personUid, 'Full', { via: 'cadetship_confirmation', cadetshipId: id });
      } catch {
        classPending = true;
        await cadetshipRef.update({ membershipClassWritePending: true, updatedAt: stamp(), updatedBy: uid });
      }

      await mirrorApplication('confirmed');
      await writeGovernanceAuditOrThrow({
        actorUid: uid,
        action: 'cadetship.confirmed',
        subjectType: 'cadetship',
        subjectId: id,
        details: { personUid: doc.personUid, round, resolutionOf: decision.resolutionOf, membershipClassWritePending: classPending },
      });
      return NextResponse.json({ ok: true, status: 'confirmed', membershipClassWritePending: classPending });
    }

    // -------------------------------------------------------------- extend
    if (outcome === 'extend') {
      if (note.length < 1) return errorJson(400, 'NOTE_REQUIRED');
      if (round !== 1 || doc.extensionUsed) return errorJson(409, 'EXTENSION_UNAVAILABLE');
      if (!due || eff.status !== 'under_review') return errorJson(409, 'NOT_UNDER_REVIEW');
      if (agreement === 'incomplete') return errorJson(409, 'EVALUATIONS_INCOMPLETE');

      const viaCpConsensus = isChapterPresidentOf(caller, doc.chapterId) && agreement === 'extendable';
      const viaNmdResolution =
        isNmd(caller) && agreement === 'escalated' && resolving && chosen === 'extend';
      if (!viaCpConsensus && !viaNmdResolution) {
        // Covers: extension against both evaluators (consensus confirm/exit),
        // CP acting on a disagreement (that is the NMD's call), and actors
        // with no standing at all.
        return errorJson(409, agreement === 'escalated' ? 'EVALUATION_DISAGREEMENT' : 'FORBIDDEN_OR_CONSENSUS', { agreement });
      }

      const { extendedEnd } = probationWindow(doc.startedAt);
      const decision = {
        outcome: 'extended',
        decidedBy: uid,
        decidedByRole: caller.roleKey,
        decidedAt: now,
        round: 1,
        note,
        memberNote,
        exitReason: null,
        resolutionOf: viaNmdResolution ? 'disagreement' : null,
        chosenRecommendation: viaNmdResolution ? 'extend' : null,
      };
      await recordDecision(decision, {
        status: 'extended',
        extendedTo: extendedEnd,
        extensionUsed: true,
        reviewDue: false,
      });
      await writeGovernanceAuditOrThrow({
        actorUid: uid,
        action: 'cadetship.extended',
        subjectType: 'cadetship',
        subjectId: id,
        details: { personUid: doc.personUid, extendedTo: extendedEnd.toISOString(), extensionDays: EXTENSION_DAYS },
      });
      return NextResponse.json({ ok: true, status: 'extended', extendedTo: extendedEnd.toISOString() });
    }

    // ---------------------------------------------------------------- exit
    if (!isNmd(caller)) return errorJson(403, 'FORBIDDEN');
    const exitReason = body.exitReason as ExitReason;
    if (!EXIT_REASONS.includes(exitReason)) return errorJson(400, 'EXIT_REASON_REQUIRED');

    const earlyExit =
      doc.status === 'active' && (exitReason === 'withdrew' || exitReason === 'conduct');
    const ghostExit =
      due &&
      (exitReason === 'withdrew' || exitReason === 'no_engagement') &&
      checklistDoneCount(doc) === 0 &&
      evals.length === 0 &&
      now.getTime() - doc.probationEnd.getTime() >= 14 * DAY_MS;

    if (!earlyExit && !ghostExit) {
      if (!due) return errorJson(409, 'NOT_UNDER_REVIEW');
      if (agreement === 'incomplete') return errorJson(409, 'EVALUATIONS_INCOMPLETE');
      if (agreement === 'confirmable' || agreement === 'extendable') {
        return errorJson(409, 'EVALUATION_CONSENSUS', { agreement });
      }
      if (agreement === 'escalated' && !(resolving && chosen === 'exit')) {
        return errorJson(409, 'EVALUATION_DISAGREEMENT');
      }
    }

    const decision = {
      outcome: 'exited',
      decidedBy: uid,
      decidedByRole: 'national_membership_director',
      decidedAt: now,
      round,
      note: note || null,
      memberNote,
      exitReason,
      resolutionOf: agreement === 'escalated' && resolving ? 'disagreement' : null,
      chosenRecommendation: agreement === 'escalated' && resolving ? 'exit' : null,
    };
    await recordDecision(decision, { status: 'exited' });
    await mirrorApplication('exited');
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'cadetship.exited',
      subjectType: 'cadetship',
      subjectId: id,
      details: { personUid: doc.personUid, exitReason, ghostException: ghostExit, earlyExit },
    });
    return NextResponse.json({ ok: true, status: 'exited', exitReason });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[cadetships/decision] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
