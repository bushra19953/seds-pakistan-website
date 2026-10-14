/**
 * Agent 3-5 regression test: baseline single-assignee personnel row.
 *
 * Bug context: in the workflow PDF export only the FIRST assignee
 * personnel row renders visibly. This test pins the baseline case
 * (exactly 1 assignee) which renders today. It must PASS on current
 * code and keep passing after the fix, so a later change cannot
 * silently break even the first row.
 *
 * What it proves, for a workflow with exactly 1 assignee:
 * - the single personnel row name is drawn as text with a visible
 *   non-white color (not white on white, not missing),
 * - the row has a QR image, and the emitted PDF bytes contain a Do
 *   operator that paints that QR image (addImage alone is not taken
 *   on trust; the Do op in the content stream is checked).
 *
 * Approach: same harness as workflow-pdf-export-geometry.test.ts.
 * exportWorkflowAsPDF builds its own jsPDF instance and ends with
 * doc.save(), so 'jspdf' is mocked with RecordingJsPDF, a subclass of
 * the REAL jsPDF (CJS node build). The subclass runs interceptDoc
 * from ../pdf-geometry to record draw-call boxes, overrides save()
 * to a no-op, and additionally records the text color in effect for
 * every text call so visibility can be asserted on color, not just
 * on the presence of a box.
 */

jest.mock('jspdf', () => {
  const util = jest.requireActual('util');
  const g = globalThis as any;
  if (!g.TextEncoder) g.TextEncoder = util.TextEncoder;
  if (!g.TextDecoder) g.TextDecoder = util.TextDecoder;
  const Actual: any = jest.requireActual('jspdf/dist/jspdf.node.js');
  const RealJsPDF: any = Actual.jsPDF;

  function parseColor(args: any[]): [number, number, number] | null {
    if (args.length === 0) return null;
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('#')) {
      const hex = first.slice(1);
      const full =
        hex.length === 3
          ? hex
              .split('')
              .map((c: string) => c + c)
              .join('')
          : hex;
      if (/^[0-9a-fA-F]{6}$/.test(full)) {
        return [
          parseInt(full.slice(0, 2), 16),
          parseInt(full.slice(2, 4), 16),
          parseInt(full.slice(4, 6), 16),
        ];
      }
      return null;
    }
    if (Array.isArray(first) && first.length >= 3) {
      return [Number(first[0]), Number(first[1]), Number(first[2])];
    }
    if (typeof first === 'number' && args.length >= 3) {
      return [Number(args[0]), Number(args[1]), Number(args[2])];
    }
    if (typeof first === 'number' && args.length === 1) {
      return [first, first, first];
    }
    return null;
  }

  class RecordingJsPDF extends RealJsPDF {
    constructor(...args: any[]) {
      super(...args);
      const helper: any = jest.requireActual('../pdf-geometry');
      const { boxes } = helper.interceptDoc(this);
      const rec: any = { boxes, doc: this, saved: false, textColors: [] };
      const regs =
        (globalThis as any).__pdfRowsVisibilityRecordings ||
        ((globalThis as any).__pdfRowsVisibilityRecordings = []);
      regs.push(rec);
      (this as any).save = () => {
        rec.saved = true;
      };
      // Track the text color in effect for each text call.
      let currentColor: [number, number, number] = [0, 0, 0];
      const origSetTextColor = (this as any).setTextColor;
      (this as any).setTextColor = function (...colorArgs: any[]) {
        const parsed = parseColor(colorArgs);
        if (parsed) currentColor = parsed;
        return origSetTextColor.apply(this, colorArgs);
      };
      const interceptedText = (this as any).text;
      (this as any).text = function (...textArgs: any[]) {
        const before = boxes.length;
        const result = interceptedText.apply(this, textArgs);
        for (const box of boxes.slice(before)) {
          if (box.kind === 'text') {
            rec.textColors.push({
              label: box.label,
              page: box.page,
              color: [...currentColor] as [number, number, number],
            });
          }
        }
        return result;
      };
    }
  }

  return { ...Actual, jsPDF: RecordingJsPDF };
});

import { exportWorkflowAsPDF } from '../../workflow-pdf-export';
import type { WorkflowPDFData } from '../../workflow-pdf-export';
import type { RecordedBox } from '../pdf-geometry';

interface TextColorEntry {
  label: string;
  page: number;
  color: [number, number, number];
}

interface PdfRecording {
  boxes: RecordedBox[];
  doc: { getNumberOfPages: () => number; output: (type: string) => any };
  saved: boolean;
  textColors: TextColorEntry[];
}

function recordings(): PdfRecording[] {
  const g = globalThis as unknown as {
    __pdfRowsVisibilityRecordings?: PdfRecording[];
  };
  if (!g.__pdfRowsVisibilityRecordings) g.__pdfRowsVisibilityRecordings = [];
  return g.__pdfRowsVisibilityRecordings;
}

function lastRecording(): PdfRecording {
  const all = recordings();
  const rec = all[all.length - 1];
  if (!rec) throw new Error('No PDF was generated');
  return rec;
}

beforeEach(() => {
  recordings().length = 0;
});

describe('agent 3-5: single-assignee personnel row baseline', () => {
  test('exactly 1 assignee: single personnel row has visible non-white text and a QR Do op', async () => {
    const workflow: WorkflowPDFData = {
      id: 'wf-agent-3-5-baseline',
      title: 'Baseline Single Assignee Workflow',
      progressPercentage: 0,
      totalSteps: 1,
      completedSteps: 0,
      isCompleted: false,
      chapterName: 'SEDS IST Chapter',
      description: 'Baseline workflow with exactly one assignee.',
      steps: [
        {
          id: 'step-1',
          title: 'Step One',
          description: 'A short step description.',
          status: 'pending',
          assigneeId: 'user-solo',
          assigneeName: 'Baseline Solo Assignee',
          assigneeEmail: 'solo@example.com',
          assigneeWhatsapp: '+923001234567',
          assigneeChapter: 'SEDS IST Chapter',
          assigneeRole: 'member',
          role: 'Step Owner',
          individualDeadline: '2026-10-20T15:30:00+05:00',
        },
      ],
    };

    await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
    const rec = lastRecording();
    expect(rec.saved).toBe(true);
    const boxes = rec.boxes;

    // Exactly 1 personnel row: exactly 1 per-teammate QR on step pages.
    // The cover QR (35x35, page 1) is separate. A personnel QR is
    // 22x22 on a step page (page > 1).
    const stepQrBoxes = boxes.filter(
      (b) =>
        b.kind === 'image' &&
        b.page > 1 &&
        b.label.includes('PNG') &&
        Math.abs(b.w - 22) < 1 &&
        Math.abs(b.h - 22) < 1,
    );
    expect(stepQrBoxes).toHaveLength(1);
    const stepQr = stepQrBoxes[0];
    expect(stepQr.w).toBeGreaterThan(0);
    expect(stepQr.h).toBeGreaterThan(0);

    // The single personnel row name is drawn as text.
    const nameBoxes = boxes.filter(
      (b) => b.kind === 'text' && b.label === 'Baseline Solo Assignee',
    );
    expect(nameBoxes).toHaveLength(1);
    const nameBox = nameBoxes[0];
    expect(nameBox.w).toBeGreaterThan(0);
    expect(nameBox.h).toBeGreaterThan(0);
    // Row and its QR share a page, so the QR belongs to this row.
    expect(nameBox.page).toBe(stepQr.page);

    // The rest of the single row is drawn too: email and phone.
    expect(
      boxes.some((b) => b.kind === 'text' && b.label === 'solo@example.com'),
    ).toBe(true);
    expect(
      boxes.some((b) => b.kind === 'text' && b.label === '+923001234567'),
    ).toBe(true);

    // Visible non-white text: the name is drawn with a color that is
    // not white (255, 255, 255) and is dark enough to read on white.
    const nameColors = rec.textColors.filter(
      (entry) => entry.label === 'Baseline Solo Assignee',
    );
    expect(nameColors).toHaveLength(1);
    const [r, g, b] = nameColors[0].color;
    expect([r, g, b]).not.toEqual([255, 255, 255]);
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    expect(luminance).toBeLessThan(200);

    // QR Do op: the emitted PDF bytes must contain a Do operator
    // painting an image XObject. jsPDF emits one Do per addImage.
    // Cover QR plus the single personnel QR means at least 2 Do ops.
    const pdfBytes = rec.doc.output('arraybuffer');
    const pdfText = Buffer.from(pdfBytes).toString('latin1');
    const doOps = pdfText.match(/\/[A-Za-z0-9]+\s+Do\b/g) ?? [];
    expect(doOps.length).toBeGreaterThanOrEqual(2);
  });
});
