/**
 * Appointment letter renderer (Workstream G, spec G.5.2).
 *
 * Pure renderer: AppointmentLetterData in, PDF Buffer out. It reads
 * nothing from Firestore; the adapter froze every printed value into
 * the snapshot first. Dynamic jspdf + qrcode imports follow the
 * credential-PDF route pattern exactly.
 *
 * Layout discipline (standing PDF rules): A4 portrait in points, 56pt
 * margins, nothing drawn near page edges, personnel details as a clean
 * vertical stack, and the verification URL drawn via the shared
 * drawClickableUrl helper with its height reserved via measureUrlLines
 * BEFORE drawing, so a long URL wraps inside the padding instead of
 * clipping.
 */

import type { AppointmentLetterData } from '@/types/appointment-instrument';
import { drawClickableUrl, measureUrlLines } from '@/lib/pdf-url';

/** Ratification paragraph, wording variant (a) of G.5.2, verbatim. */
export const RATIFICATION_PARAGRAPH =
  'This appointment is subject to ratification by the Board of Governors within 30 days. ' +
  'If the Board does not refuse ratification by a 2/3 vote within 30 days of the appointment date, ' +
  'the appointment stands ratified. You exercise the full authority of the office from the effective date.';

const PAGE_W = 595.28;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

export async function renderAppointmentLetterPDF(
  data: AppointmentLetterData,
): Promise<Buffer> {
  const QRCode = (await import('qrcode')).default;
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  let y = 64;

  // Masthead.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(20, 20, 20);
  doc.text('SEDS PAKISTAN', PAGE_W / 2, y, { align: 'center' });
  y += 18;

  // Registration status line (Q-G5): small, wrapped, never a claim.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 110);
  const statusLines = doc.splitTextToSize(
    data.registrationStatusLine,
    CONTENT_W,
  ) as string[];
  for (const line of statusLines) {
    doc.text(line, PAGE_W / 2, y, { align: 'center' });
    y += 10;
  }
  y += 6;
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.7);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 26;

  // Status banner (superseded / refused letters still download, and the
  // PDF of record shows its own state, G.5.1).
  if (data.statusLine) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(178, 34, 34);
    const bannerLines = doc.splitTextToSize(data.statusLine, CONTENT_W) as string[];
    for (const line of bannerLines) {
      doc.text(line, PAGE_W / 2, y, { align: 'center' });
      y += 14;
    }
    y += 8;
  }

  // Title + instrument identifiers.
  doc.setTextColor(20, 20, 20);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Appointment Letter', MARGIN, y);
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(70, 70, 70);
  doc.text(
    `Instrument ${data.instrumentNumber}  ·  Verification code ${data.verificationCode}`,
    MARGIN,
    y,
  );
  y += 14;
  doc.text(`Date of issue: ${data.issuedDateLine}`, MARGIN, y);
  y += 26;

  // Personnel block: clean vertical stack, nothing near edges.
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(11);
  const stack: Array<[string, string]> = [
    ['Appointee', data.appointeeName],
    ['Office', data.roleDisplayName],
  ];
  if (data.chapterName) stack.push(['Chapter', data.chapterName]);
  stack.push(['Effective from', data.effectiveFromLine]);
  if (data.termEndsAtLine) stack.push(['Term ends', data.termEndsAtLine]);
  for (const [label, value] of stack) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, MARGIN, y);
    doc.setFont('helvetica', 'normal');
    const valueLines = doc.splitTextToSize(value, CONTENT_W - 110) as string[];
    valueLines.forEach((line, i) => {
      doc.text(line, MARGIN + 110, y + i * 14);
    });
    y += Math.max(1, valueLines.length) * 14 + 4;
  }
  y += 10;

  // Body paragraphs.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const chapterBit = data.chapterName ? ` (${data.chapterName})` : '';
  const authorityParagraph =
    `${data.appointedByName}, ${data.appointedByOffice}, acting under ${data.authorityReference}, ` +
    `appoints ${data.appointeeName} to the office of ${data.roleDisplayName}${chapterBit} ` +
    `with effect from ${data.effectiveFromLine}.`;
  const paragraphs: string[] = [authorityParagraph];
  if (data.catalogReference) {
    paragraphs.push(
      `The duties and limits of this office are as set out in ${data.catalogReference} of the Role Catalog.`,
    );
  }
  if (data.ratificationRequired) {
    paragraphs.push(RATIFICATION_PARAGRAPH);
  }
  paragraphs.push(
    `To accept this appointment, sign this letter and upload the signed copy through your profile, ` +
      `quoting verification code ${data.verificationCode}.`,
  );
  for (const paragraph of paragraphs) {
    const lines = doc.splitTextToSize(paragraph, CONTENT_W) as string[];
    for (const line of lines) {
      doc.text(line, MARGIN, y);
      y += 15;
    }
    y += 9;
  }
  y += 6;

  // Signature block for the appointing authority (typed name + office,
  // Q-G4 v1: no scanned signature image).
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('For the appointing authority:', MARGIN, y);
  y += 26;
  doc.setFont('helvetica', 'bold');
  doc.text(data.appointedByName, MARGIN, y);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.text(data.appointedByOffice, MARGIN, y);
  y += 34;

  // QR + verification block. Reserve the URL height before drawing.
  const qrSize = 84;
  const urlX = MARGIN + qrSize + 18;
  const urlWidth = PAGE_W - MARGIN - urlX;
  const qrDataUrl = await QRCode.toDataURL(data.verificationUrl, {
    margin: 1,
    width: 512,
  });
  doc.addImage(qrDataUrl, 'PNG', MARGIN, y, qrSize, qrSize);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  doc.text('Verify this letter:', urlX, y + 12);
  const urlLines = measureUrlLines(doc, data.verificationUrl, urlWidth, 8);
  drawClickableUrl(doc, data.verificationUrl, urlX, y + 28, urlWidth, {
    fontSize: 8,
    align: 'left',
  });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(70, 70, 70);
  doc.text(
    `Verification code: ${data.verificationCode}`,
    urlX,
    y + 28 + urlLines * (8 * 0.55) + 14,
  );
  y += qrSize + 22;

  // Footer: content hash short form.
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 110);
  doc.text(
    `Content hash (short): ${data.contentHashShort}  ·  Verify at ${data.verificationUrl}`,
    MARGIN,
    Math.min(y, 800),
  );

  return Buffer.from(doc.output('arraybuffer'));
}
