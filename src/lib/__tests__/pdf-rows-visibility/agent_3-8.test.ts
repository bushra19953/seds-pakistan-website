/**
 * Agent 3-8: personnel row visibility regression test, overlap guard.
 *
 * BUG CONTEXT: In workflow PDF export, only the FIRST assignee personnel
 * row renders visibly. The prior fix (commit 77f1583) removed overlap by
 * giving every person a full per-person row with a reserved QR column.
 * This test guards that overlap fix while the invisibility fix lands.
 *
 * WHAT IT PROVES: With 5 assignees on one step, NO pair of drawn
 * elements on personnel pages overlaps: every text block against every
 * other text block, every text block against every QR/avatar image, and
 * every QR/avatar image against every other QR/avatar image, on the
 * same page. It must PASS on current code (no overlap, just
 * invisibility) and keep passing after the invisibility fix.
 *
 * HOW BOUNDING BOXES ARE COMPUTED: exportWorkflowAsPDF builds its own
 * jsPDF instance and ends with doc.save(), so tests cannot hand it a
 * doc. This file mocks 'jspdf' with RecordingJsPDF, a subclass of the
 * REAL jsPDF, whose constructor runs interceptDoc() from
 * ../pdf-geometry.ts. That wrapper records one bounding box per draw
 * call (text, addImage, rect), which is exactly the geometry the
 * exporter puts into the PDF content stream: text positions from the
 * doc.text calls and QR/avatar placement from the addImage calls
 * (x, y, w, h as passed, i.e. the image placement matrix). The
 * content-stream cross-check in test 2 parses the emitted PDF bytes
 * for image placement (cm + Do) and text show (Tj/TJ) operators and
 * re-asserts QR-vs-QR no-overlap from those parsed operators.
 * Parsing the PDF bytes with pdfjs-dist is not an option here: it
 * ships ESM only and this Jest setup does not transform node_modules
 * (see the header of workflow-pdf-export-geometry.test.ts).
 *
 * SCOPE DECISIONS, read before changing the harness:
 * - Rects are EXCLUDED from the all-pairs check. Rects are backgrounds
 *   (page background, step cards, badge fills, footer bars) and are
 *   meant to sit underneath text and images. Including them would flag
 *   every card as overlapping its own content. The elements that must
 *   never overlap each other are text blocks, QR images, and avatar
 *   images, and those are exactly what is checked.
 * - Text boxes are converted to glyph boxes before the overlap check.
 *   Recorded text boxes use the codebase line-height convention
 *   (fontSize * 0.55) for height, which is taller than the real
 *   glyphs. Without the conversion, the QR caption line, which sits
 *   3mm below its QR, would false-positive against its own QR. The
 *   glyph box (baseline minus real ascent, plus a small descent)
 *   matches what a reader actually sees.
 * - The footer band (y >= 285) is excluded: the footer is drawn on
 *   every page in a separate pass and is not personnel content.
 * - Personnel pages are the pages carrying a 'PERSONNEL ASSIGNED'
 *   header, including continuation pages for a many-assignee step.
 * - Overlap uses the repo convention from ../pdf-geometry.ts:
 *   boxesOverlap requires more than 0.5mm overlap on BOTH axes, so
 *   rounding hairlines and touching-but-not-overlapping boxes do not
 *   count.
 *
 * Determinism: fixed workflow id, fixed step id, fixed deadline, fake
 * assignee data. The cover "Issue Date" uses the current date but is
 * never asserted on.
 */

jest.mock('jspdf', () => {
  const util = jest.requireActual('util');
  const g = globalThis as any;
  if (!g.TextEncoder) g.TextEncoder = util.TextEncoder;
  if (!g.TextDecoder) g.TextDecoder = util.TextDecoder;
  const Actual: any = jest.requireActual('jspdf/dist/jspdf.node.js');
  const RealJsPDF: any = Actual.jsPDF;

  class RecordingJsPDF extends RealJsPDF {
    constructor(...args: any[]) {
      super(...args);
      const helper: any = jest.requireActual('../pdf-geometry');
      const { boxes } = helper.interceptDoc(this);
      const rec: any = { boxes, doc: this, saved: false, pdfBytes: null };
      const regs =
        (globalThis as any).__workflowPdfRowsVisibilityRecordings ||
        ((globalThis as any).__workflowPdfRowsVisibilityRecordings = []);
      regs.push(rec);
      (this as any).save = () => {
        rec.saved = true;
        try {
          const out = (this as any).output('arraybuffer');
          rec.pdfBytes = out instanceof ArrayBuffer ? out : null;
        } catch {
          rec.pdfBytes = null;
        }
      };
    }
  }

  return { ...Actual, jsPDF: RecordingJsPDF };
});

import { exportWorkflowAsPDF } from '../../workflow-pdf-export';
import type { WorkflowPDFData } from '../../workflow-pdf-export';
import { boxesOverlap } from '../pdf-geometry';
import type { RecordedBox } from '../pdf-geometry';

/** Footer band starts here; the footer is not personnel content. */
const FOOTER_TOP = 297 - 12;
/** Same overlap threshold as ../pdf-geometry.ts. */
const OVERLAP_EPSILON = 0.5;

/** 1x1 PNG used as a stand-in assignee photo. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface PdfRecording {
  boxes: RecordedBox[];
  doc: { getNumberOfPages: () => number };
  saved: boolean;
  pdfBytes: ArrayBuffer | null;
}

function recordings(): PdfRecording[] {
  const g = globalThis as unknown as {
    __workflowPdfRowsVisibilityRecordings?: PdfRecording[];
  };
  if (!g.__workflowPdfRowsVisibilityRecordings) g.__workflowPdfRowsVisibilityRecordings = [];
  return g.__workflowPdfRowsVisibilityRecordings;
}

function lastRecording(): PdfRecording {
  const all = recordings();
  const rec = all[all.length - 1];
  if (!rec) throw new Error('No PDF was generated');
  return rec;
}

/**
 * Convert a recorded text box to the glyph box a reader actually sees.
 * Recorded boxes use baseline minus fontSize * 0.55 for the top; glyphs
 * only rise fontSize points (0.3528 mm per point) above the baseline.
 */
function glyphBox(textBox: RecordedBox): RecordedBox {
  const fontSizePt = textBox.h / 0.55;
  const ascent = fontSizePt * 0.3528;
  const descent = ascent * 0.3;
  const baseline = textBox.y + textBox.h;
  return { ...textBox, y: baseline - ascent, h: ascent + descent };
}

/** Personnel pages: pages carrying a 'PERSONNEL ASSIGNED' header. */
function personnelPages(boxes: RecordedBox[]): Set<number> {
  return new Set(
    boxes.filter((b) => b.kind === 'text' && b.label === 'PERSONNEL ASSIGNED').map((b) => b.page),
  );
}

/**
 * Elements that must never overlap each other on personnel pages:
 * text blocks (as glyph boxes), QR images, and avatar images. Rects
 * are backgrounds and are excluded by design; see the file header.
 */
function personnelElements(boxes: RecordedBox[]): RecordedBox[] {
  const pages = personnelPages(boxes);
  const elements: RecordedBox[] = [];
  for (const b of boxes) {
    if (!pages.has(b.page)) continue;
    if (b.y >= FOOTER_TOP) continue;
    if (b.kind === 'text') elements.push(glyphBox(b));
    else if (b.kind === 'image') elements.push(b);
  }
  return elements;
}

function assertNoPairOverlaps(elements: RecordedBox[], label: string): void {
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];
      if (a.page !== b.page) continue;
      if (!boxesOverlap(a, b)) continue;
      throw new Error(
        `${label}: ${a.kind} "${a.label}" (page ${a.page}, ` +
          `x=${a.x.toFixed(2)}, y=${a.y.toFixed(2)}, w=${a.w.toFixed(2)}, h=${a.h.toFixed(2)}) ` +
          `overlaps ${b.kind} "${b.label}" (page ${b.page}, ` +
          `x=${b.x.toFixed(2)}, y=${b.y.toFixed(2)}, w=${b.w.toFixed(2)}, h=${b.h.toFixed(2)})`,
      );
    }
  }
}

/** Five-assignee workflow: one primary plus four fellows on one step. */
function fiveAssigneeWorkflow(): WorkflowPDFData {
  return {
    id: 'wf-pdf-rows-visibility-38',
    title: 'Rows Visibility Regression Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    chapterName: 'SEDS IST Chapter',
    description: 'A workflow built to guard the per-person personnel row layout.',
    steps: [
      {
        id: 'step-1',
        title: 'Step One: Five Assignees',
        description: 'One step shared by five assignees.',
        status: 'pending',
        assigneeId: 'user-primary',
        assigneeName: 'Primary Person',
        assigneeEmail: 'primary@example.com',
        assigneeWhatsapp: '+923001234567',
        assigneeChapter: 'SEDS IST Chapter',
        assigneeRole: 'member',
        role: 'Step Owner',
        individualDeadline: '2026-10-20T15:30:00+05:00',
        assigneePhoto: TINY_PNG,
        assignees: [
          { id: 'user-primary', name: 'Primary Person', role: 'member', chapterName: 'SEDS IST Chapter' },
          { id: 'user-2', name: 'Second Person', role: 'member', chapterName: 'SEDS IST Chapter' },
          { id: 'user-3', name: 'Third Person', role: 'member', chapterName: 'SEDS IST Chapter' },
          { id: 'user-4', name: 'Fourth Person', role: 'member', chapterName: 'SEDS IST Chapter' },
          { id: 'user-5', name: 'Fifth Person', role: 'member', chapterName: 'SEDS IST Chapter' },
        ],
      },
    ],
  };
}

beforeEach(() => {
  recordings().length = 0;
});

describe('workflow PDF personnel rows visibility, agent 3-8 overlap guard', () => {
  test('1. five assignees: no pair of drawn elements overlaps on personnel pages', async () => {
    await exportWorkflowAsPDF(fiveAssigneeWorkflow(), undefined, { hideQrCodes: false });
    const rec = lastRecording();
    expect(rec.saved).toBe(true);
    const boxes = rec.boxes;

    const pages = personnelPages(boxes);
    expect(pages.size).toBeGreaterThan(0);

    const elements = personnelElements(boxes);
    expect(elements.length).toBeGreaterThan(0);

    // All five assignee names are drawn.
    for (const name of ['Primary Person', 'Second Person', 'Third Person', 'Fourth Person', 'Fifth Person']) {
      expect(elements.some((b) => b.kind === 'text' && b.label.includes(name))).toBe(true);
    }

    // Five per-teammate QR images: PNG images on personnel pages, each 22x22.
    const qrImages = elements.filter(
      (b) => b.kind === 'image' && b.label.includes('PNG') && Math.abs(b.w - 22) < 1 && Math.abs(b.h - 22) < 1,
    );
    expect(qrImages).toHaveLength(5);

    // One avatar image for the primary assignee.
    const avatarImages = elements.filter(
      (b) => b.kind === 'image' && Math.abs(b.w - 16) < 1 && Math.abs(b.h - 16) < 1,
    );
    expect(avatarImages).toHaveLength(1);

    // The core invariant: every pair of drawn elements (text blocks,
    // QR images, avatar images) on the same personnel page is
    // non-overlapping.
    assertNoPairOverlaps(elements, 'five assignees');
  });

  test('2. content-stream parse: QR placement matrices from the PDF bytes do not overlap', async () => {
    await exportWorkflowAsPDF(fiveAssigneeWorkflow(), undefined, { hideQrCodes: false });
    const rec = lastRecording();
    expect(rec.saved).toBe(true);
    expect(rec.pdfBytes).not.toBeNull();
    if (!rec.pdfBytes) throw new Error('No PDF bytes captured');

    const bytes = new Uint8Array(rec.pdfBytes);
    let raw = '';
    for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);

    // Split the raw PDF into per-page content streams. jsPDF emits one
    // stream object per page, in page order.
    const streamMatches = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
    expect(streamMatches.length).toBeGreaterThan(2);

    // Page height in points for the y flip: A4 is 841.89pt tall.
    // jsPDF writes content in points with origin at the bottom left,
    // while the recorded boxes use mm with origin at the top left.
    const PAGE_HEIGHT_PT = 841.89;
    const PT_PER_MM = 72 / 25.4;

    interface ParsedImage {
      page: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }
    const parsedImages: ParsedImage[] = [];

    streamMatches.forEach((match, pageIndex) => {
      const stream = match[1];
      // Image placement: "w 0 0 h x y cm /ImX Do". The cm matrix maps
      // the unit image square to (x, y, w, h) in points, origin bottom
      // left. QR images are square and unrotated in this export.
      const imageOps = [...stream.matchAll(/([-\d.]+)\s+0\s+0\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm\s*\/\w+\s+Do/g)];
      for (const op of imageOps) {
        const wPt = parseFloat(op[1]);
        const hPt = parseFloat(op[2]);
        const xPt = parseFloat(op[3]);
        const yPt = parseFloat(op[4]);
        parsedImages.push({
          page: pageIndex + 1,
          x: xPt / PT_PER_MM,
          y: (PAGE_HEIGHT_PT - yPt - hPt) / PT_PER_MM,
          w: wPt / PT_PER_MM,
          h: hPt / PT_PER_MM,
        });
      }
    });

    // The content stream must contain the five 22x22 personnel QR
    // images plus the 35x35 cover QR plus the 16x16 avatar image.
    const personnelQrs = parsedImages.filter(
      (im) => Math.abs(im.w - 22) < 1 && Math.abs(im.h - 22) < 1,
    );
    expect(personnelQrs).toHaveLength(5);

    // QR-vs-QR no-overlap from the parsed placement matrices alone.
    for (let i = 0; i < personnelQrs.length; i++) {
      for (let j = i + 1; j < personnelQrs.length; j++) {
        const a = personnelQrs[i];
        const b = personnelQrs[j];
        if (a.page !== b.page) continue;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapX > OVERLAP_EPSILON && overlapY > OVERLAP_EPSILON).toBe(false);
      }
    }
  });
});
