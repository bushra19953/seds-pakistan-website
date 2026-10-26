/**
 * G1 SEAM — meetings core (Supabase). Plan §1-G1, §2-G1, §3, §8.
 *
 * Holds:
 *   - Supa implementations of the G1 store classes consumed through
 *     getGovernanceRouteDeps(): SupaMeetingReader,
 *     SupaAttendanceReader, SupaBodyReader (bodies are READ-ONLY for
 *     this whole cluster — no in-scope code writes `bodies`, §5).
 *   - A FirestoreLike facade (supa-facade.ts) for the direct-`db`
 *     service in server/governance/meetings.ts, obtained by the
 *     meetings routes via resolveMeetingsDb(). The facade serves
 *     meetings, meeting_attendance, bodies, consent_requests from
 *     Supa and THROWS for any other collection (never a per-collection
 *     fall-through mid-request, plan §1-G1 rule).
 *
 * Flag: surface 'meetings'. Flag OFF / adapter error at composition
 * time = Firestore classes + the real getDb() handle, byte-identical.
 * Store methods delegate to their Firestore counterpart on adapter
 * error, matching the other groups' seam contract.
 *
 * Identity/permission reads (hasServerPermissionForUser,
 * resolveUserRole) keep their FIRESTORE handles in the routes even
 * when this flag is ON — mixed mode is correct there (plan §5);
 * only the service `db` handle is swapped.
 *
 * CUTOVER (write primacy, isSupaPrimary('meetings')): the meetings
 * service's writes ride the facade (above), so primacy lands there:
 * Supa commits, Firestore mirrors post-commit best-effort. The
 * readers in this file are read-only and unchanged. SUPA_PRIMARY
 * off = byte-identical.
 *
 * Client-read ruling (plan §1-G1): the two live-listener pages
 * (src/app/admin/meetings/page.tsx, src/app/meetings/[meetingId]/
 * page.tsx) keep reading `motions` via the client Firestore SDK —
 * the adapter has no onSnapshot equivalent. See the SUPA-BLOCKED
 * comments in those pages.
 */

import { getDb } from "@/lib/server/firebase-admin";
import type { FirestoreLike } from "./meetings";
import type { BodyView } from "./shared";
import type { AttendanceReader, MeetingReader, MeetingView } from "./motions";
import type { BodyReader } from "./shared";
import type { BodyDirectory } from "./urgent";
import { PRESENT_STATUSES, toDate } from "./firestore-stores";
import {
  govSupaAdapterFor,
  govSupaPrimaryFor,
  reviveDatesDeep,
  stripDocId,
  type GovSupaAdapter,
} from "./supa-shared";
import { SupaFirestoreFacade } from "./supa-facade";

export const MEETINGS_FACADE_COLLECTIONS: ReadonlySet<string> = new Set([
  "meetings",
  "meeting_attendance",
  "bodies",
  "consent_requests",
]);

/**
 * The `db` handle for the meetings service routes: the Supa facade
 * when the 'meetings' surface is on and an adapter resolves, else the
 * real Firestore db (which may itself be null — the routes keep their
 * existing db_unavailable handling for that case).
 */
export function resolveMeetingsDb(): FirestoreLike {
  const adapter = govSupaAdapterFor("meetings");
  if (adapter) {
    // Cutover primacy: with isSupaPrimary('meetings') on and a real
    // Firestore db available, facade writes commit in Supa and
    // mirror to Firestore post-commit, best-effort (supa-facade.ts).
    const realDb = govSupaPrimaryFor("meetings") ? getDb() : null;
    return new SupaFirestoreFacade(adapter, {
      allow: MEETINGS_FACADE_COLLECTIONS,
      ...(realDb ? { primary: true, mirrorDb: realDb as never } : {}),
    });
  }
  return getDb();
}

function bodyFromData(id: string, data: Record<string, unknown>): BodyView {
  return {
    id,
    name: String(data.name ?? id),
    type: String(data.type ?? ""),
    chairUid: String(data.chairUid ?? ""),
    secretaryUid: String(data.secretaryUid ?? ""),
    memberUids: Array.isArray(data.memberUids) ? (data.memberUids as string[]) : [],
    quorumOverride: (data.quorumOverride as number | null) ?? null,
    chapterId: (data.chapterId as string | null) ?? null,
  };
}

export class SupaBodyReader implements BodyReader, BodyDirectory {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: BodyReader & BodyDirectory & {
      listBodiesForMember(uid: string): Promise<BodyView[]>;
    },
  ) {}

  async getBody(bodyId: string): Promise<BodyView | null> {
    try {
      const doc = await this.adapter.getDoc("bodies", bodyId);
      return doc ? bodyFromData(bodyId, stripDocId(doc)) : null;
    } catch {
      return this.fallback.getBody(bodyId);
    }
  }

  async getBodyByType(bodyType: string): Promise<BodyView | null> {
    try {
      const docs = await this.adapter.listDocs("bodies", {
        where: [["type", "==", bodyType]],
        limit: 1,
      });
      return docs.length === 0 ? null : bodyFromData(docs[0].id, stripDocId(docs[0]));
    } catch {
      return this.fallback.getBodyByType(bodyType);
    }
  }

  async listBodiesForMember(uid: string): Promise<BodyView[]> {
    try {
      const docs = await this.adapter.listDocs("bodies", {
        where: [["memberUids", "array-contains", uid]],
      });
      return docs.map((d) => bodyFromData(d.id, stripDocId(d)));
    } catch {
      return this.fallback.listBodiesForMember(uid);
    }
  }
}

export class SupaMeetingReader implements MeetingReader {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: MeetingReader,
  ) {}

  async getMeeting(meetingId: string): Promise<MeetingView | null> {
    try {
      const doc = await this.adapter.getDoc("meetings", meetingId);
      if (!doc) return null;
      const data = stripDocId(doc);
      return {
        id: meetingId,
        bodyId: String(data.bodyId ?? ""),
        bodyType: String(data.bodyType ?? ""),
        chairUid: String(data.chairUid ?? ""),
        secretaryUid: String(data.secretaryUid ?? ""),
        status: String(data.status ?? "draft"),
        quorumRequired: Number(data.quorumRequired ?? 0),
        quorumVerifiedAt: toDate(reviveDatesDeep(data.quorumVerifiedAt)),
      };
    } catch {
      return this.fallback.getMeeting(meetingId);
    }
  }
}

export class SupaAttendanceReader implements AttendanceReader {
  constructor(
    private adapter: GovSupaAdapter,
    private fallback: AttendanceReader,
  ) {}

  async listPresentUids(meetingId: string): Promise<string[]> {
    try {
      const docs = await this.adapter.listDocs("meeting_attendance", {
        where: [["meetingId", "==", meetingId]],
      });
      return docs
        .map((d) => stripDocId(d))
        .filter((data) => PRESENT_STATUSES.has(String(data.status ?? "")))
        .map((data) => String(data.uid ?? ""))
        .filter(Boolean);
    } catch {
      return this.fallback.listPresentUids(meetingId);
    }
  }
}
