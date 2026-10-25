/**
 * G2 SEAM — motions + votes + ballots (Supabase). Plan §1-G2, §2-G2,
 * §3 (H-1..H-6, H-8), §6 (H-09), §8.
 *
 * Holds:
 *   - SupaMotionStore and SupaBallotStore: Supa implementations of
 *     the firestore-stores.ts G2 classes, including secret-ballot
 *     tokens/choices, the token issue log subcollection, and proxy
 *     authorizations. The pure services (server/governance/
 *     motions.ts, ballots.ts) are untouched.
 *   - The governance-votes facade handle (resolveVotesDb): the votes
 *     service (server/governance-votes.ts) takes a raw db, so it is
 *     migrated by swapping the handle, never its logic.
 *
 * Flag: surface 'motions' (the votes family rides the G2 surface).
 * Flag OFF / adapter error = Firestore byte-identical; store methods
 * delegate to their Firestore counterpart on adapter error.
 *
 * Secret-ballot unlinkability (plan §2-G2): choice docs written and
 * read through this seam are whitelisted to {motionId, choice,
 * castAt} — no uid field can reach fs_secret_ballot_choices through
 * the seam, and token docs are keyed by token HASH. The issue log
 * (the only uid-bearing secret-ballot record) is deleted at close by
 * deleteTokenIssueLog: list -> delete each -> re-list until empty,
 * throwing on residual (H-8: the deletion is what destroys the
 * issue<->choice correlation, so a partial delete must surface as a
 * failure, never pass silently; the loop is NOT atomic — named
 * divergence from today's single batch commit).
 *
 * Ballot doc identity: traceable ballots keep their deterministic
 * per-voter+motion ids from the service layer; the store's getBallot
 * pre-check semantics are preserved (a put is an existence-checked
 * service flow, not a blind upsert change).
 *
 * Filing tasks and audit_logs stay on Firestore (plan §5): the
 * motions deps composition keeps FirestoreFilingTaskCreator, and the
 * votes facade DELEGATES the audit_logs collection to the real
 * Firestore db (see supa-facade.ts, H-5 batch ordering).
 */

import { getDb } from "@/lib/server/firebase-admin";
import type { Motion } from "@/lib/governance/meetings/motions-types";
import type {
  BallotDoc,
  ProxyAuthorizationDoc,
  SecretBallotChoiceDoc,
  SecretBallotTokenDoc,
} from "@/lib/governance/meetings/ballots";
import type { BallotStore } from "./ballots";
import { toMotionRef, type MotionStore } from "./motions";
import { GovernanceServiceError } from "./shared";
import { toDate } from "./firestore-stores";
import {
  govSupaAdapterFor,
  newFirestoreId,
  reviveDatesDeep,
  stripDocId,
  type GovSupaAdapter,
} from "./supa-shared";
import { SupaFirestoreFacade } from "./supa-facade";

function reqDate(v: unknown, fallback: Date): Date {
  return toDate(v) ?? fallback;
}

/** Mirror of firestore-stores' motionFromDoc over an adapter doc body. */
function motionFromData(id: string, raw: Record<string, unknown>): Motion {
  const data = reviveDatesDeep(raw) as Record<string, unknown>;
  return {
    ...(data as unknown as Motion),
    id,
    openedAt: reqDate(data.openedAt, new Date(0)),
    closedAt: toDate(data.closedAt),
    disclosures: (((data.disclosures ?? []) as unknown) as Motion["disclosures"]).map((d) => ({
      ...d,
      recordedAt: reqDate((d as { recordedAt?: unknown }).recordedAt, new Date(0)),
    })),
  } as Motion;
}

export class SupaMotionStore implements MotionStore {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: MotionStore & { nextId(): string },
  ) {}

  async getMotion(id: string): Promise<Motion | null> {
    try {
      const doc = await this.adapter.getDoc("motions", id);
      return doc ? motionFromData(id, stripDocId(doc)) : null;
    } catch {
      return this.fallback.getMotion(id);
    }
  }

  async saveMotion(motion: Motion): Promise<void> {
    try {
      await this.adapter.setDoc("motions", motion.id, { ...motion }, { merge: true });
    } catch {
      return this.fallback.saveMotion(motion);
    }
  }

  async listMotionsByMeeting(meetingId: string): Promise<Motion[]> {
    try {
      const docs = await this.adapter.listDocs("motions", {
        where: [["meetingId", "==", meetingId]],
      });
      return docs.map((d) => motionFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listMotionsByMeeting(meetingId);
    }
  }

  nextId(): string {
    return newFirestoreId();
  }
}

export class SupaBallotStore implements BallotStore {
  constructor(
    private adapter: GovSupaAdapter,
    private motions: MotionStore,
    private fallback: BallotStore,
  ) {}

  async getMotion(motionId: string) {
    const m = await this.motions.getMotion(motionId);
    return m ? toMotionRef(m) : null;
  }

  async saveMotion(ref: { id: string; status: Motion["status"]; method: Motion["method"]; secretDemandedBy: string[] }) {
    // Mirrors FirestoreBallotStore.saveMotion exactly (load via the
    // composed motion store, merge the three fields, save).
    const existing = await this.motions.getMotion(ref.id);
    if (!existing) {
      throw new GovernanceServiceError("motion_not_found", 404, `No motion with id ${ref.id}`);
    }
    await this.motions.saveMotion({
      ...existing,
      status: ref.status,
      method: ref.method,
      secretDemandedBy: [...ref.secretDemandedBy],
    });
  }

  async getBallot(ballotId: string): Promise<BallotDoc | null> {
    try {
      const doc = await this.adapter.getDoc("ballots", ballotId);
      if (!doc) return null;
      const data = reviveDatesDeep(stripDocId(doc)) as Record<string, unknown>;
      return { ...(data as unknown as BallotDoc), castAt: reqDate(data.castAt, new Date(0)) };
    } catch {
      return this.fallback.getBallot(ballotId);
    }
  }

  async putBallot(ballotId: string, doc: BallotDoc): Promise<void> {
    try {
      await this.adapter.setDoc("ballots", ballotId, { ...doc });
    } catch {
      return this.fallback.putBallot(ballotId, doc);
    }
  }

  async listBallots(motionId: string): Promise<BallotDoc[]> {
    try {
      const docs = await this.adapter.listDocs("ballots", {
        where: [["motionId", "==", motionId]],
      });
      return docs.map((d) => {
        const data = reviveDatesDeep(stripDocId(d)) as Record<string, unknown>;
        return { ...(data as unknown as BallotDoc), castAt: reqDate(data.castAt, new Date(0)) };
      });
    } catch {
      return this.fallback.listBallots(motionId);
    }
  }

  async getSecretToken(tokenHash: string): Promise<SecretBallotTokenDoc | null> {
    try {
      const doc = await this.adapter.getDoc("secret_ballot_tokens", tokenHash);
      if (!doc) return null;
      const data = stripDocId(doc);
      return {
        motionId: data.motionId as string,
        used: Boolean(data.used),
        usedAt: toDate(reviveDatesDeep(data.usedAt)),
      };
    } catch {
      return this.fallback.getSecretToken(tokenHash);
    }
  }

  async putSecretToken(tokenHash: string, doc: SecretBallotTokenDoc): Promise<void> {
    try {
      await this.adapter.setDoc("secret_ballot_tokens", tokenHash, { ...doc });
    } catch {
      return this.fallback.putSecretToken(tokenHash, doc);
    }
  }

  async putSecretChoice(choiceId: string, doc: SecretBallotChoiceDoc): Promise<void> {
    try {
      // Whitelist (unlinkability): ONLY these three fields are stored,
      // exactly as the Firestore impl's listSecretChoices reads back.
      await this.adapter.setDoc("secret_ballot_choices", choiceId, {
        motionId: doc.motionId,
        choice: doc.choice,
        castAt: doc.castAt,
      });
    } catch {
      return this.fallback.putSecretChoice(choiceId, doc);
    }
  }

  async listSecretChoices(motionId: string): Promise<SecretBallotChoiceDoc[]> {
    try {
      const docs = await this.adapter.listDocs("secret_ballot_choices", {
        where: [["motionId", "==", motionId]],
      });
      return docs.map((d) => {
        const data = reviveDatesDeep(stripDocId(d)) as Record<string, unknown>;
        return {
          motionId: data.motionId,
          choice: data.choice,
          castAt: reqDate(data.castAt, new Date(0)),
        } as SecretBallotChoiceDoc;
      });
    } catch {
      return this.fallback.listSecretChoices(motionId);
    }
  }

  private issueLogPath(motionId: string): string {
    return `motions/${motionId}/tokenIssueLog`;
  }

  async getTokenIssue(motionId: string, uid: string): Promise<{ issuedAt: Date } | null> {
    try {
      const doc = await this.adapter.getDoc(this.issueLogPath(motionId), uid);
      if (!doc) return null;
      return { issuedAt: toDate(reviveDatesDeep(stripDocId(doc).issuedAt)) ?? new Date(0) };
    } catch {
      return this.fallback.getTokenIssue(motionId, uid);
    }
  }

  async putTokenIssue(motionId: string, uid: string, issuedAt: Date): Promise<void> {
    try {
      await this.adapter.setDoc(this.issueLogPath(motionId), uid, { issuedAt });
    } catch {
      return this.fallback.putTokenIssue(motionId, uid, issuedAt);
    }
  }

  async deleteTokenIssueLog(motionId: string): Promise<void> {
    // H-8: loop-and-verify. The adapter has no batch delete; a crash
    // mid-loop must not pass silently, so residual rows throw.
    try {
      const path = this.issueLogPath(motionId);
      for (let pass = 0; pass < 10; pass++) {
        const docs = await this.adapter.listDocs(path);
        if (docs.length === 0) return;
        for (const d of docs) await this.adapter.deleteDoc(path, d.id);
      }
      const residual = await this.adapter.listDocs(path);
      if (residual.length > 0) {
        throw new GovernanceServiceError(
          "token_issue_log_delete_incomplete",
          500,
          `Token issue log for motion ${motionId} still has ${residual.length} rows after delete passes`,
        );
      }
    } catch (e) {
      if (e instanceof GovernanceServiceError) throw e;
      return this.fallback.deleteTokenIssueLog(motionId);
    }
  }

  async getProxyAuthorization(authId: string): Promise<ProxyAuthorizationDoc | null> {
    try {
      const doc = await this.adapter.getDoc("proxyAuthorizations", authId);
      if (!doc) return null;
      const data = reviveDatesDeep(stripDocId(doc)) as Record<string, unknown>;
      return {
        ...(data as unknown as ProxyAuthorizationDoc),
        revokedAt: toDate(data.revokedAt),
      };
    } catch {
      return this.fallback.getProxyAuthorization(authId);
    }
  }
}

/* ------------------------------------------------ governance votes --- */

// H-09 (FOUNDER_ACCESS_MAP_2026-10-25): governance votes family has NO permission gate by faithful-migration design — any authenticated user can open a vote with a body-supplied electorate and closeVote performs no actor check. DO NOT add a gate in migration work; the fix is a separate, founder-decided change.
// (The em dash above is part of the plan-mandated verbatim comment, §6.2.)

/**
 * The `db` handle for the governance-votes routes: the Supa facade
 * (governance_votes + its ballots subcollection) when the 'motions'
 * surface is on and an adapter resolves, else the real Firestore db.
 * `audit_logs` is DELEGATED to the real Firestore db when one exists
 * (audit cluster owns it; H-5 ordering lives in the facade's batch
 * commit); when no Firestore db exists, audit_logs is served by the
 * facade itself so the service's audit-or-throw contract still runs.
 * H-09: no permission gate is added here or in the routes — see the
 * verbatim comment above.
 */
export function resolveVotesDb(): unknown {
  const adapter = govSupaAdapterFor("motions");
  if (!adapter) return getDb();
  const realDb = getDb();
  if (realDb) {
    return new SupaFirestoreFacade(adapter, {
      allow: new Set(["governance_votes"]),
      delegateDb: realDb as never,
      delegateCollections: new Set(["audit_logs"]),
    });
  }
  return new SupaFirestoreFacade(adapter, {
    allow: new Set(["governance_votes", "audit_logs"]),
  });
}
