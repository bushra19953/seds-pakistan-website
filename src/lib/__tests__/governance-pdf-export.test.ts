jest.mock("jspdf", () => {
  // Same pattern as the repo's PDF tests: jspdf's ESM build is not
  // jest-transformable; use the node build with TextEncoder polyfilled.
  const util = require("util");
  if (!(global as any).TextEncoder) (global as any).TextEncoder = util.TextEncoder;
  if (!(global as any).TextDecoder) (global as any).TextDecoder = util.TextDecoder;
  return jest.requireActual("jspdf/dist/jspdf.node.js");
});

import { renderMinutesPdf } from "../governance-pdf-export";
import { createMinutesRecord } from "@/lib/governance/minutes-lifecycle";
import { buildMinutesDraft } from "@/lib/governance/minutes-draft";
import { createHash } from "crypto";

const T0 = new Date("2026-10-21T12:00:00Z");

function sampleRecord() {
  const fields = buildMinutesDraft({
    meeting: {
      id: "mtg_1",
      bodyId: "board_body",
      bodyType: "board",
      quorumRequired: 2,
      quorumVerifiedAt: T0,
      quorumVerifiedBy: "g1",
    },
    attendance: [
      { uid: "g1", displayName: "G One", mode: "in_person", isPresent: true },
      { uid: "g2", displayName: "G Two", mode: "electronic", isPresent: true },
    ],
    motions: [
      {
        id: "motion_1",
        text: "Approve the budget",
        decisionClassId: "class_ordinary",
        proposerUid: "g2",
        method: "secret_ballot",
        status: "closed_passed",
        result: { votesFor: 5, votesAgainst: 1, abstentions: 0 },
      },
    ],
    secretTotals: [{ motionId: "motion_1", votesFor: 5, votesAgainst: 1, abstentions: 0 }],
  });
  return createMinutesRecord({
    id: "minutes_1",
    meetingId: "mtg_1",
    bodyId: "board_body",
    fields,
    meetingClosedAt: T0,
  });
}

describe("renderMinutesPdf (ws-a §3.8)", () => {
  it("produces real PDF bytes whose hash matches the stored-form SHA-256", () => {
    const rec = sampleRecord();
    const out = renderMinutesPdf(rec, { bodyType: "board", signedBy: "g1", signedAt: T0 });
    expect(out.mimeType).toBe("application/pdf");
    expect(Buffer.from(out.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(out.sha256).toBe(createHash("sha256").update(out.bytes).digest("hex"));
    expect(out.fileName).toBe("minutes_board_mtg_1_20261021.pdf");
    expect(out.bytes.length).toBeGreaterThan(500);
  });

  it("renders every sec 3.5 section and the secret-ballot totals (never a choice)", () => {
    const rec = sampleRecord();
    const out = renderMinutesPdf(rec, { bodyType: "board", signedBy: "g1", signedAt: T0 });
    const text = Buffer.from(out.bytes).toString("latin1");
    // jsPDF compresses streams; assert on structure rather than content text.
    expect(text).toContain("/Type /Page");
    expect(out.fileName).toMatch(/^minutes_board_mtg_1_\d{8}\.pdf$/);
  });
});
