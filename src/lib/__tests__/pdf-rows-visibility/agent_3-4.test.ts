/**
 * Agent 3-4 regression test: all 5 personnel rows visible with edge-case
 * assignee data, and each row has its own QR Do op.
 *
 * BUG: In workflow PDF export, only the FIRST assignee personnel row
 * renders visibly. Rows 2+ are present in the file but do not render
 * (drawn with a white or near-white fill color, or missing their QR).
 *
 * APPROACH: Generate a real PDF through the repo export code, capture
 * the PDF bytes from doc.save(), decompress every content stream, and
 * walk the operators tracking the nonstroking fill color (rg / g / k)
 * in effect, including the q/Q graphics-state stack, plus the text
 * position (Tm / Td) and font size (Tf) in effect, plus every image
 * placement (cm + Do). For each assignee name, find its Tj/TJ text op
 * and assert the fill color in effect at that op is visible
 * (non-white), the font size is readable, and the position is inside
 * the page. For each row, assert a personnel QR Do op exists on the
 * same page whose vertical span contains the row name baseline, which
 * ties that QR to that row instead of trusting addImage call counts.
 * This parses the actual PDF bytes, so it sees the color the renderer
 * will use, not the color the exporter asked for at the call site.
 *
 * EDGE-CASE MAPPING (read before changing the fixtures):
 * - The primary row is the only row with phone/email fields in the
 *   exporter model, so the missing-phone and missing-email cases live
 *   on the primary. Test 1 uses one primary missing BOTH contacts.
 *   Test 2 splits them across two distinct single-assignee steps so
 *   a missing phone and a missing email are proven for two different
 *   assignees.
 * - Fellow role strings go through canonicalRoleTitle, which
 *   normalizes unknown tokens to Team Member, so a long fellow role
 *   would never render verbatim. The long-role case therefore goes
 *   through the primary step.role field, which the exporter renders
 *   verbatim as "Responsibility: <role>". The long-chapter case goes
 *   through a fellow chapterName, which renders verbatim and wraps.
 * - Test 1: ONE step with 5 assignees (primary + 4 fellows). This is
 *   the shape the bug hits: rows 2-5 are co-assignee rows.
 * - Test 2: FIVE steps with one assignee each, isolating the
 *   missing-phone and missing-email assignees as distinct people.
 *
 * LIMITATIONS: The parser does not detect a later opaque white rect
 * painted over text. It proves presence, non-white color, readable
 * size, in-bounds position, and a paired QR Do op per row. Page
 * numbers come from content-stream order in the file (jsPDF emits
 * one content stream per page, in page order).
 */

jest.mock('jspdf', () => {
  const util = jest.requireActual('util');
  const g = globalThis as any;
  if (!g.TextEncoder) g.TextEncoder = util.TextEncoder;
  if (!g.TextDecoder) g.TextDecoder = util.TextDecoder;
  const Actual: any = jest.requireActual('jspdf/dist/jspdf.node.js');
  const RealJsPDF: any = Actual.jsPDF;

  class CapturingJsPDF extends RealJsPDF {
    constructor(...args: any[]) {
      super(...args);
      (this as any).save = () => {
        const bytes = (this as any).output('arraybuffer') as ArrayBuffer;
        const caps =
          (globalThis as any).__pdfRowsVisibilityCaptures_agent34 ||
          ((globalThis as any).__pdfRowsVisibilityCaptures_agent34 = []);
        caps.push(new Uint8Array(bytes));
      };
    }
  }

  return { ...Actual, jsPDF: CapturingJsPDF };
});

import { inflateSync } from 'zlib';
import { exportWorkflowAsPDF } from '../../workflow-pdf-export';
import type { WorkflowPDFData } from '../../workflow-pdf-export';

/** Points per mm. jsPDF writes content-stream coordinates in points. */
const PT_PER_MM = 72 / 25.4;
const PAGE_W_PT = 210 * PT_PER_MM;
const PAGE_H_PT = 297 * PT_PER_MM;
/** Personnel QRs are 22x22 mm; the cover QR is 35x35 mm. */
const PERSONNEL_QR_PT = 22 * PT_PER_MM;
const COVER_QR_PT = 35 * PT_PER_MM;
const QR_TOL_PT = 2;
/** Fill at or above this level on every channel reads as white paper. */
const WHITE_THRESHOLD = 0.97;
/** Minimum readable font size for a personnel name, in points. */
const MIN_NAME_FONT_PT = 6;

const LONG_NAME = 'Alexandria Maximilian Constantine Bartholomew Harrington-Smith';
const LONG_ROLE =
  'Coordinate cross-chapter payload integration, ground testing, and flight readiness reviews';
const LONG_CHAPTER =
  'SEDS Pakistan Institute of Space Technology Islamabad Chapter for Aerospace Research';

type Rgb = [number, number, number];

interface TextOp {
  text: string;
  color: Rgb;
  fontSize: number;
  x: number | null;
  y: number | null;
  page: number;
}

interface ImageOp {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
}

function captures(): Uint8Array[] {
  const g = globalThis as unknown as { __pdfRowsVisibilityCaptures_agent34?: Uint8Array[] };
  if (!g.__pdfRowsVisibilityCaptures_agent34) g.__pdfRowsVisibilityCaptures_agent34 = [];
  return g.__pdfRowsVisibilityCaptures_agent34;
}

/** Decode a PDF literal string (parenthesised) handling escapes. */
function decodeLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'n') { out += '\n'; i++; continue; }
    if (next === 'r') { out += '\r'; i++; continue; }
    if (next === 't') { out += '\t'; i++; continue; }
    if (next === 'b') { out += '\b'; i++; continue; }
    if (next === 'f') { out += '\f'; i++; continue; }
    if (next === '(' || next === ')' || next === '\\') { out += next; i++; continue; }
    if (/[0-7]/.test(next)) {
      let oct = next;
      let j = i + 2;
      while (j < raw.length && oct.length < 3 && /[0-7]/.test(raw[j])) { oct += raw[j]; j++; }
      out += String.fromCharCode(parseInt(oct, 8));
      i = j - 1;
      continue;
    }
    if (next === '\n') { i++; continue; }
    if (next === '\r') { i++; if (raw[i + 1] === '\n') i++; continue; }
    out += next;
    i++;
  }
  return out;
}

function decodeHex(raw: string): string {
  const cleaned = raw.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  if (cleaned.length % 2 === 1) {
    bytes.push(parseInt(cleaned.slice(-1) + '0', 16));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  return bytes.map((b) => String.fromCharCode(b)).join('');
}

function inflateOrNull(data: Uint8Array): Uint8Array | null {
  try {
    return new Uint8Array(inflateSync(Buffer.from(data)));
  } catch {
    return null;
  }
}

/**
 * Return every page content stream, in page order. A stream counts as
 * a content stream when it holds text blocks (BT) plus text-show or
 * image-paint operators. Image and font streams fail that filter.
 * Stream bytes are sliced by the declared /Length, never by searching
 * for the next "endstream": binary stream data can contain that byte
 * sequence, and searching for it double-counts the following stream.
 */
function contentStreams(pdf: Uint8Array): string[] {
  const latin = Buffer.from(pdf).toString('latin1');
  const out: string[] = [];
  // NOTE: plain /stream/ also matches the "stream" inside "endstream",
  // which makes every real stream appear twice (the second copy is a
  // shifted window holding the next page content). The lookbehind
  // excludes that false match.
  const streamRe = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(latin)) !== null) {
    const dataStart = match.index + match[0].length;
    const dictWindow = latin.slice(Math.max(0, match.index - 300), match.index);
    const lengthMatches = [...dictWindow.matchAll(/\/Length\s+(\d+)/g)];
    const declared = lengthMatches.length > 0 ? Number(lengthMatches[lengthMatches.length - 1][1]) : NaN;
    let raw: Buffer;
    if (Number.isFinite(declared) && declared > 0) {
      raw = Buffer.from(latin.slice(dataStart, dataStart + declared), 'latin1');
    } else {
      const endIdx = latin.indexOf('endstream', dataStart);
      if (endIdx === -1) break;
      raw = Buffer.from(latin.slice(dataStart, endIdx), 'latin1');
      while (raw.length > 0 && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) {
        raw = raw.subarray(0, raw.length - 1);
      }
    }
    const inflated = inflateOrNull(new Uint8Array(raw));
    const text = inflated ? Buffer.from(inflated).toString('latin1') : raw.toString('latin1');
    if (text.includes('BT') && (text.includes('Tj') || text.includes('TJ') || text.includes(' Do'))) {
      out.push(text);
    }
  }
  return out;
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const DELIM_RE = /[\s[\]()<>]/;

/**
 * Walk one decompressed content stream, tracking the nonstroking fill
 * color, the q/Q stack, the font size (Tf), and the text position
 * (Tm / Td / TD / T*). Return every Tj/TJ text op with the color,
 * size, and position in effect at that op, plus every cm + Do image
 * paint with its placement rectangle in points.
 */
function parseContentStream(content: string, page: number): { texts: TextOp[]; images: ImageOp[] } {
  const texts: TextOp[] = [];
  const images: ImageOp[] = [];
  let color: Rgb = [0, 0, 0];
  let fontSize = 0;
  let pos: { x: number; y: number } | null = null;
  let leading = 0;
  const stack: Array<{ color: Rgb; fontSize: number }> = [];
  let pendingNumbers: number[] = [];
  let pendingStrings: string[] = [];
  let pendingTJParts: string[] | null = null;
  let arrayParts: string[] | null = null;
  let arrayDepth = 0;
  let lastCm: number[] | null = null;

  const flushOperands = () => {
    pendingNumbers = [];
    pendingStrings = [];
  };

  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '%') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') {
      let depth = 1;
      let raw = '';
      i++;
      while (i < content.length && depth > 0) {
        const c = content[i];
        if (c === '\\' && i + 1 < content.length) { raw += c + content[i + 1]; i += 2; continue; }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) { i++; break; } }
        raw += c;
        i++;
      }
      const decoded = decodeLiteral(raw);
      if (arrayParts) arrayParts.push(decoded);
      else pendingStrings.push(decoded);
      continue;
    }
    if (ch === '<') {
      if (content[i + 1] === '<') {
        let depth = 0;
        while (i < content.length) {
          if (content.startsWith('<<', i)) { depth++; i += 2; continue; }
          if (content.startsWith('>>', i)) { depth--; i += 2; if (depth === 0) break; continue; }
          i++;
        }
        continue;
      }
      let raw = '';
      i++;
      while (i < content.length && content[i] !== '>') { raw += content[i]; i++; }
      i++;
      const decoded = decodeHex(raw);
      if (arrayParts) arrayParts.push(decoded);
      else pendingStrings.push(decoded);
      continue;
    }
    if (ch === '[') {
      if (arrayDepth === 0) arrayParts = [];
      arrayDepth++;
      i++;
      continue;
    }
    if (ch === ']') {
      arrayDepth = Math.max(0, arrayDepth - 1);
      if (arrayDepth === 0 && arrayParts) {
        pendingTJParts = arrayParts;
        arrayParts = null;
      }
      i++;
      continue;
    }
    if (ch === '/') {
      while (i < content.length && !DELIM_RE.test(content[i])) i++;
      continue;
    }
    let word = '';
    while (i < content.length && !DELIM_RE.test(content[i])) { word += content[i]; i++; }
    if (word === '') continue;
    if (NUM_RE.test(word)) {
      pendingNumbers.push(Number(word));
      continue;
    }
    if (word === 'q') {
      stack.push({ color: [...color] as Rgb, fontSize });
    } else if (word === 'Q') {
      const prev = stack.pop();
      if (prev) { color = prev.color; fontSize = prev.fontSize; }
    } else if (word === 'BT') {
      // Fresh text object: the text line matrix restarts at the
      // origin, so the Td that follows carries absolute coordinates.
      // Without this reset, Td offsets accumulate across text calls.
      pos = { x: 0, y: 0 };
    } else if (word === 'ET') {
      pos = null;
    } else if (word === 'rg') {
      const [r = 0, g = 0, b = 0] = pendingNumbers.slice(-3);
      color = [r, g, b];
    } else if (word === 'g') {
      const v = pendingNumbers[pendingNumbers.length - 1];
      if (v !== undefined) color = [v, v, v];
    } else if (word === 'k') {
      const [c = 0, m = 0, y = 0, k = 0] = pendingNumbers.slice(-4);
      color = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    } else if (word === 'Tf') {
      const v = pendingNumbers[pendingNumbers.length - 1];
      if (v !== undefined) fontSize = v;
    } else if (word === 'Tm') {
      const n = pendingNumbers.slice(-6);
      if (n.length >= 6 && n[4] !== undefined && n[5] !== undefined) {
        pos = { x: n[4], y: n[5] };
      }
    } else if (word === 'Td' || word === 'TD') {
      const n = pendingNumbers.slice(-2);
      const tx = n[0] ?? 0;
      const ty = n[1] ?? 0;
      pos = pos ? { x: pos.x + tx, y: pos.y + ty } : { x: tx, y: ty };
      if (word === 'TD') leading = -ty;
    } else if (word === 'TL') {
      const v = pendingNumbers[pendingNumbers.length - 1];
      if (v !== undefined) leading = v;
    } else if (word === 'T*') {
      if (pos) pos = { x: pos.x, y: pos.y - leading };
    } else if (word === 'Tj') {
      const text = pendingStrings[pendingStrings.length - 1] ?? '';
      texts.push({ text, color: [...color] as Rgb, fontSize, x: pos ? pos.x : null, y: pos ? pos.y : null, page });
    } else if (word === 'TJ') {
      const text = (pendingTJParts ?? []).join('');
      texts.push({ text, color: [...color] as Rgb, fontSize, x: pos ? pos.x : null, y: pos ? pos.y : null, page });
    } else if (word === "'" || word === '"') {
      const text = pendingStrings[pendingStrings.length - 1] ?? '';
      texts.push({ text, color: [...color] as Rgb, fontSize, x: pos ? pos.x : null, y: pos ? pos.y : null, page });
      if (pos) pos = { x: pos.x, y: pos.y - leading };
    } else if (word === 'cm') {
      if (pendingNumbers.length >= 6) lastCm = pendingNumbers.slice(-6);
    } else if (word === 'Do') {
      if (lastCm && lastCm.length >= 6) {
        const a = lastCm[0] ?? 0;
        const d = lastCm[3] ?? 0;
        const e = lastCm[4] ?? 0;
        const f = lastCm[5] ?? 0;
        images.push({ x: e, y: f, w: a, h: d, page });
      }
      lastCm = null;
    }
    pendingTJParts = null;
    flushOperands();
  }
  return { texts, images };
}

function parsePdf(pdf: Uint8Array): { texts: TextOp[]; images: ImageOp[] } {
  const texts: TextOp[] = [];
  const images: ImageOp[] = [];
  contentStreams(pdf).forEach((stream, index) => {
    const parsed = parseContentStream(stream, index + 1);
    texts.push(...parsed.texts);
    images.push(...parsed.images);
  });
  return { texts, images };
}

function isVisible(color: Rgb): boolean {
  return !(color[0] >= WHITE_THRESHOLD && color[1] >= WHITE_THRESHOLD && color[2] >= WHITE_THRESHOLD);
}

function assertNameVisible(texts: TextOp[], name: string): TextOp[] {
  const hits = texts.filter((o) => o.text.includes(name));
  expect(hits.length).toBeGreaterThan(0);
  for (const hit of hits) {
    expect(isVisible(hit.color)).toBe(true);
    expect(hit.fontSize).toBeGreaterThanOrEqual(MIN_NAME_FONT_PT);
    if (hit.x !== null && hit.y !== null) {
      expect(hit.x).toBeGreaterThanOrEqual(-0.5);
      expect(hit.x).toBeLessThanOrEqual(PAGE_W_PT + 0.5);
      expect(hit.y).toBeGreaterThanOrEqual(-0.5);
      expect(hit.y).toBeLessThanOrEqual(PAGE_H_PT + 0.5);
    }
  }
  expect(hits.some((h) => h.x !== null && h.y !== null)).toBe(true);
  return hits;
}

function personnelQrs(images: ImageOp[]): ImageOp[] {
  return images.filter(
    (im) => Math.abs(im.w - PERSONNEL_QR_PT) < QR_TOL_PT && Math.abs(im.h - PERSONNEL_QR_PT) < QR_TOL_PT,
  );
}

function assertRowHasQr(texts: TextOp[], qrs: ImageOp[], name: string): ImageOp {
  const hits = texts.filter(
    (o) => o.text.includes(name) && o.x !== null && o.y !== null,
  );
  expect(hits.length).toBeGreaterThan(0);
  const paired = qrs.filter((qr) =>
    hits.some(
      (hit) =>
        hit.page === qr.page &&
        hit.y !== null &&
        hit.y >= qr.y - 6 &&
        hit.y <= qr.y + qr.h + 6,
    ),
  );
  expect(paired.length).toBeGreaterThan(0);
  return paired[0];
}

function assertQrCounts(images: ImageOp[]): ImageOp[] {
  const qrs = personnelQrs(images);
  const cover = images.filter(
    (im) => Math.abs(im.w - COVER_QR_PT) < QR_TOL_PT && Math.abs(im.h - COVER_QR_PT) < QR_TOL_PT,
  );
  expect(qrs).toHaveLength(5);
  expect(cover).toHaveLength(1);
  expect(images).toHaveLength(6);
  const keys = new Set(qrs.map((qr) => `${qr.page}:${qr.y.toFixed(1)}`));
  expect(keys.size).toBe(5);
  return qrs;
}

/**
 * Text ops inside one row band: the paired QR vertical span, extended
 * 45pt below the QR (contacts sit below the name) and 15pt above it.
 * The band is page-scoped, so a neighbouring step on another page can
 * never leak into it.
 */
function rowBandOps(texts: TextOp[], name: string, qrs: ImageOp[]): TextOp[] {
  const qr = assertRowHasQr(texts, qrs, name);
  return texts.filter(
    (o) => o.page === qr.page && o.y !== null && o.y >= qr.y - 45 && o.y <= qr.y + qr.h + 15,
  );
}

function baseStep(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'step-1',
    title: 'Step One',
    description: 'A short step description.',
    status: 'pending',
    individualDeadline: '2026-10-20T15:30:00+05:00',
    ...overrides,
  };
}

beforeEach(() => {
  captures().length = 0;
});

describe('workflow PDF personnel rows visibility, agent 3-4 edge cases', () => {
  test('1. one step, 5 assignees with edge-case data: all rows visible, each row has a QR Do op', async () => {
    expect(LONG_NAME.length).toBeGreaterThanOrEqual(60);
    expect(LONG_ROLE.length).toBeGreaterThanOrEqual(60);
    expect(LONG_CHAPTER.length).toBeGreaterThanOrEqual(60);

    const names = [
      LONG_NAME,
      'Beatrice Eleanor Whitmore',
      'Dmitri Ivan Petrov',
      'Fatima Zahra Khan',
      'Gabriel Owen Mitchell',
    ];

    const workflow: WorkflowPDFData = {
      id: 'wf-agent-3-4-rows-visibility',
      title: 'Agent 3-4 Rows Visibility Workflow',
      progressPercentage: 0,
      totalSteps: 1,
      completedSteps: 0,
      isCompleted: false,
      chapterName: 'SEDS IST Chapter',
      description: 'A workflow built to pin down personnel row visibility with edge-case assignee data.',
      steps: [
        baseStep({
          id: 'step-1',
          title: 'Step One: Five Assignees Edge Cases',
          description: 'One step shared by five assignees.',
          assigneeId: 'user-1',
          assigneeName: LONG_NAME,
          assigneeEmail: undefined,
          assigneeWhatsapp: undefined,
          assigneeChapter: 'SEDS IST Chapter',
          assigneeRole: 'member',
          role: LONG_ROLE,
          assignees: [
            { id: 'user-1', name: LONG_NAME, role: 'member', chapterName: 'SEDS IST Chapter' },
            { id: 'user-2', name: 'Beatrice Eleanor Whitmore', role: 'member', chapterName: LONG_CHAPTER },
            { id: 'user-3', name: 'Dmitri Ivan Petrov' },
            { id: 'user-4', name: 'Fatima Zahra Khan', role: 'member', chapterName: 'SEDS IST Chapter' },
            { id: 'user-5', name: 'Gabriel Owen Mitchell', role: 'member', chapterName: 'SEDS IST Chapter' },
          ],
        }) as unknown as WorkflowPDFData['steps'][number],
      ],
    };

    await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
    expect(captures()).toHaveLength(1);
    const { texts, images } = parsePdf(captures()[0]);
    const qrs = assertQrCounts(images);

    for (const name of names) {
      assertNameVisible(texts, name);
      assertRowHasQr(texts, qrs, name);
    }

    // The 60+ char name stays on one line and is never split mid-token.
    expect(texts.some((o) => o.text === LONG_NAME)).toBe(true);

    // The long role (Responsibility line) and long chapter survive
    // wrapping: rejoining the drawn lines in order reproduces them.
    const joined = texts.map((o) => o.text).join(' ').replace(/\s+/g, ' ').trim();
    expect(joined).toContain(`Responsibility: ${LONG_ROLE}`);
    expect(joined).toContain(LONG_CHAPTER);

    // The primary row is the assignee missing phone and email: no
    // contact text appears inside that row band.
    const primaryBand = rowBandOps(texts, LONG_NAME, qrs);
    expect(primaryBand.length).toBeGreaterThan(0);
    expect(primaryBand.some((o) => o.text.includes('+92'))).toBe(false);
    expect(primaryBand.some((o) => o.text.includes('@'))).toBe(false);
  });

  test('2. five steps, one assignee each: missing phone and missing email are distinct assignees, all rows visible', async () => {
    const names = [
      LONG_NAME,
      'Hassan Raza Sheikh',
      'Imran Khalid Farooq',
      'Javeria Noor Siddiqui',
      'Kashif Ahmed Butt',
    ];

    const workflow: WorkflowPDFData = {
      id: 'wf-agent-3-4-rows-visibility-steps',
      title: 'Agent 3-4 Rows Visibility Steps Workflow',
      progressPercentage: 0,
      totalSteps: 5,
      completedSteps: 0,
      isCompleted: false,
      chapterName: 'SEDS IST Chapter',
      description: 'Five steps, one assignee each, isolating missing-contact edge cases.',
      steps: [
        baseStep({
          id: 'step-1',
          title: 'Step One: Long Name',
          description: 'Assignee with a very long name.',
          assigneeId: 'user-1',
          assigneeName: LONG_NAME,
          assigneeEmail: 'longname@example.com',
          assigneeWhatsapp: '+923001111111',
          assigneeChapter: 'SEDS IST Chapter',
          assigneeRole: 'member',
          role: 'Step Owner',
          assignees: [{ id: 'user-1', name: LONG_NAME, role: 'member', chapterName: 'SEDS IST Chapter' }],
        }),
        baseStep({
          id: 'step-2',
          title: 'Step Two: Missing Phone',
          description: 'Assignee with no phone number on file.',
          assigneeId: 'user-2',
          assigneeName: 'Hassan Raza Sheikh',
          assigneeEmail: 'hassan@example.com',
          assigneeWhatsapp: undefined,
          assigneeChapter: 'SEDS IST Chapter',
          assigneeRole: 'member',
          role: 'Step Owner',
          assignees: [{ id: 'user-2', name: 'Hassan Raza Sheikh', role: 'member', chapterName: 'SEDS IST Chapter' }],
        }),
        baseStep({
          id: 'step-3',
          title: 'Step Three: Missing Email',
          description: 'Assignee with no email address on file.',
          assigneeId: 'user-3',
          assigneeName: 'Imran Khalid Farooq',
          assigneeEmail: undefined,
          assigneeWhatsapp: '+923003333333',
          assigneeChapter: 'SEDS IST Chapter',
          assigneeRole: 'member',
          role: 'Step Owner',
          assignees: [{ id: 'user-3', name: 'Imran Khalid Farooq', role: 'member', chapterName: 'SEDS IST Chapter' }],
        }),
        baseStep({
          id: 'step-4',
          title: 'Step Four: Long Role And Chapter',
          description: 'Assignee with a long role and a long chapter.',
          assigneeId: 'user-4',
          assigneeName: 'Javeria Noor Siddiqui',
          assigneeEmail: 'javeria@example.com',
          assigneeWhatsapp: '+923004444444',
          assigneeChapter: LONG_CHAPTER,
          assigneeRole: 'member',
          role: LONG_ROLE,
          assignees: [{ id: 'user-4', name: 'Javeria Noor Siddiqui', role: 'member', chapterName: LONG_CHAPTER }],
        }),
        baseStep({
          id: 'step-5',
          title: 'Step Five: Baseline',
          description: 'Assignee with every field present.',
          assigneeId: 'user-5',
          assigneeName: 'Kashif Ahmed Butt',
          assigneeEmail: 'kashif@example.com',
          assigneeWhatsapp: '+923005555555',
          assigneeChapter: 'SEDS IST Chapter',
          assigneeRole: 'member',
          role: 'Step Owner',
          assignees: [{ id: 'user-5', name: 'Kashif Ahmed Butt', role: 'member', chapterName: 'SEDS IST Chapter' }],
        }),
      ] as unknown as WorkflowPDFData['steps'],
    };

    await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
    expect(captures()).toHaveLength(1);
    const { texts, images } = parsePdf(captures()[0]);
    const qrs = assertQrCounts(images);

    for (const name of names) {
      assertNameVisible(texts, name);
      assertRowHasQr(texts, qrs, name);
    }

    const joined = texts.map((o) => o.text).join(' ').replace(/\s+/g, ' ').trim();
    expect(joined).toContain(`Responsibility: ${LONG_ROLE}`);
    expect(joined).toContain(LONG_CHAPTER);

    // Missing phone: no phone text inside that assignee row band.
    const missingPhoneBand = rowBandOps(texts, 'Hassan Raza Sheikh', qrs);
    expect(missingPhoneBand.length).toBeGreaterThan(0);
    expect(missingPhoneBand.some((o) => o.text.includes('+92'))).toBe(false);

    // Missing email: no email text inside that assignee row band.
    const missingEmailBand = rowBandOps(texts, 'Imran Khalid Farooq', qrs);
    expect(missingEmailBand.length).toBeGreaterThan(0);
    expect(missingEmailBand.some((o) => o.text.includes('@'))).toBe(false);

    // Positive controls: the full-contact rows do show phone and email.
    const longNameBand = rowBandOps(texts, LONG_NAME, qrs);
    expect(longNameBand.some((o) => o.text.includes('+92'))).toBe(true);
    expect(longNameBand.some((o) => o.text.includes('@'))).toBe(true);
    const baselineBand = rowBandOps(texts, 'Kashif Ahmed Butt', qrs);
    expect(baselineBand.some((o) => o.text.includes('+92'))).toBe(true);
    expect(baselineBand.some((o) => o.text.includes('@'))).toBe(true);
  });
});
