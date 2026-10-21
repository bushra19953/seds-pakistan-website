/**
 * Tests for the shared quorum engine (src/lib/governance/quorum-engine.ts)
 * plus its lifecycle adapter (quorum-adapter.ts).
 * Spec: ws-a section 6.2, meetings_core_interfaces.md section 4,
 * Doc 04 secs 4.3-4.6, P-05 / P-07.
 *
 * KNOWN BUG (reported, NOT fixed here - fix is a separate decision):
 * quorum-engine.ts imports MotionThreshold / ThresholdEvaluation /
 * CastingBallotRecord from types.ts and its header promises threshold
 * evaluation, but it exports NO threshold function at all: no
 * evaluateThreshold, no needsCastingVote, no requiredCountForFraction,
 * no majorityOfAll (all named in ws-a section 6.2 and interfaces sec 4).
 * The "threshold evaluation (MISSING)" describe below encodes the spec
 * behaviour against the interfaces-sec-4 signature; every test in it
 * fails until the engine is completed. All quorum / snapshot / motion
 * effect tests pass against the code as committed.
 */
import * as engine from '../quorum-engine';
import {
  BOARD_ADJOURNED_QUORUM,
  BOARD_ORDINARY_QUORUM,
  CASTING_VOTE_BODY_TYPES,
  applyQuorumToMotions,
  canOpenMotion,
  computePresent,
  computePresentUids,
  evaluateQuorum,
  isFounderPresent,
  isPresent,
  snapshotDenominator,
  verifyQuorum,
} from '../quorum-engine';
import * as adapter from '../quorum-adapter';
import type {
  AttendanceRecord,
  BodyConfigView,
  DenominatorSnapshot,
  MotionThreshold,
} from '../types';

const NINE = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'];

function board(overrides: Partial<BodyConfigView> = {}): BodyConfigView {
  return { memberUids: [...NINE], bodyType: 'board', ...overrides };
}

/** First n governors present in person; optionally flag one as Founder. */
function present(
  n: number,
  opts: { mode?: AttendanceRecord['mode']; founderUid?: string } = {},
): AttendanceRecord[] {
  return NINE.slice(0, n).map((uid) => ({
    uid,
    mode: opts.mode ?? 'in_person',
    isFounder: uid === opts.founderUid,
  }));
}

describe('presence', () => {
  it('electronic attendance counts identically to in person; absent never counts', () => {
    const mixed: AttendanceRecord[] = [
      { uid: 'a', mode: 'in_person' },
      { uid: 'b', mode: 'electronic' },
      { uid: 'c', mode: 'absent' },
    ];
    expect(computePresent(mixed)).toBe(2);
    expect(computePresentUids(mixed)).toEqual(['a', 'b']);
    expect(isPresent(mixed[1])).toBe(true);
    expect(isPresent(mixed[2])).toBe(false);
  });

  it('a member who has left (leftAt set) is not present; a stored isPresent flag wins over derivation', () => {
    expect(isPresent({ uid: 'a', mode: 'in_person', leftAt: '2026-11-20T11:00:00Z' })).toBe(false);
    expect(isPresent({ uid: 'a', mode: 'electronic', leftAt: null })).toBe(true);
    expect(isPresent({ uid: 'a', mode: 'absent', isPresent: true })).toBe(true);
    expect(isPresent({ uid: 'a', mode: 'in_person', isPresent: false })).toBe(false);
  });

  it('Founder presence requires the Founder to actually be present', () => {
    expect(isFounderPresent(present(3, { founderUid: 'u1' }))).toBe(true);
    expect(isFounderPresent(present(3))).toBe(false);
    expect(isFounderPresent([{ uid: 'u1', mode: 'absent', isFounder: true }])).toBe(false);
  });
});

describe('Board ordinary quorum is 5', () => {
  it('4 present fails, 5 present passes', () => {
    const four = evaluateQuorum(board(), present(4));
    expect(four).toMatchObject({ met: false, presentCount: 4, required: 5, founderRequired: false });
    const five = evaluateQuorum(board(), present(5));
    expect(five).toMatchObject({ met: true, presentCount: 5, required: BOARD_ORDINARY_QUORUM });
  });

  it('3 in person + 2 electronic meets Board quorum 5 exactly like 5 in person', () => {
    const attendance = [...present(3), ...NINE.slice(3, 5).map((uid) => ({ uid, mode: 'electronic' as const }))];
    expect(evaluateQuorum(board(), attendance).met).toBe(true);
    expect(evaluateQuorum(board(), present(5, { mode: 'electronic' })).met).toBe(true);
  });

  it('stored quorumRequired wins, then quorumOverride, for non-Board bodies ceil(members/2)', () => {
    expect(evaluateQuorum(board({ quorumRequired: 6 }), present(5)).met).toBe(false);
    expect(evaluateQuorum(board({ quorumOverride: 4 }), present(4)).met).toBe(true);
    const nec = evaluateQuorum({ memberUids: NINE.slice(0, 7), bodyType: 'nec' }, present(3));
    expect(nec.required).toBe(4);
    expect(nec.met).toBe(false);
    expect(evaluateQuorum({ memberUids: NINE.slice(0, 7), bodyType: 'nec' }, present(4)).met).toBe(true);
  });

  it('verifyQuorum mirrors met, and a motion opens only on verified AND still-met quorum', () => {
    const ok = verifyQuorum(board(), present(5));
    expect(ok.verified).toBe(true);
    expect(canOpenMotion({ quorumVerified: true, quorum: ok })).toBe(true);
    // Stale verification + quorum since lost does not open.
    const lost = evaluateQuorum(board(), present(2));
    expect(canOpenMotion({ quorumVerified: true, quorum: lost })).toBe(false);
    expect(canOpenMotion({ quorumVerified: false, quorum: ok })).toBe(false);
  });
});

describe('Board adjourned quorum is 3 AND requires the Founder', () => {
  const adjourned = () => board({ isAdjournedSitting: true });

  it('3 present including the Founder passes', () => {
    const r = evaluateQuorum(adjourned(), present(3, { founderUid: 'u2' }));
    expect(r).toMatchObject({ met: true, presentCount: 3, required: BOARD_ADJOURNED_QUORUM, founderRequired: true, founderConditionMet: true });
  });

  it('3 present without the Founder fails, and 4 without the Founder also fails', () => {
    expect(evaluateQuorum(adjourned(), present(3)).met).toBe(false);
    expect(evaluateQuorum(adjourned(), present(4)).met).toBe(false);
    expect(evaluateQuorum(adjourned(), present(4)).founderConditionMet).toBe(false);
  });

  it('2 present even with the Founder fails on count', () => {
    expect(evaluateQuorum(adjourned(), present(2, { founderUid: 'u1' })).met).toBe(false);
  });

  it('an explicit body-level founderPresent flag is honoured over attendance derivation', () => {
    const r = evaluateQuorum(board({ isAdjournedSitting: true, founderPresent: true }), present(3));
    expect(r.met).toBe(true);
    expect(r.founderPresent).toBe(true);
  });

  it('the adjourned rule is Board-only: an adjourned NEC sitting needs no Founder', () => {
    const r = evaluateQuorum({ memberUids: NINE, bodyType: 'nec', isAdjournedSitting: true, quorumRequired: 3 }, present(3));
    expect(r.met).toBe(true);
    expect(r.founderRequired).toBe(false);
  });
});

describe('denominator snapshot is frozen at motion open', () => {
  it('snapshots eligible + present uids and the whole-body count', () => {
    const snap = snapshotDenominator(board(), present(6));
    expect(snap.eligibleUids).toEqual(NINE);
    expect(snap.presentUids).toEqual(NINE.slice(0, 6));
    expect(snap.presentCount).toBe(6);
    expect(snap.wholeBodyCount).toBe(9);
  });

  it('later joins and leaves do not change the snapshot, and caller mutation cannot reach it', () => {
    const bodyCfg = board();
    const atOpen = present(5);
    const snap = snapshotDenominator(bodyCfg, atOpen);
    const frozen = JSON.parse(JSON.stringify(snap)) as DenominatorSnapshot;

    // After open: two more join, one of the original five leaves.
    const later = [...present(7), { uid: 'u1', mode: 'absent' as const }];
    expect(computePresent(later)).toBe(7);
    // Mutate the very arrays the snapshot was taken from.
    bodyCfg.memberUids.push('late-joiner');
    atOpen.push({ uid: 'late-joiner', mode: 'in_person' });

    expect(snap).toEqual(frozen);
    expect(snap.wholeBodyCount).toBe(9);
    expect(snap.presentCount).toBe(5);
  });

  it('a paused motion resumes with its original snapshot (the snapshot is never retaken)', () => {
    const snap = snapshotDenominator(board(), present(5));
    const lost = evaluateQuorum(board(), present(2));
    const [effect] = applyQuorumToMotions([{ motionId: 'm1', status: 'open' }], lost);
    expect(effect.resultingStatus).toBe('paused_quorum_lost');
    const regained = evaluateQuorum(board(), present(8)); // MORE present than at open
    const [resume] = applyQuorumToMotions([{ motionId: 'm1', status: 'paused_quorum_lost' }], regained);
    expect(resume).toMatchObject({ resultingStatus: 'open', action: 'resume' });
    // Resume reuses the open-time snapshot: denominators are unchanged.
    expect(snap.presentCount).toBe(5);
    expect(snap.wholeBodyCount).toBe(9);
  });
});

describe('quorum dropping mid-meeting', () => {
  const motions = [
    { motionId: 'open-1', status: 'open' as const },
    { motionId: 'passed-1', status: 'closed_passed' as const },
    { motionId: 'failed-1', status: 'closed_failed' as const },
    { motionId: 'tied-1', status: 'closed_tied_pending_casting' as const },
    { motionId: 'wd-1', status: 'withdrawn' as const },
  ];

  it('pauses open motions and leaves every closed motion standing', () => {
    const lost = evaluateQuorum(board(), present(2));
    const effects = applyQuorumToMotions(motions, lost);
    const byId = Object.fromEntries(effects.map((e) => [e.motionId, e]));
    expect(byId['open-1']).toMatchObject({ previousStatus: 'open', resultingStatus: 'paused_quorum_lost', action: 'pause' });
    for (const id of ['passed-1', 'failed-1', 'tied-1', 'wd-1']) {
      expect(byId[id].action).toBe('none');
      expect(byId[id].resultingStatus).toBe(byId[id].previousStatus);
    }
    // Report only: the input motions are not mutated.
    expect(motions[0].status).toBe('open');
  });

  it('with quorum met, open motions stay open and paused motions resume', () => {
    const met = evaluateQuorum(board(), present(5));
    const effects = applyQuorumToMotions(
      [{ motionId: 'a', status: 'open' }, { motionId: 'b', status: 'paused_quorum_lost' }],
      met,
    );
    expect(effects[0]).toMatchObject({ resultingStatus: 'open', action: 'none' });
    expect(effects[1]).toMatchObject({ resultingStatus: 'open', action: 'resume' });
  });
});

describe('quorum adapter (fallback behind the lifecycle slice)', () => {
  afterEach(() => adapter.registerQuorumEngine(null));

  it('fallback: Board ordinary uses the stored quorumRequired; adjourned Board needs 3 + Founder', () => {
    const att = (n: number, founder = false) =>
      Array.from({ length: n }, (_, i) => ({ uid: `u${i + 1}`, isPresent: true, isFounder: founder && i === 0 }));
    expect(adapter.evaluateQuorum({ bodyType: 'board', quorumRequired: 5, isAdjournedSitting: false, attendance: att(4) }).met).toBe(false);
    expect(adapter.evaluateQuorum({ bodyType: 'board', quorumRequired: 5, isAdjournedSitting: false, attendance: att(5) }).met).toBe(true);
    expect(adapter.evaluateQuorum({ bodyType: 'board', quorumRequired: 5, isAdjournedSitting: true, attendance: att(3, true) }).met).toBe(true);
    expect(adapter.evaluateQuorum({ bodyType: 'board', quorumRequired: 5, isAdjournedSitting: true, attendance: att(4) }).met).toBe(false);
    expect(adapter.computePresent([{ uid: 'x', isPresent: true }, { uid: 'y', isPresent: false }])).toBe(1);
  });

  it('a registered engine replaces the fallback and unregistering restores it', () => {
    expect(adapter.hasRegisteredQuorumEngine()).toBe(false);
    adapter.registerQuorumEngine(() => ({ met: true, presentCount: 99, required: 1, founderPresent: true, founderConditionMet: true }));
    expect(adapter.hasRegisteredQuorumEngine()).toBe(true);
    expect(adapter.evaluateQuorum({ bodyType: 'nec', quorumRequired: 4, isAdjournedSitting: false, attendance: [] }).presentCount).toBe(99);
    adapter.registerQuorumEngine(null);
    expect(adapter.hasRegisteredQuorumEngine()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG: threshold evaluation is missing from the committed engine.
// The tests below follow meetings_core_interfaces.md section 4 (object-arg
// signature) and ws-a section 6.2 semantics. They fail with an explicit
// BUG message until evaluateThreshold / needsCastingVote /
// requiredCountForFraction / majorityOfAll are implemented in
// quorum-engine.ts. Do not delete them when fixing; they become the
// regression suite for the fix.
// ---------------------------------------------------------------------------

type EvaluateThresholdFn = (input: {
  threshold: MotionThreshold;
  snapshot: DenominatorSnapshot;
  tallies: { votesFor: number; votesAgainst: number; abstentions: number };
  bodyType: string;
  castingChoice?: 'for' | 'against' | 'abstain' | null;
}) => {
  outcome: string; thresholdMet: boolean; votesFor: number; votesAgainst: number;
  abstentions: number; denominatorUsed: number; requiredCount: number | null;
  castingVoteUsed: boolean; castingChoice: string | null;
};

function thresholdFn(): EvaluateThresholdFn {
  const fn = (engine as unknown as Record<string, unknown>).evaluateThreshold;
  if (typeof fn !== 'function') {
    throw new Error(
      'BUG quorum-engine.ts: evaluateThreshold is not exported, although types.ts ' +
      'defines MotionThreshold/ThresholdEvaluation and ws-a 6.2 + interfaces sec 4 name it. ' +
      'Ordinary / fraction / casting threshold evaluation cannot be performed at all.',
    );
  }
  return fn as EvaluateThresholdFn;
}

const snap9of5: DenominatorSnapshot = {
  eligibleUids: [...NINE], presentUids: NINE.slice(0, 5), presentCount: 5, wholeBodyCount: 9,
};
const ordinary: MotionThreshold = {
  majorityType: 'ordinary_present_and_voting', numerator: null, denominatorKind: 'present_and_voting',
  requiredCount: null, consentRequired: false, isReservedMatter: false, filingFlag: false,
};
const twoThirdsOfGovernors: MotionThreshold = {
  majorityType: 'fraction_of_all_governors', numerator: 2, denominator: 3, denominatorKind: 'all_governors',
  requiredCount: 6, consentRequired: false, isReservedMatter: false, filingFlag: false,
};

describe('threshold evaluation (MISSING - known bug)', () => {
  it('BUG: evaluateThreshold / needsCastingVote / requiredCountForFraction / majorityOfAll are exported', () => {
    const eng = engine as unknown as Record<string, unknown>;
    expect(typeof eng.evaluateThreshold).toBe('function');
    expect(typeof eng.needsCastingVote).toBe('function');
    expect(typeof eng.requiredCountForFraction).toBe('function');
    expect(typeof eng.majorityOfAll).toBe('function');
  });

  it('ordinary majority: for > against among present-and-voting passes (4-3-2, abstentions never compared)', () => {
    const r = thresholdFn()({
      threshold: ordinary, snapshot: snap9of5, bodyType: 'board',
      tallies: { votesFor: 4, votesAgainst: 3, abstentions: 2 },
    });
    expect(r.outcome).toBe('passed');
    expect(r.thresholdMet).toBe(true);
    expect(r.denominatorUsed).toBe(7); // for + against only
    expect(r.abstentions).toBe(2);
    const lost = thresholdFn()({
      threshold: ordinary, snapshot: snap9of5, bodyType: 'board',
      tallies: { votesFor: 2, votesAgainst: 3, abstentions: 4 },
    });
    expect(lost.outcome).toBe('failed');
  });

  it('supermajority is a fraction of the WHOLE snapshot: 2/3 of 9 needs 6 regardless of who is present', () => {
    // Present-and-voting is unanimous (5-0) but 5 < 6 of the whole body: fails.
    const five = thresholdFn()({
      threshold: twoThirdsOfGovernors, snapshot: snap9of5, bodyType: 'board',
      tallies: { votesFor: 5, votesAgainst: 0, abstentions: 0 },
    });
    expect(five.outcome).toBe('failed');
    expect(five.requiredCount).toBe(6);
    expect(five.denominatorUsed).toBe(9);
    const six = thresholdFn()({
      threshold: twoThirdsOfGovernors, snapshot: snap9of5, bodyType: 'board',
      tallies: { votesFor: 6, votesAgainst: 1, abstentions: 0 },
    });
    expect(six.outcome).toBe('passed');
    // Fraction helpers named in interfaces sec 4.
    const eng = engine as unknown as Record<string, (a: number, b: number, c: number) => number>;
    expect(typeof eng.requiredCountForFraction).toBe('function');
    expect(eng.requiredCountForFraction(2, 3, 9)).toBe(6);
    expect(eng.requiredCountForFraction(3, 4, 9)).toBe(7);
    expect((engine as unknown as Record<string, (n: number) => number>).majorityOfAll(9)).toBe(5);
  });

  it('a Board tie opens exactly one Founder casting ballot, recorded separately from the tallies', () => {
    expect(CASTING_VOTE_BODY_TYPES).toEqual(['board', 'council']);
    const tallies = { votesFor: 3, votesAgainst: 3, abstentions: 1 };
    const tied = thresholdFn()({ threshold: ordinary, snapshot: snap9of5, bodyType: 'board', tallies });
    expect(tied.outcome).toBe('tie_pending_casting');
    expect(tied.castingVoteUsed).toBe(false);
    const needs = (engine as unknown as Record<string, (r: { outcome: string }) => boolean>).needsCastingVote;
    expect(typeof needs).toBe('function');
    expect(needs(tied)).toBe(true);
    expect(needs({ outcome: 'passed' })).toBe(false);

    // Casting FOR decides the motion; the casting ballot never merges into votesFor.
    const castFor = thresholdFn()({ threshold: ordinary, snapshot: snap9of5, bodyType: 'board', tallies, castingChoice: 'for' });
    expect(castFor.outcome).toBe('passed');
    expect(castFor.castingVoteUsed).toBe(true);
    expect(castFor.castingChoice).toBe('for');
    expect(castFor.votesFor).toBe(3);
    expect(castFor.votesAgainst).toBe(3);

    const castAgainst = thresholdFn()({ threshold: ordinary, snapshot: snap9of5, bodyType: 'board', tallies, castingChoice: 'against' });
    expect(castAgainst.outcome).toBe('failed');
    expect(castAgainst.votesFor).toBe(3);

    const castAbstain = thresholdFn()({ threshold: ordinary, snapshot: snap9of5, bodyType: 'board', tallies, castingChoice: 'abstain' });
    expect(castAbstain.outcome).toBe('failed');
    expect(castAbstain.castingVoteUsed).toBe(true);
  });

  it('a Council tie also opens a casting ballot; a tie at any other body type simply fails', () => {
    const tallies = { votesFor: 2, votesAgainst: 2, abstentions: 0 };
    expect(thresholdFn()({ threshold: ordinary, snapshot: snap9of5, bodyType: 'council', tallies }).outcome)
      .toBe('tie_pending_casting');
    expect(thresholdFn()({ threshold: ordinary, snapshot: snap9of5, bodyType: 'nec', tallies }).outcome)
      .toBe('failed');
  });

  it('no casting vote exists on fraction types: a shortfall is failed, never tied', () => {
    const r = thresholdFn()({
      threshold: twoThirdsOfGovernors, snapshot: snap9of5, bodyType: 'board',
      tallies: { votesFor: 3, votesAgainst: 3, abstentions: 0 }, castingChoice: 'for',
    });
    expect(r.outcome).toBe('failed');
    expect(r.castingVoteUsed).toBe(false);
  });
});
