/**
 * Firestore-shaped facade over the Supabase adapter (governance
 * cluster). Two services in this cluster take a raw `db` handle
 * instead of store interfaces — `server/governance/meetings.ts` (G1)
 * and `server/governance-votes.ts` (G2) — so their migration unit is
 * a handle with the exact surface they use:
 *
 *   collection(name).doc(id?).{get,set,update,delete,collection}
 *   collection(name).where(...).orderBy(...).limit(...).get()
 *   runTransaction(fn)   — serialised per facade instance (H-3)
 *   batch().{set,update,delete}.commit()
 *
 * Rules (plan §1-G1, §3):
 * - The facade serves ONLY its allow-listed top-level collections.
 *   Any other collection THROWS, so a request can never silently
 *   split across two databases mid-flight; route-level code catches
 *   and falls back to Firestore wholesale, or the service's own
 *   error handling applies (lookupConsentState swallows, by design).
 * - Delegated collections (e.g. `audit_logs` for the G2 votes facade)
 *   return the REAL Firestore collection object: audit stays on
 *   Firestore (audit cluster owns it, plan §5).
 * - Batch commit order (H-5): delegated-collection ops (the audit
 *   write) commit FIRST through a real Firestore batch, then the
 *   Supa ops. Today's Firestore batch commits both atomically; the
 *   cross-store version cannot — if the Supa half fails after the
 *   audit commits, an orphan audit row exists (the reverse order
 *   risks a closed vote with NO audit row, which is worse: the audit
 *   is the legal record). This divergence is accepted and documented
 *   here, per plan §3/H-5.
 * - runTransaction (H-3): the facade serialises transactions per
 *   instance on a promise chain and applies tx writes immediately
 *   inside the serialised section, so the read-check-write sequence
 *   of castVote cannot interleave with another cast/close ON THE
 *   SAME facade instance (per-process, like the routes' single
 *   server instance). Cross-process serialisation is NOT provided
 *   by this lock — named risk, plan H-3. CUTOVER: this per-process
 *   lock is a FIRST LINE ONLY and is no longer load-bearing. Under
 *   isSupaPrimary('motions') the votes critical sections never reach
 *   runTransaction: they run as one Postgres transaction each
 *   (tx_motions_* in src/lib/supa/sql/) under the cross-process
 *   advisory lock 'vote:<voteId>' (see governance-votes.ts). The
 *   lock here still serialises the dual-write (SUPA_PRIMARY off)
 *   path exactly as before.
 * - FieldValue sentinels in write payloads become the seam's write
 *   instant (sanitizeForSupaWrite), reproducing serverTimestamp
 *   semantics at the seam (H-1/H-2/H-4/H-6).
 * - Read data() returns the adapter's stored shape (ISO strings for
 *   timestamps): services' own toDate() helpers convert, exactly as
 *   they convert Firestore values (H-7/H-9). EXCEPTION: the votes
 *   service returns stored data raw (getVote), where ISO strings
 *   replace Timestamp JSON — the plan-flagged unavoidable delta
 *   (§2-G2), not faked here.
 */

import {
  mirrorToFirestore,
  newFirestoreId,
  sanitizeForSupaWrite,
  stripDocId,
  type GovSupaAdapter,
} from "./supa-shared";

export class SupaFacadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupaFacadeError";
  }
}

interface FacadeSnapshot {
  id: string;
  exists: boolean;
  ref: FacadeDocRef;
  data: () => Record<string, unknown> | undefined;
}

interface FacadeQuerySnapshot {
  docs: FacadeSnapshot[];
  empty: boolean;
  size: number;
}

type WhereTriple = [string, string, unknown];

export class FacadeDocRef {
  readonly __supaFacadeRef = true;
  constructor(
    private facade: SupaFirestoreFacade,
    readonly collectionPath: string,
    readonly id: string,
  ) {}
  get path(): string {
    return `${this.collectionPath}/${this.id}`;
  }
  collection(name: string): FacadeCollectionRef {
    return new FacadeCollectionRef(this.facade, `${this.path}/${name}`);
  }
  async get(): Promise<FacadeSnapshot> {
    const doc = await this.facade.adapter.getDoc(this.collectionPath, this.id);
    if (!doc) {
      return { id: this.id, exists: false, ref: this, data: () => undefined };
    }
    const data = stripDocId(doc);
    return { id: this.id, exists: true, ref: this, data: () => ({ ...data }) };
  }
  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    await this.facade.adapter.setDoc(
      this.collectionPath,
      this.id,
      sanitizeForSupaWrite(data) as Record<string, unknown>,
      opts,
    );
    // Cutover primacy: the Supa write above is the commit; mirror the
    // RAW payload (FieldValue sentinels intact — Firestore resolves
    // them itself) to the real Firestore doc, best-effort.
    await this.facade.mirrorDocOp(this.path, async (ref) => {
      await ref.set(data, opts);
    });
  }
  async update(data: Record<string, unknown>): Promise<void> {
    await this.facade.adapter.updateDoc(
      this.collectionPath,
      this.id,
      sanitizeForSupaWrite(data) as Record<string, unknown>,
    );
    await this.facade.mirrorDocOp(this.path, async (ref) => {
      await ref.update(data);
    });
  }
  async delete(): Promise<void> {
    await this.facade.adapter.deleteDoc(this.collectionPath, this.id);
    await this.facade.mirrorDocOp(this.path, async (ref) => {
      await ref.delete();
    });
  }
}

class FacadeQuery {
  constructor(
    protected facade: SupaFirestoreFacade,
    protected collectionPath: string,
    protected wheres: WhereTriple[] = [],
    protected orders: Array<{ field: string; direction: "asc" | "desc" }> = [],
    protected limitN: number | undefined = undefined,
  ) {}
  where(field: string, op: string, value: unknown): FacadeQuery {
    return new FacadeQuery(
      this.facade,
      this.collectionPath,
      [...this.wheres, [field, op, value]],
      this.orders,
      this.limitN,
    );
  }
  orderBy(field: string, direction: "asc" | "desc" = "asc"): FacadeQuery {
    return new FacadeQuery(this.facade, this.collectionPath, this.wheres, [
      ...this.orders,
      { field, direction },
    ], this.limitN);
  }
  limit(n: number): FacadeQuery {
    return new FacadeQuery(this.facade, this.collectionPath, this.wheres, this.orders, n);
  }
  async get(): Promise<FacadeQuerySnapshot> {
    const docs = await this.facade.adapter.listDocs(this.collectionPath, {
      where: this.wheres as never,
      ...(this.orders.length > 0 ? { orderBy: this.orders } : {}),
      ...(this.limitN !== undefined ? { limit: this.limitN } : {}),
    });
    const snaps = docs.map((d) => {
      const ref = new FacadeDocRef(this.facade, this.collectionPath, d.id);
      const data = stripDocId(d);
      return { id: d.id, exists: true, ref, data: () => ({ ...data }) } as FacadeSnapshot;
    });
    return { docs: snaps, empty: snaps.length === 0, size: snaps.length };
  }
}

export class FacadeCollectionRef extends FacadeQuery {
  constructor(facade: SupaFirestoreFacade, collectionPath: string) {
    super(facade, collectionPath);
  }
  doc(id?: string): FacadeDocRef {
    return new FacadeDocRef(this.facade, this.collectionPath, id ?? newFirestoreId());
  }
}

interface BatchOp {
  kind: "set" | "update" | "delete";
  ref: unknown;
  data?: Record<string, unknown>;
  opts?: { merge?: boolean };
}

export interface SupaFacadeOptions {
  /** Top-level collections served from Supabase. Anything else throws. */
  allow: ReadonlySet<string>;
  /**
   * Collections delegated to the real Firestore db (the db object
   * itself; its .collection(name) is returned verbatim). Used for
   * `audit_logs` on the votes facade. Delegated batch ops commit via
   * `realDb.batch()` FIRST (H-5).
   */
  delegateDb?: { collection(name: string): unknown; batch(): unknown } | null;
  delegateCollections?: ReadonlySet<string>;
  /**
   * Cutover write primacy: when true, every Supa doc write through
   * this facade is the commit, and the same write is mirrored to the
   * real Firestore doc (mirrorDb) post-commit, best-effort. Set by
   * the resolvers (resolveMeetingsDb / resolveVotesDb) only when
   * isSupaPrimary(<surface>) is on AND a real Firestore db exists.
   * Absent/false = pre-cutover behaviour, byte-identical.
   */
  primary?: boolean;
  mirrorDb?: { collection(name: string): unknown } | null;
}

export class SupaFirestoreFacade {
  private txChain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly adapter: GovSupaAdapter,
    private opts: SupaFacadeOptions,
  ) {}

  /**
   * Post-commit Firestore mirror for one doc write (primacy only).
   * Resolves the real Firestore DocumentReference for a full doc
   * path by alternating collection/doc segments, then runs the op.
   * Never throws (mirrorToFirestore logs and swallows).
   */
  async mirrorDocOp(
    docPath: string,
    op: (ref: {
      set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
      update(data: Record<string, unknown>): Promise<void>;
      delete(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    if (!this.opts.primary || !this.opts.mirrorDb) return;
    const mirrorDb = this.opts.mirrorDb;
    await mirrorToFirestore(`facade doc ${docPath}`, async () => {
      const segments = docPath.split("/").filter(Boolean);
      let cur: unknown = mirrorDb.collection(segments[0]);
      for (let i = 1; i < segments.length; i += 2) {
        cur = (cur as { doc(id: string): unknown }).doc(segments[i]);
        if (i + 1 < segments.length) {
          cur = (cur as { collection(name: string): unknown }).collection(segments[i + 1]);
        }
      }
      await op(cur as never);
    });
  }

  collection(name: string): unknown {
    if (this.opts.delegateCollections?.has(name) && this.opts.delegateDb) {
      return this.opts.delegateDb.collection(name);
    }
    const top = name.split("/")[0];
    if (!this.opts.allow.has(top)) {
      throw new SupaFacadeError(
        `supa facade: collection "${name}" is not served by this facade (allow-list: ${[...this.opts.allow].join(", ")}); refusing a mid-request cross-store split`,
      );
    }
    return new FacadeCollectionRef(this, name);
  }

  runTransaction<T>(fn: (tx: FacadeTransaction) => Promise<T>): Promise<T> {
    const run = this.txChain.then(() => fn(new FacadeTransaction()));
    this.txChain = run.catch(() => undefined);
    return run;
  }

  batch(): SupaFacadeBatch {
    return new SupaFacadeBatch(this);
  }

  /** Commit helper for SupaFacadeBatch (H-5 ordering lives here). */
  async commitBatch(ops: BatchOp[]): Promise<void> {
    const isFacadeRef = (r: unknown): r is FacadeDocRef =>
      !!r && typeof r === "object" && (r as { __supaFacadeRef?: unknown }).__supaFacadeRef === true;
    const delegated = ops.filter((o) => !isFacadeRef(o.ref));
    const own = ops.filter((o) => isFacadeRef(o.ref));
    if (delegated.length > 0) {
      if (!this.opts.delegateDb) {
        throw new SupaFacadeError("supa facade: batch contains delegated refs but no delegateDb was supplied");
      }
      const realBatch = this.opts.delegateDb.batch() as {
        set(ref: unknown, data: Record<string, unknown>): void;
        update(ref: unknown, data: Record<string, unknown>): void;
        delete(ref: unknown): void;
        commit(): Promise<void>;
      };
      for (const op of delegated) {
        if (op.kind === "set") realBatch.set(op.ref, op.data ?? {});
        else if (op.kind === "update") realBatch.update(op.ref, op.data ?? {});
        else realBatch.delete(op.ref);
      }
      await realBatch.commit(); // audit FIRST (H-5)
    }
    for (const op of own) {
      const ref = op.ref as FacadeDocRef;
      if (op.kind === "set") await ref.set(op.data ?? {}, op.opts);
      else if (op.kind === "update") await ref.update(op.data ?? {});
      else await ref.delete();
    }
  }
}

class FacadeTransaction {
  async get(ref: FacadeDocRef): Promise<FacadeSnapshot> {
    return ref.get();
  }
  async set(ref: FacadeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    await ref.set(data, opts);
  }
  async update(ref: FacadeDocRef, data: Record<string, unknown>): Promise<void> {
    await ref.update(data);
  }
}

export class SupaFacadeBatch {
  private ops: BatchOp[] = [];
  constructor(private facade: SupaFirestoreFacade) {}
  set(ref: unknown, data: Record<string, unknown>, opts?: { merge?: boolean }): this {
    this.ops.push({ kind: "set", ref, data, opts });
    return this;
  }
  update(ref: unknown, data: Record<string, unknown>): this {
    this.ops.push({ kind: "update", ref, data });
    return this;
  }
  delete(ref: unknown): this {
    this.ops.push({ kind: "delete", ref });
    return this;
  }
  async commit(): Promise<void> {
    await this.facade.commitBatch(this.ops);
  }
}
