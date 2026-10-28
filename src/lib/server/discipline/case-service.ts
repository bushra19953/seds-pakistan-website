/**
 * case-service.ts - the disciplinary case model and state machine
 * (Phase 2 spec Section E.2/E.3/E.4).
 *
 * Core principle (E.3): transitionCase() is the ONLY writer of case
 * status outside the decision transaction, and NO function in this file
 * ever writes a users-doc sanction field. Sanctions are applied only by
 * applyCaseDecision / applyExpulsionBan in apply-decision.ts, inside
 * the decision transition, in the same transaction as the audit row.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import {
    ActorContext,
    isFounderUid,
    notifyUser,
    resolveActorOffices,
    writeGovernanceAuditOrThrow,
} from './adapters';
import { disciplineData } from './supa-seam';

export type CaseStatus =
    | 'initiated'
    | 'notice_draft'
    | 'notice_issued'
    | 'defence_received'
    | 'defence_window_closed'
    | 'hearing'
    | 'decided'
    | 'board_notice_issued'
    | 'board_vote_open'
    | 'board_decided'
    | 'decided_outcome_failed'
    | 'sanction_applied'
    | 'closed'
    | 'dismissed';

export type ConstitutionalGround = '10.9(a)' | '10.9(b)' | '10.9(c)' | '10.9(d)' | '10.9(e)';
export const CONSTITUTIONAL_GROUNDS: ConstitutionalGround[] = [
    '10.9(a)',
    '10.9(b)',
    '10.9(c)',
    '10.9(d)',
    '10.9(e)',
];
/**
 * Grove can't/won't diagnosis (Item 18): every decided case names its
 * cause before its consequence. 'capability' = he cannot do it (cure:
 * training), 'motivation' = he will not do it (cure: motivation and
 * consequences), 'conduct' = a conduct breach, neither a skill nor an
 * effort gap. Required on every decision via applyCaseDecision;
 * historical cases decided before this field existed stay null.
 */
export type CaseDiagnosis = 'capability' | 'motivation' | 'conduct';
export const CASE_DIAGNOSES: CaseDiagnosis[] = ['capability', 'motivation', 'conduct'];

export type GroundCSubtype =
    | 'chapter_constitution'
    | 'chapter_bylaws'
    | 'board_direction'
    | 'founder_direction';

export interface GroundEDirection {
    directionId: string;
    directionTextSnapshot: string;
    issuedBy: 'board_resolution' | 'founder_written';
    issuedAt: string;
}

export interface EvidenceRef {
    kind: 'task' | 'document' | 'url' | 'note';
    ref: string;
    label: string;
    addedByUid: string;
    addedAt: string;
}

export interface StatusHistoryEntry {
    from: CaseStatus | null;
    to: CaseStatus;
    byUid: string;
    byRole: string | null;
    at: string;
    note?: string;
}

export interface FounderReview {
    outcome: 'upheld' | 'modify' | 'revoke_sanction' | 'reinstate';
    byUid: string;
    at: string;
    noticeText: string;
    reason: string;
}

export interface DisciplinaryCase {
    caseId: string;
    caseNumber: string;
    subjectUid: string;
    subjectNameSnapshot: string;
    subjectRoleSnapshot: string | null;
    subjectIsMember: boolean;
    category: 'warning_only' | 'suspension' | 'expulsion_recommendation' | null;
    proposedStrike: 1 | 2 | 3 | null;
    strikeNumber: 1 | 2 | 3 | null;
    status: CaseStatus;
    constitutionalGround: ConstitutionalGround | null;
    groundCSubtype: GroundCSubtype | null;
    groundEDirection: GroundEDirection | null;
    groundNarrative: string | null;
    drafterNote: string | null;
    evidenceRefs: EvidenceRef[];
    initiatedByUid: string;
    initiatedByRole: string | null;
    initiationSource: 'manual' | 'cron_referral';
    noticeIssuedByUid: string | null;
    hearingOfficerUid: string | null;
    decidedByRole: string | null;
    decidedByUid: string | null;
    necDecisionRef: string | null;
    boardVoteId: string | null;
    founderReview: FounderReview | null;
    initiatedAt: string;
    noticeIssuedAt: string | null;
    defenceDueAt: string | null;
    defenceReceivedAt: string | null;
    hearingAt: string | null;
    decidedAt: string | null;
    sanctionAppliedAt: string | null;
    suspensionStartsAt: string | null;
    suspensionEndsAt: string | null;
    boardNoticeIssuedAt: string | null;
    boardVoteOpensAt: string | null;
    closedAt: string | null;
    noticeText: string | null;
    noticeChannel: 'in_app' | 'email' | 'in_app_and_email' | null;
    noticeDeliveredAt: string | null;
    defenceText: string | null;
    defenceSubmittedByUid: string | null;
    defenceSubmittedAt: string | null;
    defenceLate: boolean;
    hearingNotes: string | null;
    hearingOutcome: 'upheld' | 'modified' | 'dismissed' | null;
    decision: 'strike1' | 'strike2' | 'strike3' | 'dismissed' | 'no_case' | null;
    decisionReason: string | null;
    diagnosis: CaseDiagnosis | null;
    conditions: string | null;
    sanctionApplied: {
        warningRecordId: string | null;
        suspensionDays: number | null;
        banVoteId: string | null;
    } | null;
    shadowWouldApply: Record<string, unknown> | null;
    suspensionCaseId: string | null;
    suspensionDays: number | null;
    suspensionReason: string | null;
    cause: {
        causeType: 'three_strikes' | 'gross_misconduct';
        countedCaseIds: string[];
        priorStrikesAtDecision: number;
        grossMisconductStatement: string | null;
    } | null;
    linkedMissRecordIds: string[];
    linkedTaskIds: string[];
    founderReviewRequests: { lastRequestAt: string | null; requestCount: number };
    reinstatementRoleRestore: 'none' | 'restored' | 'pending' | null;
    createdAt: string;
    updatedAt: string;
    createdByUid: string;
    statusHistory: StatusHistoryEntry[];
}

export class DisciplineError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
        super(message);
        this.name = 'DisciplineError';
        this.code = code;
        this.status = status;
    }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function validateGroundFields(input: {
    constitutionalGround?: ConstitutionalGround | null;
    groundCSubtype?: GroundCSubtype | null;
    groundEDirection?: GroundEDirection | null;
    groundNarrative?: string | null;
}): void {
    const ground = input.constitutionalGround ?? null;
    if (ground !== null && !CONSTITUTIONAL_GROUNDS.includes(ground)) {
        throw new DisciplineError(
            'INVALID_GROUND',
            `Ground "${ground}" is not a constitutional ground. Deadline misses, attendance, and general conduct are not grounds (spec E.2).`,
        );
    }
    if (ground === '10.9(c)' && !input.groundCSubtype) {
        throw new DisciplineError('GROUND_C_SUBTYPE_REQUIRED', 'Ground 10.9(c) requires groundCSubtype.');
    }
    if (ground === '10.9(e)') {
        const d = input.groundEDirection;
        if (!d || !d.directionId || !d.directionTextSnapshot || !d.issuedBy) {
            throw new DisciplineError(
                'GROUND_E_DIRECTION_REQUIRED',
                'Ground 10.9(e) requires the direction relied on (directionId, text snapshot, issuer).',
            );
        }
    }
    if (ground !== null) {
        const narrative = (input.groundNarrative || '').trim();
        if (narrative.length < 50) {
            throw new DisciplineError(
                'GROUND_NARRATIVE_TOO_SHORT',
                'groundNarrative must be at least 50 characters: the factual allegation.',
            );
        }
    }
}

export interface CreateCaseInput {
    subjectUid: string;
    constitutionalGround?: ConstitutionalGround | null;
    groundCSubtype?: GroundCSubtype | null;
    groundEDirection?: GroundEDirection | null;
    groundNarrative?: string | null;
    proposedStrike?: 1 | 2 | 3 | null;
    evidenceRefs?: EvidenceRef[];
    linkedMissRecordIds?: string[];
    linkedTaskIds?: string[];
    drafterNote?: string | null;
    initiationSource?: 'manual' | 'cron_referral';
}

/**
 * Create a case. Manual cases start at 'initiated'; cron referral drafts
 * start at 'notice_draft' with the ground UNSET (a human must map the
 * facts onto a real ground or dismiss - E.6.3 option (i) semantics).
 */
export async function createCase(
    db: any,
    input: CreateCaseInput,
    actor: ActorContext,
    now: Date,
): Promise<DisciplinaryCase> {
    const source = input.initiationSource || 'manual';
    if (!input.subjectUid) {
        throw new DisciplineError('SUBJECT_REQUIRED', 'subjectUid is required.');
    }
    if (input.subjectUid === FOUNDER_UID) {
        throw new DisciplineError(
            'FOUNDER_NOT_SUBJECT',
            'The Founder is not subject to the Society discipline machinery in his Founder capacity.',
            403,
        );
    }
    if (actor.uid === input.subjectUid) {
        throw new DisciplineError('SELF_INITIATION', 'Nobody may initiate a case against themselves.', 403);
    }
    if (source === 'manual') {
        const eligible =
            actor.offices.includes('chapter_president') ||
            actor.offices.includes('membership_director') ||
            actor.offices.includes('ngs') ||
            actor.offices.includes('audit_chair');
        if (!eligible) {
            throw new DisciplineError(
                'INITIATOR_NOT_ELIGIBLE',
                'Only a Chapter President, the National Membership Director, the NGS, or the Audit Chair may initiate a case.',
                403,
            );
        }
        validateGroundFields(input);
        if (!input.constitutionalGround) {
            throw new DisciplineError('GROUND_REQUIRED', 'A manual case requires a constitutional ground.');
        }
    } else {
        if (input.constitutionalGround) {
            throw new DisciplineError(
                'DRAFT_GROUND_MUST_BE_UNSET',
                'A cron referral draft must leave constitutionalGround unset until a human confirms it.',
            );
        }
        if (!input.linkedMissRecordIds || input.linkedMissRecordIds.length === 0) {
            throw new DisciplineError('DRAFT_REQUIRES_MISSES', 'A cron referral draft requires linkedMissRecordIds.');
        }
    }

    const subjectSnap = await db.collection('users').doc(input.subjectUid).get();
    if (!subjectSnap.exists) {
        throw new DisciplineError('SUBJECT_NOT_FOUND', 'Subject user record not found.', 404);
    }
    const subject = subjectSnap.data() || {};
    const subjectNameSnapshot = subject.displayName || subject.name || input.subjectUid;
    const subjectRoleSnapshot = subject.role || null;
    const subjectIsMember = subjectRoleSnapshot !== 'applicant' && subjectRoleSnapshot !== null;

    const year = now.getUTCFullYear();
    const counterRef = db.collection('counters').doc(`disciplinary_cases_${year}`);
    const caseRef = db.collection('disciplinary_cases').doc();
    const iso = now.toISOString();
    const initialStatus: CaseStatus = source === 'cron_referral' ? 'notice_draft' : 'initiated';

    const newCase: DisciplinaryCase = await db.runTransaction(async (tx: any) => {
        const counterSnap = await tx.get(counterRef);
        const last = counterSnap.exists ? Number(counterSnap.data()?.lastNumber || 0) : 0;
        const next = last + 1;
        tx.set(counterRef, { lastNumber: next, updatedAt: Timestamp.fromDate(now) }, { merge: true });
        const caseNumber = `DISC-${year}-${String(next).padStart(4, '0')}`;
        const doc: DisciplinaryCase = {
            caseId: caseRef.id,
            caseNumber,
            subjectUid: input.subjectUid,
            subjectNameSnapshot,
            subjectRoleSnapshot,
            subjectIsMember,
            category: null,
            proposedStrike: input.proposedStrike ?? null,
            strikeNumber: null,
            status: initialStatus,
            constitutionalGround: input.constitutionalGround ?? null,
            groundCSubtype: input.groundCSubtype ?? null,
            groundEDirection: input.groundEDirection ?? null,
            groundNarrative: input.groundNarrative ?? null,
            drafterNote: input.drafterNote ?? null,
            evidenceRefs: input.evidenceRefs ?? [],
            initiatedByUid: actor.uid,
            initiatedByRole: actor.roleKey,
            initiationSource: source,
            noticeIssuedByUid: null,
            hearingOfficerUid: null,
            decidedByRole: null,
            decidedByUid: null,
            necDecisionRef: null,
            boardVoteId: null,
            founderReview: null,
            initiatedAt: iso,
            noticeIssuedAt: null,
            defenceDueAt: null,
            defenceReceivedAt: null,
            hearingAt: null,
            decidedAt: null,
            sanctionAppliedAt: null,
            suspensionStartsAt: null,
            suspensionEndsAt: null,
            boardNoticeIssuedAt: null,
            boardVoteOpensAt: null,
            closedAt: null,
            noticeText: null,
            noticeChannel: null,
            noticeDeliveredAt: null,
            defenceText: null,
            defenceSubmittedByUid: null,
            defenceSubmittedAt: null,
            defenceLate: false,
            hearingNotes: null,
            hearingOutcome: null,
            decision: null,
            decisionReason: null,
            diagnosis: null,
            conditions: null,
            sanctionApplied: null,
            shadowWouldApply: null,
            suspensionCaseId: null,
            suspensionDays: null,
            suspensionReason: null,
            cause: null,
            linkedMissRecordIds: input.linkedMissRecordIds ?? [],
            linkedTaskIds: input.linkedTaskIds ?? [],
            founderReviewRequests: { lastRequestAt: null, requestCount: 0 },
            reinstatementRoleRestore: null,
            createdAt: iso,
            updatedAt: iso,
            createdByUid: actor.uid,
            statusHistory: [
                { from: null, to: initialStatus, byUid: actor.uid, byRole: actor.roleKey, at: iso },
            ],
        };
        tx.set(caseRef, doc);
        return doc;
    });

    await writeGovernanceAuditOrThrow(db, {
        action: 'discipline.case_created',
        actorUid: actor.uid,
        actorRole: actor.roleKey,
        targetType: 'disciplinary_case',
        targetId: newCase.caseId,
        details: { caseNumber: newCase.caseNumber, source, subjectUid: input.subjectUid },
    });
    return newCase;
}

export async function getCase(db: any, caseId: string): Promise<DisciplinaryCase> {
    // Supa path (surface 'discipline', plan G1): single-doc case get via
    // the seam; a supa miss classifies exactly like a Firestore miss.
    // Adapter error falls back to the Firestore get byte-for-byte. All
    // WRITES (transitionCase, the decision transactions) stay Firestore.
    if (disciplineData.enabled()) {
        try {
            const doc = await disciplineData.getCase(caseId);
            if (!doc) throw new DisciplineError('CASE_NOT_FOUND', 'Case not found.', 404);
            const { id: _adapterId, ...data } = doc;
            return { caseId, ...data } as DisciplinaryCase;
        } catch (e) {
            if (e instanceof DisciplineError) throw e;
            // fall through to the Firestore path
        }
    }
    const snap = await db.collection('disciplinary_cases').doc(caseId).get();
    if (!snap.exists) throw new DisciplineError('CASE_NOT_FOUND', 'Case not found.', 404);
    return { caseId: snap.id, ...(snap.data() as any) } as DisciplinaryCase;
}

interface TransitionRule {
    from: CaseStatus[];
    // 'system' means the cron/system actor; 'internal' transitions are
    // performed by apply-decision.ts inside the decision transaction and
    // are REJECTED here so there is exactly one door for decisions.
    actor: 'initiator_offices' | 'ngs_or_founder_sub' | 'subject' | 'audit_chair' | 'ngs' | 'ngs_or_founder' | 'system' | 'internal';
}

const TRANSITIONS: Record<string, TransitionRule> = {
    notice_draft: { from: ['initiated'], actor: 'initiator_offices' },
    notice_issued: { from: ['notice_draft', 'initiated'], actor: 'ngs_or_founder_sub' },
    defence_received: { from: ['notice_issued'], actor: 'subject' },
    defence_window_closed: { from: ['notice_issued'], actor: 'system' },
    hearing: { from: ['defence_received', 'defence_window_closed'], actor: 'audit_chair' },
    decided: { from: ['hearing'], actor: 'internal' },
    board_notice_issued: { from: ['decided'], actor: 'ngs' },
    board_vote_open: { from: ['board_notice_issued'], actor: 'ngs_or_founder' },
    board_decided: { from: ['board_vote_open'], actor: 'system' },
    decided_outcome_failed: { from: ['board_decided'], actor: 'system' },
    sanction_applied: { from: ['decided', 'board_decided'], actor: 'internal' },
    closed: { from: ['sanction_applied', 'decided_outcome_failed'], actor: 'system' },
    dismissed: {
        from: ['initiated', 'notice_draft', 'notice_issued', 'defence_received', 'defence_window_closed', 'hearing'],
        actor: 'initiator_offices',
    },
};

export interface TransitionOpts {
    note?: string;
    noticeText?: string;
    noticeChannel?: 'in_app' | 'email' | 'in_app_and_email';
    defenceText?: string;
    hearingAt?: string;
    hearingNotes?: string;
    decisionReason?: string;
    systemActor?: boolean;
    subjectIsNgsHolder?: boolean;
    ngsVacant?: boolean;
}

function assertActor(
    rule: TransitionRule,
    actor: ActorContext,
    kase: DisciplinaryCase,
    opts: TransitionOpts,
): void {
    if (rule.actor === 'internal') {
        throw new DisciplineError(
            'USE_DECISION_PATH',
            'Decisions and sanction application run through applyCaseDecision, not transitionCase.',
        );
    }
    if (opts.systemActor || actor.uid === 'system') {
        if (rule.actor === 'system' || rule.actor === 'initiator_offices') return;
        throw new DisciplineError('SYSTEM_TRANSITION_NOT_ALLOWED', 'The system actor may not fire this transition.', 403);
    }
    switch (rule.actor) {
        case 'initiator_offices': {
            const ok =
                actor.uid === kase.initiatedByUid ||
                actor.offices.includes('ngs') ||
                actor.offices.includes('audit_chair') ||
                actor.offices.includes('membership_director') ||
                actor.offices.includes('chapter_president');
            if (!ok) throw new DisciplineError('ACTOR_NOT_ELIGIBLE', 'This office may not fire this transition.', 403);
            return;
        }
        case 'ngs_or_founder_sub': {
            // NGS only; the Founder substitutes when the NGS is the subject
            // or the office is vacant (E.4.2, vacancy asserted by the route
            // via opts.ngsVacant). No other substitution.
            if (actor.offices.includes('ngs') && actor.uid !== kase.subjectUid) return;
            if (isFounderUid(actor.uid) && (opts.subjectIsNgsHolder || opts.ngsVacant)) return;
            throw new DisciplineError('NOTICE_NGS_ONLY', 'Only the National General Secretary may issue a notice.', 403);
        }
        case 'subject': {
            if (actor.uid !== kase.subjectUid) {
                throw new DisciplineError('DEFENCE_SUBJECT_ONLY', 'Only the case subject may submit a defence.', 403);
            }
            return;
        }
        case 'audit_chair': {
            if (!actor.offices.includes('audit_chair')) {
                throw new DisciplineError('HEARING_AUDIT_CHAIR_ONLY', 'Only the Audit Chair may open a hearing.', 403);
            }
            return;
        }
        case 'ngs': {
            if (!actor.offices.includes('ngs')) {
                throw new DisciplineError('NGS_ONLY', 'Only the National General Secretary may fire this transition.', 403);
            }
            return;
        }
        case 'ngs_or_founder': {
            if (actor.offices.includes('ngs') || isFounderUid(actor.uid)) return;
            throw new DisciplineError('NGS_OR_FOUNDER_ONLY', 'Only the NGS or the Founder may fire this transition.', 403);
        }
        case 'system':
            throw new DisciplineError('SYSTEM_ONLY', 'This transition is fired by the system.', 403);
        default:
            throw new DisciplineError('ACTOR_NOT_ELIGIBLE', 'Actor not eligible.', 403);
    }
}

/**
 * The ONLY writer of case status outside the decision transaction.
 * Validates the (from, to) pair and the actor's office server-side,
 * appends statusHistory, and stamps the matching timeline field.
 */
export async function transitionCase(
    db: any,
    caseId: string,
    to: CaseStatus,
    actor: ActorContext,
    opts: TransitionOpts,
    now: Date,
): Promise<DisciplinaryCase> {
    const ref = db.collection('disciplinary_cases').doc(caseId);
    const kase = await getCase(db, caseId);
    const rule = TRANSITIONS[to];
    if (!rule) throw new DisciplineError('UNKNOWN_STATUS', `Unknown target status ${to}.`);
    if (kase.status === 'closed' || kase.status === 'dismissed') {
        throw new DisciplineError('CASE_TERMINAL', 'A closed or dismissed case has no outgoing transitions.');
    }
    if (!rule.from.includes(kase.status)) {
        throw new DisciplineError(
            'INVALID_TRANSITION',
            `Transition ${kase.status} -> ${to} is not in the state machine.`,
        );
    }
    if (to === 'notice_issued' && opts.subjectIsNgsHolder === undefined) {
        const subjectActor = await resolveActorOffices(db, kase.subjectUid);
        opts = { ...opts, subjectIsNgsHolder: subjectActor.offices.includes('ngs') };
    }
    assertActor(rule, actor, kase, opts);

    const iso = now.toISOString();
    const update: Record<string, unknown> = {
        status: to,
        updatedAt: iso,
        statusHistory: [
            ...(kase.statusHistory || []),
            { from: kase.status, to, byUid: actor.uid, byRole: actor.roleKey, at: iso, note: opts.note },
        ],
    };

    if (to === 'notice_issued') {
        if (!opts.noticeText || !opts.noticeText.trim()) {
            throw new DisciplineError('NOTICE_TEXT_REQUIRED', 'Issuing a notice requires the served notice text.');
        }
        update.noticeText = opts.noticeText;
        update.noticeChannel = opts.noticeChannel || 'in_app_and_email';
        update.noticeIssuedByUid = actor.uid;
        update.noticeIssuedAt = iso;
        // The 7-day defence clock runs from ISSUE, exactly (E.3.2).
        update.defenceDueAt = new Date(now.getTime() + 7 * DAY_MS).toISOString();
    }
    if (to === 'defence_received') {
        if (!opts.defenceText || !opts.defenceText.trim()) {
            throw new DisciplineError('DEFENCE_TEXT_REQUIRED', 'A defence requires non-empty defenceText.');
        }
        update.defenceText = opts.defenceText;
        update.defenceSubmittedByUid = actor.uid;
        update.defenceSubmittedAt = iso;
        update.defenceReceivedAt = iso;
        // Late defences are recorded, never auto-disqualifying (E.2).
        update.defenceLate = kase.defenceDueAt ? now.getTime() > new Date(kase.defenceDueAt).getTime() : false;
    }
    if (to === 'hearing') {
        if (actor.uid === kase.initiatedByUid) {
            throw new DisciplineError(
                'HEARING_OFFICER_CONFLICT',
                'The Audit Chair may not hear a case he initiated; the Founder assigns the NGS as hearing officer for that case.',
                403,
            );
        }
        update.hearingOfficerUid = actor.uid;
        if (opts.hearingAt) update.hearingAt = opts.hearingAt;
        if (opts.hearingNotes) update.hearingNotes = opts.hearingNotes;
    }
    if (to === 'dismissed') {
        const reason = (opts.decisionReason || '').trim();
        if (reason.length < 30) {
            throw new DisciplineError('DECISION_REASON_REQUIRED', 'A dismissal requires a decisionReason of at least 30 characters.');
        }
        update.decision = 'dismissed';
        update.decisionReason = reason;
        update.decidedByUid = actor.uid;
        update.decidedByRole = actor.roleKey;
        update.decidedAt = iso;
        update.closedAt = iso;
    }
    if (to === 'board_notice_issued') {
        if (kase.decision !== 'strike3') {
            throw new DisciplineError('BOARD_NOTICE_STRIKE3_ONLY', 'Board notice exists only for Strike 3 cases.');
        }
        update.boardNoticeIssuedAt = iso;
        update.boardVoteOpensAt = new Date(now.getTime() + 7 * DAY_MS).toISOString();
    }
    if (to === 'board_vote_open') {
        // Z-13: the 7-day Board notice period has NO override, no Founder
        // exception, no urgent flag.
        if (kase.boardVoteOpensAt && now.getTime() < new Date(kase.boardVoteOpensAt).getTime()) {
            throw new DisciplineError(
                'BOARD_NOTICE_PERIOD',
                `The Board vote may not open before ${kase.boardVoteOpensAt}.`,
                409,
            );
        }
        let seated = 0;
        try {
            const govSnap = await db.collection('governors').get();
            govSnap.forEach((d: any) => {
                const g = d.data() || {};
                if (!g.vacant && g.status !== 'vacant') seated++;
            });
        } catch {
            seated = 0;
        }
        if (seated < 3) {
            throw new DisciplineError(
                'BOARD_NOT_SEATED',
                'No seated Board exists; a Strike 3 case queues at board_notice_issued until a Board is seated.',
                409,
            );
        }
    }

    await ref.update(update);
    await writeGovernanceAuditOrThrow(db, {
        action: `discipline.transition.${to}`,
        actorUid: actor.uid,
        actorRole: actor.roleKey,
        targetType: 'disciplinary_case',
        targetId: caseId,
        details: { caseNumber: kase.caseNumber, from: kase.status, to },
    });

    if (to === 'notice_issued') {
        await notifyUser(kase.subjectUid, {
            type: 'discipline_notice',
            title: `Disciplinary notice - case ${kase.caseNumber}`,
            body: opts.noticeText || '',
            link: `/profile/discipline/${caseId}`,
        });
        await ref.update({ noticeDeliveredAt: new Date().toISOString() });
    }
    if (to === 'dismissed' && kase.noticeIssuedAt) {
        await notifyUser(kase.subjectUid, {
            type: 'discipline_dismissed',
            title: `Case ${kase.caseNumber} dismissed`,
            body: `The disciplinary case against you has been dismissed. Reason: ${update.decisionReason}`,
            link: `/profile/discipline/${caseId}`,
        });
    }
    return getCase(db, caseId);
}

/**
 * Internal helper for apply-decision.ts: writes the decision fields and
 * status progression (hearing -> decided -> sanction_applied -> closed)
 * INSIDE the caller's transaction, so the decision, the sanction, and
 * the audit row commit or fail together (E.4.5).
 */
export function decisionTransitionFields(
    kase: DisciplinaryCase,
    to: CaseStatus,
    actor: ActorContext,
    now: Date,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    const iso = now.toISOString();
    const history = [...(kase.statusHistory || [])];
    let from = kase.status;
    const chain: CaseStatus[] =
        to === 'closed' && kase.status === 'hearing'
            ? ['decided', 'sanction_applied', 'closed']
            : to === 'closed' && kase.status === 'board_vote_open'
              ? ['board_decided', 'sanction_applied', 'closed']
              : [to];
    for (const step of chain) {
        history.push({ from, to: step, byUid: actor.uid, byRole: actor.roleKey, at: iso });
        from = step;
    }
    return {
        ...extra,
        status: to,
        updatedAt: iso,
        statusHistory: history,
        ...(to === 'closed' ? { closedAt: iso } : {}),
    };
}

/**
 * Draft auto-expiry (E.3.1): an unconfirmed draft older than 14 days in
 * notice_draft with no notice issued expires to dismissed. The subject
 * was never told, so expiry harms nobody and notifies nobody.
 */
export async function expireStaleDrafts(
    db: any,
    now: Date,
): Promise<{ expired: number; caseIds: string[] }> {
    const cutoff = new Date(now.getTime() - 14 * DAY_MS).toISOString();
    // Supa path: the notice_draft scan via the seam (full docs; the
    // cutoff comparison below is ISO-string vs ISO-string, plan G1).
    // The dismissals themselves stay on transitionCase/Firestore.
    let draftDocs: Array<{ id: string; data: Record<string, any> }> | null = null;
    if (disciplineData.enabled()) {
        try {
            const docs = await disciplineData.listCases([['status', '==', 'notice_draft']]);
            draftDocs = docs.map((d) => {
                const { id, ...data } = d;
                return { id: String(id), data };
            });
        } catch {
            draftDocs = null;
        }
    }
    if (!draftDocs) {
        const snap = await db
            .collection('disciplinary_cases')
            .where('status', '==', 'notice_draft')
            .get();
        draftDocs = snap.docs.map((doc: any) => ({ id: doc.id, data: doc.data() || {} }));
    }
    // Non-null here by construction: the seam path assigns or nulls-then-falls-back,
    // and the Firestore fallback assigns (or throws before this point).
    const resolvedDraftDocs: Array<{ id: string; data: Record<string, any> }> = draftDocs ?? [];
    const systemActor: ActorContext = { uid: 'system', offices: [], roleKey: 'system', chapterId: null };
    const caseIds: string[] = [];
    for (const doc of resolvedDraftDocs) {
        const kase = { caseId: doc.id, ...doc.data } as DisciplinaryCase;
        if (kase.createdAt && kase.createdAt < cutoff && !kase.noticeIssuedAt) {
            try {
                await transitionCase(db, doc.id, 'dismissed', systemActor, {
                    systemActor: true,
                    decisionReason: 'Draft expired without confirmation',
                    note: 'Auto-expired by the daily stanza (spec E.3.1).',
                }, now);
                caseIds.push(doc.id);
            } catch {
                /* one bad draft must not abort the sweep */
            }
        }
    }
    return { expired: caseIds.length, caseIds };
}

export async function resolveActor(db: any, uid: string): Promise<ActorContext> {
    return resolveActorOffices(db, uid);
}

/**
 * Record the hearing officer's recommendation (E.4.3): the hearing
 * RECOMMENDS (hearingOutcome), the entitled officer then DECIDES via
 * applyCaseDecision. Only the assigned hearing officer (normally the
 * Audit Chair) may record it, and only while the case is in 'hearing'.
 * A hearing outcome of 'dismissed' blocks any strike at decision time.
 */
export async function recordHearingOutcome(
    db: any,
    caseId: string,
    actor: ActorContext,
    payload: { hearingOutcome: 'upheld' | 'modified' | 'dismissed'; hearingNotes: string },
    now: Date,
): Promise<DisciplinaryCase> {
    const kase = await getCase(db, caseId);
    if (kase.status !== 'hearing') {
        throw new DisciplineError('HEARING_NOT_OPEN', `Case is in status ${kase.status}; a hearing outcome can only be recorded during a hearing.`);
    }
    if (actor.uid !== kase.hearingOfficerUid) {
        throw new DisciplineError('HEARING_OFFICER_ONLY', 'Only the assigned hearing officer may record the hearing outcome.', 403);
    }
    if (!['upheld', 'modified', 'dismissed'].includes(payload.hearingOutcome)) {
        throw new DisciplineError('HEARING_OUTCOME_INVALID', 'hearingOutcome must be upheld, modified, or dismissed.');
    }
    if (!payload.hearingNotes || payload.hearingNotes.trim().length < 10) {
        throw new DisciplineError('HEARING_NOTES_REQUIRED', 'Hearing notes (at least 10 characters) are required: they are the record of who attended and what was said.');
    }
    await db.collection('disciplinary_cases').doc(caseId).update({
        hearingOutcome: payload.hearingOutcome,
        hearingNotes: payload.hearingNotes,
        updatedAt: now.toISOString(),
    });
    await writeGovernanceAuditOrThrow(db, {
        action: 'discipline.hearing_outcome_recorded',
        actorUid: actor.uid,
        actorRole: actor.roleKey,
        targetType: 'disciplinary_case',
        targetId: caseId,
        details: { caseNumber: kase.caseNumber, hearingOutcome: payload.hearingOutcome },
    });
    return getCase(db, caseId);
}
