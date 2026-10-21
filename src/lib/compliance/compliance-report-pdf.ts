/**
 * Quarterly compliance report PDF (phase2_spec.md Section G.10).
 *
 * jsPDF, A4 portrait, mm - mirroring src/lib/workflow-pdf-export.ts
 * conventions. NOTE: the clickable-URL helpers below DUPLICATE
 * drawClickableUrl / measureUrlLines from workflow-pdf-export.ts (which
 * are not exported there). The spec prefers extracting shared helpers
 * into src/lib/pdf-primitives.ts; extraction was judged too invasive for
 * this workstream, so the two small helpers are duplicated here with this
 * pointer at the original - drift between the two is a known accepted
 * cost (spec G.10).
 */

import { jsPDF } from 'jspdf';
import type { QuarterlyReportData } from '@/lib/server/compliance/report-aggregator';

const LINK_BLUE: [number, number, number] = [29, 78, 216];
const INK: [number, number, number] = [24, 24, 27];
const MUTED: [number, number, number] = [113, 113, 122];
const BAND: [number, number, number] = [24, 24, 27];

function wrapUrlLines(doc: jsPDF, url: string, maxWidth: number, fontSize: number): string[] {
  doc.setFontSize(fontSize);
  const lines: string[] = [];
  let rest = url;
  while (rest.length > 0) {
    if (doc.getTextWidth(rest) <= maxWidth) {
      lines.push(rest);
      break;
    }
    let cut = rest.length;
    while (cut > 1 && doc.getTextWidth(rest.slice(0, cut)) > maxWidth) cut -= 1;
    // Prefer breaking at a URL separator at or before the width limit.
    const windowText = rest.slice(0, cut);
    const sep = Math.max(
      windowText.lastIndexOf('/'),
      windowText.lastIndexOf('-'),
      windowText.lastIndexOf('_'),
      windowText.lastIndexOf('?'),
      windowText.lastIndexOf('&'),
      windowText.lastIndexOf('='),
    );
    if (sep > 0) cut = sep + 1;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return lines;
}

function measureUrlLines(doc: jsPDF, url: string, maxWidth: number, fontSize = 7): number {
  if (!url) return 0;
  return wrapUrlLines(doc, url, maxWidth, fontSize).length;
}

/** Draws visible, clickable, underlined URL text. Returns vertical mm consumed. */
function drawClickableUrl(
  doc: jsPDF,
  url: string,
  x: number,
  y: number,
  maxWidth: number,
  opts?: { fontSize?: number },
): number {
  const fontSize = opts?.fontSize ?? 7;
  if (!url) return 0;
  const lines = wrapUrlLines(doc, url, maxWidth, fontSize);
  if (lines.length === 0) return 0;
  doc.setFontSize(fontSize);
  doc.setTextColor(...LINK_BLUE);
  doc.setDrawColor(...LINK_BLUE);
  doc.setLineWidth(0.15);
  const lineHeight = fontSize * 0.55;
  lines.forEach((line, i) => {
    const baseline = y + i * lineHeight;
    const w = doc.getTextWidth(line);
    doc.text(line, x, baseline);
    doc.line(x, baseline + 0.8, x + w, baseline + 0.8);
    doc.link(x, baseline - lineHeight + 0.3, w, lineHeight, { url });
  });
  doc.setTextColor(...INK);
  return lines.length * lineHeight;
}

const MARGIN = 14;
const LINE = 4.6;

export function renderQuarterlyReportPdf(data: QuarterlyReportData): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;
  let y = MARGIN;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };
  const heading = (text: string, size = 13) => {
    ensureSpace(10);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(...INK);
    doc.text(text, MARGIN, y);
    y += LINE + 1.5;
    doc.setFont('helvetica', 'normal');
  };
  const line = (text: string, size = 9) => {
    ensureSpace(LINE + 1);
    doc.setFontSize(size);
    doc.setTextColor(...INK);
    const wrapped = doc.splitTextToSize(text, contentWidth) as string[];
    for (const part of wrapped) {
      ensureSpace(LINE);
      doc.text(part, MARGIN, y);
      y += LINE;
    }
  };
  const generatedKarachi = new Date(data.generatedAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  // ------------------------------------------------------------- COVER
  doc.setFillColor(...BAND);
  doc.rect(0, 0, pageWidth, 34, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Quarterly Compliance Report', MARGIN, 15);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `SEDS Pakistan - ${data.quarterKey} - ${data.quarterLabel} - ${data.fyLabel}`,
    MARGIN,
    23,
  );
  doc.setFontSize(8.5);
  doc.text(`Generated ${generatedKarachi} (Asia/Karachi) by the compliance engine.`, MARGIN, 29.5);
  y = 44;

  // ----------------------------------------------------------- SUMMARY
  heading('Summary');
  const s = data.summary;
  line(`Due in quarter: ${s.dueInQuarter}`);
  line(`Completed on time: ${s.completedOnTime}    Completed late: ${s.completedLate}`);
  line(`Overdue (open): ${s.overdueOpen}    Waived: ${s.waived}    In default: ${s.inDefault}`);
  line(`Cured: ${s.cured}    Escalated: ${s.escalated}`);
  line(
    `Integrity: orphan event instances ${data.integrity.orphanEventInstances}; evidence unreviewed >14d ${data.integrity.evidenceUnreviewedOver14d}; incomplete notice receipts ${data.integrity.incompleteReceipts}.`,
  );
  y += 3;

  // ------------------------------------------------- SECTION 1: duties
  heading('Section 1 - Obligations');
  if (data.obligations.length === 0) {
    line('No obligations fell due in this quarter.');
  }
  for (const row of data.obligations) {
    const evidenceLines = row.evidenceRef ? measureUrlLines(doc, row.evidenceRef, contentWidth - 4) : 0;
    ensureSpace(LINE * (3 + evidenceLines) + 3);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(`${row.title} (${row.templateKey})`, MARGIN, y);
    y += LINE;
    doc.setFont('helvetica', 'normal');
    line(
      `Office: ${row.office} | Due: ${row.dueDate.slice(0, 10)} | Status: ${row.statusAtGeneration} | Responsible holder (snapshot): ${row.ownerUidSnapshot ?? 'vacant'} | Current holder: ${row.currentHolderUid ?? 'vacant'}`,
      8.5,
    );
    if (row.completedAt) line(`Completed: ${row.completedAt.slice(0, 10)}${row.wasOverdue ? ' (was overdue)' : ''}`, 8.5);
    if (row.waiverRef) line(`Waiver instrument: ${row.waiverRef}`, 8.5);
    if (row.evidenceRef) {
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text('Evidence:', MARGIN, y);
      y += LINE;
      y += drawClickableUrl(doc, row.evidenceRef, MARGIN + 2, y, contentWidth - 4, { fontSize: 7.5 });
      y += 1;
      doc.setTextColor(...INK);
    }
    y += 2;
  }
  y += 2;

  // -------------------------------------------- SECTION 2: notices
  heading('Section 2 - Default notices');
  if (data.defaultNotices.length === 0) {
    line('No default notices were attached to obligations due in this quarter.');
  }
  for (const notice of data.defaultNotices) {
    ensureSpace(LINE * 3 + 2);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(`${notice.templateKey} - notice ${notice.noticeId}`, MARGIN, y);
    y += LINE;
    doc.setFont('helvetica', 'normal');
    line(
      `Office: ${notice.officeRole} | Issued to: ${notice.issuedToUid ?? 'not issued'} | Issued: ${notice.issuedAt?.slice(0, 10) ?? '-'} | Cure deadline: ${notice.cureDeadline?.slice(0, 10) ?? '-'} | Cure outcome: ${notice.cureOutcome} | Receipts complete: ${notice.receiptsComplete ? 'yes' : 'NO'}${notice.interventionType ? ` | Intervention: ${notice.interventionType}` : ''}`,
      8.5,
    );
    y += 2;
  }
  y += 2;

  // ------------------------------------- SECTION 3: vacancy + integrity
  heading('Section 3 - Vacancy and integrity');
  if (data.vacantOffices.length === 0) {
    line('No office with duties in this quarter was vacant at generation time.');
  } else {
    line(`Vacant offices at generation: ${data.vacantOffices.join(', ')}. Vacancy never pauses the compliance clock and never blocks this report.`);
  }
  line(`Orphan event instances (no trigger doc): ${data.integrity.orphanEventInstances}`);
  line(`Evidence submitted but unreviewed for over 14 days: ${data.integrity.evidenceUnreviewedOver14d}`);
  line(`Issued notices with incomplete delivery receipts: ${data.integrity.incompleteReceipts}`);
  y += 3;

  // ---------------------------------------------------------- APPENDIX
  heading('Appendix - Method and discrepancies');
  line(`Discrepancies between default_notices and audit_logs: ${data.discrepancyCount}.`, 9);
  for (const d of data.discrepancies) {
    line(`Notice ${d.noticeId}: fact '${d.fact}' - notices record ${d.noticeValue}, audit log records ${d.auditValue}; the notice record prevails.`, 8.5);
  }
  line(data.methodNote, 8.5);

  return new Uint8Array(doc.output('arraybuffer'));
}
