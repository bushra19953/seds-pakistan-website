/**
 * Governance PDF export (ws-a §3.8) — signed minutes renderer.
 *
 * Renders a LOCKED minutes record to PDF bytes with jsPDF, following the
 * repo's PDF layout rules: absolute positioning with generous padding,
 * clean vertical stacks, nothing near card edges. The content is exactly
 * the six Procedure Manual sec 3.5 fields plus the signature block —
 * the PDF is the printable form of the stored record, never a second
 * source of truth (the minutes doc is; the SHA-256 of these bytes is
 * stored back on the doc at signing).
 *
 * Server-side use: returns the raw bytes + content hash + the canonical
 * file name (`minutes_<bodyType>_<meetingId>_<signedDateYYYYMMDD>.pdf`).
 * Drive upload is the caller's step (minutes service pipeline).
 */

import { jsPDF } from "jspdf";
import { createHash } from "crypto";
import type { MinutesRecord } from "@/lib/governance/minutes-lifecycle";

export function minutesPdfFileName(rec: MinutesRecord, bodyType: string, signedAt: Date): string {
  const ymd = signedAt.toISOString().slice(0, 10).replaceAll("-", "");
  return `minutes_${bodyType}_${rec.meetingId}_${ymd}.pdf`;
}

export interface RenderedMinutesPdf {
  bytes: Uint8Array;
  fileName: string;
  sha256: string;
  mimeType: "application/pdf";
}

function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return "-";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export function renderMinutesPdf(
  rec: MinutesRecord,
  opts: { bodyType: string; signedBy: string; signedAt: Date },
): RenderedMinutesPdf {
  const { signedBy, signedAt } = opts;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 56;
  const width = 595 - margin * 2;
  let y = margin;

  const line = (text: string, size = 10, gap = 14) => {
    doc.setFontSize(size);
    const wrapped = doc.splitTextToSize(text, width) as string[];
    for (const w of wrapped) {
      if (y > 780) {
        doc.addPage();
        y = margin;
      }
      doc.text(w, margin, y);
      y += gap;
    }
  };
  const heading = (text: string) => {
    y += 6;
    line(text, 13, 18);
  };

  doc.setFont("helvetica", "bold");
  line("SEDS Pakistan — Minutes of Meeting", 16, 22);
  doc.setFont("helvetica", "normal");
  line(`Meeting: ${rec.meetingId}`);
  line(`Body: ${rec.bodyId}`);
  line(`Status: signed and locked`);
  line(`Signed by: ${signedBy} on ${fmtDate(signedAt)}`);

  const names = (xs: Array<{ uid: string; displayName: string }>) =>
    xs.map((x) => `${x.displayName} (${x.uid})`).join(", ") || "-";
  const a = rec.fieldAttendees;
  heading("(a) Attendees");
  line(`Present: ${names(a.present)}`);
  line(`Present electronically: ${names(a.electronic)}`);
  line(`Absent: ${names(a.absent)}`);

  const q = rec.fieldQuorum;
  heading("(b) Quorum verification");
  line(`Required: ${q.quorumRequired}  Present: ${q.presentCount}  Met: ${q.met ? "yes" : "no"}`);
  line(`Verified at: ${fmtDate(q.verifiedAt as Date)}  Verified by: ${q.verifiedBy ?? "-"}`);

  heading("(c) Interest disclosures");
  if (rec.fieldDisclosures.length === 0) line("None recorded.");
  for (const d of rec.fieldDisclosures) {
    line(`Motion ${d.motionId} — ${d.displayName} (${d.uid}): ${d.description}`);
  }

  heading("(d) Motions");
  if (rec.fieldMotions.length === 0) line("No motions were moved.");
  for (const m of rec.fieldMotions) {
    line(`[${m.decisionClassId}] ${m.text} (proposed by ${m.proposerUid})`);
  }

  heading("(e) Voting record");
  if (rec.fieldVoting.length === 0) line("No votes were taken.");
  for (const v of rec.fieldVoting) {
    // Secret ballots carry totals only — this renderer never sees a choice.
    line(
      `Motion ${v.motionId} (${v.method}): for ${v.votesFor}, against ${v.votesAgainst}, abstentions ${v.abstentions}` +
        (v.castingVoteUsed ? `, casting vote used (${v.castingChoice ?? "-"})` : ""),
    );
  }

  heading("(f) Consents referenced");
  if (rec.fieldConsents.length === 0) line("None.");
  for (const c of rec.fieldConsents) {
    line(`Consent ${c.consentId}: ${c.matter} — ${c.outcome}`);
  }

  if (rec.supplementaryNotes) {
    heading("Supplementary notes");
    line(rec.supplementaryNotes);
  }

  y += 12;
  line(`Retention until: ${fmtDate(rec.retentionUntil)}`);
  line(`Minutes document: ${rec.id}`);

  const bytes = new Uint8Array(doc.output("arraybuffer"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, fileName: minutesPdfFileName(rec, opts.bodyType, signedAt), sha256, mimeType: "application/pdf" };
}
