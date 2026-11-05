/**
 * Geometry regression test for MSG46: a long parent description under
 * OPERATIONAL INTENT must flow across pages without clipping or
 * overlapping the sections below it, and a URL inside it must be a
 * clickable link.
 *
 * What this file proves, with a ~5,500-char description carrying a URL:
 * - every text/image box stays inside its page (nothing past the bottom);
 * - the intent text flows onto a second briefing page;
 * - no intent line overlaps the COMMANDER'S DIRECTIVE callout box;
 * - MISSION ASSET INVENTORY starts below (or after) that box;
 * - the description URL is a recorded link annotation.
 * Plus a short-description control: the commander box stays on page 2,
 * exactly as before the fix.
 *
 * APPROACH: same as workflow-pdf-export-geometry.test.ts — 'jspdf' is
 * mocked with RecordingJsPDF, a subclass of the REAL jsPDF whose
 * constructor runs interceptDoc(this) from ./pdf-geometry.ts. This file
 * additionally wraps doc.link in the subclass constructor so link
 * annotations are recorded with their URL.
 *
 * Determinism: fixed workflow/step ids, fixed deadlines, no Date.now in
 * assertions. The cover "Issue Date" uses the current date but is never
 * asserted on.
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
      const helper: any = jest.requireActual('./pdf-geometry');
      const { boxes } = helper.interceptDoc(this);
      const rec = {
        boxes,
        links: [] as Array<{ x: number; y: number; w: number; h: number; url: string }>,
        doc: this,
        saved: false,
      };
      const regs =
        (globalThis as any).__workflowPdfIntentRecordings ||
        ((globalThis as any).__workflowPdfIntentRecordings = []);
      regs.push(rec);
      const origLink = (this as any).link?.bind(this);
      (this as any).link = (x: number, y: number, w: number, h: number, opts: any) => {
        rec.links.push({ x, y, w, h, url: String(opts?.url || '') });
        return origLink ? origLink(x, y, w, h, opts) : undefined;
      };
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
const PAGE_HEIGHT = 297;
/** Same overlap threshold as ./pdf-geometry.ts. */
const OVERLAP_EPSILON = 0.5;

interface PdfLink {
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
}

interface PdfRecording {
  boxes: RecordedBox[];
  links: PdfLink[];
  doc: { getNumberOfPages: () => number };
  saved: boolean;
}

function recordings(): PdfRecording[] {
  const g = globalThis as unknown as {
    __workflowPdfIntentRecordings?: PdfRecording[];
  };
  if (!g.__workflowPdfIntentRecordings) g.__workflowPdfIntentRecordings = [];
  return g.__workflowPdfIntentRecordings;
}

function lastRecording(): PdfRecording {
  const recs = recordings();
  const rec = recs[recs.length - 1];
  if (!rec) throw new Error('No PDF was generated');
  return rec;
}

/** 1x1 PNG used as a stand-in assignee photo. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DESCRIPTION_URL = 'https://sedspakistan.live/missions/wf-msg46-001';

/** Long parent description: URL first (so it lands whole on line 1),
 * then 60 tagged sentences, ~5,500 chars total. */
function longDescription(): string {
  const head = `See the full plan at ${DESCRIPTION_URL} for the criteria. `;
  const sentences: string[] = [];
  for (let n = 1; n <= 60; n++) {
    const tag = `SENT-${String(n).padStart(4, '0')}`;
    sentences.push(
      `${tag} The review criteria require every verdict to cite its evidence before the deadline, and the pod lead signs off each deliverable in turn.`,
    );
  }
  return head + sentences.join(' ');
}

function baseStep(overrides: Partial<WorkflowPDFStep> = {}): WorkflowPDFStep {
  return {
    id: 'step-1',
    title: 'Intent Geometry Step',
    description: 'A step used to exercise long-intent pagination.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: 'Primary Person',
    assigneePhoto: TINY_PNG,
    ...overrides,
  };
}

function baseWorkflow(overrides: Partial<WorkflowPDFData> = {}): WorkflowPDFData {
  return {
    id: 'wf-msg46-001',
    title: 'Long Intent Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    steps: [baseStep()],
    ...overrides,
  };
}

beforeEach(() => {
  recordings().length = 0;
});

describe('MSG46 long parent description renders without overlap', () => {
  test('5,500-char description with a URL flows across briefing pages, nothing clipped or overlapped, URL linked', async () => {
    const description = longDescription();
    expect(description.length).toBeGreaterThan(3000);
    await exportWorkflowAsPDF(baseWorkflow({ description }));
    const rec = lastRecording();
    expect(rec.saved).toBe(true);
    expect(rec.doc.getNumberOfPages()).toBeGreaterThanOrEqual(4);

    // 1. Every text/image box stays inside its page.
    for (const box of rec.boxes) {
      if (box.kind === 'rect') continue; // backgrounds clip at the edge by design
      expect(box.y).toBeGreaterThanOrEqual(-OVERLAP_EPSILON);
      expect(box.y + box.h).toBeLessThanOrEqual(PAGE_HEIGHT + OVERLAP_EPSILON);
    }

    // 2. The intent text flows: SENT- lines appear on at least two pages.
    const intentBoxes = rec.boxes.filter((b) => b.kind === 'text' && b.label.includes('SENT-'));
    expect(intentBoxes.length).toBeGreaterThan(0);
    const intentPages = new Set(intentBoxes.map((b) => b.page));
    expect(intentPages.size).toBeGreaterThanOrEqual(2);

    // 3. No intent line overlaps the COMMANDER'S DIRECTIVE callout box
    // (the 35mm-tall rounded rect, width = pageWidth - 40 = 170).
    const commanderRect = rec.boxes.find(
      (b) => b.kind === 'rect' && b.label === 'roundedRect' && b.h === 35 && Math.abs(b.w - 170) < 0.01,
    );
    expect(commanderRect).toBeTruthy();
    for (const box of intentBoxes) {
      if (box.page !== commanderRect!.page) continue;
      expect(boxesOverlap(box, commanderRect!)).toBe(false);
    }

    // 4. MISSION ASSET INVENTORY starts below (or after) the commander box.
    const inventoryHeading = rec.boxes.find(
      (b) => b.kind === 'text' && b.label === 'MISSION ASSET INVENTORY',
    );
    expect(inventoryHeading).toBeTruthy();
    if (inventoryHeading!.page === commanderRect!.page) {
      expect(inventoryHeading!.y).toBeGreaterThan(commanderRect!.y + commanderRect!.h);
    } else {
      expect(inventoryHeading!.page).toBeGreaterThan(commanderRect!.page);
    }

    // 5. The URL inside the description is a clickable link annotation.
    const urlLinks = rec.links.filter((l) => l.url === DESCRIPTION_URL);
    expect(urlLinks.length).toBeGreaterThanOrEqual(1);
    // The link sits inside the intent text column on the first briefing page.
    expect(urlLinks[0].x).toBeGreaterThanOrEqual(20);
    expect(urlLinks[0].x + urlLinks[0].w).toBeLessThanOrEqual(190 + OVERLAP_EPSILON);
  });

  test('short description keeps the commander box on page 2, as before', async () => {
    await exportWorkflowAsPDF(baseWorkflow({ description: 'Short intent. Review and approve.' }));
    const rec = lastRecording();
    expect(rec.saved).toBe(true);
    const commanderRect = rec.boxes.find(
      (b) => b.kind === 'rect' && b.label === 'roundedRect' && b.h === 35 && Math.abs(b.w - 170) < 0.01,
    );
    expect(commanderRect).toBeTruthy();
    expect(commanderRect!.page).toBe(2);
  });
});
