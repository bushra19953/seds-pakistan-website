/**
 * @jest-environment node
 *
 * F6 — closeVote ORPHAN AUDIT (BUILDOUT_AUDIT §5, flip-blocker F6).
 *
 * closeVoteSupa writes the `governance_vote_closed` audit entry
 * FIRST (so a close never lands unaudited) and only then updates
 * the vote doc. If the bridge fails between those two writes, the
 * current implementation falls back to the Firestore path, which
 * cannot see the Supa-only vote and reports VOTE_NOT_FOUND — a
 * domain verdict for what is really an infrastructure failure,
 * with an orphan audit entry left behind.
 *
 * This suite pins the required behavior:
 *   (i)   the interrupted close does NOT succeed;
 *   (ii)  the thrown error is NOT VOTE_NOT_FOUND — it is
 *         infrastructure-class (neither a VoteError nor a
 *         GovernanceAuditError);
 *   (iii) NO Firestore fallback close is attempted: the vote doc
 *         never appears on Firestore, and the Supa vote doc stays
 *         open with no result (the close landed nowhere);
 *   (iv)  after the bridge recovers, a retry closes the vote, and
 *         the TOTAL number of governance_vote_closed audit entries
 *         for that vote is exactly ONE (no orphan + retry duplicate);
 *   (v)   getCertifiedResult then returns the result.
 *
 * Zero live reads: governance fake Firestore + in-memory fake
 * adapter only.
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
  VoteError,
  type ElectorateSeat,
} from '@/lib/server/governance-votes';
import { GovernanceAuditError } from '@/lib/server/governance-audit';
import {
  __setAgmSupaAdapterForTests,
  agmSupaEnabled,
  type AgmSupaAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from '../agm-domain-supa';

// ---------------------------------------------------------------------------
// Fake Supabase adapter (governance-votes-supa pattern) with a
// failure predicate armed only for the close's vote-doc update.
// ---------------------------------------------------------------------------

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeSupaAdapter implements AgmSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();
  /** When true, updateDoc on the governance_votes collection throws. */
  failVoteUpdates = false;

  private bucket(path: string): Map<string, SupaDocData> {
    let b = this.store.get(path);
    if (!b) {
      b = new Map();
      this.store.set(path, b);
    }
    return b;
  }

  async getDoc(path: string, id: string): Promise<SupaDoc | null> {
    const data = this.bucket(path).get(id);
    return data ? { id, ...jsonClone(data) } : null;
  }

  async listDocs(
    path: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]> {
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
    this.bucket(path).set(id, jsonClone(data));
    return { id, ...jsonClone(data) };
  }

  async updateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    if (this.failVoteUpdates && path === 'governance_votes') {
      throw new Error('fake supa: simulated infra error on vote update');
    }
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake supa: updateDoc missing ${path}/${id}`);
    const next = { ...existing, ...jsonClone(updates) };
    this.bucket(path).set(id, next);
    return { id, ...next };
  }

  async deleteDoc(path: string, id: string): Promise<void> {
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

function closeAuditCount(db: FakeDb, voteId: string): number {
  return db
    .all('audit_logs')
    .filter(
      (a) =>
        a.data.action === 'governance_vote_closed' && a.data.targetId === voteId,
    ).length;
}

describe('F6 closeVote: post-audit bridge failure', () => {
  const savedSurfaces = process.env.SUPA_SURFACES;
  let db: FakeDb;
  let adapter: FakeSupaAdapter;

  beforeEach(() => {
    db = createFakeDb();
    process.env.SUPA_SURFACES = 'elections';
    adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(true);
  });

  afterEach(() => {
    __setAgmSupaAdapterForTests(undefined);
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
  });

  it('bridge fails AFTER the audit write, BEFORE the vote update: loud infra error, no Firestore fallback close, retry closes with exactly ONE close audit entry', async () => {
    // Open + cast on the healthy Supa path.
    const voteId = await openVote(db as any, {
      subjectType: 'board_generic',
      electorate: seats(3),
      createdByUid: 'founder-uid',
    });
    await castVote(db as any, voteId, 'gov-1', 'for');
    await castVote(db as any, voteId, 'gov-2', 'for');
    expect(adapter.docsAt('governance_votes').get(voteId)?.status).toBe('open');
    expect(db.read('governance_votes', voteId)).toBeUndefined();
    expect(closeAuditCount(db, voteId)).toBe(0);

    // Arm the failure: the audit write (Firestore audit_logs, via
    // the unconverted governance audit writer) still lands, but the
    // vote-doc update on the bridge throws.
    adapter.failVoteUpdates = true;

    let err: unknown = null;
    try {
      await closeVote(db as any, voteId, 'founder-uid');
    } catch (e) {
      err = e;
    }

    // (i) The call does NOT succeed.
    expect(err).not.toBeNull();
    // (ii) The error is NOT VOTE_NOT_FOUND and is infrastructure-class:
    //      neither a VoteError (domain) nor a GovernanceAuditError.
    expect(err).not.toBeInstanceOf(VoteError);
    expect(err).not.toBeInstanceOf(GovernanceAuditError);
    expect((err as { code?: string }).code).not.toBe('VOTE_NOT_FOUND');
    expect((err as { code?: string }).code).toBeUndefined();

    // (iii) No Firestore fallback close was attempted: no vote doc
    //       exists (or was closed) on Firestore, and the Supa vote
    //       doc is still open with no result — the close landed
    //       on NEITHER backend.
    expect(db.read('governance_votes', voteId)).toBeUndefined();
    expect(db.all('governance_votes')).toHaveLength(0);
    const supaVoteAfterFailure = adapter.docsAt('governance_votes').get(voteId);
    expect(supaVoteAfterFailure?.status).toBe('open');
    expect(supaVoteAfterFailure?.result ?? null).toBeNull();

    // Bridge recovers; the retry closes the vote.
    adapter.failVoteUpdates = false;
    const result = await closeVote(db as any, voteId, 'founder-uid');
    expect(result.passed).toBe(true);
    expect(result.votesFor).toBe(2);
    expect(result.votesAgainst).toBe(0);

    // (iv) Exactly ONE governance_vote_closed audit entry exists
    //      for this vote in total — the interrupted attempt must
    //      not leave an orphan that the retry then duplicates.
    expect(closeAuditCount(db, voteId)).toBe(1);

    // The close landed on Supa, still nowhere on Firestore.
    const supaVote = adapter.docsAt('governance_votes').get(voteId);
    expect(supaVote?.status).toBe('closed');
    expect((supaVote?.result as { votesFor?: number })?.votesFor).toBe(2);
    expect(db.read('governance_votes', voteId)).toBeUndefined();

    // (v) The certified result is now readable and equals the result.
    const certified = await getCertifiedResult(db as any, voteId);
    expect(certified).toEqual(result);
  });
});
