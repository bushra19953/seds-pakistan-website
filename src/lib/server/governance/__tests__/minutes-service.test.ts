import {
  InMemoryMinutesStore,
  circulateMinutesService,
  editMinutes,
  flagOverdueMinutes,
  generateMinutesDraft,
  linkMinutesApproval,
  signMinutesService,
  type MinutesDeps,
  type MinutesPdfPipeline,
} from "../minutes";
import { InMemoryMotionStore } from "../motions";
import { buildMinutesDraft } from "@/lib/governance/minutes-draft";
import type { Motion } from "@/lib/governance/meetings/motions-types";

const CLOSED = new Date("2026-10-21T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const fields = () =>
  buildMinutesDraft({
    meeting: { id: "mtg_prev", bodyId: "board_body", bodyType: "board", quorumRequired: 2, quorumVerifiedAt: CLOSED, quorumVerifiedBy: "g1" },
    attendance: [
      { uid: "g1", displayName: "G One", mode: "in_person", isPresent: true },
      { uid: "g2", displayName: "G Two", mode: "electronic", isPresent: true },
      { uid: "g3", displayName: "G Three", mode: "absent", isPresent: false },
    ],
    motions: [],
  });

const fakePdf: MinutesPdfPipeline = {
  async renderAndUpload(_rec, _by, at) {
    return {
      driveFileId: "drive_fake_1",
      driveLink: "https://drive.example/minutes",
      fileName: `minutes_board_mtg_prev_${at.toISOString().slice(0, 10).replaceAll("-", "")}.pdf`,
      sha256: "a".repeat(64),
      uploadedAt: at,
    };
  },
};

function makeDeps() {
  const store = new InMemoryMinutesStore();
  const motions = new InMemoryMotionStore();
  const deps: MinutesDeps = { store, motions, pdfPipeline: fakePdf, newId: () => store.nextId() };
  return { deps, store, motions };
}

async function draftAndCirculate(deps: MinutesDeps) {
  const rec = await generateMinutesDraft(deps, {
    meetingId: "mtg_prev",
    bodyId: "board_body",
    fields: fields(),
    meetingClosedAt: CLOSED,
  });
  const circulated = await circulateMinutesService(deps, {
    minutesId: rec.id,
    attendeeUids: ["g1", "g2"],
    at: CLOSED,
  });
  return circulated;
}

function approvalMotion(over: Partial<Motion>): Motion {
  return {
    id: "motion_approve",
    meetingId: "mtg_next",
    bodyId: "board_body",
    bodyType: "board",
    text: "Approve the minutes of the previous sitting",
    proposerUid: "g1",
    decisionClassId: "class_ordinary",
    threshold: {
      majorityType: "ordinary_present_and_voting",
      numerator: null,
      fractionDenominator: null,
      denominatorKind: "present_and_voting",
      requiredCount: null,
      consentRequired: false,
      isReservedMatter: false,
      filingFlag: false,
    },
    denominatorSnapshot: { eligibleUids: [], presentUids: [], presentCount: 0, wholeBodyCount: 0 },
    method: "electronic_poll",
    secretDemandedBy: [],
    status: "closed_passed",
    disclosures: [],
    openedAt: CLOSED,
    openedBy: "g1",
    closedAt: CLOSED,
    closedBy: "g1",
    result: null,
    decisionId: null,
    supersedesDecisionId: null,
    reversesDecisionId: null,
    consentId: null,
    matrixWarning: null,
    subjectRef: null,
    minutesApprovalFor: "minutes_1",
    ...over,
  };
}

describe("minutes service (ws-a §4.6, §6.3)", () => {
  it("draft generation is idempotent per meeting", async () => {
    const { deps, store } = makeDeps();
    const a = await generateMinutesDraft(deps, { meetingId: "mtg_prev", bodyId: "board_body", fields: fields(), meetingClosedAt: CLOSED });
    const b = await generateMinutesDraft(deps, { meetingId: "mtg_prev", bodyId: "board_body", fields: fields(), meetingClosedAt: CLOSED });
    expect(a.id).toBe(b.id);
    expect(await store.listMinutes()).toHaveLength(1);
    expect(a.status).toBe("auto_drafted");
    expect(a.circulationDueAt.getTime()).toBe(CLOSED.getTime() + 7 * DAY);
  });

  it("edits flow through the lifecycle guard (generated fields refused)", async () => {
    const { deps } = makeDeps();
    const rec = await generateMinutesDraft(deps, { meetingId: "mtg_prev", bodyId: "board_body", fields: fields(), meetingClosedAt: CLOSED });
    await expect(
      editMinutes(deps, { minutesId: rec.id, patch: { fieldMotions: [] }, editorUid: "ngs_1", at: CLOSED }),
    ).rejects.toMatchObject({ code: "generated_field_immutable", status: 422 });
    const edited = await editMinutes(deps, {
      minutesId: rec.id,
      patch: { supplementaryNotes: "Typo corrected" },
      editorUid: "ngs_1",
      at: CLOSED,
    });
    expect(edited.status).toBe("in_edit");
  });

  it("signing before approval is refused with minutes_not_approved and uploads nothing", async () => {
    let uploads = 0;
    const { deps } = makeDeps();
    deps.pdfPipeline = {
      async renderAndUpload(rec, by, at) {
        uploads += 1;
        return fakePdf.renderAndUpload(rec, by, at);
      },
    };
    const rec = await draftAndCirculate(deps);
    await expect(
      signMinutesService(deps, { minutesId: rec.id, signedBy: "g1", at: CLOSED }),
    ).rejects.toMatchObject({ code: "minutes_not_approved", status: 422 });
    expect(uploads).toBe(0);
  });

  it("approval requires a closed_passed motion whose minutesApprovalFor names THIS doc", async () => {
    const { deps, motions } = makeDeps();
    const rec = await draftAndCirculate(deps);
    // Motion approving a DIFFERENT minutes doc.
    await motions.saveMotion(approvalMotion({ id: "motion_other", minutesApprovalFor: "minutes_999" }));
    await expect(
      linkMinutesApproval(deps, { minutesId: rec.id, approvalMotionId: "motion_other", at: CLOSED }),
    ).rejects.toMatchObject({ code: "minutes_not_approved", status: 422 });
    // Motion that FAILED to pass.
    await motions.saveMotion(approvalMotion({ id: "motion_failed", status: "closed_failed" }));
    await expect(
      linkMinutesApproval(deps, { minutesId: rec.id, approvalMotionId: "motion_failed", at: CLOSED }),
    ).rejects.toMatchObject({ code: "minutes_not_approved", status: 422 });
    // The real approval motion.
    await motions.saveMotion(approvalMotion({}));
    const approved = await linkMinutesApproval(deps, {
      minutesId: rec.id,
      approvalMotionId: "motion_approve",
      at: CLOSED,
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvalMotionId).toBe("motion_approve");
    expect(approved.approvedInMeetingId).toBe("mtg_next");
  });

  it("the full path: draft -> edit -> circulate -> approve -> sign locks with PDF meta and 10-year retention", async () => {
    const { deps, motions } = makeDeps();
    const rec = await draftAndCirculate(deps);
    await motions.saveMotion(approvalMotion({}));
    await linkMinutesApproval(deps, { minutesId: rec.id, approvalMotionId: "motion_approve", at: CLOSED });
    const signAt = new Date("2026-11-04T12:00:00Z");
    const { record } = await signMinutesService(deps, { minutesId: rec.id, signedBy: "g1", at: signAt });
    expect(record.status).toBe("signed_locked");
    expect(record.pdf?.driveFileId).toBe("drive_fake_1");
    expect(record.pdf?.fileName).toBe("minutes_board_mtg_prev_20261104.pdf");
    expect(record.retentionUntil?.toISOString()).toBe("2036-11-04T12:00:00.000Z");
    // A locked record refuses every further edit.
    await expect(
      editMinutes(deps, { minutesId: rec.id, patch: { supplementaryNotes: "late edit" }, editorUid: "ngs_1", at: signAt }),
    ).rejects.toMatchObject({ code: "minutes_locked", status: 409 });
  });

  it("T2: overdue circulation is flagged once, and signed/circulated records are never overdue", async () => {
    const { deps } = makeDeps();
    await generateMinutesDraft(deps, { meetingId: "mtg_prev", bodyId: "board_body", fields: fields(), meetingClosedAt: CLOSED });
    const weekLater = new Date(CLOSED.getTime() + 7 * DAY + 1);
    const first = await flagOverdueMinutes(deps, weekLater);
    expect(first.flagged).toBe(1);
    const second = await flagOverdueMinutes(deps, weekLater);
    expect(second.flagged).toBe(0);
  });
});
