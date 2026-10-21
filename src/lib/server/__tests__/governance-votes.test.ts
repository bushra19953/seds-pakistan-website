/**
 * @jest-environment node
 *
 * Tests for governance votes (spec Section 0.2): exact-fraction tally,
 * frozen electorate snapshots, one ballot per voter, idempotent close.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

import { createFakeDb, type FakeDb } from './fake-firestore';
import {
  castVote,
  closeVote,
  getCertifiedResult,
  openVote,
  resolveThreshold,
  tallyBallots,
  type ElectorateSeat,
} from '@/lib/server/governance-votes';

function seats(n: number): ElectorateSeat[] {
  return Array.from({ length: n }, (_, i) => ({
    seatKey: `seat-${i + 1}`,
    roleKey: 'governor',
    uid: `gov-${i + 1}`,
    vacant: false,
  }));
}

function ballots(forCount: number, against = 0, abstain = 0) {
  return [
    ...Array.from({ length: forCount }, () => ({ choice: 'for' as const })),
    ...Array.from({ length: against }, () => ({ choice: 'against' as const })),
    ...Array.from({ length: abstain }, () => ({ choice: 'abstain' as const })),
  ];
}

describe('tallyBallots exact fraction math', () => {
  it('ratification refusal needs 2/3 of all seated: 5 of 9 fails, 6 of 9 passes', () => {
    const config = { ...resolveThreshold('ratification_refusal', 9), electorateSize: 9 };
    expect(tallyBallots(ballots(5, 4), config).passed).toBe(false);
    expect(tallyBallots(ballots(6, 3), config).passed).toBe(true);
  });

  it('co-option needs strict majority of seated at open: floor(9/2)+1 = 5', () => {
    const config = { ...resolveThreshold('cooption', 9), electorateSize: 9 };
    expect(config.threshold).toEqual({ numerator: 5, denominator: 9 });
    expect(tallyBallots(ballots(4, 0), config).passed).toBe(false);
    expect(tallyBallots(ballots(5, 0), config).passed).toBe(true);
  });

  it('strike 3: strict majority of present and voting; a tie fails', () => {
    const config = { ...resolveThreshold('strike3_expulsion', 9), electorateSize: 9 };
    expect(tallyBallots(ballots(3, 3), config).passed).toBe(false);
    expect(tallyBallots(ballots(4, 3), config).passed).toBe(true);
  });

  it('strike 3: quorum 5 participating; abstains count toward quorum but not votes cast', () => {
    const config = { ...resolveThreshold('strike3_expulsion', 9), electorateSize: 9 };
    const short = tallyBallots(ballots(2, 1, 1), config); // 4 participating
    expect(short.quorumMet).toBe(false);
    expect(short.passed).toBe(false);
    const withAbstains = tallyBallots(ballots(2, 1, 2), config); // 5 participating
    expect(withAbstains.quorumMet).toBe(true);
    expect(withAbstains.passed).toBe(true); // 2 > 1
  });

  it('chapter expel needs 2/3 of all seats', () => {
    const config = { ...resolveThreshold('chapter_expel', 6), electorateSize: 6 };
    expect(tallyBallots(ballots(3, 0), config).passed).toBe(false);
    expect(tallyBallots(ballots(4, 0), config).passed).toBe(true);
  });
});

describe('openVote / castVote / closeVote against the fake', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = createFakeDb();
  });

  it('freezes the electorate snapshot at open', async () => {
    const electorate = seats(3);
    const voteId = await openVote(db as any, {
      subjectType: 'board_generic',
      electorate,
      createdByUid: 'founder-uid',
    });
    electorate.push({ seatKey: 'seat-4', roleKey: 'governor', uid: 'gov-4', vacant: false });
    electorate[0].uid = 'someone-else';
    const stored: any = db.read('governance_votes', voteId);
    expect(stored.electorate).toHaveLength(3);
    expect(stored.electorate[0].uid).toBe('gov-1');
  });

  it('castVote rejects voters outside the frozen electorate and vacant seats', async () => {
    const electorate = seats(2);
    electorate[1].vacant = true;
    electorate[1].uid = null;
    const voteId = await openVote(db as any, {
      subjectType: 'board_generic',
      electorate,
      createdByUid: 'founder-uid',
    });
    await expect(castVote(db as any, voteId, 'outsider', 'for')).rejects.toMatchObject({
      code: 'VOTER_NOT_IN_ELECTORATE',
    });
    await expect(castVote(db as any, voteId, 'gov-2', 'for')).rejects.toMatchObject({
      code: 'VOTER_NOT_IN_ELECTORATE',
    });
    await castVote(db as any, voteId, 'gov-1', 'for');
    expect(db.all(`governance_votes/${voteId}/ballots`)).toHaveLength(1);
  });

  it('closeVote is idempotent and the result is written once', async () => {
    const voteId = await openVote(db as any, {
      subjectType: 'ratification_refusal',
      electorate: seats(9),
      createdByUid: 'founder-uid',
    });
    for (let i = 1; i <= 6; i += 1) {
      await castVote(db as any, voteId, `gov-${i}`, 'for');
    }
    for (let i = 7; i <= 9; i += 1) {
      await castVote(db as any, voteId, `gov-${i}`, 'against');
    }
    const first = await closeVote(db as any, voteId, 'founder-uid');
    expect(first.passed).toBe(true);
    expect(first.votesFor).toBe(6);
    const second = await closeVote(db as any, voteId, 'founder-uid');
    expect(second).toEqual(first);
    const certified = await getCertifiedResult(db as any, voteId);
    expect(certified).toEqual(first);
    const closedAudits = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'governance_vote_closed');
    expect(closedAudits).toHaveLength(1);
    // A closed vote accepts no further ballots.
    await expect(castVote(db as any, voteId, 'gov-1', 'against')).rejects.toMatchObject({
      code: 'VOTE_NOT_OPEN',
    });
  });

  it('offline_attested records carry the attested shape and status recorded', async () => {
    const voteId = await openVote(db as any, {
      subjectType: 'ratification_approval',
      mode: 'offline_attested',
      electorate: seats(9),
      createdByUid: 'ngs-uid',
      deciders: ['gov-1', 'gov-2', 'gov-3', 'gov-4', 'gov-5'],
      attestedBy: 'ngs-uid',
      meetingRef: 'Board meeting 2026-10-15',
    });
    const stored: any = db.read('governance_votes', voteId);
    expect(stored.status).toBe('recorded');
    expect(stored.mode).toBe('offline_attested');
    expect(stored.deciders).toHaveLength(5);
    expect(stored.attestedBy).toBe('ngs-uid');
    expect(stored.meetingRef).toBe('Board meeting 2026-10-15');
    await expect(castVote(db as any, voteId, 'gov-1', 'for')).rejects.toMatchObject({
      code: 'VOTE_NOT_OPEN',
    });
  });
});
