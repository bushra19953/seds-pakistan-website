/**
 * Geometry regression tests for the workflow PDF personnel layout.
 *
 * What this file proves: the personnel block (name, role, responsibility,
 * chapter, contacts, IN THE LOOP list, per-teammate QR codes) never overlaps
 * the QR images, QR images never overlap each other, no text runs past the
 * right card edge, nothing runs past the page bottom, and card backgrounds
 * cover the content drawn on their page.
 *
 * APPROACH (read this before changing the harness):
 * - exportWorkflowAsPDF builds its own jsPDF instance and ends with
 *   doc.save(), so the tests cannot hand it a doc. Instead this file mocks
 *   'jspdf' with RecordingJsPDF, a subclass of the REAL jsPDF (the CJS node
 *   build at jspdf/dist/jspdf.node.js, because the ESM build cannot load
 *   under this repo's CJS Jest setup). The subclass constructor runs
 *   interceptDoc(this) from ./pdf-geometry.ts, which wraps the doc's own
 *   text / addImage / rect / roundedRect calls and records a bounding box
 *   per call. Assertions run against those recorded boxes, never against
 *   PDF bytes.
 * - pdfjs-dist IS in node_modules, but it ships ESM only (pdf.mjs) and this
 *   Jest setup does not transform node_modules, so parsing the PDF bytes
 *   with pdfjs-dist is not an option without changing Jest config. The
 *   call-interception approach is the fallback the task allows, and it is
 *   stronger here anyway: it records the exact coordinates the exporter
 *   asked for, with no PDF parsing ambiguity.
 * - jsPDF assigns its drawing methods as per-instance own properties, so
 *   spying on jsPDF.prototype does NOT intercept anything. The subclass
 *   constructor approach above is what actually works.
 * - save() is overridden to a no-op that marks the recording saved, so the
 *   export never tries to trigger a browser download under jsdom.
 * - Text boxes from ./pdf-geometry.ts use the codebase line-height
 *   convention (fontSize * 0.55) for the box height. That box is taller
 *   than the real glyphs. For text-vs-QR overlap we therefore convert to a
 *   glyph box (baseline minus real ascent, plus a small descent) before
 *   testing overlap. Without that step, the QR caption line, which sits
 *   3mm below its QR, would false-positive by about 0.08mm against the
 *   0.5mm threshold. The glyph box matches what a reader actually sees.
 * - Text-vs-text overlap is deliberately NOT asserted globally: adjacent
 *   wrapped lines legitimately sit closer than any box model can separate.
 *   The overlap invariants that matter for this layout are text-vs-QR
 *   and QR-vs-QR.
 * - Page-bounds checks cover TEXT and IMAGE boxes only, never rects.
 *   Rects are backgrounds (page background, step cards, footer bars) and
 *   jsPDF clips them at the page edge. The fixed exporter draws a step
 *   card at its full predicted height, so when a many-assignee step spans
 *   pages the card runs to the page edge while the rows continue on a
 *   fresh page with their own capped card. Treating that clipped card as
 *   "content past the page bottom" would fail the fixed code on a
 *   cosmetic, out-of-scope behavior. Card/content coverage is checked
 *   separately in test 5.
 * - Width/height comparisons use an epsilon, never exact equality: jsPDF
 *   reports A4 as 210.0015 x 297.0001 mm (point conversion), so a rect
 *   the code draws at width 170 records as 170.0015.
 *
 * Determinism: fixed workflow ids, fixed step ids, fixed deadlines, no
 * Date.now in assertions. The cover "Issue Date" uses the current date
 * but is never asserted on.
 *
 * Expected results on the buggy code (branch
 * fix/workflow-pdf-personnel-layout, before the layout fix):
 * - Test 1 FAILS: personnel lines (role, responsibility, chapter,
 *   contacts, IN THE LOOP label) overlap the QR row of the 5-assignee step.
 * - Test 3 FAILS: the 10-QR row runs off the left page edge, and
 *   personnel lines overlap QRs.
 * - Test 5 FAILS: same personnel-vs-QR overlaps with long content.
 * - Tests 2, 4, 6 PASS on the buggy code; they are guards that must keep
 *   passing after the fix.
 *
 * NOTE (2026-10-14): the layout fix landed at HEAD (commit 77f1583,
 * "per-person personnel rows, no QR/text overlap") while this file was
 * being written. The suite now passes on the fixed code. The fail-on-buggy
 * behavior above was verified by temporarily swapping in the pre-fix
 * version of the exporter (git show HEAD~1), running the suite, and
 * restoring the fixed file: tests 1, 3, 5 fail on the pre-fix code, the
 * rest pass.
 */

jest.mock('jspdf', () => {
  // jspdf.node.js needs TextEncoder/TextDecoder, which jsdom does not provide.
  const util = jest.requireActual('util');
  const g = globalThis as any;
  if (!g.TextEncoder) g.TextEncoder = util.TextEncoder;
  if (!g.TextDecoder) g.TextDecoder = util.TextDecoder;
  const Actual: any = jest.requireActual('jspdf/dist/jspdf.node.js');
  const RealJsPDF: any = Actual.jsPDF;

  class RecordingJsPDF extends RealJsPDF {
    constructor(...args: any[]) {
      super(...args);
      // Loaded here, not at module top: ./pdf-geometry.ts imports 'jspdf',
      // and requiring it inside the mock factory would be circular. By
      // construction time the mock is fully registered, so this is safe.
      const helper: any = jest.requireActual('./pdf-geometry');
      const { boxes } = helper.interceptDoc(this);
      const rec = { boxes, doc: this, saved: false };
      const regs =
        (globalThis as any).__workflowPdfGeometryRecordings ||
        ((globalThis as any).__workflowPdfGeometryRecordings = []);
      regs.push(rec);
      (this as any).save = () => {
        rec.saved = true;
      };
    }
  }

  return { ...Actual, jsPDF: RecordingJsPDF };
});

import { exportWorkflowAsPDF } from '../workflow-pdf-export';
import type { WorkflowPDFData, WorkflowPDFStep } from '../workflow-pdf-export';
import { boxesOverlap } from './pdf-geometry';
import type { RecordedBox } from './pdf-geometry';

/** A4 in mm, the format exportWorkflowAsPDF uses. */
const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
/** Left margin (20) plus step content width (170). */
const CARD_RIGHT_EDGE = 190;
/** Footer band starts here; the footer intentionally spans full width. */
const FOOTER_TOP = PAGE_HEIGHT - 12;
/** Same overlap threshold as ./pdf-geometry.ts. */
const OVERLAP_EPSILON = 0.5;

/** 1x1 PNG used as a stand-in assignee photo. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface PdfRecording {
  boxes: RecordedBox[];
  doc: { getNumberOfPages: () => number };
  saved: boolean;
}

function recordings(): PdfRecording[] {
  const g = globalThis as unknown as {
    __workflowPdfGeometryRecordings?: PdfRecording[];
  };
  if (!g.__workflowPdfGeometryRecordings) g.__workflowPdfGeometryRecordings = [];
  return g.__workflowPdfGeometryRecordings;
}

function lastRecording(): PdfRecording {
  const all = recordings();
  const rec = all[all.length - 1];
  if (!rec) throw new Error('No PDF was generated');
  return rec;
}

function pageCount(rec: PdfRecording): number {
  return Math.max(...rec.boxes.map((b) => b.page));
}

async function exportAndCapture(workflow: WorkflowPDFData): Promise<PdfRecording> {
  await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
  const rec = lastRecording();
  expect(rec.saved).toBe(true);
  return rec;
}

/** QR images: PNG images no larger than the cover QR (35x35). Avatars are JPEG, the logo is wider. */
function qrBoxes(boxes: RecordedBox[]): RecordedBox[] {
  return boxes.filter(
    (b) => b.kind === 'image' && b.label.includes('PNG') && b.w <= 60 && b.h <= 60,
  );
}

/** Per-teammate QR codes live on step pages, never on the cover (page 1). */
function stepQrBoxes(boxes: RecordedBox[]): RecordedBox[] {
  return qrBoxes(boxes).filter((b) => b.page > 1);
}

function coverQrBoxes(boxes: RecordedBox[]): RecordedBox[] {
  return qrBoxes(boxes).filter((b) => b.page === 1);
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

function assertNoTextQrOverlap(boxes: RecordedBox[], label: string): void {
  const texts = boxes.filter((b) => b.kind === 'text');
  const qrs = qrBoxes(boxes);
  for (const text of texts) {
    const glyph = glyphBox(text);
    for (const qr of qrs) {
      if (glyph.page !== qr.page) continue;
      if (!boxesOverlap(glyph, qr)) continue;
      throw new Error(
        `${label}: text "${text.label}" (page ${text.page}, ` +
          `glyph x=${glyph.x.toFixed(2)}, y=${glyph.y.toFixed(2)}, ` +
          `w=${glyph.w.toFixed(2)}, h=${glyph.h.toFixed(2)}) overlaps QR ` +
          `(x=${qr.x.toFixed(2)}, y=${qr.y.toFixed(2)}, w=${qr.w.toFixed(2)}, h=${qr.h.toFixed(2)})`,
      );
    }
  }
}

function assertNoQrQrOverlap(boxes: RecordedBox[], label: string): void {
  const qrs = qrBoxes(boxes);
  for (let i = 0; i < qrs.length; i++) {
    for (let j = i + 1; j < qrs.length; j++) {
      const a = qrs[i];
      const b = qrs[j];
      if (a.page !== b.page) continue;
      if (!boxesOverlap(a, b)) continue;
      throw new Error(
        `${label}: QR ${i} (page ${a.page}, x=${a.x.toFixed(2)}, y=${a.y.toFixed(2)}) ` +
          `overlaps QR ${j} (x=${b.x.toFixed(2)}, y=${b.y.toFixed(2)})`,
      );
    }
  }
}

function assertInsidePageBounds(boxes: RecordedBox[], label: string): void {
  for (const b of boxes) {
    // Rects are backgrounds, clipped at the page edge; see the header.
    if (b.kind === 'rect') continue;
    if (b.x < -OVERLAP_EPSILON) {
      throw new Error(
        `${label}: ${b.kind} "${b.label}" on page ${b.page} extends past the left page edge (x=${b.x.toFixed(2)})`,
      );
    }
    if (b.x + b.w > PAGE_WIDTH + OVERLAP_EPSILON) {
      throw new Error(
        `${label}: ${b.kind} "${b.label}" on page ${b.page} extends past the right page edge (right=${(b.x + b.w).toFixed(2)})`,
      );
    }
    if (b.y < -OVERLAP_EPSILON) {
      throw new Error(
        `${label}: ${b.kind} "${b.label}" on page ${b.page} extends past the top page edge (y=${b.y.toFixed(2)})`,
      );
    }
    if (b.y + b.h > PAGE_HEIGHT + OVERLAP_EPSILON) {
      throw new Error(
        `${label}: ${b.kind} "${b.label}" on page ${b.page} extends past the page bottom (bottom=${(b.y + b.h).toFixed(2)})`,
      );
    }
  }
}

function assertTextInsideRightCardEdge(boxes: RecordedBox[], label: string): void {
  for (const b of boxes) {
    if (b.kind !== 'text') continue;
    if (b.y >= FOOTER_TOP) continue; // Footer spans the full width by design.
    if (b.x + b.w > CARD_RIGHT_EDGE + OVERLAP_EPSILON) {
      throw new Error(
        `${label}: text "${b.label}" on page ${b.page} extends past the right card edge ` +
          `(right=${(b.x + b.w).toFixed(2)}, card edge=${CARD_RIGHT_EDGE})`,
      );
    }
  }
}

function baseStep(overrides: Partial<WorkflowPDFStep> = {}): WorkflowPDFStep {
  return {
    id: 'step-1',
    title: 'Step One',
    description: 'A short step description.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: 'Primary Person',
    assigneeEmail: 'primary@example.com',
    assigneeWhatsapp: '+923001234567',
    assigneeChapter: 'SEDS IST Chapter',
    assigneeRole: 'member',
    role: 'Step Owner',
    individualDeadline: '2026-10-20T15:30:00+05:00',
    ...overrides,
  };
}

function baseWorkflow(overrides: Partial<WorkflowPDFData> = {}): WorkflowPDFData {
  const steps = overrides.steps ?? [baseStep()];
  return {
    id: 'wf-pdf-geometry-fixed',
    title: 'Geometry Regression Workflow',
    progressPercentage: 0,
    totalSteps: steps.length,
    completedSteps: 0,
    isCompleted: false,
    chapterName: 'SEDS IST Chapter',
    description: 'A workflow built to pin down PDF personnel geometry.',
    steps,
    ...overrides,
  };
}

beforeEach(() => {
  recordings().length = 0;
});

describe('workflow PDF personnel geometry', () => {
  test('1. five assignees with long name and missing fields: no overlaps, no edge spill', async () => {
    const longName = 'Muhammad Alexander Christopher Jonathan Smith';
    expect(longName.length).toBeGreaterThan(40);
    const workflow = baseWorkflow({
      steps: [
        // Primary with a 40+ char name, full contact block, no avatar, plus 4 fellows.
        baseStep({
          id: 'step-1',
          title: 'Step One: Long Name Personnel',
          assigneeName: longName,
          assigneePhoto: undefined,
          assignees: [
            { id: 'user-primary', name: longName, role: 'member' },
            { id: 'user-2', name: 'Second Person', role: 'member' },
            { id: 'user-3', name: 'Third Person', role: 'member' },
            { id: 'user-4', name: 'Fourth Person', role: 'member' },
            { id: 'user-5', name: 'Fifth Person', role: 'member' },
          ],
        }),
        // Missing phone.
        baseStep({
          id: 'step-2',
          title: 'Step Two: Missing Phone',
          assigneeId: 'user-no-phone',
          assigneeName: 'No Phone Person',
          assigneeWhatsapp: undefined,
          assigneePhoto: TINY_PNG,
        }),
        // Missing email.
        baseStep({
          id: 'step-3',
          title: 'Step Three: Missing Email',
          assigneeId: 'user-no-email',
          assigneeName: 'No Email Person',
          assigneeEmail: undefined,
          assigneePhoto: TINY_PNG,
        }),
        // Missing chapter.
        baseStep({
          id: 'step-4',
          title: 'Step Four: Missing Chapter',
          assigneeId: 'user-no-chapter',
          assigneeName: 'No Chapter Person',
          assigneeChapter: undefined,
          assigneePhoto: TINY_PNG,
        }),
        // Missing avatar.
        baseStep({
          id: 'step-5',
          title: 'Step Five: Missing Avatar',
          assigneeId: 'user-no-avatar',
          assigneeName: 'No Avatar Person',
          assigneePhoto: undefined,
        }),
      ],
    });
    const rec = await exportAndCapture(workflow);
    const boxes = rec.boxes;

    assertNoTextQrOverlap(boxes, 'five assignees');
    assertNoQrQrOverlap(boxes, 'five assignees');
    assertTextInsideRightCardEdge(boxes, 'five assignees');
    assertInsidePageBounds(boxes, 'five assignees');

    // Five per-teammate QR codes on the first step, one per assignee, plus
    // one QR each on the four single-assignee steps. The first step's
    // personnel rows flow to continuation pages, so only the total is pinned.
    expect(stepQrBoxes(boxes)).toHaveLength(9);
    expect(boxes.some((b) => b.kind === 'text' && b.label.includes(longName))).toBe(true);
  });

  test('2. one assignee, all fields present: single QR, no overlap', async () => {
    const workflow = baseWorkflow({
      steps: [
        baseStep({
          assigneePhoto: TINY_PNG,
        }),
      ],
    });
    const rec = await exportAndCapture(workflow);
    const boxes = rec.boxes;

    expect(stepQrBoxes(boxes)).toHaveLength(1);
    assertNoTextQrOverlap(boxes, 'single assignee');
    assertNoQrQrOverlap(boxes, 'single assignee');
    assertInsidePageBounds(boxes, 'single assignee');
    expect(boxes.some((b) => b.kind === 'text' && b.label.includes('Primary Person'))).toBe(
      true,
    );
  });

  test('3. ten assignees on one step: no overlap, all QRs present and in bounds', async () => {
    const fellowNames = [
      'Fellow One',
      'Fellow Two',
      'Fellow Three',
      'Fellow Four',
      'Fellow Five',
      'Fellow Six',
      'Fellow Seven',
      'Fellow Eight',
      'Fellow Nine',
    ];
    const workflow = baseWorkflow({
      steps: [
        baseStep({
          assignees: [
            { id: 'user-primary', name: 'Primary Person' },
            ...fellowNames.map((name, i) => ({ id: `user-fellow-${i + 1}`, name })),
          ],
        }),
      ],
    });
    const rec = await exportAndCapture(workflow);
    const boxes = rec.boxes;

    // Ten assignees means ten per-teammate QR codes.
    expect(stepQrBoxes(boxes)).toHaveLength(10);
    // All ten names appear (primary plus all nine fellows in the loop list).
    expect(boxes.some((b) => b.kind === 'text' && b.label.includes('Primary Person'))).toBe(
      true,
    );
    for (const name of fellowNames) {
      expect(boxes.some((b) => b.kind === 'text' && b.label.includes(name))).toBe(true);
    }
    assertNoTextQrOverlap(boxes, 'ten assignees');
    assertNoQrQrOverlap(boxes, 'ten assignees');
    assertInsidePageBounds(boxes, 'ten assignees');
  });

  test('3b. ten steps paginate: page count grows instead of clipping onto one page', async () => {
    const oneStep = await exportAndCapture(baseWorkflow());
    const oneStepPages = pageCount(oneStep);

    const tenSteps = await exportAndCapture(
      baseWorkflow({
        steps: Array.from({ length: 10 }, (_, i) =>
          baseStep({
            id: `step-${i + 1}`,
            title: `Step ${i + 1}`,
            assigneeId: `user-${i + 1}`,
            assigneeName: `Assignee ${i + 1}`,
            assignees: [{ id: `user-${i + 1}`, name: `Assignee ${i + 1}` }],
          }),
        ),
      }),
    );
    const tenStepPages = pageCount(tenSteps);

    expect(tenStepPages).toBeGreaterThan(oneStepPages);
    for (let i = 1; i <= 10; i++) {
      // Exact match: 'Assignee 1' is a substring of 'Assignee 10'.
      expect(
        tenSteps.boxes.some((b) => b.kind === 'text' && b.label === `Assignee ${i}`),
      ).toBe(true);
    }
  });

  test('4. empty assignees: no step QR drawn, no crash, Pending Assignment shown', async () => {
    const workflow = baseWorkflow({
      steps: [
        {
          id: 'step-unassigned',
          title: 'Unassigned Step',
          description: 'Nobody owns this step yet.',
          status: 'pending',
        },
      ],
    });
    const rec = await exportAndCapture(workflow);
    const boxes = rec.boxes;

    expect(stepQrBoxes(boxes)).toHaveLength(0);
    expect(boxes.some((b) => b.kind === 'text' && b.label.includes('Pending Assignment'))).toBe(
      true,
    );
    assertInsidePageBounds(boxes, 'empty assignees');
  });

  test('5. long description plus long resource URLs plus five assignees: cards cover content', async () => {
    const sentence = 'The mission requires precise coordination across all teams. ';
    const longDescription = sentence.repeat(Math.ceil(500 / sentence.length)).slice(0, 500);
    expect(longDescription.length).toBe(500);
    const longUrls = [1, 2, 3].map(
      (i) =>
        `https://example.com/missions/directives/section-${i}/` +
        'very-long-resource-path-segment/'.repeat(3) +
        `document-${i}.pdf`,
    );
    for (const url of longUrls) expect(url.length).toBeGreaterThan(100);

    const workflow = baseWorkflow({
      steps: [
        baseStep({
          title: 'Step One: Long Content',
          description: longDescription,
          resources: longUrls.map((url, i) => ({
            title: `Resource ${i + 1}: Mission Directive Document`,
            url,
            type: 'link',
          })),
          assignees: [
            { id: 'user-primary', name: 'Primary Person', role: 'member' },
            { id: 'user-2', name: 'Fellow Alpha', role: 'member' },
            { id: 'user-3', name: 'Fellow Beta', role: 'member' },
            { id: 'user-4', name: 'Fellow Gamma', role: 'member' },
            { id: 'user-5', name: 'Fellow Delta', role: 'member' },
          ],
        }),
      ],
    });
    const rec = await exportAndCapture(workflow);
    const boxes = rec.boxes;

    assertNoTextQrOverlap(boxes, 'long content');
    assertNoQrQrOverlap(boxes, 'long content');
    assertInsidePageBounds(boxes, 'long content');

    // Card coverage, approximated per the spec: on every page that carries
    // step cards, all step content must fall inside the union y-range of
    // that page's card rects. The page header and the footer are not card
    // content and are excluded. Pages with no card (cover, briefing) are
    // skipped: this check is about content escaping its own card.
    const stepPages = new Set(
      boxes
        .filter((b) => b.kind === 'text' && b.label === 'MISSION EXECUTION PLAN')
        .map((b) => b.page),
    );
    expect(stepPages.size).toBeGreaterThan(0);
    for (const page of stepPages) {
      // jsPDF reports A4 as 210.0015 wide, so card widths record as
      // 170.0015, not exactly 170. Compare with an epsilon.
      const cards = boxes.filter(
        (b) =>
          b.kind === 'rect' &&
          b.page === page &&
          Math.abs(b.w - 170) < 1 &&
          b.h >= 20,
      );
      expect(cards.length).toBeGreaterThan(0);
      const cardTop = Math.min(...cards.map((c) => c.y));
      const cardBottom = Math.max(...cards.map((c) => c.y + c.h));
      const content = boxes.filter(
        (b) =>
          b.page === page &&
          (b.kind === 'text' || b.kind === 'image') &&
          b.y < FOOTER_TOP &&
          !(b.kind === 'text' && b.label === 'MISSION EXECUTION PLAN'),
      );
      for (const b of content) {
        if (b.y < cardTop - OVERLAP_EPSILON) {
          throw new Error(
            `long content: ${b.kind} "${b.label}" on page ${page} starts above its card ` +
              `(top=${b.y.toFixed(2)}, card top=${cardTop.toFixed(2)})`,
          );
        }
        if (b.y + b.h > cardBottom + OVERLAP_EPSILON) {
          throw new Error(
            `long content: ${b.kind} "${b.label}" on page ${page} extends below its card ` +
              `(bottom=${(b.y + b.h).toFixed(2)}, card bottom=${cardBottom.toFixed(2)})`,
          );
        }
      }
    }

    // All three resource links render (the domain survives URL wrapping).
    expect(boxes.some((b) => b.kind === 'text' && b.label.includes('example.com'))).toBe(
      true,
    );
    expect(boxes.some((b) => b.kind === 'text' && b.label.includes('Resource 3'))).toBe(
      true,
    );
  });

  test('6. cover page: cover QR present and its URL text clear of the directive box', async () => {
    const workflow = baseWorkflow();
    const rec = await exportAndCapture(workflow);
    const boxes = rec.boxes;

    const coverQrs = coverQrBoxes(boxes);
    expect(coverQrs).toHaveLength(1);
    expect(coverQrs[0].w).toBeCloseTo(coverQrs[0].h, 6);
    expect(coverQrs[0].w).toBeGreaterThanOrEqual(20);

    // The directive box is the 170x22 filled rect on the cover page
    // (width records as 170.0015; see the epsilon note in the header).
    const directiveBoxes = boxes.filter(
      (b) =>
        b.kind === 'rect' &&
        b.page === 1 &&
        Math.abs(b.w - 170) < 1 &&
        Math.abs(b.h - 22) < 0.5,
    );
    expect(directiveBoxes).toHaveLength(1);
    const directive = directiveBoxes[0];

    // The clickable mission URL text under the cover QR.
    const urlTexts = boxes.filter(
      (b) => b.kind === 'text' && b.page === 1 && b.label.includes('/missions/'),
    );
    expect(urlTexts.length).toBeGreaterThan(0);
    for (const urlText of urlTexts) {
      const glyph = glyphBox(urlText);
      if (!boxesOverlap(glyph, directive)) continue;
      throw new Error(
        `cover: URL text "${urlText.label}" overlaps the directive box ` +
          `(URL glyph y=${glyph.y.toFixed(2)}..${(glyph.y + glyph.h).toFixed(2)}, ` +
          `directive y=${directive.y.toFixed(2)}..${(directive.y + directive.h).toFixed(2)})`,
      );
    }
  });
});
