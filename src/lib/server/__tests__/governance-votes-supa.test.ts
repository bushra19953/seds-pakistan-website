/**
 * @jest-environment node
 *
 * Supabase migration suite for governance votes (elections G3,
 * governance-votes.ts behind agm-domain-supa).
 *
 * Everything is mocked: the governance fake Firestore for the
 * Firestore side (and the unconverted governance audit writer), and
 * a fake in-memory adapter injected into agm-domain-supa for the
 * Supabase side. Zero live reads.
 *
 * Covered:
 * - flag OFF parity: votes/ballots land ONLY in Firestore.
 * - flag ON happy paths: open (frozen electorate snapshot), cast,
 *   close (exact-fraction tally), getVote / getCertifiedResult.
 * - castVote validation order ON path is identical to the Firestore
 *   transaction: VOTE_VALIDATION (choice, before any read) ->
 *   VOTE_NOT_FOUND -> VOTE_NOT_OPEN -> VOTER_NOT_IN_ELECTORATE.
 * - One ballot per voter is structural ON path (doc id = voter uid).
 * - closeVote idempotency ON path: second close returns the stored
 *   result and writes no second audit entry.
 * - Bridge-error fallback: open/cast/close run the Firestore paths.
 * - Unconfigured fallback.
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
  type ElectorateSeat,
} from '@/lib/server/governance-votes';
import {
  __setAgmSupaAdapterForTests,
  agmSupaEnabled,
  type AgmSupaAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from '../agm-domain-supa';

// ---------------------------------------------------------------------------
// Fake Supabase adapter: stores the SERIALIZED jsonb form (ISO
// strings), exactly like fs_* tables, keyed by collection path + id.
// ---------------------------------------------------------------------------

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeSupaAdapter implements AgmSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();
  failAll = false;

  private bucket(path: string): Map<string, SupaDocData> {
    let b = this.store.get(path);
    if (!b) {
      b = new Map();
      this.store.set(path, b);
    }
    return b;
  }

  private guard(): void {
    if (this.failAll) throw new Error('fake supa: simulated outage');
  }

  async getDoc(path: string, id: string): Promise<SupaDoc | null> {
    this.guard();
    const data = this.bucket(path).get(id);
    return data ? { id, ...jsonClone(data) } : null;
  }

  async listDocs(
    path: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]> {
    this.guard();
    const out: SupaDoc[] = [];
    for (const [id, data] of this.bucket(path)) {
      const matches = (options?.where ?? []).every(
        ([field, , value]) => data[field] === value,
      );
      if (matches) out.push({ id, ...jsonClone(data) });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out;
  }

  async setDoc(path: string, id: string, data: SupaDocData): Promise<SupaDoc> {
    this.guard();
    this.bucket(path).set(id, jsonClone(data));
    return { id, ...jsonClone(data) };
  }

  async updateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    this.guard();
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake supa: updateDoc missing ${path}/${id}`);
    const next = { ...existing, ...jsonClone(updates) };
    this.bucket(path).set(id, next);
    return { id, ...next };
  }

  async deleteDoc(path: string, id: string): Promise<void> {
    this.guard();
    this.bucket(path).delete(id);
  }

  docsAt(path: string): Map<string, SupaDocData> {
    return this.store.get(path) ?? new Map();
  }
}

// ---------------------------------------------------------------------------

function seats(n: number): ElectorateSeat[] {
  return Array.from({ length: n }, (_, i) => ({
    seatKey: `seat-${i + 1}`,
    roleKey: 'governor',
    uid: `gov-${i + 1}`,
    vacant: false,
  }));
}

describe('governance votes behind agm-domain-supa', () => {
  const savedSurfaces = process.env.SUPA_SURFACES;
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(() => {
    __setAgmSupaAdapterForTests(undefined);
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
  });

  it('flag OFF: open/cast/close land ONLY in Firestore (adapter untouched)', async () => {
    delete process.env.SUPA_SURFACES;
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(false);

    const voteId = await openVote(db as any, {
      subjectType: 'board_generic',
      electorate: seats(3),
      createdByUid: 'founder-uid',
    });
    await castVote(db as any, voteId, 'gov-1', 'for');
    const result = await closeVote(db as any, voteId, 'founder-uid');
    expect(result.votesFor).toBe(1);
    expect(adapter.store.size).toBe(0);
    expect(db.read('governance_votes', voteId)?.status).toBe('closed');
    expect(db.all(`governance_votes/${voteId}/ballots`)).toHaveLength(1);
  });

  it('flag ON: open freezes the electorate snapshot in Supa; the audit stays in Firestore audit_logs', async () => {
    process.env.SUPA_SURFACES = 'elections';
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(true);

    const electorate = seats(3);
    const voteId = await openVote(db as any, {
      subjectType: 'board_generic',
      electorate,
      createdByUid: 'founder-uid',
    });
    // Mutating the caller's array after open must not move the snapshot.
    electorate.push({ seatKey: 'seat-4', roleKey: 'governor', uid: 'gov-4', vacant: false });
    electorate[0].uid = 'someone-else';

    expect(db.all('governance_votes')).toHaveLength(0);
    const raw = adapter.docsAt('governance_votes').get(voteId);
    expect(raw).toBeDefined();
    expect((raw?.electorate as ElectorateSeat[])).toHaveLength(3);
    expect((raw?.electorate as ElectorateSeat[])[0].uid).toBe('gov-1');
    // createdAt (FieldValue.serverTimestamp -> Date in the mock) is an
    // ISO string in the raw jsonb row, restored on read.
    expect(typeof raw?.createdAt).toBe('string');
    expect(typeof raw?.auditLogId).toBe('string');

    // The governance audit writer is unconverted: its entry is in
    // Firestore audit_logs on BOTH paths.
    const opened = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'governance_vote_opened');
    expect(opened).toHaveLength(1);

    const vote = await getVote(db as any, voteId);
    const createdAt = vote.createdAt as { toMillis?: () => number };
    expect(typeof createdAt.toMillis).toBe('function');
    expect(createdAt.toMillis!()).toBe(Date.parse(raw!.createdAt as string));
    expect(vote.ballotCount).toBe(0);
  });

  it('flag ON: castVote validation order + structural one-ballot-per-voter', async () => {
    process.env.SUPA_SURFACES = 'elections';
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);

    const electorate = seats(2);
    electorate[1].vacant = true;
    electorate[1].uid = null;
    const voteId = await openVote(db as any, {
      subjectType: 'board_generic',
      electorate,
      createdByUid: 'founder-uid',
    });
    const ballotsPath = `governance_votes/${voteId}/ballots`;

    // 1. Choice validation precedes any read: even a missing vote id
    //    yields VOTE_VALIDATION for a bad choice, as on Firestore.
    await expect(
      castVote(db as any, 'no-such-vote', 'gov-1', 'maybe' as any),
    ).rejects.toMatchObject({ code: 'VOTE_VALIDATION', status: 422 });
    // 2. Missing vote -> VOTE_NOT_FOUND.
    await expect(
      castVote(db as any, 'no-such-vote', 'gov-1', 'for'),
    ).rejects.toMatchObject({ code: 'VOTE_NOT_FOUND', status: 404 });
    // 3/4. Electorate membership (outsiders and vacant seats alike).
    await expect(
      castVote(db as any, voteId, 'outsider', 'for'),
    ).rejects.toMatchObject({ code: 'VOTER_NOT_IN_ELECTORATE', status: 403 });
    await expect(
      castVote(db as any, voteId, 'gov-2', 'for'),
    ).rejects.toMatchObject({ code: 'VOTER_NOT_IN_ELECTORATE', status: 403 });
    expect(adapter.docsAt(ballotsPath).size).toBe(0);

    await castVote(db as any, voteId, 'gov-1', 'for');
    expect(adapter.docsAt(ballotsPath).size).toBe(1);
    const rawBallot = adapter.docsAt(ballotsPath).get('gov-1');
    expect(rawBallot?.choice).toBe('for');
    expect(rawBallot?.seatKey).toBe('seat-1');
    expect(typeof rawBallot?.castAt).toBe('string');
    expect(db.all(ballotsPath)).toHaveLength(0);

    // Doc id = voter uid: a second cast by the same voter overwrites
    // the same ballot doc instead of creating a second ballot.
    await castVote(db as any, voteId, 'gov-1', 'against');
    expect(adapter.docsAt(ballotsPath).size).toBe(1);
    expect(adapter.docsAt(ballotsPath).get('gov-1')?.choice).toBe('against');
  });

  it('flag ON: offline_attested records reject ballots with VOTE_NOT_OPEN', async () => {
    process.env.SUPA_SURFACES = 'elections';
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);

    const voteId = await openVote(db as any, {
      subjectType: 'ratification_approval',
      mode: 'offline_attested',
      electorate: seats(9),
      createdByUid: 'ngs-uid',
      deciders: ['gov-1', 'gov-2', 'gov-3', 'gov-4', 'gov-5'],
      attestedBy: 'ngs-uid',
      meetingRef: 'Board meeting 2026-10-15',
    });
    const raw = adapter.docsAt('governance_votes').get(voteId);
    expect(raw?.status).toBe('recorded');
    expect(raw?.mode).toBe('offline_attested');
    await expect(
      castVote(db as any, voteId, 'gov-1', 'for'),
    ).rejects.toMatchObject({ code: 'VOTE_NOT_OPEN', status: 409 });
  });

  it('flag ON: closeVote tallies with exact fraction math and is idempotent (result written once)', async () => {
    process.env.SUPA_SURFACES = 'elections';
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);

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
    // 6 of 9 meets 2/3 of all seats exactly (integer math, no float).
    const first = await closeVote(db as any, voteId, 'founder-uid');
    expect(first.passed).toBe(true);
    expect(first.votesFor).toBe(6);
    expect(first.votesAgainst).toBe(3);

    const raw = adapter.docsAt('governance_votes').get(voteId);
    expect(raw?.status).toBe('closed');
    expect(typeof raw?.closedAt).toBe('string');
    expect((raw?.result as { votesFor: number }).votesFor).toBe(6);
    expect(db.read('governance_votes', voteId)).toBeUndefined();

    const second = await closeVote(db as any, voteId, 'founder-uid');
    expect(second).toEqual(first);
    const certified = await getCertifiedResult(db as any, voteId);
    expect(certified).toEqual(first);

    // Exactly one close audit entry: the idempotent second close
    // returns the stored result before any audit/write.
    const closedAudits = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'governance_vote_closed');
    expect(closedAudits).toHaveLength(1);

    // A closed vote accepts no further ballots.
    await expect(
      castVote(db as any, voteId, 'gov-1', 'against'),
    ).rejects.toMatchObject({ code: 'VOTE_NOT_OPEN', status: 409 });

    const vote = await getVote(db as any, voteId);
    expect(vote.ballotCount).toBe(9);
    expect(vote).not.toHaveProperty('ballots');
  });

  it('flag ON: getVote on a missing vote returns VOTE_NOT_FOUND; getCertifiedResult returns null', async () => {
    process.env.SUPA_SURFACES = 'elections';
    __setAgmSupaAdapterForTests(new FakeSupaAdapter());
    await expect(getVote(db as any, 'no-such-vote')).rejects.toMatchObject({
      code: 'VOTE_NOT_FOUND',
      status: 404,
    });
    await expect(getCertifiedResult(db as any, 'no-such-vote')).resolves.toBeNull();
  });

  it('unconfigured (flag ON, no adapter): the Firestore paths serve unchanged', async () => {
    process.env.SUPA_SURFACES = 'elections';
    __setAgmSupaAdapterForTests(null);
    expect(agmSupaEnabled()).toBe(false);

    const voteId = await openVote(db as any, {
      subjectType: 'board_generic',
      electorate: seats(3),
      createdByUid: 'founder-uid',
    });
    await castVote(db as any, voteId, 'gov-1', 'for');
    const result = await closeVote(db as any, voteId, 'founder-uid');
    expect(result.votesFor).toBe(1);
    expect(db.read('governance_votes', voteId)?.status).toBe('closed');
  });

  it('adapter error: open/cast/close fall back to the Firestore transaction/batch paths', async () => {
    process.env.SUPA_SURFACES = 'elections';
    const adapter = new FakeSupaAdapter();
    adapter.failAll = true;
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(true);

    const voteId = await openVote(db as any, {
      subjectType: 'ratification_refusal',
      electorate: seats(9),
      createdByUid: 'founder-uid',
    });
    expect(adapter.docsAt('governance_votes').size).toBe(0);
    expect(db.read('governance_votes', voteId)?.status).toBe('open');

    for (let i = 1; i <= 6; i += 1) {
      await castVote(db as any, voteId, `gov-${i}`, 'for');
    }
    expect(db.all(`governance_votes/${voteId}/ballots`)).toHaveLength(6);

    // Validation still precedes the fallback transaction.
    await expect(
      castVote(db as any, voteId, 'outsider', 'for'),
    ).rejects.toMatchObject({ code: 'VOTER_NOT_IN_ELECTORATE', status: 403 });

    const result = await closeVote(db as any, voteId, 'founder-uid');
    expect(result.passed).toBe(true);
    expect(db.read('governance_votes', voteId)?.status).toBe('closed');
    const certified = await getCertifiedResult(db as any, voteId);
    expect(certified).toEqual(result);
    const closedAudits = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'governance_vote_closed');
    expect(closedAudits).toHaveLength(1);
  });
});
