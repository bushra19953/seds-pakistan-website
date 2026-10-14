/**
 * Regression tests for clickable profile links in workflow PDF personnel rows.
 *
 * Bug: in workflow PDF export, only the FIRST assignee personnel row
 * renders visibly. The export uses a clickable link pattern
 * (drawClickableUrl / measureUrlLines) for profile URLs next to each QR.
 * These tests pin that pattern for EVERY personnel row, so the
 * invisibility fix cannot silently drop the links on rows 2 and later.
 *
 * What is asserted, for a 5-assignee step:
 * - Test 1: one or more link annotations exist for EACH of the 5 profile
 *   URLs, each annotation has a sane rect (positive size, inside the page,
 *   no wider than the QR column), and each annotation sits inside its own
 *   row bounds (paired to that row QR image on the same page).
 * - Test 2: the visible link text for EACH row reconstructs that row
 *   profile URL exactly when the wrapped fragments next to its QR are
 *   joined in reading order, so the link is present in the content stream
 *   and not just an invisible annotation.
 *
 * Harness: same RecordingJsPDF approach as
 * workflow-pdf-export-geometry.test.ts (subclass of the real jsPDF node
 * build, interceptDoc records text/image/rect boxes, save is a no-op).
 * That helper does not record doc.link calls, so this file additionally
 * wraps doc.link and records every annotation (url, rect, page).
 * jsPDF assigns drawing methods as per-instance own properties, so the
 * subclass constructor approach is what actually intercepts them.
 *
 * Fail behavior: if rows 2+ lack links, test 1 fails because those rows
 * QR images have no nearby link annotation and fewer than 5 distinct
 * profile URLs appear, and test 2 fails because those rows have no URL
 * text fragments next to their QR. If the invisibility fix keeps the
 * link pattern on every row, both tests pass.
 *
 * Determinism: fixed workflow id, fixed step id, fixed deadline, fixed
 * assignee ids. The cover Issue Date uses the current date but is never
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
      const helper: any = jest.requireActual('../pdf-geometry');
      const { boxes } = helper.interceptDoc(this);
      const rec: any = { boxes, links: [], doc: this, saved: false };
      const regs =
        (globalThis as any).__pdfRowsVisibilityRecordings ||
        ((globalThis as any).__pdfRowsVisibilityRecordings = []);
      regs.push(rec);
      // Record every doc.link annotation. The exporter always calls
      // link(x, y, w, h, { url }), so record that shape and pass through.
      const origLink = (this as any).link;
      (this as any).link = function (...linkArgs: any[]) {
        const [x, y, w, h, opts] = linkArgs;
        if (
          typeof x === 'number' &&
          typeof y === 'number' &&
          typeof w === 'number' &&
          typeof h === 'number' &&
          opts &&
          typeof opts.url === 'string'
        ) {
          let page = 1;
          try {
            const info = (this as any).getCurrentPageInfo?.();
            if (info && typeof info.pageNumber === 'number') page = info.pageNumber;
          } catch {
            // Keep the fallback page.
          }
          rec.links.push({ url: opts.url, x, y, w, h, page });
        }
        return origLink.apply(this, linkArgs);
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
import type { RecordedBox } from '../pdf-geometry';

/** A4 in mm, the format exportWorkflowAsPDF uses. */
const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
/** QR column width used by the exporter for personnel rows. */
const PERSONNEL_QR_COL = 30;
/** Slack for floating point noise in rect comparisons. */
const EPSILON = 0.5;

interface LinkAnnotation {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
}

interface PdfRecording {
  boxes: RecordedBox[];
  links: LinkAnnotation[];
  doc: { getNumberOfPages: () => number };
  saved: boolean;
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

async function exportAndCapture(workflow: WorkflowPDFData): Promise<PdfRecording> {
  await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
  const rec = lastRecording();
  expect(rec.saved).toBe(true);
  return rec;
}

/** Per-teammate QR codes: PNG images no larger than the cover QR, on step pages. */
function stepQrBoxes(boxes: RecordedBox[]): RecordedBox[] {
  return boxes.filter(
    (b) => b.kind === 'image' && b.label.includes('PNG') && b.w <= 60 && b.h <= 60 && b.page > 1,
  );
}

/** The five assignees in the fixture, in personnel row order. */
const ASSIGNEE_IDS = ['user-primary', 'user-2', 'user-3', 'user-4', 'user-5'];
const ASSIGNEE_NAMES = [
  'Primary Person',
  'Second Person',
  'Third Person',
  'Fourth Person',
  'Fifth Person',
];

function profileUrlFor(assigneeId: string): string {
  const origin =
    typeof window !== 'undefined' && window.location && window.location.origin
      ? window.location.origin
      : 'https://sedspakistan.live';
  return `${origin}/profile/unified/${assigneeId}?task=step-1`;
}

function fiveAssigneeWorkflow(): WorkflowPDFData {
  const step: WorkflowPDFStep = {
    id: 'step-1',
    title: 'Step One: Five Assignees',
    description: 'A step with five assignees, one personnel row each.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: 'Primary Person',
    assigneeEmail: 'primary@example.com',
    assigneeWhatsapp: '+923001234567',
    assigneeChapter: 'SEDS IST Chapter',
    assigneeRole: 'member',
    role: 'Step Owner',
    individualDeadline: '2026-10-20T15:30:00+05:00',
    assignees: ASSIGNEE_IDS.map((id, i) => ({ id, name: ASSIGNEE_NAMES[i], role: 'member' })),
  };
  return {
    id: 'wf-pdf-rows-visibility-310',
    title: 'Rows Visibility Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    chapterName: 'SEDS IST Chapter',
    description: 'A workflow built to pin clickable links on every personnel row.',
    steps: [step],
  };
}

/**
 * Links near one QR image: same page, vertically from just above the QR
 * to below its URL block, and horizontally overlapping the QR column
 * expanded by 10mm on each side (the centered URL text may extend a few
 * mm past the 22mm QR on either side, within the 30mm QR column).
 */
function linksNearQr(qr: RecordedBox, links: LinkAnnotation[]): LinkAnnotation[] {
  return links.filter(
    (l) =>
      l.page === qr.page &&
      l.y >= qr.y - 1 &&
      l.y <= qr.y + 45 &&
      l.x < qr.x + qr.w + 10 &&
      l.x + l.w > qr.x - 10,
  );
}

beforeEach(() => {
  recordings().length = 0;
});

describe('workflow PDF personnel row clickable links (agent 3-10)', () => {
  test('1. each of the 5 personnel rows has a profile link annotation inside its row bounds', async () => {
    const rec = await exportAndCapture(fiveAssigneeWorkflow());
    const boxes = rec.boxes;
    const links = rec.links;

    const expectedUrls = ASSIGNEE_IDS.map((id) => profileUrlFor(id));

    // Five per-teammate QR codes, one per assignee.
    const qrs = stepQrBoxes(boxes);
    expect(qrs).toHaveLength(5);

    // Every expected profile URL has at least one link annotation.
    // A wrapped URL produces one annotation per wrapped line, so the
    // count per URL may exceed one; the per-URL presence is what matters.
    for (const url of expectedUrls) {
      const forUrl = links.filter((l) => l.url === url);
      expect(forUrl.length).toBeGreaterThanOrEqual(1);
    }

    // Exactly the 5 expected profile URLs appear, no row missing, no
    // row duplicated under a different URL.
    const profileLinks = links.filter((l) => expectedUrls.includes(l.url));
    expect(new Set(profileLinks.map((l) => l.url))).toEqual(new Set(expectedUrls));

    // Every profile link annotation has a sane rect: finite, positive
    // size, inside the page, no wider than the QR column it wraps in.
    for (const link of profileLinks) {
      expect(Number.isFinite(link.x)).toBe(true);
      expect(Number.isFinite(link.y)).toBe(true);
      expect(Number.isFinite(link.w)).toBe(true);
      expect(Number.isFinite(link.h)).toBe(true);
      expect(link.w).toBeGreaterThan(0);
      expect(link.h).toBeGreaterThan(0);
      expect(link.x).toBeGreaterThanOrEqual(-EPSILON);
      expect(link.y).toBeGreaterThanOrEqual(-EPSILON);
      expect(link.x + link.w).toBeLessThanOrEqual(PAGE_WIDTH + EPSILON);
      expect(link.y + link.h).toBeLessThanOrEqual(PAGE_HEIGHT + EPSILON);
      expect(link.w).toBeLessThanOrEqual(PERSONNEL_QR_COL + EPSILON);
    }

    // Each QR pairs to exactly one distinct profile URL, and each URL
    // pairs to exactly one QR. This is the per-row check: if rows 2+
    // lacked links, their QRs would have zero nearby links and this fails.
    const qrToUrl = new Map<RecordedBox, string>();
    const seenUrls = new Set<string>();
    for (const qr of qrs) {
      const nearby = linksNearQr(qr, profileLinks);
      expect(nearby.length).toBeGreaterThanOrEqual(1);
      const distinct = new Set(nearby.map((l) => l.url));
      expect(distinct.size).toBe(1);
      const url = [...distinct][0];
      expect(seenUrls.has(url)).toBe(false);
      seenUrls.add(url);
      qrToUrl.set(qr, url);

      // Each nearby annotation sits inside this row bounds: horizontally
      // within the QR column expanded by the centering slack, vertically
      // from the QR top to below the QR plus its URL block.
      for (const link of nearby) {
        expect(link.x).toBeGreaterThanOrEqual(qr.x - 8 - EPSILON);
        expect(link.x + link.w).toBeLessThanOrEqual(qr.x + qr.w + 8 + EPSILON);
        expect(link.y).toBeGreaterThanOrEqual(qr.y - EPSILON);
        expect(link.y + link.h).toBeLessThanOrEqual(qr.y + 45 + EPSILON);
      }
    }
    expect(seenUrls).toEqual(new Set(expectedUrls));
    expect(qrToUrl.size).toBe(5);
  }, 30000);

  test('2. the visible link text for each of the 5 rows reconstructs its profile URL', async () => {
    const rec = await exportAndCapture(fiveAssigneeWorkflow());
    const boxes = rec.boxes;
    const links = rec.links;

    const expectedUrls = ASSIGNEE_IDS.map((id) => profileUrlFor(id));
    const qrs = stepQrBoxes(boxes);
    expect(qrs).toHaveLength(5);

    const seenUrls = new Set<string>();
    for (const qr of qrs) {
      const nearby = linksNearQr(qr, links);
      expect(nearby.length).toBeGreaterThanOrEqual(1);
      const distinct = new Set(nearby.map((l) => l.url));
      expect(distinct.size).toBe(1);
      const url = [...distinct][0];
      expect(expectedUrls).toContain(url);
      expect(seenUrls.has(url)).toBe(false);
      seenUrls.add(url);

      // Visible URL text fragments next to this QR, in reading order.
      // The QR label sits above this band, so the y floor excludes it.
      // The fragments wrap without added spaces, so joining them in
      // order must reconstruct the URL exactly.
      const fragments = boxes
        .filter(
          (b) =>
            b.kind === 'text' &&
            b.page === qr.page &&
            b.y >= qr.y + 23 &&
            b.y <= qr.y + 50 &&
            b.x >= qr.x - 12 &&
            b.x + b.w <= qr.x + qr.w + 12,
        )
        .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
      expect(fragments.length).toBeGreaterThanOrEqual(1);
      const reconstructed = fragments.map((f) => f.label).join('');
      expect(reconstructed).toBe(url);
    }
    expect(seenUrls).toEqual(new Set(expectedUrls));
  }, 30000);
});
