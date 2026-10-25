/**
 * @jest-environment node
 *
 * Flag-ON mocked-adapter tests for the G1 seam (meetings-supa.ts):
 * the REAL meetings service (createMeeting / recordAttendance /
 * verifyQuorum / listMeetings) runs against the Supa facade, so the
 * quorum boundary is exercised end-to-end through jsonb-shaped
 * storage: present == quorumRequired convenes, one fewer does not.
 * Also pins: facade refuses non-allow-listed collections (no
 * mid-request cross-store split), and date round-trip at ms
 * precision through the service's own toDate helper (plan H-9).
 */
import { createFakeSupaAdapter } from "./fake-supa-adapter";
import { SupaFirestoreFacade, SupaFacadeError } from "../supa-facade";
import { MEETINGS_FACADE_COLLECTIONS } from "../meetings-supa";
import {
  createMeeting,
  getMeeting,
  listMeetings,
  recordAttendance,
  verifyQuorum,
} from "../meetings";

const T0 = new Date("2026-10-21T09:00:00.123Z");
const SCHED = new Date("2026-12-04T09:00:00.000Z"); // > notice window after T0
const MEMBERS = ["g1", "g2", "g3", "g4", "g5"];

function facadeWithBoard() {
  const adapter = createFakeSupaAdapter();
  adapter.seed("bodies", "board_body", {
    name: "Board of Governors",
    type: "board",
    chairUid: "g1",
    secretaryUid: "ngs_1",
    memberUids: MEMBERS,
    quorumOverride: null,
    quorum: null,
    chapterId: null,
  });
  const db = new SupaFirestoreFacade(adapter, { allow: MEETINGS_FACADE_COLLECTIONS });
  return { adapter, db };
}

async function createdMeeting(db: unknown) {
  return createMeeting(db as never, {
    bodyId: "board_body",
    type: "ordinary",
    title: "Board sitting",
    scheduledAt: SCHED,
    durationMinutes: 60,
    location: "Room 131",
    actorUid: "g1",
    meetingId: "mtg_1",
    now: T0,
  });
}

describe("meetings service over the Supa facade (flag ON)", () => {
  it("createMeeting writes the meeting + one absent attendance stub per member into Supa", async () => {
    const { adapter, db } = facadeWithBoard();
    const result = await createdMeeting(db);
    expect(result.meetingId).toBe("mtg_1");
    expect(adapter.raw("meetings", "mtg_1")?.title).toBe("Board sitting");
    expect(adapter.all("meeting_attendance")).toHaveLength(5);
    expect(adapter.raw("meeting_attendance", "mtg_1_g3")?.mode).toBe("absent");
  });

  it("date round-trip: scheduledAt/createdAt come back at ms precision via the service toDate helper", async () => {
    const { db } = facadeWithBoard();
    await createdMeeting(db);
    const meeting = await getMeeting(db as never, "mtg_1");
    expect(meeting?.scheduledAt).toEqual(SCHED);
    expect(meeting?.createdAt.getTime()).toBe(T0.getTime());
    const listed = await listMeetings(db as never, { bodyId: "board_body" });
    expect(listed).toHaveLength(1);
    expect(listed[0].scheduledAt).toEqual(SCHED);
  });

  it("quorum boundary through the facade: 4 of 5 present does NOT convene; the 5th does", async () => {
    const { adapter, db } = facadeWithBoard();
    await createdMeeting(db);
    // Board ordinary default quorum is 5 (all members).
    for (const uid of MEMBERS.slice(0, 4)) {
      await recordAttendance(db as never, { meetingId: "mtg_1", uid, mode: "in_person", actorUid: uid, now: T0 });
    }
    const notYet = await verifyQuorum(db as never, { meetingId: "mtg_1", actorUid: "g1", now: T0 });
    expect(notYet.quorumMet).toBe(false);
    expect(notYet.presentCount).toBe(4);
    await recordAttendance(db as never, { meetingId: "mtg_1", uid: "g5", mode: "electronic", actorUid: "g5", now: T0 });
    const met = await verifyQuorum(db as never, { meetingId: "mtg_1", actorUid: "g1", now: T0 });
    expect(met.quorumMet).toBe(true);
    expect(met.presentCount).toBe(5);
    const stored = adapter.raw("meetings", "mtg_1")!;
    expect(stored.status).toBe("convened");
    expect(stored.quorumVerifiedBy).toBe("g1");
    expect(stored.quorumVerifiedAt).toBe(T0.toISOString());
  });

  it("facade throws for a non-allow-listed collection (no cross-store split)", () => {
    const { db } = facadeWithBoard();
    expect(() => (db as never as { collection(n: string): unknown }).collection("tasks")).toThrow(SupaFacadeError);
    expect(() => (db as never as { collection(n: string): unknown }).collection("decisions")).toThrow(SupaFacadeError);
  });

  it("consent lookup through the facade: missing consent doc reads as state 'missing', decided reads decided", async () => {
    const { adapter, db } = facadeWithBoard();
    adapter.seed("consent_requests", "consent_1", { status: "consented" });
    const { lookupConsentState } = await import("../meetings");
    await expect(lookupConsentState(db as never, "consent_1")).resolves.toMatchObject({ decided: true, state: "decided" });
    await expect(lookupConsentState(db as never, "nope")).resolves.toMatchObject({ state: "missing" });
  });
});
