/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT TESTS - cluster: MEETINGS + DECISIONS + MOTIONS.
 * Area 2 (service layer): motion creation / voting / close semantics that
 * motions.test.ts and ballots.test.ts do NOT pin:
 *
 * - THERE IS NO SECONDER IN THE CODE. openMotion's input has no seconder
 *   field, the stored Motion has no seconder field, and nothing validates
 *   proposerUid: the proposer need not be the actor, need not be present,
 *   need not be eligible, need not even be a body member. The chair (the
 *   actor) may also name THEMSELVES as proposer (self-proposal allowed).
 *   Any "mover/seconder" rule in a migration spec is NOT current behaviour.
 * - A motion closed with ZERO ballots (ordinary class) closes FAILED and
 *   still writes a decisions-register entry with outcome "failed".
 * - Closing a SECRET-ballot motion through the full closeMotion service
 *   counts secret choices (not traceable ballots) and the stored result
 *   carries tallies only.
 */
import {
  InMemoryAttendanceReader,
  InMemoryMeetingReader,
  InMemoryMotionStore,
  ballotStoreFor,
  closeMotion,
  openMotion,
  type MeetingView,
  type MotionDeps,
} from '../motions';
import {
  InMemoryBallotStore,
  castTraceableBallot,
  issueSecretToken,
  castSecretBallot,
} from '../ballots';
import { InMemoryDecisionsClient } from '../decisions-client';
import { InMemoryDecisionClassesReader, type ServerDecisionClassView } from '../decision-classes';
import { InMemoryBodyReader, InMemoryFilingTaskCreator, type BodyView } from '../shared';

const T0 = new Date('2026-10-21T10:00:00Z');
const BOARD_9 = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'];
const PRESENT_5 = BOARD_9.slice(0, 5);

const boardBody: BodyView = {
  id: 'board_body', name: 'Board of Governors', type: 'board',
  chairUid: 'g1', secretaryUid: 'ngs_1', memberUids: [...BOARD_9],
  quorumOverride: null, chapterId: null,
};

const meeting: MeetingView = {
  id: 'mtg_1', bodyId: 'board_body', bodyType: 'board', chairUid: 'g1',
  secretaryUid: 'ngs_1', status: 'convened', quorumRequired: 5, quorumVerifiedAt: T0,
};

const ordinaryClass: ServerDecisionClassView = {
  id: 'class_ordinary', label: 'Ordinary', assignedBodyType: 'board',
  majorityType: 'ordinary_present_and_voting', numerator: null,
  denominatorKind: 'present_and_voting', consentRequired: false,
  isReservedMatter: false, filingFlag: false, sourceRow: '4.3', enforcementMode: 'enforce',
};

function makeDeps() {
  const motions = new InMemoryMotionStore();
  const ballots = new InMemoryBallotStore();
  const decisions = new InMemoryDecisionsClient();
  const deps: MotionDeps = {
    motions, ballots,
    meetings: new InMemoryMeetingReader([{ ...meeting }]),
    attendance: new InMemoryAttendanceReader({ mtg_1: [...PRESENT_5] }),
    bodies: new InMemoryBodyReader([boardBody]),
    classes: new InMemoryDecisionClassesReader([ordinaryClass]),
    decisions,
    filingTasks: new InMemoryFilingTaskCreator(),
    newId: () => motions.nextMotionId(),
  };
  return { deps, motions, ballots, decisions };
}

const openInput = (over: Record<string, unknown> = {}) => ({
  meetingId: 'mtg_1', actorUid: 'g1', text: 'Approve the budget',
  decisionClassId: 'class_ordinary', proposerUid: 'g2', at: T0, ...over,
});

describe('proposer semantics: no seconder, no proposer validation (as coded)', () => {
  it('the stored motion has NO seconder field of any kind', async () => {
    const { deps } = makeDeps();
    const { motion } = await openMotion(deps, openInput());
    expect(Object.keys(motion)).not.toContain('seconderUid');
    expect(Object.keys(motion)).not.toContain('secondedBy');
    expect((motion as unknown as Record<string, unknown>).seconder).toBeUndefined();
  });

  it('proposerUid is stored verbatim even when the proposer is absent and not a body member', async () => {
    const { deps } = makeDeps();
    const { motion } = await openMotion(deps, openInput({ proposerUid: 'total_outsider' }));
    expect(motion.proposerUid).toBe('total_outsider');
    expect(motion.status).toBe('open');
  });

  it('the chair may name THEMSELVES as proposer (self-proposal is allowed)', async () => {
    const { deps } = makeDeps();
    const { motion } = await openMotion(deps, openInput({ proposerUid: 'g1' }));
    expect(motion.proposerUid).toBe('g1');
    expect(motion.openedBy).toBe('g1');
  });

  it('open-time quorum boundary through the service: present == quorumRequired opens, one fewer is 409', async () => {
    const { deps } = makeDeps();
    deps.attendance = new InMemoryAttendanceReader({ mtg_1: BOARD_9.slice(0, 4) });
    await expect(openMotion(deps, openInput())).rejects.toMatchObject({ code: 'quorum_not_met', status: 409 });
    deps.attendance = new InMemoryAttendanceReader({ mtg_1: [...PRESENT_5] });
    const { motion } = await openMotion(deps, openInput());
    expect(motion.denominatorSnapshot.presentCount).toBe(5);
  });
});

describe('close semantics: zero ballots and secret counting through closeMotion', () => {
  it('closing an ordinary motion with ZERO ballots closes FAILED and still writes a register entry', async () => {
    const { deps, decisions } = makeDeps();
    const { motion } = await openMotion(deps, openInput());
    const result = await closeMotion(deps, { motionId: motion.id, actorUid: 'g1', at: T0 });
    expect(result.status).toBe('closed_failed');
    expect(result.tied).toBe(false);
    expect(result.result).toMatchObject({ votesFor: 0, votesAgainst: 0, abstentions: 0, thresholdMet: false });
    const entries = decisions.all();
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe('failed');
    expect(entries[0].source).toBe('meeting_motion');
    expect(entries[0].status).toBe('effective');
  });

  it('an abstention-only close also fails (abstentions never enter the comparison)', async () => {
    const { deps, ballots } = makeDeps();
    const { motion } = await openMotion(deps, openInput());
    const store = ballotStoreFor(deps.motions, ballots);
    await castTraceableBallot(store, { motionId: motion.id, voterUid: 'g2', choice: 'abstain' });
    await castTraceableBallot(store, { motionId: motion.id, voterUid: 'g3', choice: 'abstain' });
    const result = await closeMotion(deps, { motionId: motion.id, actorUid: 'g1', at: T0 });
    expect(result.status).toBe('closed_failed');
    expect(result.result).toMatchObject({ votesFor: 0, votesAgainst: 0, abstentions: 2 });
  });

  it('closing a secret-ballot motion counts SECRET choices, writes tallies only, and the result passes at for>against', async () => {
    const { deps, ballots, decisions } = makeDeps();
    const { motion } = await openMotion(deps, openInput({ method: 'secret_ballot' }));
    const store = ballotStoreFor(deps.motions, ballots);
    for (const uid of ['g2', 'g3', 'g4']) {
      const { token } = await issueSecretToken(store, { motionId: motion.id, uid });
      await castSecretBallot(store, { token, choice: uid === 'g4' ? 'against' : 'for' });
    }
    const result = await closeMotion(deps, { motionId: motion.id, actorUid: 'g1', at: T0 });
    expect(result.status).toBe('closed_passed');
    expect(result.result).toMatchObject({ votesFor: 2, votesAgainst: 1, abstentions: 0 });
    const entries = decisions.all();
    expect(entries).toHaveLength(1);
    expect(entries[0].votingSummary).toMatchObject({ votesFor: 2, votesAgainst: 1 });
    // Anonymity at the register layer: the entry carries no voter identities.
    expect(JSON.stringify(entries[0])).not.toContain('g2');
    expect(JSON.stringify(entries[0])).not.toContain('g3');
  });
});
