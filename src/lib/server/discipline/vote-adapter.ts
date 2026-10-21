/**
 * vote-adapter.ts - ADAPTER over the governance_votes substrate.
 *
 * Section 0.2's governance_votes module is a parallel build; this
 * adapter implements the specced shape locally (one collection, frozen
 * electorate snapshot at open, exact pass rule) so the discipline
 * workstream composes. When the substrate lands, only this file's
 * internals change.
 *
 * Expulsion pass rule (E.4.4): strict majority of Governors PRESENT AND
 * VOTING (votesFor > votesAgainst; abstentions excluded from the
 * denominator; a tie FAILS). Quorum: at least 5 participating on a
 * 9-seat Board; if seated with fewer, a majority of SEATED Governors,
 * minimum 3 - computed at vote open and FROZEN on the vote doc.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { DisciplineError, transitionCase } from './case-service';
import { ActorContext, writeGovernanceAuditOrThrow } from './adapters';
import { applyExpulsionBan } from './apply-decision';

export interface GovernorSeat {
    seatKey: string;
    uid: string | null;
    vacant: boolean;
}

export async function getSeatedGovernors(db: any): Promise<GovernorSeat[]> {
    try {
        const snap = await db.collection('governors').get();
        const seats: GovernorSeat[] = [];
        snap.forEach((d: any) => {
            const g = d.data() || {};
            const vacant = g.vacant === true || g.status === 'vacant' || !g.uid;
            seats.push({ seatKey: d.id, uid: g.uid || null, vacant });
        });
        return seats.filter((s) => !s.vacant);
    } catch {
        return [];
    }
}

export function quorumForSeated(seatedCount: number): number {
    if (seatedCount >= 9) return 5;
    return Math.max(3, Math.floor(seatedCount / 2) + 1);
}

export async function openExpulsionVote(db: any, caseId: string, now: Date): Promise<string> {
    const seated = await getSeatedGovernors(db);
    if (seated.length < 3) {
        throw new DisciplineError(
            'BOARD_NOT_SEATED',
            'No seated Board exists (fewer than 3 seated Governors); the vote cannot open.',
            409,
        );
    }
    const ref = db.collection('governance_votes').doc();
    await ref.set({
        subjectType: 'strike3_expulsion',
        subjectCaseId: caseId,
        mode: 'ballot',
        status: 'open',
        openedAt: Timestamp.fromDate(now),
        electorateSnapshot: seated.map((s) => ({ seatKey: s.seatKey, uid: s.uid, vacant: false })),
        quorumRequired: quorumForSeated(seated.length),
        passRule: 'strict_majority_present_and_voting',
        denominatorBasis: 'present',
        result: null,
        createdAt: Timestamp.fromDate(now),
    });
    // Link the vote onto the case.
    await db.collection('disciplinary_cases').doc(caseId).update({ boardVoteId: ref.id });
    return ref.id;
}

export async function castBallot(
    db: any,
    voteId: string,
    voterUid: string,
    choice: 'for' | 'against' | 'abstain',
): Promise<void> {
    const voteRef = db.collection('governance_votes').doc(voteId);
    const snap = await voteRef.get();
    if (!snap.exists) throw new DisciplineError('VOTE_NOT_FOUND', 'Vote not found.', 404);
    const vote = snap.data() || {};
    if (vote.status !== 'open') throw new DisciplineError('VOTE_NOT_OPEN', 'This vote is not open.');
    const inSnapshot = (vote.electorateSnapshot || []).some((s: any) => s.uid === voterUid);
    if (!inSnapshot) {
        throw new DisciplineError('VOTER_NOT_IN_ELECTORATE', 'Only Governors in the frozen electorate snapshot may cast a ballot.', 403);
    }
    // Doc id = voter uid enforces one ballot per voter structurally.
    await voteRef.collection('ballots').doc(voterUid).set({
        choice,
        castAt: Timestamp.now(),
    });
}

export interface TallyResult {
    votesFor: number;
    votesAgainst: number;
    abstentions: number;
    participating: number;
    quorumMet: boolean;
    passed: boolean;
}

/** Pure tally: strict majority of present-and-voting; a tie FAILS. */
export function tallyBallots(
    ballots: Array<{ choice: string }>,
    config: { quorumRequired: number },
): TallyResult {
    const votesFor = ballots.filter((b) => b.choice === 'for').length;
    const votesAgainst = ballots.filter((b) => b.choice === 'against').length;
    const abstentions = ballots.filter((b) => b.choice === 'abstain').length;
    const participating = votesFor + votesAgainst + abstentions;
    const quorumMet = participating >= config.quorumRequired;
    return {
        votesFor,
        votesAgainst,
        abstentions,
        participating,
        quorumMet,
        passed: quorumMet && votesFor > votesAgainst,
    };
}

/**
 * Close the vote (idempotent: a second close returns the stored
 * result). On a PASS, the expulsion is applied by applyExpulsionBan -
 * the sole isBanned writer. On a FAIL, the case moves
 * board_vote_open -> board_decided -> decided_outcome_failed -> closed
 * with NO sanction of any kind (E.3.9), and its strikeNumber is cleared:
 * the strike was recommended, never landed.
 */
export async function closeExpulsionVote(
    db: any,
    voteId: string,
    actor: ActorContext,
    now: Date,
): Promise<{ passed: boolean; tally: TallyResult }> {
    const voteRef = db.collection('governance_votes').doc(voteId);
    const snap = await voteRef.get();
    if (!snap.exists) throw new DisciplineError('VOTE_NOT_FOUND', 'Vote not found.', 404);
    const vote = snap.data() || {};
    if (vote.status === 'closed' && vote.result) {
        return { passed: !!vote.result.passed, tally: vote.result.tally };
    }
    const ballotsSnap = await voteRef.collection('ballots').get();
    const ballots: Array<{ choice: string }> = [];
    ballotsSnap.forEach((d: any) => ballots.push({ choice: (d.data() || {}).choice }));
    const tally = tallyBallots(ballots, { quorumRequired: vote.quorumRequired });
    const caseId = vote.subjectCaseId as string;
    await voteRef.update({
        status: 'closed',
        closedAt: Timestamp.fromDate(now),
        result: { passed: tally.passed, tally, closedBy: actor.uid },
    });
    await writeGovernanceAuditOrThrow(db, {
        action: 'discipline.expulsion_vote_closed',
        actorUid: actor.uid,
        actorRole: actor.roleKey,
        targetType: 'governance_vote',
        targetId: voteId,
        details: { caseId, passed: tally.passed, votesFor: tally.votesFor, votesAgainst: tally.votesAgainst, quorumMet: tally.quorumMet },
    });

    const systemActor: ActorContext = { uid: 'system', offices: [], roleKey: 'system', chapterId: null };
    if (tally.passed) {
        await applyExpulsionBan(db, caseId, {
            voteId,
            votesFor: tally.votesFor,
            votesAgainst: tally.votesAgainst,
            quorumMet: tally.quorumMet,
        }, now);
    } else {
        await transitionCase(db, caseId, 'board_decided', systemActor, { systemActor: true, note: 'Board vote closed.' }, now);
        // No sanction of any kind: clear the recommended strike so the
        // derived counter never counts a strike that did not land.
        await db.collection('disciplinary_cases').doc(caseId).update({
            strikeNumber: null,
            decisionOutcomeNote: 'Board vote did not pass; no sanction applied by this case (spec E.3.9).',
        });
        await transitionCase(db, caseId, 'decided_outcome_failed', systemActor, { systemActor: true }, now);
        await transitionCase(db, caseId, 'closed', systemActor, { systemActor: true }, now);
    }
    return { passed: tally.passed, tally };
}
