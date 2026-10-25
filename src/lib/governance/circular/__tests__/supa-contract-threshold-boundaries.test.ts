/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT TESTS - cluster: MEETINGS + DECISIONS + MOTIONS.
 * Area 4 (pure layer): circular/threshold.ts + circular/engine.ts boundaries.
 * Fills gaps NOT covered by circular/__tests__/engine.test.ts (which pins
 * the 9-Governor strict-majority and 2/3 cases): EVEN electorates where
 * strict majority differs from ceil(n/2), the numerator->denominator map,
 * zero-size snapshots, and snapshotThreshold with unknown whole count.
 */
import {
  computeRequiredCount,
  fractionDenominatorFor,
  majorityNeeded,
  snapshotThreshold,
} from '../threshold';
import { effectiveRequiredCount } from '../engine';
import type { CircularResolution, DecisionClassView } from '../types';

const cls = (over: Partial<DecisionClassView> = {}): DecisionClassView => ({
  id: 'class_board_ordinary',
  label: 'Board ordinary business (circular)',
  assignedBodyType: 'board',
  majorityType: 'fraction_of_all_governors',
  numerator: 1,
  denominatorKind: 'all_governors',
  consentRequired: true,
  isReservedMatter: false,
  filingFlag: false,
  sourceRow: '5.18',
  ...over,
});

describe('strict majority of ALL on EVEN electorates (the ceil trap)', () => {
  it('majorityNeeded: 8 -> 5, 6 -> 4, 2 -> 2, 1 -> 1, 0 -> 1 (floor(n/2)+1 as coded)', () => {
    expect(majorityNeeded(8)).toBe(5);
    expect(majorityNeeded(6)).toBe(4);
    expect(majorityNeeded(2)).toBe(2);
    expect(majorityNeeded(1)).toBe(1);
    expect(majorityNeeded(0)).toBe(1);
  });

  it('computeRequiredCount for the 1/2 class is strict: 4 of 8 does NOT reach it, 5 does', () => {
    expect(computeRequiredCount('fraction_of_all_governors', 1, 8)).toBe(5);
    expect(computeRequiredCount('fraction_of_all_governors', 1, 9)).toBe(5);
  });

  it('2/3 and 3/4 use integer ceil: 2/3 of 8 = 6, 3/4 of 8 = 6, 3/4 of 10 = 8', () => {
    expect(computeRequiredCount('fraction_of_all_governors', 2, 8)).toBe(6);
    expect(computeRequiredCount('fraction_of_all_representatives', 3, 8)).toBe(6);
    expect(computeRequiredCount('fraction_of_all_representatives', 3, 10)).toBe(8);
  });

  it('non-fraction types and null numerator yield null (no fixed count)', () => {
    expect(computeRequiredCount('ordinary_present_and_voting', null, 9)).toBeNull();
    expect(computeRequiredCount('fraction_of_all_governors', null, 9)).toBeNull();
    expect(computeRequiredCount('plurality', 1, 9)).toBeNull();
  });
});

describe('fractionDenominatorFor mapping as coded', () => {
  it('numerator 1 -> 2, 2 -> 3, 3 -> 4 on fraction types only', () => {
    expect(fractionDenominatorFor('fraction_of_all_governors', 1)).toBe(2);
    expect(fractionDenominatorFor('fraction_of_all_governors', 2)).toBe(3);
    expect(fractionDenominatorFor('fraction_of_all_representatives', 3)).toBe(4);
    expect(fractionDenominatorFor('ordinary_present_and_voting', 1)).toBeNull();
    expect(fractionDenominatorFor('fraction_of_all_governors', null)).toBeNull();
  });
});

describe('snapshotThreshold copy semantics', () => {
  it('wholeBodyCount 0 (pre-circulation copy) leaves requiredCount null but freezes the fraction', () => {
    const t = snapshotThreshold(cls(), 0);
    expect(t.requiredCount).toBeNull();
    expect(t.numerator).toBe(1);
    expect(t.denominator).toBe(2);
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('with a known whole count the copy carries the strict-majority count for even bodies', () => {
    const t = snapshotThreshold(cls(), 8);
    expect(t.requiredCount).toBe(5);
  });
});

describe('effectiveRequiredCount against the circulation snapshot', () => {
  const res = (over: Partial<CircularResolution> = {}): CircularResolution => ({
    id: 'circ_1',
    bodyId: 'board_body',
    bodyType: 'board',
    title: 'T',
    text: 'Text',
    decisionClassId: 'class_board_ordinary',
    consentId: 'consent_1',
    status: 'circulating',
    threshold: snapshotThreshold(cls(), 0) as CircularResolution['threshold'],
    circulatedAt: new Date('2026-10-21T10:00:00Z'),
    closesAt: new Date('2026-10-28T10:00:00Z'),
    createdBy: 'g1',
    createdAt: new Date('2026-10-21T09:00:00Z'),
    updatedAt: new Date('2026-10-21T10:00:00Z'),
    governorUidsSnapshot: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'],
    signatures: [],
    votes: [],
    signedCount: 0,
    decisionId: null,
    filingTaskId: null,
    ...over,
  });

  it('empty snapshot yields null (no count can be derived)', () => {
    expect(effectiveRequiredCount(res({ governorUidsSnapshot: [] }))).toBeNull();
  });

  it('derives 5 from the COPIED 1/2 fraction against an 8-Governor snapshot', () => {
    expect(effectiveRequiredCount(res())).toBe(5);
  });

  it('ordinary present-and-voting classes have no fixed count even with a snapshot', () => {
    const r = res({
      threshold: snapshotThreshold(cls({ majorityType: 'ordinary_present_and_voting', numerator: null, denominatorKind: 'present_and_voting' }), 0) as CircularResolution['threshold'],
    });
    expect(effectiveRequiredCount(r)).toBeNull();
  });
});
