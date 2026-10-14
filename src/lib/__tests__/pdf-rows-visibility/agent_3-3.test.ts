/**
 * Regression test for invisible PDF personnel rows (agent 3-3).
 *
 * Hypothesis under test: in workflow PDF export, only the FIRST assignee
 * personnel row renders visibly because a white or opaque filled rect is
 * drawn AFTER the text of rows 2 and later, covering that text.
 *
 * Method: generate a PDF with 5 assignees through the real export code,
 * intercept every draw call in draw order, and check each personnel row.
 * A rect counts as covering a row only when ALL of these hold:
 * - it is a filled rect (style contains F, so stroke-only rects do not count),
 * - its fill color is light (every channel >= 240, so white, paper white,
 *   card header, and light gray all count, while dark fills do not),
 * - it is drawn AFTER that row's text (draw order greater than the text),
 * - it is on the same page as that text,
 * - it overlaps that text by more than 0.5 mm on both axes.
 *
 * Legitimate backgrounds are not flagged: card and page backgrounds are
 * drawn BEFORE the text they sit behind, so the draw-order rule excludes
 * them. Dark footer bars are excluded by the light-fill rule. Stroke-only
 * borders are excluded by the filled rule.
 *
 * Expected behavior:
 * - On code with a covering rect, this test FAILS and names the rect,
 *   its fill, its draw order, and the text it covers.
 * - On code without a covering rect, this test PASSES, and the pass
 *   disproves the covering hypothesis for the 5-assignee case: the rows
 *   text ops are present and no light filled rect overlaps them.
 * - The synthetic detector test below proves the detector itself would
 *   catch a covering rect if one existed, so a pass is not a blind pass.
 *
 * Harness notes: exportWorkflowAsPDF builds its own jsPDF instance and
 * ends with doc.save(), so this file mocks 'jspdf' with RecordingJsPDF,
 * a subclass of the REAL jsPDF (the CJS node build at
 * jspdf/dist/jspdf.node.js, because the ESM build cannot load under this
 * repo's CJS Jest setup). The subclass constructor wraps the doc's own
 * setFillColor, text, rect, roundedRect, addPage, and setPage calls and
 * records one enriched box per call, in draw order. jsPDF assigns its
 * drawing methods as per-instance own properties, so spying on
 * jsPDF.prototype does NOT intercept anything. The subclass constructor
 * approach is what actually works. save() is overridden to a no-op that
 * marks the recording saved.
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
      const doc: any = this;
      const boxes: any[] = [];
      let order = 0;
      let trackedPage = 1;
      let currentFill: [number, number, number] = [0, 0, 0];
      const rec: any = { boxes, doc: this, saved: false };
      const regs =
        (globalThis as any).__agent33Recordings ||
        ((globalThis as any).__agent33Recordings = []);
      regs.push(rec);

      const normalizeFill = (fillArgs: any[]): [number, number, number] | null => {
        if (fillArgs.length === 1 && typeof fillArgs[0] === 'number') {
          const v = fillArgs[0];
          return [v, v, v];
        }
        if (
          fillArgs.length >= 3 &&
          typeof fillArgs[0] === 'number' &&
          typeof fillArgs[1] === 'number' &&
          typeof fillArgs[2] === 'number'
        ) {
          return [fillArgs[0], fillArgs[1], fillArgs[2]];
        }
        if (fillArgs.length === 1 && typeof fillArgs[0] === 'string') {
          const hex = fillArgs[0].replace('#', '');
          if (/^[0-9a-fA-F]{6}$/.test(hex)) {
            return [
              parseInt(hex.slice(0, 2), 16),
              parseInt(hex.slice(2, 4), 16),
              parseInt(hex.slice(4, 6), 16),
            ];
          }
        }
        return null;
      };

      const origSetFillColor = doc.setFillColor.bind(doc);
      doc.setFillColor = (...fillArgs: any[]) => {
        const parsed = normalizeFill(fillArgs);
        if (parsed) currentFill = parsed;
        return origSetFillColor(...fillArgs);
      };

      const origAddPage = doc.addPage.bind(doc);
      doc.addPage = (...pageArgs: any[]) => {
        const result = origAddPage(...pageArgs);
        trackedPage += 1;
        return result;
      };

      const origSetPage = doc.setPage.bind(doc);
      doc.setPage = (...pageArgs: any[]) => {
        const result = origSetPage(...pageArgs);
        if (typeof pageArgs[0] === 'number') trackedPage = pageArgs[0];
        return result;
      };

      const origText = doc.text.bind(doc);
      doc.text = (...textArgs: any[]) => {
        const textArg = textArgs[0];
        const xArg = textArgs[1];
        const yArg = textArgs[2];
        const optionsArg = textArgs[3];
        const options =
          optionsArg && typeof optionsArg === 'object' ? optionsArg : undefined;
        const align =
          (options && typeof options.align === 'string' ? options.align : undefined) ??
          'left';
        let fontSize = 11;
        if (options && typeof options.fontSize === 'number') {
          fontSize = options.fontSize;
        } else if (typeof doc.getFontSize === 'function') {
          try {
            const s = doc.getFontSize();
            if (typeof s === 'number' && s > 0) fontSize = s;
          } catch {
            // Keep the default.
          }
        }
        const lineHeight = fontSize * 0.55;
        const entries: string[] = [];
        if (typeof textArg === 'string') {
          entries.push(...textArg.split(/\r\n|\r|\n/g));
        } else if (Array.isArray(textArg)) {
          for (const item of textArg) {
            if (typeof item === 'string') entries.push(...item.split(/\r\n|\r|\n/g));
            else if (Array.isArray(item) && typeof item[0] === 'string') entries.push(item[0]);
            else entries.push(String(item ?? ''));
          }
        }
        const baseX = typeof xArg === 'number' ? xArg : 0;
        const baseY = typeof yArg === 'number' ? yArg : 0;
        entries.forEach((line, index) => {
          if (line.length === 0) return;
          let w = 0;
          try {
            w = doc.getTextWidth(line);
          } catch {
            w = line.length * fontSize * 0.5;
          }
          let left = baseX;
          if (align === 'center') left = baseX - w / 2;
          else if (align === 'right') left = baseX - w;
          boxes.push({
            kind: 'text',
            page: trackedPage,
            x: left,
            y: baseY - lineHeight + index * lineHeight,
            w,
            h: lineHeight,
            label: line,
            order: order++,
            fill: null,
            style: null,
          });
        });
        return origText(...textArgs);
      };

      const origRect = doc.rect.bind(doc);
      doc.rect = (...rectArgs: any[]) => {
        const [x, y, w, h, style] = rectArgs;
        if (
          typeof x === 'number' &&
          typeof y === 'number' &&
          typeof w === 'number' &&
          typeof h === 'number'
        ) {
          boxes.push({
            kind: 'rect',
            page: trackedPage,
            x,
            y,
            w,
            h,
            label: `rect:${typeof style === 'string' ? style : ''}`,
            order: order++,
            fill: [...currentFill] as [number, number, number],
            style: typeof style === 'string' ? style : '',
          });
        }
        return origRect(...rectArgs);
      };

      const origRoundedRect = doc.roundedRect.bind(doc);
      doc.roundedRect = (...rrArgs: any[]) => {
        const [x, y, w, h, , , style] = rrArgs;
        if (
          typeof x === 'number' &&
          typeof y === 'number' &&
          typeof w === 'number' &&
          typeof h === 'number'
        ) {
          boxes.push({
            kind: 'rect',
            page: trackedPage,
            x,
            y,
            w,
            h,
            label: `roundedRect:${typeof style === 'string' ? style : ''}`,
            order: order++,
            fill: [...currentFill] as [number, number, number],
            style: typeof style === 'string' ? style : '',
          });
        }
        return origRoundedRect(...rrArgs);
      };

      (this as any).save = () => {
        rec.saved = true;
      };
    }
  }

  return { ...Actual, jsPDF: RecordingJsPDF };
});

import { exportWorkflowAsPDF } from '../../workflow-pdf-export';
import type { WorkflowPDFData, WorkflowPDFStep } from '../../workflow-pdf-export';

interface EnrichedBox {
  kind: 'text' | 'rect';
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  order: number;
  fill: [number, number, number] | null;
  style: string | null;
}

interface PdfRecording {
  boxes: EnrichedBox[];
  saved: boolean;
}

function recordings(): PdfRecording[] {
  const g = globalThis as unknown as { __agent33Recordings?: PdfRecording[] };
  if (!g.__agent33Recordings) g.__agent33Recordings = [];
  return g.__agent33Recordings;
}

const LIGHT_FILL_MIN = 240;
const OVERLAP_EPSILON = 0.5;

function isLightFill(fill: [number, number, number] | null): boolean {
  return !!fill && fill.every((c) => c >= LIGHT_FILL_MIN);
}

function isFilledRect(box: EnrichedBox): boolean {
  return box.kind === 'rect' && !!box.style && /F/i.test(box.style);
}

function boxesOverlap(a: EnrichedBox, b: EnrichedBox): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX > OVERLAP_EPSILON && overlapY > OVERLAP_EPSILON;
}

function isCoveringRect(rect: EnrichedBox, textBox: EnrichedBox): boolean {
  if (!isFilledRect(rect)) return false;
  if (!isLightFill(rect.fill)) return false;
  if (rect.page !== textBox.page) return false;
  if (rect.order <= textBox.order) return false;
  return boxesOverlap(rect, textBox);
}

interface CoveringHit {
  rect: EnrichedBox;
  textBox: EnrichedBox;
}

function findCoveringRects(
  boxes: EnrichedBox[],
  rowTextBoxes: EnrichedBox[],
): CoveringHit[] {
  const hits: CoveringHit[] = [];
  for (const rect of boxes) {
    if (!isFilledRect(rect)) continue;
    if (!isLightFill(rect.fill)) continue;
    for (const textBox of rowTextBoxes) {
      if (isCoveringRect(rect, textBox)) {
        hits.push({ rect, textBox });
      }
    }
  }
  return hits;
}

function formatHit(hit: CoveringHit): string {
  const { rect, textBox } = hit;
  return (
    `light filled rect ${rect.label} fill=rgb(${rect.fill ? rect.fill.join(',') : '?'}) ` +
    `(page ${rect.page}, order ${rect.order}, x=${rect.x.toFixed(2)}, y=${rect.y.toFixed(2)}, ` +
    `w=${rect.w.toFixed(2)}, h=${rect.h.toFixed(2)}) drawn after and overlapping ` +
    `text "${textBox.label}" (page ${textBox.page}, order ${textBox.order}, ` +
    `x=${textBox.x.toFixed(2)}, y=${textBox.y.toFixed(2)}, w=${textBox.w.toFixed(2)}, h=${textBox.h.toFixed(2)})`
  );
}

/**
 * Row text boxes for one assignee: every text box drawn from that
 * assignee's name onward until the next assignee's name (or the end of
 * the document for the last row). Personnel rows are drawn in assignee
 * order, so draw order groups each row's name, role, chapter, contacts,
 * QR label, and QR URL text together.
 */
function rowTextBoxes(
  boxes: EnrichedBox[],
  name: string,
  nextName: string | null,
): EnrichedBox[] {
  const nameBox = boxes.find((b) => b.kind === 'text' && b.label === name);
  if (!nameBox) return [];
  const nextBox = nextName
    ? boxes.find((b) => b.kind === 'text' && b.label === nextName)
    : undefined;
  return boxes.filter(
    (b) =>
      b.kind === 'text' &&
      b.order >= nameBox.order &&
      (nextBox === undefined || b.order < nextBox.order),
  );
}

const ASSIGNEE_NAMES = [
  'Ayesha Khan',
  'Bilal Ahmed',
  'Cyrus Daniel',
  'Dania Ehsan',
  'Eman Farooq',
];

function baseStep(overrides: Partial<WorkflowPDFStep> = {}): WorkflowPDFStep {
  return {
    id: 'step-1',
    title: 'Step One',
    description: 'A short step description.',
    status: 'pending',
    assigneeId: 'user-1',
    assigneeName: 'Ayesha Khan',
    assigneeEmail: 'ayesha@example.com',
    assigneeWhatsapp: '+923001234567',
    assigneeChapter: 'SEDS IST Chapter',
    assigneeRole: 'member',
    role: 'Step Owner',
    individualDeadline: '2026-10-20T15:30:00+05:00',
    assignees: [
      { id: 'user-2', name: 'Bilal Ahmed', role: 'member', chapterName: 'SEDS IST Chapter' },
      { id: 'user-3', name: 'Cyrus Daniel', role: 'member', chapterName: 'SEDS IST Chapter' },
      { id: 'user-4', name: 'Dania Ehsan', role: 'member', chapterName: 'SEDS IST Chapter' },
      { id: 'user-5', name: 'Eman Farooq', role: 'member', chapterName: 'SEDS IST Chapter' },
    ],
    ...overrides,
  };
}

function baseWorkflow(overrides: Partial<WorkflowPDFData> = {}): WorkflowPDFData {
  return {
    id: 'wf-pdf-rows-visibility',
    title: 'Rows Visibility Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    chapterName: 'SEDS IST Chapter',
    description: 'A workflow built to check that all five personnel rows stay visible.',
    steps: [baseStep()],
    ...overrides,
  };
}

beforeEach(() => {
  recordings().length = 0;
});

describe('workflow PDF personnel rows visibility (covering rect)', () => {
  test('5 assignees: no light filled rect drawn after rows 2-5 text covers that text', async () => {
    await exportWorkflowAsPDF(baseWorkflow(), undefined, { hideQrCodes: false });
    const all = recordings();
    const rec = all[all.length - 1];
    expect(rec).toBeTruthy();
    expect(rec.saved).toBe(true);
    const boxes = rec.boxes;

    // Every row's name text op must be present, or the row is missing
    // entirely (a different failure from covering, but still a failure).
    for (const name of ASSIGNEE_NAMES) {
      const nameBoxes = boxes.filter((b) => b.kind === 'text' && b.label === name);
      expect(nameBoxes.length).toBeGreaterThanOrEqual(1);
    }

    // Rows 2-5 are the rows the hypothesis says are covered. Check each
    // row's full text bounds (name, role, chapter, contacts, QR label,
    // QR URL text), not just the name line.
    const failures: string[] = [];
    for (let i = 1; i < ASSIGNEE_NAMES.length; i++) {
      const name = ASSIGNEE_NAMES[i];
      const nextName = i + 1 < ASSIGNEE_NAMES.length ? ASSIGNEE_NAMES[i + 1] : null;
      const rowTexts = rowTextBoxes(boxes, name, nextName);
      expect(rowTexts.length).toBeGreaterThan(1);
      const hits = findCoveringRects(boxes, rowTexts);
      for (const hit of hits) {
        failures.push(`Row ${i + 1} (${name}): ${formatHit(hit)}`);
      }
    }

    // Also check row 1 with the same rule, so a covering rect that
    // happened to hit the first row is not silently ignored.
    const row1Texts = rowTextBoxes(boxes, ASSIGNEE_NAMES[0], ASSIGNEE_NAMES[1]);
    for (const hit of findCoveringRects(boxes, row1Texts)) {
      failures.push(`Row 1 (${ASSIGNEE_NAMES[0]}): ${formatHit(hit)}`);
    }

    expect(failures).toEqual([]);
  });

  test('detector sensitivity: a white filled rect drawn after text and overlapping it is flagged', () => {
    const textBox: EnrichedBox = {
      kind: 'text',
      page: 3,
      x: 30,
      y: 100,
      w: 40,
      h: 5,
      label: 'Bilal Ahmed',
      order: 10,
      fill: null,
      style: null,
    };
    const covering: EnrichedBox = {
      kind: 'rect',
      page: 3,
      x: 25,
      y: 98,
      w: 60,
      h: 10,
      label: 'rect:F',
      order: 11,
      fill: [255, 255, 255],
      style: 'F',
    };
    expect(isCoveringRect(covering, textBox)).toBe(true);
    expect(findCoveringRects([covering, textBox], [textBox])).toHaveLength(1);

    // Drawn BEFORE the text: a background, not a cover.
    const before: EnrichedBox = { ...covering, order: 9 };
    expect(isCoveringRect(before, textBox)).toBe(false);

    // Stroke-only: a border, not a cover.
    const strokeOnly: EnrichedBox = { ...covering, style: 'S', label: 'rect:S' };
    expect(isCoveringRect(strokeOnly, textBox)).toBe(false);

    // Dark fill: visible as a background band, does not hide text the
    // way a white rect does.
    const dark: EnrichedBox = { ...covering, fill: [15, 23, 42] };
    expect(isCoveringRect(dark, textBox)).toBe(false);

    // Different page: cannot cover text on another page.
    const otherPage: EnrichedBox = { ...covering, page: 4 };
    expect(isCoveringRect(otherPage, textBox)).toBe(false);

    // No overlap: a rect elsewhere on the page is not a cover.
    const elsewhere: EnrichedBox = { ...covering, x: 150, y: 200 };
    expect(isCoveringRect(elsewhere, textBox)).toBe(false);

    // Paper-white fill also counts as light.
    const paperWhite: EnrichedBox = { ...covering, fill: [252, 252, 250] };
    expect(isCoveringRect(paperWhite, textBox)).toBe(true);
  });
});
