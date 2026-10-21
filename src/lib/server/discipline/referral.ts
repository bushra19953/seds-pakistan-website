/**
 * referral.ts - the human half of the cron referral flow (spec E.6.4).
 *
 * A referral draft is a record, not a case. It becomes a case only when
 * a human CONFIRMS it by mapping the facts onto a real constitutional
 * ground (usually Art 10.9(c) via chapter bylaws), writes the narrative,
 * and proposes a tier - or DISMISSES it with a recorded reason, which
 * marks the linked misses dismissed_pattern so the pattern does not
 * re-fire for the same facts. The subject is never notified of drafts
 * or of draft dismissals.
 */
import { ActorContext } from './adapters';
import {
    ConstitutionalGround,
    DisciplinaryCase,
    DisciplineError,
    GroundCSubtype,
    GroundEDirection,
    getCase,
    transitionCase,
    validateGroundFields,
} from './case-service';

const CONFIRM_OFFICES = ['chapter_president', 'membership_director', 'ngs', 'audit_chair'];

function assertConfirmer(actor: ActorContext, kase: DisciplinaryCase): void {
    if (actor.uid === kase.initiatedByUid) return;
    if (actor.offices.some((o) => CONFIRM_OFFICES.includes(o))) return;
    throw new DisciplineError(
        'REFERRAL_CONFIRM_FORBIDDEN',
        'Only the attributed initiator or an entitled office may confirm or dismiss a referral draft.',
        403,
    );
}

function assertReferralDraft(kase: DisciplinaryCase): void {
    if (kase.initiationSource !== 'cron_referral') {
        throw new DisciplineError('NOT_A_REFERRAL_DRAFT', 'This case is not a cron referral draft.');
    }
    if (kase.status !== 'notice_draft') {
        throw new DisciplineError('DRAFT_NOT_OPEN', `Referral draft is in status ${kase.status}; only notice_draft drafts can be confirmed or dismissed.`);
    }
}

export interface ConfirmDraftPayload {
    constitutionalGround: ConstitutionalGround;
    groundCSubtype?: GroundCSubtype | null;
    groundEDirection?: GroundEDirection | null;
    groundNarrative: string;
    proposedStrike?: 1 | 2 | 3 | null;
}

export async function confirmDraft(
    db: any,
    caseId: string,
    actor: ActorContext,
    payload: ConfirmDraftPayload,
    now: Date,
): Promise<DisciplinaryCase> {
    const kase = await getCase(db, caseId);
    assertReferralDraft(kase);
    assertConfirmer(actor, kase);
    validateGroundFields(payload);
    const iso = now.toISOString();
    await db.collection('disciplinary_cases').doc(caseId).update({
        constitutionalGround: payload.constitutionalGround,
        groundCSubtype: payload.groundCSubtype ?? null,
        groundEDirection: payload.groundEDirection ?? null,
        groundNarrative: payload.groundNarrative,
        proposedStrike: payload.proposedStrike ?? null,
        updatedAt: iso,
        statusHistory: [
            ...(kase.statusHistory || []),
            {
                from: 'notice_draft',
                to: 'notice_draft',
                byUid: actor.uid,
                byRole: actor.roleKey,
                at: iso,
                note: `Referral draft confirmed: ground ${payload.constitutionalGround} set by a human initiator.`,
            },
        ],
    });
    // The linked misses are now attached to a live case.
    for (const missId of kase.linkedMissRecordIds || []) {
        await db.collection('deadline_miss_records').doc(missId).update({ status: 'attached_to_case' });
    }
    return getCase(db, caseId);
}

export async function dismissDraft(
    db: any,
    caseId: string,
    actor: ActorContext,
    decisionReason: string,
    now: Date,
): Promise<DisciplinaryCase> {
    const kase = await getCase(db, caseId);
    assertReferralDraft(kase);
    assertConfirmer(actor, kase);
    const updated = await transitionCase(db, caseId, 'dismissed', actor, {
        decisionReason,
        note: 'Referral draft dismissed by a human reviewer.',
    }, now);
    for (const missId of kase.linkedMissRecordIds || []) {
        await db.collection('deadline_miss_records').doc(missId).update({ status: 'dismissed_pattern' });
    }
    return updated;
}
