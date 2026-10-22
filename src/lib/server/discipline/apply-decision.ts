/**
 * apply-decision.ts - applyCaseDecision, the ONE sanction writer
 * (Phase 2 spec E.4.5).
 *
 * Core principle: no sanction ever lands on a user record except as the
 * recorded outcome of a decided case, applied by this function (and its
 * expulsion branch), in exactly one transaction, with the audit entry
 * written in that same transaction. If the audit write fails, the
 * decision fails (T18).
 *
 * Points and demotion are NEVER case outcomes (Z-08): payloads carrying
 * them are rejected. applyExpulsionBan is the SOLE code path permitted
 * to set isBanned = true after cutover (T-GREP-1).
 *
 * Shadow mode (settings/discipline shadowMode, default ON): decisions
 * are recorded and shadowWouldApply is populated, but the users doc is
 * never touched (E.9 step 1).
 */
import { Timestamp } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import {
    ActorContext,
    OFFICE_ROLE_KEYS,
    isFounderUid,
    notifyUser,
    writeGovernanceAuditOrThrow,
} from './adapters';
import {
    CASE_DIAGNOSES,
    CaseDiagnosis,
    DisciplinaryCase,
    DisciplineError,
    decisionTransitionFields,
    getCase,
} from './case-service';
import { getDisciplineSettings } from './settings';

/** Verbatim Founder-review copy (spec E.5) - ships in every outcome notice. */
export const FOUNDER_REVIEW_COPY =
    'Founder review: the Founder may review any disciplinary decision and may uphold it, reduce the sanction, revoke the sanction, or reinstate the member. There is no appeal to an administrator.';
import { computeDerivedWarningCount } from './derived-counter';

const DAY_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN_PAYLOAD_KEYS = ['points', 'penaltyPoints', 'pointsDeducted', 'demoteToRole', 'demotion', 'isBlacklisted', 'isBanned'];

export interface DecisionPayload {
    decision: 'strike1' | 'strike2' | 'strike3' | 'dismissed' | 'no_case';
    decisionReason: string;
    /**
     * Required at runtime (Item 18): applyCaseDecision rejects any
     * decision without a valid diagnosis. Optional in the type only so
     * the rejection is a domain error, not a type error, for API callers
     * that omit it.
     */
    diagnosis?: CaseDiagnosis | null;
    suspensionDays?: number;
    conditions?: string | null;
    necDecisionRef?: string;
    cause?: DisciplinaryCase['cause'];
    [key: string]: unknown;
}

async function officeHolders(db: any, office: keyof typeof OFFICE_ROLE_KEYS): Promise<string[]> {
    const keys = OFFICE_ROLE_KEYS[office] || [];
    const uids: string[] = [];
    for (const key of keys) {
        const snap = await db.collection('roles').where('role', '==', key).get();
        snap.forEach((d: any) => uids.push(d.id));
    }
    return uids;
}

function assertNoForbiddenKeys(payload: Record<string, unknown>): void {
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
        if (payload[key] !== undefined && payload[key] !== null) {
            throw new DisciplineError(
                'POINTS_NOT_A_SANCTION',
                `Field "${key}" may not be a disciplinary case outcome. Points are a task-management instrument and demotion lives in the probation mechanics (Z-08).`,
            );
        }
    }
}

function validateDecider(kase: DisciplinaryCase, payload: DecisionPayload, actor: ActorContext, subjectChapterId: string | null): { decidedByRole: string } {
    const decision = payload.decision;
    if (decision === 'strike1') {
        if (kase.hearingOutcome === 'dismissed') {
            throw new DisciplineError(
                'HEARING_DISMISSED_BLOCKS_STRIKE',
                'The hearing outcome was dismissed; no Strike 1 may be recorded on this case by anyone.',
                403,
            );
        }
        if (actor.offices.includes('membership_director')) return { decidedByRole: 'membership_director' };
        if (actor.offices.includes('chapter_president')) {
            if (subjectChapterId && actor.chapterId && subjectChapterId === actor.chapterId) {
                return { decidedByRole: 'chapter_president' };
            }
            throw new DisciplineError('CHAPTER_SCOPE', 'A Chapter President may decide a Strike 1 only for a subject in his own chapter.', 403);
        }
        throw new DisciplineError('DECIDER_NOT_ELIGIBLE', 'Strike 1 is decided by the Chapter President (own chapter) or the National Membership Director.', 403);
    }
    if (decision === 'strike2' || decision === 'strike3') {
        if (!actor.offices.includes('nec')) {
            throw new DisciplineError('DECIDER_NEC_ONLY', `${decision === 'strike2' ? 'Strike 2' : 'A Strike 3 recommendation'} is decided by the National Executive Council.`, 403);
        }
        if (!payload.necDecisionRef || !String(payload.necDecisionRef).trim()) {
            throw new DisciplineError('NEC_REF_REQUIRED', 'A Council decision requires necDecisionRef (a governance_votes id or minutes reference). A single officer cannot decide this tier alone.');
        }
        return { decidedByRole: 'nec' };
    }
    // dismissed / no_case
    const ok =
        actor.offices.includes('audit_chair') ||
        actor.offices.includes('ngs') ||
        actor.uid === kase.initiatedByUid;
    if (!ok) {
        throw new DisciplineError('DECIDER_NOT_ELIGIBLE', 'A dismissal at this stage is recorded by the Audit Chair, the NGS, or the initiating office.', 403);
    }
    return { decidedByRole: actor.offices.includes('audit_chair') ? 'audit_chair' : actor.offices.includes('ngs') ? 'ngs' : 'initiator' };
}

export async function applyCaseDecision(
    db: any,
    caseId: string,
    payload: DecisionPayload,
    actor: ActorContext,
    now: Date,
): Promise<DisciplinaryCase> {
    assertNoForbiddenKeys(payload as Record<string, unknown>);
    const kase = await getCase(db, caseId);
    if (kase.status !== 'hearing') {
        throw new DisciplineError('CASE_NOT_IN_HEARING', `Decisions apply from the hearing state; this case is ${kase.status}.`);
    }
    const reason = (payload.decisionReason || '').trim();
    if (reason.length < 30) {
        throw new DisciplineError('DECISION_REASON_REQUIRED', 'Every decision, including dismissals, requires a decisionReason of at least 30 characters.');
    }
    // Item 18: the can't/won't diagnosis is named BEFORE the consequence,
    // on every decision including dismissals. It cannot be backfilled
    // honestly later, so a decision without it is rejected outright.
    const diagnosis = payload.diagnosis ?? null;
    if (!diagnosis || !CASE_DIAGNOSES.includes(diagnosis)) {
        throw new DisciplineError(
            'DIAGNOSIS_REQUIRED',
            'Every decision requires a diagnosis: capability (he cannot do it - train), motivation (he will not do it - motivate/consequences), or conduct.',
        );
    }
    const subjectSnap = await db.collection('users').doc(kase.subjectUid).get();
    const subjectChapterId = subjectSnap.exists ? ((subjectSnap.data() || {}).chapterId as string) || null : null;
    const { decidedByRole } = validateDecider(kase, payload, actor, subjectChapterId);

    const decision = payload.decision;
    const strikeNumber = decision === 'strike1' ? 1 : decision === 'strike2' ? 2 : decision === 'strike3' ? 3 : null;
    if (decision === 'strike2') {
        const days = payload.suspensionDays;
        if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 60) {
            throw new DisciplineError('SUSPENSION_DAYS_BOUNDS', 'Strike 2 suspensionDays must be an integer in 1..60 inclusive.');
        }
    }
    let priorStrikesAtDecision: number | null = null;
    if (decision === 'strike3') {
        if (!payload.cause) {
            throw new DisciplineError('CAUSE_REQUIRED', 'A Strike 3 recommendation requires the Cause (three_strikes or gross_misconduct).');
        }
        const derived = await computeDerivedWarningCount(db, kase.subjectUid);
        priorStrikesAtDecision = derived;
    }

    const settings = await getDisciplineSettings(db);
    const shadow = settings.shadowMode;
    const caseRef = db.collection('disciplinary_cases').doc(caseId);
    const userRef = db.collection('users').doc(kase.subjectUid);
    const derivedBefore = await computeDerivedWarningCount(db, kase.subjectUid);
    const derivedAfter = derivedBefore + (strikeNumber ? 1 : 0);
    const iso = now.toISOString();

    const decisionFields: Record<string, unknown> = {
        decision,
        decisionReason: reason,
        diagnosis,
        decidedByRole,
        decidedByUid: actor.uid,
        decidedAt: iso,
        strikeNumber,
        category: decision === 'strike1' ? 'warning_only' : decision === 'strike2' ? 'suspension' : decision === 'strike3' ? 'expulsion_recommendation' : kase.category,
        conditions: payload.conditions ?? null,
        necDecisionRef: payload.necDecisionRef ?? kase.necDecisionRef,
        ...(decision === 'strike3'
            ? {
                  cause: {
                      causeType: payload.cause!.causeType,
                      countedCaseIds: payload.cause!.countedCaseIds || [],
                      priorStrikesAtDecision: priorStrikesAtDecision ?? payload.cause!.priorStrikesAtDecision ?? 0,
                      grossMisconductStatement: payload.cause!.grossMisconductStatement ?? null,
                  },
              }
            : {}),
    };

    await db.runTransaction(async (tx: any) => {
        const freshSnap = await tx.get(caseRef);
        if (!freshSnap.exists) throw new DisciplineError('CASE_NOT_FOUND', 'Case not found.', 404);
        const fresh = freshSnap.data() as DisciplinaryCase;
        if (fresh.status !== 'hearing') {
            throw new DisciplineError('CASE_STATE_CHANGED', 'The case left the hearing state before the decision committed.');
        }

        if (decision === 'strike3') {
            // Recommendation only: the case moves to 'decided' and waits
            // for the Board notice/vote flow. No sanction is applied.
            const history = [
                ...(fresh.statusHistory || []),
                { from: 'hearing' as const, to: 'decided' as const, byUid: actor.uid, byRole: actor.roleKey, at: iso },
            ];
            tx.update(caseRef, {
                ...decisionFields,
                status: 'decided',
                statusHistory: history,
                updatedAt: iso,
                ...(shadow ? { shadowWouldApply: { decision, note: 'Strike 3 recommendation recorded in shadow mode.' } } : {}),
            });
        } else {
            const warningRef =
                !shadow && decision === 'strike1' ? userRef.collection('warnings').doc() : null;
            const sanctionApplied: DisciplinaryCase['sanctionApplied'] = {
                warningRecordId: warningRef ? warningRef.id : null,
                suspensionDays: decision === 'strike2' ? (payload.suspensionDays as number) : null,
                banVoteId: null,
            };
            const fields = decisionTransitionFields(fresh, 'closed', actor, now, {
                ...decisionFields,
                sanctionApplied,
                sanctionAppliedAt: shadow ? null : iso,
                ...(shadow
                    ? {
                          shadowWouldApply: {
                              decision,
                              suspensionDays: decision === 'strike2' ? payload.suspensionDays : null,
                              warningCountWouldBecome: strikeNumber ? derivedAfter : derivedBefore,
                          },
                      }
                    : {}),
            });
            tx.update(caseRef, fields);

            if (!shadow && decision === 'strike1' && warningRef) {
                tx.set(warningRef, {
                    kind: 'formal_warning',
                    caseId,
                    caseNumber: fresh.caseNumber,
                    strikeNumber: 1,
                    ground: fresh.constitutionalGround,
                    title: `Formal warning - ${fresh.caseNumber}`,
                    description: reason,
                    issuedByUid: actor.uid,
                    issuedByRole: decidedByRole,
                    issuedAt: Timestamp.fromDate(now),
                    isPermanent: true,
                    expiresAt: null,
                    status: 'active',
                    pointsDeducted: 0,
                    penaltyPoints: 0,
                    demotedToRole: null,
                });
                tx.update(userRef, { warningCount: derivedAfter });
            }
            if (!shadow && decision === 'strike2') {
                const days = payload.suspensionDays as number;
                tx.update(userRef, {
                    privilegesSuspendedUntil: Timestamp.fromDate(new Date(now.getTime() + days * DAY_MS)),
                    suspendedFrom: Timestamp.fromDate(now),
                    suspensionCaseId: caseId,
                    warningCount: derivedAfter,
                });
                tx.update(caseRef, {
                    suspensionCaseId: caseId,
                    suspensionDays: days,
                    suspensionReason: reason.slice(0, 200),
                    suspensionStartsAt: iso,
                    suspensionEndsAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
                });
            }
            // Dismissals and no_case: no sanction fields are touched.
        }

        // The audit row sits INSIDE the transaction: if it throws, the
        // whole decision rolls back (E.4.5 step 5, test T18).
        await writeGovernanceAuditOrThrow(db, {
            action: 'discipline.decision',
            actorUid: actor.uid,
            actorRole: decidedByRole,
            targetType: 'disciplinary_case',
            targetId: caseId,
            details: { caseNumber: fresh.caseNumber, decision, strikeNumber, diagnosis, shadow },
        }, { tx });
    });

    // Notifications (post-commit; delivery is not the legal record).
    const reviewLine = FOUNDER_REVIEW_COPY;
    if (decision === 'dismissed' || decision === 'no_case') {
        if (kase.noticeIssuedAt) {
            await notifyUser(kase.subjectUid, {
                type: 'discipline_dismissed',
                title: `Case ${kase.caseNumber} dismissed`,
                body: `The disciplinary case against you has been dismissed. Reason: ${reason}`,
                link: `/profile/discipline/${caseId}`,
            });
        }
    } else {
        await notifyUser(kase.subjectUid, {
            type: 'discipline_decision',
            title: `Disciplinary decision - case ${kase.caseNumber}`,
            body: `Decision: ${decision}. Reason: ${reason} ${reviewLine}`,
            link: `/profile/discipline/${caseId}`,
        });
    }
    await notifyUser(kase.initiatedByUid, {
        type: 'discipline_decision',
        title: `Decision recorded - case ${kase.caseNumber}`,
        body: `Decision: ${decision}. Reason: ${reason}`,
        link: `/admin/discipline/${caseId}`,
    });
    for (const office of ['ngs', 'audit_chair'] as const) {
        for (const uid of await officeHolders(db, office)) {
            if (uid !== kase.initiatedByUid && uid !== actor.uid) {
                await notifyUser(uid, {
                    type: 'discipline_decision',
                    title: `Decision recorded - case ${kase.caseNumber}`,
                    body: `Decision: ${decision} by ${decidedByRole}.`,
                    link: `/admin/discipline/${caseId}`,
                });
            }
        }
    }
    return getCase(db, caseId);
}

/**
 * The expulsion branch: the SOLE writer of isBanned = true after
 * cutover. Runs at Board vote close (E.4.4) after validating the Cause
 * and the vote AT CLOSE, because the strike count can change between
 * recommendation and vote.
 */
export async function applyExpulsionBan(
    db: any,
    caseId: string,
    vote: { voteId: string; votesFor: number; votesAgainst: number; quorumMet: boolean },
    now: Date,
): Promise<DisciplinaryCase> {
    const kase = await getCase(db, caseId);
    if (kase.status !== 'board_vote_open') {
        throw new DisciplineError('CASE_NOT_IN_BOARD_VOTE', `Expulsion applies from board_vote_open; this case is ${kase.status}.`);
    }
    const toSequence = (kase.statusHistory || []).map((h) => h.to);
    const noticeIdx = toSequence.indexOf('board_notice_issued');
    const openIdx = toSequence.indexOf('board_vote_open');
    if (noticeIdx === -1 || openIdx === -1 || openIdx < noticeIdx) {
        throw new DisciplineError('BOARD_FLOW_ORDER', 'The case did not pass through board_notice_issued then board_vote_open in order.');
    }
    if (!vote.quorumMet) {
        throw new DisciplineError('VOTE_QUORUM_NOT_MET', 'The Board vote did not meet quorum; no expulsion may be applied.');
    }
    if (!(vote.votesFor > vote.votesAgainst)) {
        throw new DisciplineError('VOTE_NOT_PASSED', 'The Board vote did not pass (a tie fails). No expulsion may be applied.');
    }
    const cause = kase.cause;
    if (!cause) {
        throw new DisciplineError('CAUSE_REQUIRED', 'No Cause is recorded on this case.');
    }
    if (cause.causeType === 'three_strikes') {
        const ids = cause.countedCaseIds || [];
        if (ids.length !== 3 || new Set(ids).size !== 3) {
            throw new DisciplineError('CAUSE_THREE_STRIKES_INVALID', 'three_strikes requires exactly 3 distinct counted case ids.');
        }
        if (cause.priorStrikesAtDecision !== 2) {
            throw new DisciplineError('CAUSE_PRIOR_COUNT_INVALID', 'priorStrikesAtDecision must be 2 for a three_strikes expulsion.');
        }
        for (const countedId of ids) {
            const counted = await getCase(db, countedId);
            if (counted.subjectUid !== kase.subjectUid) {
                throw new DisciplineError('CAUSE_CASE_SUBJECT_MISMATCH', `Counted case ${countedId} is not against this subject.`);
            }
            if (counted.decision === 'dismissed' || counted.decision === 'no_case' || counted.strikeNumber === null) {
                throw new DisciplineError('CAUSE_CASE_NOT_A_STRIKE', `Counted case ${countedId} is not a decided strike case.`);
            }
            if (counted.founderReview && counted.founderReview.outcome === 'revoke_sanction') {
                throw new DisciplineError('CAUSE_CASE_REVOKED', `Counted case ${countedId} had its sanction revoked on Founder review and may not be counted.`);
            }
        }
    } else if (cause.causeType === 'gross_misconduct') {
        const stmt = (cause.grossMisconductStatement || '').trim();
        if (!stmt || !stmt.includes('10.9')) {
            throw new DisciplineError('CAUSE_GROSS_MISCONDUCT_INVALID', 'gross_misconduct requires a statement naming the Const 10.9 head relied on.');
        }
    }

    const settings = await getDisciplineSettings(db);
    const caseRef = db.collection('disciplinary_cases').doc(caseId);
    const userRef = db.collection('users').doc(kase.subjectUid);
    const derivedBefore = await computeDerivedWarningCount(db, kase.subjectUid);
    const derivedAfter = derivedBefore + 1;
    const iso = now.toISOString();
    const systemActor: ActorContext = { uid: 'system', offices: [], roleKey: 'board_vote', chapterId: null };

    await db.runTransaction(async (tx: any) => {
        const freshSnap = await tx.get(caseRef);
        const fresh = freshSnap.data() as DisciplinaryCase;
        if (fresh.status !== 'board_vote_open') {
            throw new DisciplineError('CASE_STATE_CHANGED', 'The case left board_vote_open before the expulsion committed.');
        }
        const fields = decisionTransitionFields(fresh, 'closed', systemActor, now, {
            sanctionApplied: { warningRecordId: null, suspensionDays: null, banVoteId: vote.voteId },
            sanctionAppliedAt: settings.shadowMode ? null : iso,
            ...(settings.shadowMode
                ? { shadowWouldApply: { decision: 'strike3', banVoteId: vote.voteId, note: 'Board expulsion recorded in shadow mode; users doc untouched.' } }
                : {}),
        });
        tx.update(caseRef, fields);
        if (!settings.shadowMode) {
            tx.update(userRef, {
                isBanned: true,
                bannedReason: `Expelled by Board vote - case ${fresh.caseNumber}`,
                bannedAt: Timestamp.fromDate(now),
                bannedBy: `board:${vote.voteId}`,
                warningCount: derivedAfter,
            });
        }
        await writeGovernanceAuditOrThrow(db, {
            action: 'discipline.expulsion_applied',
            actorUid: 'system',
            actorRole: 'board',
            targetType: 'disciplinary_case',
            targetId: caseId,
            details: { caseNumber: fresh.caseNumber, voteId: vote.voteId, votesFor: vote.votesFor, votesAgainst: vote.votesAgainst },
        }, { tx });
    });

    await notifyUser(kase.subjectUid, {
        type: 'discipline_expulsion',
        title: `Expulsion - case ${kase.caseNumber}`,
        body: `The Board has voted to expel you. Case ${kase.caseNumber}, vote ${vote.voteId}. Founder review: the Founder may review any disciplinary decision and may uphold it, reduce the sanction, revoke the sanction, or reinstate the member. There is no appeal to an administrator.`,
        link: `/profile/discipline/${caseId}`,
    });
    return getCase(db, caseId);
}

/**
 * Founder-review modify effects (E.5): REDUCE only. The review record
 * itself is written by the founder-review route; this function applies
 * the sanction changes and recomputes the derived counter.
 */
export async function applyReviewModification(
    db: any,
    caseId: string,
    modifyPayload: { newStrike: 1 | 2; newSuspensionDays?: number },
    actor: ActorContext,
    now: Date,
    review?: import('./case-service').FounderReview,
): Promise<DisciplinaryCase> {
    if (!isFounderUid(actor.uid) || actor.uid !== FOUNDER_UID) {
        throw new DisciplineError('FOUNDER_ONLY', 'Founder review is exercised by the Founder personally (UID check, not a role).', 403);
    }
    const kase = await getCase(db, caseId);
    const current = kase.strikeNumber;
    if (!current) {
        throw new DisciplineError('NOTHING_TO_MODIFY', 'This case carries no strike to reduce.');
    }
    const next = modifyPayload.newStrike;
    if (!next || next >= current || next < 1) {
        throw new DisciplineError('MODIFY_INCREASE_FORBIDDEN', 'Founder review may only REDUCE a sanction (strike3 -> strike2 -> strike1). An increase is a second prosecution and is rejected.');
    }
    if (next === 2) {
        const days = modifyPayload.newSuspensionDays;
        if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 60) {
            throw new DisciplineError('SUSPENSION_DAYS_BOUNDS', 'A reduction to Strike 2 requires newSuspensionDays in 1..60.');
        }
        if (current === 2 && kase.suspensionDays && (days as number) >= kase.suspensionDays) {
            throw new DisciplineError('MODIFY_INCREASE_FORBIDDEN', 'Suspension days may only shrink on review.');
        }
    }
    const caseRef = db.collection('disciplinary_cases').doc(caseId);
    const userRef = db.collection('users').doc(kase.subjectUid);
    const iso = now.toISOString();

    await db.runTransaction(async (tx: any) => {
        const freshSnap = await tx.get(caseRef);
        const fresh = freshSnap.data() as DisciplinaryCase;
        if (review) {
            tx.update(caseRef, { founderReview: review, updatedAt: iso });
        }
        const userUpdate: Record<string, unknown> = {};
        if (current === 3 && next === 2) {
            // The ONE place a board ban is cleared short of reinstatement:
            // the review overrides the vote's EFFECT; the vote record
            // itself stands as history (E.5).
            userUpdate.isBanned = false;
            userUpdate.bannedReason = `Expelled by Board vote - case ${fresh.caseNumber} (reduced on Founder review, case ${fresh.caseNumber})`;
            const days = modifyPayload.newSuspensionDays as number;
            userUpdate.privilegesSuspendedUntil = Timestamp.fromDate(new Date(now.getTime() + days * DAY_MS));
            userUpdate.suspendedFrom = Timestamp.fromDate(now);
            userUpdate.suspensionCaseId = caseId;
            tx.update(caseRef, {
                strikeNumber: 2,
                suspensionDays: days,
                suspensionCaseId: caseId,
                suspensionStartsAt: iso,
                suspensionEndsAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
                updatedAt: iso,
            });
        } else if (next === 1) {
            if (current === 3) {
                userUpdate.isBanned = false;
                userUpdate.bannedReason = `Expelled by Board vote - case ${fresh.caseNumber} (reduced on Founder review, case ${fresh.caseNumber})`;
            }
            userUpdate.privilegesSuspendedUntil = null;
            userUpdate.suspendedFrom = null;
            userUpdate.suspensionCaseId = null;
            tx.update(caseRef, {
                strikeNumber: 1,
                suspensionDays: null,
                suspensionCaseId: null,
                suspensionStartsAt: null,
                suspensionEndsAt: null,
                updatedAt: iso,
            });
        }
        const derived = await computeDerivedWarningCount(db, kase.subjectUid);
        userUpdate.warningCount = derived;
        tx.update(userRef, userUpdate);
        await writeGovernanceAuditOrThrow(db, {
            action: 'discipline.founder_review_modify_applied',
            actorUid: actor.uid,
            actorRole: 'founder',
            targetType: 'disciplinary_case',
            targetId: caseId,
            details: { caseNumber: fresh.caseNumber, from: current, to: next },
        }, { tx });
    });
    return getCase(db, caseId);
}
