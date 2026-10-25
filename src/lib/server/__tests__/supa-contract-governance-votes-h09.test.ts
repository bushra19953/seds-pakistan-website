/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT TESTS - cluster: MEETINGS + DECISIONS + MOTIONS.
 * Area 6 (service layer): governance votes family
 * (src/lib/server/governance-votes.ts), gaps NOT pinned by
 * src/lib/server/__tests__/governance-votes.test.ts.
 *
 * H-09: behavior pinned faithfully for migration; the missing gate is a
 * known hole, NOT a spec.
 * (FOUNDER_ACCESS_MAP_2026-10-25 H-09: the family has no permission gate;
 * openVote trusts a body-supplied electorate from ANY caller, and
 * closeVote performs NO actor check at all.)
 */
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

import { createFakeDb, type FakeDb } from './fake-firestore';
import {
  castVote,
  closeVote,
  getCertifiedResult,
  getVote,
  openVote,
  resolveThreshold,
  tallyBallots,
  VoteError,
  type ElectorateSeat,
} from '@/lib/server/governance-votes';

function seats(n: number, prefix = 'gov'): ElectorateSeat[] {
  return Array.from({ length: n }, (_, i) => ({
    seatKey: `seat-${i + 1}`, roleKey: 'governor', uid: `${prefix}-${i + 1}`, vacant: false,
  }));
}

let db: FakeDb;
beforeEach(() => { db = createFakeDb(); });

describe('H-09: openVote trusts ANY caller and ANY body-supplied electorate', () => {
  it('a creator who is NOT in the electorate can open a vote over other people', async () => {
    const id = await openVote(db as never, {
      subjectType: 'board_generic', electorate: seats(3), createdByUid: 'random_member',
    });
    const vote = await getVote(db as never, id);
    expect(vote.status).toBe('open');
    expect(vote.createdByUid).toBe('random_member');
    expect(vote.electorateSize).toBe(3);
  });

  it('an EMPTY electorate opens successfully (no minimum-size validation as coded)', async () => {
    const id = await openVote(db as never, {
      subjectType: 'board_generic', electorate: [], createdByUid: 'anyone',
    });
    const vote = await getVote(db as never, id);
    expect(vote.electorateSize).toBe(0);
    const result = await closeVote(db as never, id, 'anyone');
    expect(result.participating).toBe(0);
    expect(result.passed).toBe(false); // strict majority of present: 0 > 0 is false
  });

  it('a non-array electorate is the ONLY open validation: 422 VOTE_VALIDATION', async () => {
    await expect(openVote(db as never, {
      subjectType: 'board_generic', electorate: 'not-an-array' as never, createdByUid: 'x',
    })).rejects.toMatchObject({ code: 'VOTE_VALIDATION', status: 422 });
  });
});

describe('H-09: closeVote has NO actor check', () => {
  it('a complete outsider (not creator, not electorate) can close and certify a vote', async () => {
    const id = await openVote(db as never, {
      subjectType: 'board_generic', electorate: seats(3), createdByUid: 'gov-1',
    });
    await castVote(db as never, id, 'gov-1', 'for');
    await castVote(db as never, id, 'gov-2', 'for');
    const result = await closeVote(db as never, id, 'total_outsider');
    expect(result.passed).toBe(true);
    expect(result.votesFor).toBe(2);
    const vote = await getVote(db as never, id);
    expect(vote.status).toBe('closed');
    expect(vote.closedByUid).toBe('total_outsider');
  });
});

describe('castVote semantics as coded', () => {
  it('a REPEAT cast OVERWRITES the previous ballot (doc id = voter uid; no already-voted error)', async () => {
    const id = await openVote(db as never, {
      subjectType: 'board_generic', electorate: seats(3), createdByUid: 'gov-1',
    });
    await castVote(db as never, id, 'gov-1', 'against');
    await castVote(db as never, id, 'gov-1', 'for');
    const vote = await getVote(db as never, id);
    expect(vote.ballotCount).toBe(1);
    const result = await closeVote(db as never, id, 'gov-1');
    expect(result.votesFor).toBe(1);
    expect(result.votesAgainst).toBe(0);
  });

  it('an invalid choice is 422 VOTE_VALIDATION before any state is touched', async () => {
    const id = await openVote(db as never, {
      subjectType: 'board_generic', electorate: seats(3), createdByUid: 'gov-1',
    });
    await expect(castVote(db as never, id, 'gov-1', 'yes' as never))
      .rejects.toMatchObject({ code: 'VOTE_VALIDATION', status: 422 });
  });

  it('casting on a closed vote is 409 VOTE_NOT_OPEN; closing a recorded (offline_attested) vote is 409 too', async () => {
    const id = await openVote(db as never, {
      subjectType: 'board_generic', electorate: seats(3), createdByUid: 'gov-1',
    });
    await closeVote(db as never, id, 'gov-1');
    await expect(castVote(db as never, id, 'gov-1', 'for'))
      .rejects.toMatchObject({ code: 'VOTE_NOT_OPEN', status: 409 });

    const recorded = await openVote(db as never, {
      subjectType: 'board_generic', mode: 'offline_attested', electorate: seats(3), createdByUid: 'gov-1',
    });
    await expect(closeVote(db as never, recorded, 'gov-1'))
      .rejects.toMatchObject({ code: 'VOTE_NOT_OPEN', status: 409 });
    await expect(castVote(db as never, recorded, 'gov-1', 'for'))
      .rejects.toMatchObject({ code: 'VOTE_NOT_OPEN', status: 409 });
  });

  it('missing vote: cast/close/get throw 404 VOTE_NOT_FOUND, getCertifiedResult returns null', async () => {
    await expect(castVote(db as never, 'nope', 'gov-1', 'for'))
      .rejects.toMatchObject({ code: 'VOTE_NOT_FOUND', status: 404 });
    await expect(closeVote(db as never, 'nope', 'gov-1'))
      .rejects.toMatchObject({ code: 'VOTE_NOT_FOUND', status: 404 });
    await expect(getVote(db as never, 'nope'))
      .rejects.toMatchObject({ code: 'VOTE_NOT_FOUND', status: 404 });
    await expect(getCertifiedResult(db as never, 'nope')).resolves.toBeNull();
    expect(VoteError).toBeDefined();
  });
});

describe('threshold presets: even electorates and the quorum difference', () => {
  it('cooption / governor_removal on 8 seats: threshold pair is 5/8; 4 fails, 5 passes', () => {
    for (const kind of ['cooption', 'governor_removal'] as const) {
      const cfg = { ...resolveThreshold(kind, 8), electorateSize: 8 };
      expect(cfg.threshold).toEqual({ numerator: 5, denominator: 8 });
      expect(cfg.kind).toBe('strict_majority_electorate');
      const mk = (f: number) => Array.from({ length: f }, () => ({ choice: 'for' as const }));
      expect(tallyBallots(mk(4), cfg).passed).toBe(false);
      expect(tallyBallots(mk(5), cfg).passed).toBe(true);
    }
  });

  it('strike3_expulsion carries quorum 5; chapter_suspend (same majority kind) carries NO quorum', () => {
    expect(resolveThreshold('strike3_expulsion', 9).quorum).toBe(5);
    expect(resolveThreshold('chapter_suspend', 9).quorum).toBeUndefined();
    // Consequence: a 1-0 chapter_suspend passes with a single participant,
    // while a 1-0 strike3 vote fails on quorum alone.
    const suspend = { ...resolveThreshold('chapter_suspend', 9), electorateSize: 9 };
    expect(tallyBallots([{ choice: 'for' }], suspend).passed).toBe(true);
    const strike = { ...resolveThreshold('strike3_expulsion', 9), electorateSize: 9 };
    const r = tallyBallots([{ choice: 'for' }], strike);
    expect(r.quorumMet).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('fraction basis counts VACANT seats: 2/3 of 9 seats with 3 vacant needs 6 for-votes that can never exist', () => {
    const cfg = { ...resolveThreshold('chapter_expel', 9), electorateSize: 9 };
    const six = Array.from({ length: 6 }, () => ({ choice: 'for' as const }));
    expect(tallyBallots(six, cfg).basis).toBe(9);
    expect(tallyBallots(six, cfg).passed).toBe(true);
    const five = Array.from({ length: 5 }, () => ({ choice: 'for' as const }));
    expect(tallyBallots(five, cfg).passed).toBe(false);
  });

  it('an unknown/default subject type falls back to strict majority of present and voting', () => {
    const cfg = resolveThreshold('board_generic', 9);
    expect(cfg.kind).toBe('strict_majority_present_voting');
    expect(cfg.denominatorBasis).toBe('present');
  });
});
