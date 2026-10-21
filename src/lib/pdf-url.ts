/**
 * Shared clickable-URL helpers for jsPDF documents.
 *
 * Moved out of src/lib/workflow-pdf-export.ts (Phase 3 Workstream G build
 * step 1, spec G.5.2) so the appointment letter renderer and the workflow
 * exporter share ONE implementation. Behavior is preserved exactly from
 * the original workflow-pdf-export.ts helpers: same wrapping, same
 * underline, same doc.link attachment, same return values.
 *
 * Type-only jspdf import: this module must not pull jspdf in at runtime,
 * because renderers load jspdf dynamically (credential-PDF pattern).
 */

import type { jsPDF } from 'jspdf';

const LINK_BLUE: [number, number, number] = [0, 80, 160];

const URL_BREAK_CHARS = '/-_?&=';

/** Split one overlong token at / - _ ? & = (sep stays at chunk end), else hard chunk. */
const splitOverlongUrlSegment = (doc: jsPDF, segment: string, maxWidth: number): string[] => {
  const chunks: string[] = [];
  let current = '';
  const flush = () => { if (current) { chunks.push(current); current = ''; } };
  for (const ch of segment) {
    const trial = current + ch;
    if (doc.getTextWidth(trial) > maxWidth && current.length > 0) {
      let cut = -1;
      for (let i = current.length - 1; i >= 0; i--) {
        if (URL_BREAK_CHARS.includes(current[i])) { cut = i; break; }
      }
      if (cut >= 0) {
        chunks.push(current.slice(0, cut + 1));
        current = current.slice(cut + 1) + ch;
      } else {
        chunks.push(current);
        current = ch;
      }
    } else {
      current = trial;
    }
  }
  flush();
  return chunks;
};

/** Wrap a URL into lines that fit maxWidth. Sets the link font before measuring. */
const wrapUrlLines = (doc: jsPDF, url: string, maxWidth: number, fontSize: number): string[] => {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(fontSize);
  const lines: string[] = [];
  for (const segment of doc.splitTextToSize(url, maxWidth) as string[]) {
    if (doc.getTextWidth(segment) <= maxWidth) lines.push(segment);
    else lines.push(...splitOverlongUrlSegment(doc, segment, maxWidth));
  }
  return lines;
};

/**
 * Returns how many wrapped lines the URL needs at the given width and size.
 * Used for card height prediction before drawing. Returns 0 for empty URL.
 */
export function measureUrlLines(
  doc: jsPDF,
  url: string,
  maxWidth: number,
  fontSize?: number
): number {
  if (!url) return 0;
  return wrapUrlLines(doc, url, maxWidth, fontSize ?? 7).length;
}

/**
 * Draws visible, clickable, underlined URL text. Returns vertical mm consumed.
 * Empty or missing URL draws nothing and returns 0.
 * Long URLs wrap within maxWidth, breaking at / - _ ? & = when needed.
 * Align left starts text at x; center centers on x; right ends text at x.
 */
export function drawClickableUrl(
  doc: jsPDF,
  url: string,
  x: number,
  y: number,
  maxWidth: number,
  opts?: { fontSize?: number; align?: 'left' | 'center' | 'right' }
): number {
  const fontSize = opts?.fontSize ?? 7;
  const align = opts?.align ?? 'left';
  if (!url) return 0;
  const lines = wrapUrlLines(doc, url, maxWidth, fontSize);
  if (lines.length === 0) return 0;

  doc.setTextColor(...LINK_BLUE);
  doc.setDrawColor(...LINK_BLUE);
  doc.setLineWidth(0.15);

  const lineHeight = fontSize * 0.55;
  lines.forEach((line, i) => {
    const baseline = y + i * lineHeight;
    const w = doc.getTextWidth(line);
    let tx = x;
    if (align === 'center') tx = x - w / 2;
    else if (align === 'right') tx = x - w;
    doc.text(line, tx, baseline);
    doc.line(tx, baseline + 0.8, tx + w, baseline + 0.8);
    doc.link(tx, baseline - lineHeight + 0.3, w, lineHeight, { url });
  });

  return lines.length * lineHeight;
}
