/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT TESTS - cluster: MEETINGS + DECISIONS + MOTIONS.
 * Area 1 (pure layer): quorum-engine + quorum-adapter boundary arithmetic.
 * Fills gaps NOT covered by quorum-engine.test.ts: empty electorates,
 * fraction helper edge inputs, fraction-vs-strict-majority on even bodies,
 * plurality / single_person branches, copied-requiredCount precedence,
 * adapter fallback for non-Board bodies with no stored requirement.
 * CODE vs PACK: pack item 31 makes the member role the canonical Full
 * Member definition; the engine is electorate-agnostic (memberUids
 * snapshots only, never roles). No disagreement at this layer.
 */
import {
  evaluateQuorum,
  evaluateThreshold,
  majorityOfAll,
  requiredCountForFraction,
  resolveQuorumRequired,
} from '../quorum-engine';
import type {
  AttendanceRecord,
  BodyConfigView,
  DenominatorSnapshot,
  MotionThreshold,
} from '../types';
import { evaluateQuorum as adapterEvaluate } from '../quorum-adapter';

const body = (over: Partial<BodyConfigView> = {}): BodyConfigView => ({
  memberUids: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'],
  bodyType: 'nec',
  ...over,
});

const snapshot = (whole: number): DenominatorSnapshot => ({
  eligibleUids: Array.from({ length: whole }, (_, i) => `u${i + 1}`),
  presentUids: [],
  presentCount: 0,
  wholeBodyCount: whole,
});

const threshold = (over: Partial<MotionThreshold> = {}): MotionThreshold => ({
  majorityType: 'ordinary_present_and_voting',
  numerator: null,
  denominatorKind: 'present_and_voting',
  requiredCount: null,
  consentRequired: false,
  isReservedMatter: false,
  filingFlag: false,
  ...over,
});

describe('empty electorate (boundary the migration must reproduce)', () => {
  it('non-Board body with zero members resolves quorumRequired 0 and 0 present is MET', () => {
    const b = body({ memberUids: [] });
    expect(resolveQuorumRequired(b)).toBe(0);
    const ev = evaluateQuorum(b, []);
    expect(ev.required).toBe(0);
    expect(ev.presentCount).toBe(0);
    expect(ev.met).toBe(true);
  });

  it('Board with zero members and no stored quorum still defaults to 5, so empty Board is NOT quorate', () => {
    const b = body({ memberUids: [], bodyType: 'board' });
    expect(resolveQuorumRequired(b)).toBe(5);
    expect(evaluateQuorum(b, []).met).toBe(false);
  });

  it('non-Board stored quorumRequired: exactly at count passes; one below fails', () => {
    const mk = (n: number): AttendanceRecord[] =>
      Array.from({ length: n }, (_, i) => ({ uid: `u${i + 1}`, mode: 'in_person' as const, isPresent: true }));
    const b = body({ quorumRequired: 4 });
    expect(evaluateQuorum(b, mk(4)).met).toBe(true);
    expect(evaluateQuorum(b, mk(3)).met).toBe(false);
  });
});

describe('requiredCountForFraction / majorityOfAll exact arithmetic', () => {
  it('ceil division: 1/2 of 8 via the fraction path is 4 (NOT the strict-majority 5)', () => {
    expect(requiredCountForFraction(1, 2, 8)).toBe(4);
    expect(majorityOfAll(8)).toBe(5);
  });

  it('majorityOfAll table: 0->1, 1->1, 2->2, 8->5, 9->5', () => {
    expect(majorityOfAll(0)).toBe(1);
    expect(majorityOfAll(1)).toBe(1);
    expect(majorityOfAll(2)).toBe(2);
    expect(majorityOfAll(8)).toBe(5);
    expect(majorityOfAll(9)).toBe(5);
  });

  it('degenerate inputs as coded: denominator <= 0 returns wholeBodyCount; whole <= 0 returns 0', () => {
    expect(requiredCountForFraction(2, 0, 9)).toBe(9);
    expect(requiredCountForFraction(2, -3, 9)).toBe(9);
    expect(requiredCountForFraction(2, 3, 0)).toBe(0);
  });

  it('exact hits: 2/3 of 9 = 6, 3/4 of 8 = 6, 2/3 of 7 = 5', () => {
    expect(requiredCountForFraction(2, 3, 9)).toBe(6);
    expect(requiredCountForFraction(3, 4, 8)).toBe(6);
    expect(requiredCountForFraction(2, 3, 7)).toBe(5);
  });
});

describe('evaluateThreshold branches not covered by quorum-engine.test.ts', () => {
  it('plurality: for > against passes, tie fails, no casting vote ever', () => {
    const t = threshold({ majorityType: 'plurality' });
    const pass = evaluateThreshold({ threshold: t, snapshot: snapshot(9), tallies: { votesFor: 3, votesAgainst: 2, abstentions: 4 }, bodyType: 'board' });
    expect(pass.outcome).toBe('passed');
    const tie = evaluateThreshold({ threshold: t, snapshot: snapshot(9), tallies: { votesFor: 2, votesAgainst: 2, abstentions: 0 }, bodyType: 'board', castingChoice: 'for' });
    expect(tie.outcome).toBe('failed');
    expect(tie.castingVoteUsed).toBe(false);
  });

  it('single_person: denominator is 1; one for-vote passes even with more against, zero fails', () => {
    const t = threshold({ majorityType: 'single_person' });
    const pass = evaluateThreshold({ threshold: t, snapshot: snapshot(9), tallies: { votesFor: 1, votesAgainst: 5, abstentions: 0 }, bodyType: 'nec' });
    expect(pass.outcome).toBe('passed');
    expect(pass.denominatorUsed).toBe(1);
    expect(pass.requiredCount).toBe(1);
    const fail = evaluateThreshold({ threshold: t, snapshot: snapshot(9), tallies: { votesFor: 0, votesAgainst: 0, abstentions: 3 }, bodyType: 'nec' });
    expect(fail.outcome).toBe('failed');
  });

  it('fraction type: a COPIED requiredCount on the motion wins over recomputation', () => {
    const t = threshold({ majorityType: 'fraction_of_all_governors', numerator: 2, denominator: 3, denominatorKind: 'all_governors', requiredCount: 4 });
    const ev = evaluateThreshold({ threshold: t, snapshot: snapshot(9), tallies: { votesFor: 4, votesAgainst: 0, abstentions: 0 }, bodyType: 'board' });
    expect(ev.requiredCount).toBe(4);
    expect(ev.outcome).toBe('passed');
    expect(ev.denominatorUsed).toBe(9);
  });

  it('fraction type with neither copied count nor numerator can never pass', () => {
    const t = threshold({ majorityType: 'fraction_of_all_full_members', numerator: null, denominatorKind: 'all_full_members', requiredCount: null });
    const ev = evaluateThreshold({ threshold: t, snapshot: snapshot(9), tallies: { votesFor: 9, votesAgainst: 0, abstentions: 0 }, bodyType: 'general_body' });
    expect(ev.requiredCount).toBeNull();
    expect(ev.outcome).toBe('failed');
  });

  it('ordinary 0-0 (only abstentions) fails even at Board - no casting ballot', () => {
    const ev = evaluateThreshold({ threshold: threshold(), snapshot: snapshot(9), tallies: { votesFor: 0, votesAgainst: 0, abstentions: 5 }, bodyType: 'board' });
    expect(ev.outcome).toBe('failed');
    expect(ev.denominatorUsed).toBe(0);
  });
});

describe('quorum-adapter fallback boundaries', () => {
  it('non-Board with no usable stored requirement: any attendance is quorate', () => {
    const ev = adapterEvaluate({ bodyType: 'nec', quorumRequired: 0, isAdjournedSitting: false, attendance: [{ uid: 'u1', isPresent: true }] });
    expect(ev.presentCount).toBe(1);
    expect(ev.met).toBe(true);
  });

  it('exactly at threshold via the adapter passes; one below fails', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, isPresent: true }));
    expect(adapterEvaluate({ bodyType: 'council', quorumRequired: 4, isAdjournedSitting: false, attendance: mk(4) }).met).toBe(true);
    expect(adapterEvaluate({ bodyType: 'council', quorumRequired: 4, isAdjournedSitting: false, attendance: mk(3) }).met).toBe(false);
  });
});
