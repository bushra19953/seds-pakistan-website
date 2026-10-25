/**
 * @jest-environment node
 *
 * Flag-ON mocked-adapter tests for the G3 seam
 * (minutes-circular-supa.ts):
 * - minutes generate -> circulate -> approve-link -> sign runs over
 *   SupaMinutesStore with the pipeline seeing the PRE-SIGN record
 *   (ordering contract), retention +10y, dates revived from ISO;
 * - circular pass boundary on an EVEN electorate (8 Governors, need
 *   5) runs over SupaCircularStore with the G4 decisions client:
 *   the 4th signature leaves it circulating, the 5th passes and
 *   writes exactly one register entry;
 * - C-5 pin: listOpenResolutions keeps the verbatim status=='open'
 *   query (a 'circulating' record is NOT returned — the suspected
 *   dead query is preserved, not "fixed").
 */
import { createFakeSupaAdapter } from "./fake-supa-adapter";
import { SupaCircularStore, SupaMinutesStore } from "../minutes-circular-supa";
import { SupaDecisionsClient } from "../decisions-supa";
import {
  InMemoryMinutesStore,
  circulateMinutesService,
  generateMinutesDraft,
  linkMinutesApproval,
  signMinutesService,
  type MinutesDeps,
  type MinutesPdfPipeline,
} from "../minutes";
import {
  InMemoryCircularStore,
  createCircularDraft,
  circulateCircular,
  signCircular,
  type CircularDeps,
} from "../circular";
import { InMemoryMotionStore } from "../motions";
import { InMemoryDecisionsClient } from "../decisions-client";
import { InMemoryDecisionClassesReader, type ServerDecisionClassView } from "../decision-classes";
import { InMemoryBodyReader, InMemoryFilingTaskCreator, type BodyView } from "../shared";
import { InMemoryConsentsClient } from "../consents-client";
import { buildMinutesDraft } from "@/lib/governance/minutes-draft";
import type { MinutesRecord } from "@/lib/governance/minutes-lifecycle";
import type { Motion } from "@/lib/governance/meetings/motions-types";

const T0 = new Date("2026-10-21T09:00:00Z");
const CLOSED = new Date("2026-10-21T12:00:00Z");
const GOV8 = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"];
const board8: BodyView = {
  id: "board_body", name: "Board of Governors", type: "board",
  chairUid: "g1", secretaryUid: "ngs_1", memberUids: [...GOV8],
  quorumOverride: null, chapterId: null,
};

describe("minutes services over SupaMinutesStore (flag ON)", () => {
  function makeDeps() {
    const adapter = createFakeSupaAdapter();
    const store = new SupaMinutesStore(adapter, new InMemoryMinutesStore());
    const motions = new InMemoryMotionStore();
    const pipelineCalls: Array<{ status: string; signedBy: string | null }> = [];
    const pdfPipeline: MinutesPdfPipeline = {
      async renderAndUpload(rec: MinutesRecord, by: string, at: Date) {
        pipelineCalls.push({ status: rec.status, signedBy: rec.signedBy });
        return {
          driveFileId: "drive_fake_1", driveLink: "https://drive.example/minutes",
          fileName: "minutes.pdf", sha256: "a".repeat(64), uploadedAt: at,
        };
      },
    };
    const deps: MinutesDeps = { store, motions, pdfPipeline, newId: () => store.nextId() };
    return { adapter, deps, store, motions, pipelineCalls };
  }

  it("sign flow: pipeline sees the pre-sign record; stored record locks with +10y retention", async () => {
    const ctx = makeDeps();
    const fields = buildMinutesDraft({
      meeting: { id: "mtg_prev", bodyId: "board_body", bodyType: "board", quorumRequired: 2, quorumVerifiedAt: CLOSED, quorumVerifiedBy: "g1" },
      attendance: [
        { uid: "g1", displayName: "G One", mode: "in_person", isPresent: true },
        { uid: "g2", displayName: "G Two", mode: "electronic", isPresent: true },
      ],
      motions: [],
    });
    const rec = await generateMinutesDraft(ctx.deps, {
      meetingId: "mtg_prev", bodyId: "board_body", fields, meetingClosedAt: CLOSED,
    });
    await circulateMinutesService(ctx.deps, { minutesId: rec.id, attendeeUids: ["g1", "g2"], at: CLOSED });
    await ctx.motions.saveMotion({
      id: "motion_approve", meetingId: "mtg_next", minutesApprovalFor: rec.id, status: "closed_passed",
    } as Motion);
    const approved = await linkMinutesApproval(ctx.deps, {
      minutesId: rec.id, approvalMotionId: "motion_approve", at: CLOSED,
    });
    expect(approved.approvedInMeetingId).toBe("mtg_next");
    const { record } = await signMinutesService(ctx.deps, { minutesId: rec.id, signedBy: "ngs_1", at: CLOSED });
    expect(ctx.pipelineCalls).toEqual([{ status: "approved", signedBy: null }]);
    expect(record.status).toBe("signed_locked");
    expect(record.retentionUntil?.getUTCFullYear()).toBe(CLOSED.getUTCFullYear() + 10);
    const raw = ctx.adapter.raw("minutes", rec.id)!;
    expect(raw.status).toBe("signed_locked");
    expect(typeof raw.circulationDueAt).toBe("string"); // stored as ISO in jsonb
    const back = await ctx.store.getMinutes(rec.id);
    expect(back?.circulationDueAt).toBeInstanceOf(Date);
  });
});

describe("circular services over SupaCircularStore (flag ON)", () => {
  const circClass: ServerDecisionClassView = {
    id: "class_board_ordinary", label: "Board ordinary business (circular)",
    assignedBodyType: "board", majorityType: "fraction_of_all_governors",
    numerator: 1, denominatorKind: "all_governors", consentRequired: true,
    isReservedMatter: false, filingFlag: false, sourceRow: "5.18", enforcementMode: "enforce",
  };

  function makeDeps() {
    const adapter = createFakeSupaAdapter();
    const store = new SupaCircularStore(adapter, new InMemoryCircularStore() as never);
    const decisions = new SupaDecisionsClient(adapter, new InMemoryDecisionsClient() as never);
    const consents = new InMemoryConsentsClient();
    consents.add({ id: "consent_1", status: "granted", matter: "Telescope", proposedAct: "Buy it", decidedAt: T0, decidedBy: "founder", meetingId: null });
    const deps: CircularDeps = {
      store, decisions,
      bodies: new InMemoryBodyReader([board8]),
      classes: new InMemoryDecisionClassesReader([circClass]),
      consents,
      filingTasks: new InMemoryFilingTaskCreator(),
      newId: () => store.nextId(),
    };
    return { adapter, deps, store, decisions };
  }

  it("even-electorate boundary: 4th signature circulates, 5th passes with exactly one register entry", async () => {
    const { adapter, deps } = makeDeps();
    const { resolution } = await createCircularDraft(deps, {
      bodyId: "board_body", title: "Buy the telescope", text: "Resolved: buy it",
      decisionClassId: "class_board_ordinary", consentId: "consent_1", createdBy: "g1", at: T0,
    });
    const circ = await circulateCircular(deps, { resolutionId: resolution.id, actorUid: "g1", isFounder: false, at: T0 });
    expect(circ.majorityNeeded).toBe(5);
    // closesAt = circulatedAt + 7 days, revived as a Date from ISO storage.
    const stored = await deps.store.getResolution(resolution.id);
    expect(stored?.closesAt).toBeInstanceOf(Date);
    expect(stored?.closesAt?.getTime()).toBe(T0.getTime() + 7 * 24 * 60 * 60 * 1000);
    for (const uid of GOV8.slice(0, 4)) {
      const r = await signCircular(deps, { resolutionId: resolution.id, uid, displayName: uid, at: T0 });
      expect(r.status).toBe("circulating");
    }
    expect(adapter.all("decisions")).toHaveLength(0);
    const fifth = await signCircular(deps, { resolutionId: resolution.id, uid: "g5", displayName: "g5", at: T0 });
    expect(fifth.status).toBe("passed");
    expect(adapter.all("decisions")).toHaveLength(1);
    expect(adapter.all("decisions")[0].data.source).toBe("circular");
  });

  it("C-5 pin: listOpenResolutions queries status 'open' verbatim — a circulating record is NOT listed", async () => {
    const { deps, store } = makeDeps();
    const { resolution } = await createCircularDraft(deps, {
      bodyId: "board_body", title: "T", text: "X",
      decisionClassId: "class_board_ordinary", consentId: "consent_1", createdBy: "g1", at: T0,
    });
    await circulateCircular(deps, { resolutionId: resolution.id, actorUid: "g1", isFounder: false, at: T0 });
    const open = await (store as SupaCircularStore).listOpenResolutions();
    expect(open.map((r) => r.id)).not.toContain(resolution.id);
  });
});
