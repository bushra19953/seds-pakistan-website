/**
 * G3 SEAM — minutes + circular resolutions (Supabase). Plan §1-G3,
 * §2-G3, §3, §8.
 *
 * Holds Supa implementations of FirestoreMinutesStore and
 * FirestoreCircularStore. The pure services (server/governance/
 * minutes.ts, circular.ts) are untouched. The Drive minutes PDF
 * pipeline's RECORD side rides the minutes store; the Drive upload
 * itself stays Google Drive (DriveMinutesPdfPipeline is not
 * re-implemented — it receives the same MinutesRecord shape).
 *
 * Flag: surface 'minutes' (circulars ride the G3 surface). Flag OFF
 * / adapter error = Firestore byte-identical; store methods delegate
 * to their Firestore counterpart on adapter error.
 *
 * Verbatim-behaviour notes:
 * - listMinutes is a FULL-COLLECTION read (census C16) serving
 *   listOverdue/flagOverdue; it becomes an unfiltered listDocs. It
 *   must NOT be "optimised" into a filtered query here (plan §2-G3).
 * - FirestoreCircularStore.listOpenResolutions queries
 *   status == 'open' while the pure engine's live status is
 *   'circulating' (plan C-5 — strong suspicion the query is dead
 *   today). The query is ported VERBATIM with this comment; do not
 *   "fix" it to 'circulating' — that changes which rows a caller
 *   receives and needs its own decision + test.
 * - Dates: minutes fields convert through the same reqDate/toDate
 *   rules as minutesFromDoc; circular records revive ISO strings to
 *   Dates deep (the service compares Date objects; the Firestore
 *   store spreads raw docs whose Timestamp values the service layer
 *   already treats opaquely by field).
 */

import type { MinutesRecord } from "@/lib/governance/minutes-lifecycle";
import type { CircularResolution } from "@/lib/governance/circular/types";
import type { MinutesStore } from "./minutes";
import { toDate } from "./firestore-stores";
import {
  newFirestoreId,
  reviveDatesDeep,
  stripDocId,
  type GovSupaAdapter,
} from "./supa-shared";

function reqDate(v: unknown, fallback: Date): Date {
  return toDate(v) ?? fallback;
}

/** Mirror of firestore-stores' minutesFromDoc over an adapter doc body. */
function minutesFromData(id: string, raw: Record<string, unknown>): MinutesRecord {
  const data = reviveDatesDeep(raw) as Record<string, unknown>;
  return {
    ...(data as unknown as MinutesRecord),
    id,
    circulationDueAt: reqDate(data.circulationDueAt, new Date(0)),
    updatedAt: reqDate(data.updatedAt, new Date(0)),
    circulatedAt: toDate(data.circulatedAt),
    signedAt: toDate(data.signedAt),
    retentionUntil: toDate(data.retentionUntil),
  } as MinutesRecord;
}

export class SupaMinutesStore implements MinutesStore {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: MinutesStore & { nextId(): string },
  ) {}

  async getMinutes(id: string): Promise<MinutesRecord | null> {
    try {
      const doc = await this.adapter.getDoc("minutes", id);
      return doc ? minutesFromData(id, stripDocId(doc)) : null;
    } catch {
      return this.fallback.getMinutes(id);
    }
  }

  async saveMinutes(rec: MinutesRecord): Promise<void> {
    try {
      await this.adapter.setDoc("minutes", rec.id, { ...rec }, { merge: true });
    } catch {
      return this.fallback.saveMinutes(rec);
    }
  }

  /** FULL-COLLECTION read, verbatim (census C16 — no filter added). */
  async listMinutes(): Promise<MinutesRecord[]> {
    try {
      const docs = await this.adapter.listDocs("minutes");
      return docs.map((d) => minutesFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listMinutes();
    }
  }

  async getByMeetingId(meetingId: string): Promise<MinutesRecord | null> {
    try {
      const docs = await this.adapter.listDocs("minutes", {
        where: [["meetingId", "==", meetingId]],
        limit: 1,
      });
      return docs.length === 0 ? null : minutesFromData(docs[0].id, stripDocId(docs[0]));
    } catch {
      return this.fallback.getByMeetingId(meetingId);
    }
  }

  nextId(): string {
    return newFirestoreId();
  }
}

function circularFromData(id: string, raw: Record<string, unknown>): CircularResolution {
  const data = reviveDatesDeep(raw) as Record<string, unknown>;
  return { ...(data as unknown as CircularResolution), id } as CircularResolution;
}

export class SupaCircularStore {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: {
      createResolution(rec: CircularResolution): Promise<void>;
      getResolution(id: string): Promise<CircularResolution | null>;
      saveResolution(rec: CircularResolution): Promise<void>;
      listOpenResolutions(): Promise<CircularResolution[]>;
      listResolutions(): Promise<CircularResolution[]>;
      nextId(): string;
    },
  ) {}

  async createResolution(rec: CircularResolution): Promise<void> {
    try {
      await this.adapter.setDoc("circular_resolutions", rec.id, { ...rec });
    } catch {
      return this.fallback.createResolution(rec);
    }
  }

  async getResolution(id: string): Promise<CircularResolution | null> {
    try {
      const doc = await this.adapter.getDoc("circular_resolutions", id);
      return doc ? circularFromData(id, stripDocId(doc)) : null;
    } catch {
      return this.fallback.getResolution(id);
    }
  }

  async saveResolution(rec: CircularResolution): Promise<void> {
    try {
      await this.adapter.setDoc("circular_resolutions", rec.id, { ...rec }, { merge: true });
    } catch {
      return this.fallback.saveResolution(rec);
    }
  }

  async listOpenResolutions(): Promise<CircularResolution[]> {
    try {
      // C-5: status 'open' verbatim — see the header note. Do not fix.
      const docs = await this.adapter.listDocs("circular_resolutions", {
        where: [["status", "==", "open"]],
      });
      return docs.map((d) => circularFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listOpenResolutions();
    }
  }

  /** FULL-COLLECTION read, verbatim (census C16 — no filter added). */
  async listResolutions(): Promise<CircularResolution[]> {
    try {
      const docs = await this.adapter.listDocs("circular_resolutions");
      return docs.map((d) => circularFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listResolutions();
    }
  }

  nextId(): string {
    return newFirestoreId();
  }
}
