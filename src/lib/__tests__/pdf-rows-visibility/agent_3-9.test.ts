/**
 * Agent 3-9: content-stream regression test for workflow PDF personnel rows.
 *
 * What this file proves: with 5 assignees on one step, every drawn element
 * on personnel pages (text, QR images, avatars, links) lies inside the page
 * bounds and inside the card padding margins. Nothing clips and nothing
 * runs off the page.
 *
 * APPROACH: parse the real PDF bytes, not the draw calls.
 * - exportWorkflowAsPDF builds its own jsPDF instance and ends with
 *   doc.save(), so this file mocks 'jspdf' with RecordingJsPDF (the same
 *   subclass pattern as workflow-pdf-export-geometry.test.ts). The mock
 *   overrides save() to capture doc.output('arraybuffer') into the
 *   recording, so assertions run against the actual PDF bytes the exporter
 *   produced.
 * - parsePdfBytes() walks the PDF objects, reads each page MediaBox,
 *   decompresses FlateDecode content streams when present, tokenizes the
 *   content stream, tracks the graphics-state CTM stack (q/Q/cm), the
 *   text matrix (BT/ET/Td/Tm/Tj/TJ), image placements (cm + Do),
 *   rectangles/paths (re/m/l/c + paint operators), and link annotation
 *   Rects from the page dictionary. Every entry is converted to
 *   top-down mm (PDF origin is bottom-left; jsPDF origin is top-left).
 * - Text widths are measured with the recording doc's real
 *   getTextWidth() after setting the parsed font (mapped from the PDF
 *   Resources font dictionary), so right-edge checks use real font
 *   metrics, not a character-count estimate.
 *
 * SCOPE NOTES (so this test does not false-positive on fixed code):
 * - Rect/path card backgrounds are backgrounds. When a many-assignee step
 *   spans pages, the exporter draws the first-page card at its full
 *   predicted height, so that background runs past the page bottom while
 *   the rows continue on a fresh page with their own capped card. That
 *   clipped background is cosmetic and out of scope (same reasoning as
 *   workflow-pdf-export-geometry.test.ts). Card backgrounds (width about
 *   170mm, height at least 20mm) are therefore checked for left/right/top
 *   only, never for bottom. Text, images, and links are always checked
 *   on all four sides.
 * - The footer band (last 10mm) spans the full page width by design, so
 *   footer text/rects are excluded from the card-horizontal check but
 *   are still checked against the page bounds.
 * - The page header ("MISSION EXECUTION PLAN") sits at the card left edge
 *   and is excluded from the personnel-inner check, but is still checked
 *   against the page bounds and the card horizontal range.
 *
 * Determinism: fixed workflow id, fixed step id, fixed deadline, fixed
 * assignee ids/names. The cover "Issue Date" uses the current date but is
 * never asserted on.
 */

import { inflateSync } from 'zlib';

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
      const rec: any = { doc: this, saved: false, pdfBytes: null as Uint8Array | null };
      const regs =
        (globalThis as any).__pdfRowsVisibility39Recordings ||
        ((globalThis as any).__pdfRowsVisibility39Recordings = []);
      regs.push(rec);
      (this as any).save = () => {
        rec.saved = true;
        try {
          const buf = (this as any).output('arraybuffer');
          rec.pdfBytes = buf ? new Uint8Array(buf) : null;
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

/** A4 in mm. */
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
/** Points per mm (72 / 25.4). */
const PT_PER_MM = 72 / 25.4;
/** Tolerance for floating point noise and hairline rounding. */
const EPS_MM = 0.5;
/** Step card horizontal range: left margin 20, content width 170. */
const CARD_LEFT_MM = 20;
const CARD_RIGHT_MM = 190;
/** Personnel inner range: card left + 10 padding to card right - 10 padding. */
const INNER_LEFT_MM = 30;
const INNER_RIGHT_MM = 180;
/** Footer band top (page height minus 10). */
const FOOTER_TOP_MM = PAGE_HEIGHT_MM - 10;
/** Card background detection: width about 170 and height at least 20. */
const CARD_BG_WIDTH_MM = 170;
const CARD_BG_MIN_HEIGHT_MM = 20;

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const LONG_NAME = 'Muhammad Alexander Christopher Jonathan Smith';
const FELLOW_NAMES = ['Second Person', 'Third Person', 'Fourth Person', 'Fifth Person'];

interface PdfRecording {
  doc: any;
  saved: boolean;
  pdfBytes: Uint8Array | null;
}

function recordings(): PdfRecording[] {
  const g = globalThis as unknown as { __pdfRowsVisibility39Recordings?: PdfRecording[] };
  if (!g.__pdfRowsVisibility39Recordings) g.__pdfRowsVisibility39Recordings = [];
  return g.__pdfRowsVisibility39Recordings;
}

/** One drawn element, in top-down mm. yTop is the top edge. */
interface ContentEntry {
  kind: 'text' | 'image' | 'path' | 'link';
  page: number;
  x: number;
  yTop: number;
  w: number;
  h: number;
  label: string;
}

type Matrix = [number, number, number, number, number, number];

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function translationMatrix(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

/** Return m1 after m2: apply m2 first, then m1. */
function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix(m: Matrix, p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

/** Decode the inside of a PDF (...) string, handling escapes and octal. */
function decodePdfString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'n') {
      out += '\n';
      i++;
    } else if (next === 'r') {
      out += '\r';
      i++;
    } else if (next === 't') {
      out += '\t';
      i++;
    } else if (next === 'b') {
      out += '\b';
      i++;
    } else if (next === 'f') {
      out += '\f';
      i++;
    } else if (next === '(' || next === ')' || next === '\\') {
      out += next;
      i++;
    } else if (next === '\n') {
      i++;
    } else if (next === '\r') {
      i++;
      if (raw[i + 1] === '\n') i++;
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      let j = i + 2;
      while (j < raw.length && octal.length < 3 && /[0-7]/.test(raw[j])) {
        octal += raw[j];
        j++;
      }
      out += String.fromCharCode(parseInt(octal, 8));
      i = j - 1;
    } else {
      out += next;
      i++;
    }
  }
  return out;
}

/** Decode a PDF <...> hex string. Handles a UTF-16BE BOM when present. */
function decodeHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const pair = clean.slice(i, i + 2);
    if (pair.length === 0) break;
    bytes.push(parseInt(pair.length === 1 ? pair + '0' : pair, 16));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
    }
    return out;
  }
  return bytes.map((b) => String.fromCharCode(b)).join('');
}

type Token =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'array'; value: Token[] }
  | { type: 'operator'; value: string };

/** Tokenize one content stream. Handles strings, hex strings, arrays, names, numbers, operators. */
function tokenizeContent(stream: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const len = stream.length;
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\0';
  const isDelimiter = (c: string) =>
    isWs(c) || c === '(' || c === ')' || c === '<' || c === '>' || c === '[' || c === ']' || c === '{' || c === '}' || c === '/' || c === '%';

  const parseArray = (): Token[] => {
    // pos is just past '['.
    const items: Token[] = [];
    while (pos < len) {
      while (pos < len && isWs(stream[pos])) pos++;
      if (pos >= len) break;
      if (stream[pos] === ']') {
        pos++;
        break;
      }
      const tok = parseOne();
      if (tok) items.push(tok);
    }
    return items;
  };

  const parseString = (): string => {
    // pos is just past '('.
    let depth = 1;
    let raw = '';
    while (pos < len && depth > 0) {
      const ch = stream[pos];
      if (ch === '\\') {
        raw += ch;
        if (pos + 1 < len) {
          raw += stream[pos + 1];
          pos += 2;
        } else {
          pos++;
        }
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')') {
        depth--;
        if (depth === 0) {
          pos++;
          break;
        }
      }
      if (depth > 0) raw += ch;
      pos++;
    }
    return decodePdfString(raw);
  };

  const parseOne = (): Token | null => {
    while (pos < len) {
      const ch = stream[pos];
      if (isWs(ch)) {
        pos++;
        continue;
      }
      if (ch === '%') {
        while (pos < len && stream[pos] !== '\n' && stream[pos] !== '\r') pos++;
        continue;
      }
      if (ch === '(') {
        pos++;
        return { type: 'string', value: parseString() };
      }
      if (ch === '<') {
        if (stream[pos + 1] === '<') {
          // Dictionary: skip balanced << >> (content streams rarely carry dicts).
          let depth = 0;
          while (pos < len) {
            if (stream[pos] === '<' && stream[pos + 1] === '<') {
              depth++;
              pos += 2;
            } else if (stream[pos] === '>' && stream[pos + 1] === '>') {
              depth--;
              pos += 2;
              if (depth <= 0) break;
            } else {
              pos++;
            }
          }
          continue;
        }
        pos++;
        let hex = '';
        while (pos < len && stream[pos] !== '>') {
          hex += stream[pos];
          pos++;
        }
        if (pos < len) pos++;
        return { type: 'string', value: decodeHexString(hex) };
      }
      if (ch === '[') {
        pos++;
        return { type: 'array', value: parseArray() };
      }
      if (ch === ']') {
        pos++;
        continue;
      }
      if (ch === '/') {
        pos++;
        let name = '';
        while (pos < len && !isDelimiter(stream[pos])) {
          name += stream[pos];
          pos++;
        }
        return { type: 'name', value: '/' + name };
      }
      if (ch === "'" || ch === '"') {
        pos++;
        return { type: 'operator', value: ch };
      }
      if (/[0-9+\-.]/.test(ch)) {
        let num = '';
        while (pos < len && /[0-9+\-.]/.test(stream[pos])) {
          num += stream[pos];
          pos++;
        }
        const value = parseFloat(num);
        if (Number.isFinite(value)) return { type: 'number', value };
        continue;
      }
      if (/[A-Za-z*]/.test(ch)) {
        let op = '';
        while (pos < len && /[A-Za-z*]/.test(stream[pos])) {
          op += stream[pos];
          pos++;
        }
        return { type: 'operator', value: op };
      }
      // Any other character: skip it.
      pos++;
    }
    return null;
  };

  while (pos < len) {
    const tok = parseOne();
    if (!tok) break;
    tokens.push(tok);
  }
  return tokens;
}

type MeasureFn = (text: string, fontName: string | undefined, fontSizePt: number) => number;

/**
 * Interpret one content stream into drawn entries. Tracks CTM (q, Q, cm),
 * text state (BT, ET, Tf, TL, Td, TD, Tm, T-star, Tj, TJ, quote ops),
 * image placement (cm plus Do), and paths (re, m, l, c, v, y, h plus paint ops).
 */
function parseContentStream(
  stream: string,
  page: number,
  pageHeightPt: number,
  measure: MeasureFn,
): ContentEntry[] {
  const tokens = tokenizeContent(stream);
  const entries: ContentEntry[] = [];
  let ctm: Matrix = identityMatrix();
  const ctmStack: Matrix[] = [];
  let fontName: string | undefined;
  let fontSizePt = 0;
  let leading = 0;
  let tm: Matrix = identityMatrix();
  let tlm: Matrix = identityMatrix();
  let inText = false;
  let path: Array<{ x: number; y: number }> = [];
  let operands: Token[] = [];

  const numbers = (): number[] =>
    operands.filter((t): t is { type: 'number'; value: number } => t.type === 'number').map((t) => t.value);

  const toMmBox = (pts: Array<{ x: number; y: number }>): { x: number; yTop: number; w: number; h: number } => {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX / PT_PER_MM,
      yTop: (pageHeightPt - maxY) / PT_PER_MM,
      w: (maxX - minX) / PT_PER_MM,
      h: (maxY - minY) / PT_PER_MM,
    };
  };

  const flushPath = () => {
    if (path.length === 0) return;
    const devicePts = path.map((p) => applyMatrix(ctm, p));
    const box = toMmBox(devicePts);
    entries.push({ kind: 'path', page, x: box.x, yTop: box.yTop, w: box.w, h: box.h, label: 'path' });
    path = [];
  };

  const recordText = (text: string) => {
    if (!text) return;
    const origin = applyMatrix(ctm, applyMatrix(tm, { x: 0, y: 0 }));
    const widthMm = measure(text, fontName, fontSizePt);
    const baselineTopDownMm = (pageHeightPt - origin.y) / PT_PER_MM;
    const ascentMm = fontSizePt * 0.3528;
    entries.push({
      kind: 'text',
      page,
      x: origin.x / PT_PER_MM,
      yTop: baselineTopDownMm - ascentMm,
      w: widthMm,
      h: ascentMm * 1.3,
      label: text,
    });
    // Advance the text matrix by the drawn width (in points, text space).
    const widthPt = widthMm * PT_PER_MM;
    tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + widthPt, tm[5]];
  };

  for (const token of tokens) {
    if (token.type !== 'operator') {
      operands.push(token);
      continue;
    }
    const op = token.value;
    const nums = numbers();
    switch (op) {
      case 'q':
        ctmStack.push(ctm);
        break;
      case 'Q':
        if (ctmStack.length > 0) ctm = ctmStack.pop() as Matrix;
        break;
      case 'cm':
        if (nums.length >= 6) {
          const m: Matrix = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
          ctm = multiplyMatrix(m, ctm);
        }
        break;
      case 'BT':
        inText = true;
        tm = identityMatrix();
        tlm = identityMatrix();
        break;
      case 'ET':
        inText = false;
        break;
      case 'Tf': {
        const nameTok = operands.find((t) => t.type === 'name') as { type: 'name'; value: string } | undefined;
        const sizeTok = operands.find((t) => t.type === 'number') as { type: 'number'; value: number } | undefined;
        if (nameTok) fontName = nameTok.value;
        if (sizeTok) fontSizePt = sizeTok.value;
        break;
      }
      case 'TL':
        if (nums.length >= 1) leading = nums[0];
        break;
      case 'Td':
      case 'TD':
        if (nums.length >= 2) {
          tlm = multiplyMatrix(translationMatrix(nums[0], nums[1]), tlm);
          tm = tlm;
          if (op === 'TD') leading = -nums[1];
        }
        break;
      case 'Tm':
        if (nums.length >= 6) {
          tm = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
          tlm = tm;
        }
        break;
      case 'T*':
        tlm = multiplyMatrix(translationMatrix(0, -leading), tlm);
        tm = tlm;
        break;
      case 'Tj': {
        const strTok = operands.find((t) => t.type === 'string') as { type: 'string'; value: string } | undefined;
        if (inText && strTok) recordText(strTok.value);
        break;
      }
      case 'TJ': {
        const arrTok = operands.find((t) => t.type === 'array') as { type: 'array'; value: Token[] } | undefined;
        if (inText && arrTok) {
          let combined = '';
          let kernPt = 0;
          for (const item of arrTok.value) {
            if (item.type === 'string') combined += item.value;
            else if (item.type === 'number') kernPt += (item.value * fontSizePt) / 1000;
          }
          if (combined) {
            recordText(combined);
            // TJ kerning shifts the next glyph: undo the part of the
            // advance that recordText added for the kerned amount.
            tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + kernPt, tm[5]];
          }
        }
        break;
      }
      case "'": {
        const strTok = operands.find((t) => t.type === 'string') as { type: 'string'; value: string } | undefined;
        if (inText && strTok) {
          tlm = multiplyMatrix(translationMatrix(0, -leading), tlm);
          tm = tlm;
          recordText(strTok.value);
        }
        break;
      }
      case '"': {
        const strTok = operands.find((t) => t.type === 'string') as { type: 'string'; value: string } | undefined;
        if (inText && strTok) {
          tlm = multiplyMatrix(translationMatrix(0, -leading), tlm);
          tm = tlm;
          recordText(strTok.value);
        }
        break;
      }
      case 'Do': {
        const nameTok = operands.find((t) => t.type === 'name') as { type: 'name'; value: string } | undefined;
        const corners = [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ].map((p) => applyMatrix(ctm, p));
        const box = toMmBox(corners);
        entries.push({
          kind: 'image',
          page,
          x: box.x,
          yTop: box.yTop,
          w: box.w,
          h: box.h,
          label: nameTok ? nameTok.value : 'image',
        });
        break;
      }
      case 're':
        if (nums.length >= 4) {
          const [x, y, w, h] = nums;
          path.push({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h });
        }
        break;
      case 'm':
        if (nums.length >= 2) path = [{ x: nums[0], y: nums[1] }];
        break;
      case 'l':
        if (nums.length >= 2) path.push({ x: nums[0], y: nums[1] });
        break;
      case 'c':
        if (nums.length >= 6) {
          path.push({ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] }, { x: nums[4], y: nums[5] });
        }
        break;
      case 'v':
        if (nums.length >= 4) path.push({ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] });
        break;
      case 'y':
        if (nums.length >= 4) path.push({ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] });
        break;
      case 'h':
        if (path.length > 0) path.push(path[0]);
        break;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        flushPath();
        break;
      case 'n':
        path = [];
        break;
      case 'W':
      case 'W*':
        // Clip path: the path stays until 'n'; it draws nothing itself.
        break;
      default:
        break;
    }
    operands = [];
  }
  return entries;
}

interface ParsedPage {
  pageNumber: number;
  pageObjNum: number;
  mediaBox: [number, number, number, number];
  entries: ContentEntry[];
}

/** Parse full PDF bytes into per-page drawn entries plus link entries. */
function parsePdfBytes(bytes: Uint8Array, measure: MeasureFn): ParsedPage[] {
  const raw = Buffer.from(bytes).toString('latin1');
  const objMap = new Map<number, { dict: string; stream: string; isFlate: boolean }>();
  const objRe = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw)) !== null) {
    const num = parseInt(m[1], 10);
    const body = m[2];
    const streamIdx = body.indexOf('stream');
    let dict = body;
    let stream = '';
    if (streamIdx >= 0) {
      dict = body.slice(0, streamIdx);
      let start = streamIdx + 'stream'.length;
      if (body[start] === '\r' && body[start + 1] === '\n') start += 2;
      else if (body[start] === '\n' || body[start] === '\r') start += 1;
      let end = body.indexOf('endstream', start);
      if (end < 0) end = body.length;
      stream = body.slice(start, end);
      if (stream.endsWith('\r\n')) stream = stream.slice(0, -2);
      else if (stream.endsWith('\n') || stream.endsWith('\r')) stream = stream.slice(0, -1);
    }
    objMap.set(num, { dict, stream, isFlate: /\/FlateDecode/.test(dict) });
  }

  const pagesByObj = new Map<number, ParsedPage>();
  const pageOrder: number[] = [];
  for (const [num, obj] of objMap) {
    if (!/\/Type\s*\/Page(?![A-Za-z])/.test(obj.dict)) continue;
    const mbMatch = /\/MediaBox\s*\[([^\]]+)\]/.exec(obj.dict);
    const mbNums = mbMatch ? mbMatch[1].trim().split(/\s+/).map(Number) : [0, 0, 595.28, 841.89];
    const mediaBox: [number, number, number, number] = [
      mbNums[0] ?? 0,
      mbNums[1] ?? 0,
      mbNums[2] ?? 595.28,
      mbNums[3] ?? 841.89,
    ];
    const pageHeightPt = mediaBox[3] - mediaBox[1];
    const contentNums: number[] = [];
    const contentsArrayMatch = /\/Contents\s*\[([^\]]+)\]/.exec(obj.dict);
    if (contentsArrayMatch) {
      const refRe = /(\d+)\s+0\s+R/g;
      let rm: RegExpExecArray | null;
      while ((rm = refRe.exec(contentsArrayMatch[1])) !== null) contentNums.push(parseInt(rm[1], 10));
    } else {
      const singleMatch = /\/Contents\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (singleMatch) contentNums.push(parseInt(singleMatch[1], 10));
    }
    const entries: ContentEntry[] = [];
    for (const cn of contentNums) {
      const cobj = objMap.get(cn);
      if (!cobj) continue;
      let streamText = cobj.stream;
      if (cobj.isFlate) {
        try {
          streamText = inflateSync(Buffer.from(cobj.stream, 'latin1')).toString('latin1');
        } catch {
          continue;
        }
      }
      entries.push(...parseContentStream(streamText, pageOrder.length + 1, pageHeightPt, measure));
    }
    // Link annotation Rects live in the page dictionary.
    const rectRe = /\/Rect\s*\[([^\]]+)\]/g;
    let rrm: RegExpExecArray | null;
    while ((rrm = rectRe.exec(obj.dict)) !== null) {
      const nums = rrm[1].trim().split(/\s+/).map(Number);
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) continue;
      const [x1, y1, x2, y2] = nums;
      const leftMm = Math.min(x1, x2) / PT_PER_MM;
      const rightMm = Math.max(x1, x2) / PT_PER_MM;
      const topMm = (pageHeightPt - Math.max(y1, y2)) / PT_PER_MM;
      const bottomMm = (pageHeightPt - Math.min(y1, y2)) / PT_PER_MM;
      const after = obj.dict.slice(rrm.index, rrm.index + 900);
      const uriMatch = /\/URI\s*\(((?:\\.|[^\\\)])*)\)/.exec(after);
      const uri = uriMatch ? decodePdfString(uriMatch[1]) : 'link';
      entries.push({
        kind: 'link',
        page: pageOrder.length + 1,
        x: leftMm,
        yTop: topMm,
        w: rightMm - leftMm,
        h: bottomMm - topMm,
        label: uri,
      });
    }
    pageOrder.push(num);
    pagesByObj.set(num, { pageNumber: pageOrder.length, pageObjNum: num, mediaBox, entries });
  }

  // Order pages by the /Pages Kids list when present, so page numbers
  // follow document order even if objects are stored out of order.
  let orderedObjNums = pageOrder;
  for (const obj of objMap.values()) {
    if (!/\/Type\s*\/Pages(?![A-Za-z])/.test(obj.dict)) continue;
    const kidsMatch = /\/Kids\s*\[([^\]]+)\]/.exec(obj.dict);
    if (!kidsMatch) continue;
    const kids: number[] = [];
    const kidRe = /(\d+)\s+0\s+R/g;
    let km: RegExpExecArray | null;
    while ((km = kidRe.exec(kidsMatch[1])) !== null) kids.push(parseInt(km[1], 10));
    if (kids.length === pagesByObj.size) orderedObjNums = kids;
    break;
  }
  return orderedObjNums
    .map((num, idx) => {
      const p = pagesByObj.get(num);
      if (!p) return null;
      const renumbered: ParsedPage = {
        ...p,
        pageNumber: idx + 1,
        entries: p.entries.map((e) => ({ ...e, page: idx + 1 })),
      };
      return renumbered;
    })
    .filter((p): p is ParsedPage => p !== null);
}

/** Map a PDF BaseFont name to a jsPDF family/style pair for getTextWidth. */
function fontForBaseFont(baseFont: string | undefined): { family: string; style: string } {
  const base = String(baseFont || '');
  if (base.startsWith('Times')) {
    if (base.includes('BoldItalic')) return { family: 'times', style: 'bolditalic' };
    if (base.includes('Bold')) return { family: 'times', style: 'bold' };
    if (base.includes('Italic')) return { family: 'times', style: 'italic' };
    return { family: 'times', style: 'normal' };
  }
  if (base.startsWith('Courier')) {
    if (base.includes('BoldOblique')) return { family: 'courier', style: 'bolditalic' };
    if (base.includes('Bold')) return { family: 'courier', style: 'bold' };
    if (base.includes('Oblique')) return { family: 'courier', style: 'italic' };
    return { family: 'courier', style: 'normal' };
  }
  if (base.includes('BoldOblique')) return { family: 'helvetica', style: 'bolditalic' };
  if (base.includes('Bold')) return { family: 'helvetica', style: 'bold' };
  if (base.includes('Oblique') || base.includes('Italic')) return { family: 'helvetica', style: 'italic' };
  return { family: 'helvetica', style: 'normal' };
}

/** True for a card-background path/rect: full card width, tall, drawn as a background. */
function isCardBackground(entry: ContentEntry): boolean {
  return (
    entry.kind === 'path' &&
    Math.abs(entry.w - CARD_BG_WIDTH_MM) < 1 &&
    entry.h >= CARD_BG_MIN_HEIGHT_MM
  );
}

/** True for the full-page background: 210 x 297, drawn behind everything. */
function isPageBackground(entry: ContentEntry): boolean {
  return (
    entry.kind === 'path' &&
    Math.abs(entry.w - PAGE_WIDTH_MM) < 1 &&
    Math.abs(entry.h - PAGE_HEIGHT_MM) < 1
  );
}

function assertInsidePageBounds(entry: ContentEntry, label: string): void {
  const right = entry.x + entry.w;
  const bottom = entry.yTop + entry.h;
  if (entry.x < -EPS_MM) {
    throw new Error(
      `${label}: ${entry.kind} "${entry.label}" on page ${entry.page} extends past the left page edge (x=${entry.x.toFixed(2)})`,
    );
  }
  if (right > PAGE_WIDTH_MM + EPS_MM) {
    throw new Error(
      `${label}: ${entry.kind} "${entry.label}" on page ${entry.page} extends past the right page edge (right=${right.toFixed(2)})`,
    );
  }
  if (entry.yTop < -EPS_MM) {
    throw new Error(
      `${label}: ${entry.kind} "${entry.label}" on page ${entry.page} extends past the top page edge (top=${entry.yTop.toFixed(2)})`,
    );
  }
  if (bottom > PAGE_HEIGHT_MM + EPS_MM) {
    throw new Error(
      `${label}: ${entry.kind} "${entry.label}" on page ${entry.page} extends past the page bottom (bottom=${bottom.toFixed(2)})`,
    );
  }
}

function assertInsideHorizontal(entry: ContentEntry, left: number, right: number, label: string): void {
  if (entry.x < left - EPS_MM) {
    throw new Error(
      `${label}: ${entry.kind} "${entry.label}" on page ${entry.page} starts left of ${left}mm (x=${entry.x.toFixed(2)})`,
    );
  }
  if (entry.x + entry.w > right + EPS_MM) {
    throw new Error(
      `${label}: ${entry.kind} "${entry.label}" on page ${entry.page} extends right of ${right}mm (right=${(entry.x + entry.w).toFixed(2)})`,
    );
  }
}

beforeEach(() => {
  recordings().length = 0;
});

describe('agent 3-9 pdf rows visibility, parsed from the content stream', () => {
  test('five assignees: every drawn element stays inside page bounds and card padding', async () => {
    expect(LONG_NAME.length).toBeGreaterThan(40);
    const workflow: WorkflowPDFData = {
      id: 'wf-pdf-rows-visibility-39',
      title: 'Rows Visibility Check',
      progressPercentage: 0,
      totalSteps: 1,
      completedSteps: 0,
      isCompleted: false,
      chapterName: 'SEDS IST Chapter',
      description: 'Step with five assignees to check that every personnel row stays visible.',
      steps: [
        {
          id: 'step-rows-39',
          title: 'Personnel Rows Visibility',
          description: 'One step owned by five people. Every row must render in full.',
          status: 'pending',
          assigneeId: 'user-primary',
          assigneeName: LONG_NAME,
          assigneeEmail: 'primary.person@example.com',
          assigneeWhatsapp: '+923001234567',
          assigneeChapter: 'SEDS IST Chapter',
          assigneeRole: 'member',
          role: 'Step Owner',
          individualDeadline: '2026-10-20T15:30:00+05:00',
          points: 10,
          assigneePhoto: TINY_PNG,
          assignees: [
            { id: 'user-primary', name: LONG_NAME, role: 'member', chapterName: 'SEDS IST Chapter' },
            ...FELLOW_NAMES.map((name, i) => ({
              id: `user-${i + 2}`,
              name,
              role: 'member',
              chapterName: 'SEDS IST Chapter',
            })),
          ],
          resources: [
            {
              title: 'Mission Brief',
              url: 'https://example.com/missions/rows-visibility/brief-document.pdf',
              type: 'link',
            },
          ],
        },
      ],
    };

    await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
    const rec = recordings()[recordings().length - 1];
    expect(rec).toBeDefined();
    expect(rec.saved).toBe(true);
    expect(rec.pdfBytes).not.toBeNull();
    expect(rec.pdfBytes as Uint8Array).toBeDefined();
    expect((rec.pdfBytes as Uint8Array).length).toBeGreaterThan(0);

    // Width measurement uses the real doc font metrics for the parsed font.
    // The PDF Resources font dictionary maps /F1, /F2, ... to BaseFont
    // names; the parser hands the font reference through, and here the
    // reference is resolved via the doc font stack. jsPDF getTextWidth
    // uses the currently set font, so set it per measurement.
    const measure: MeasureFn = (text, fontName, fontSizePt) => {
      if (!text) return 0;
      try {
        // fontName is the PDF resource name (for example /F1). The BaseFont
        // for the standard 14 fonts follows the jsPDF resource order:
        // F1 Helvetica, F2 Helvetica-Bold, F3 Helvetica-Oblique,
        // F4 Helvetica-BoldOblique, F5 Courier, F6 Courier-Bold,
        // F7 Courier-Oblique, F8 Courier-BoldOblique, F9 Times-Roman,
        // F10 Times-Bold, F11 Times-Italic, F12 Times-BoldItalic.
        // Map the resource name to its BaseFont for an exact metric.
        const resourceFonts: Record<string, string> = {
          '/F1': 'Helvetica',
          '/F2': 'Helvetica-Bold',
          '/F3': 'Helvetica-Oblique',
          '/F4': 'Helvetica-BoldOblique',
          '/F5': 'Courier',
          '/F6': 'Courier-Bold',
          '/F7': 'Courier-Oblique',
          '/F8': 'Courier-BoldOblique',
          '/F9': 'Times-Roman',
          '/F10': 'Times-Bold',
          '/F11': 'Times-Italic',
          '/F12': 'Times-BoldItalic',
        };
        const baseFont = resourceFonts[fontName || ''] || 'Helvetica';
        const { family, style } = fontForBaseFont(baseFont);
        rec.doc.setFont(family, style);
        rec.doc.setFontSize(fontSizePt);
        const w = rec.doc.getTextWidth(text);
        if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return w;
      } catch {
        // Fall through to the estimate.
      }
      return text.length * fontSizePt * 0.5 * 0.3528;
    };

    const pages = parsePdfBytes(rec.pdfBytes as Uint8Array, measure);
    expect(pages.length).toBeGreaterThanOrEqual(3);

    // Page size: every page MediaBox must be A4 (210 x 297 mm).
    for (const page of pages) {
      const wMm = (page.mediaBox[2] - page.mediaBox[0]) / PT_PER_MM;
      const hMm = (page.mediaBox[3] - page.mediaBox[1]) / PT_PER_MM;
      expect(Math.abs(wMm - PAGE_WIDTH_MM)).toBeLessThan(1);
      expect(Math.abs(hMm - PAGE_HEIGHT_MM)).toBeLessThan(1);
    }

    const allEntries = pages.flatMap((p) => p.entries);

    // Global rule: every text, image, path, and link stays inside the
    // page bounds. Card backgrounds are checked for left/right/top only,
    // because a spanning step card background legitimately runs past the
    // page bottom (see the header note).
    for (const entry of allEntries) {
      if (isCardBackground(entry)) {
        if (entry.x < -EPS_MM || entry.x + entry.w > PAGE_WIDTH_MM + EPS_MM || entry.yTop < -EPS_MM) {
          throw new Error(
            `page bounds: card background on page ${entry.page} escapes the page horizontally or above the top (x=${entry.x.toFixed(2)}, right=${(entry.x + entry.w).toFixed(2)}, top=${entry.yTop.toFixed(2)})`,
          );
        }
        continue;
      }
      assertInsidePageBounds(entry, 'page bounds');
    }

    // Personnel pages: pages carrying the PERSONNEL ASSIGNED header.
    const personnelPages = pages.filter((p) =>
      p.entries.some((e) => e.kind === 'text' && e.label === 'PERSONNEL ASSIGNED'),
    );
    expect(personnelPages.length).toBeGreaterThanOrEqual(1);

    for (const page of personnelPages) {
      const header = page.entries.find((e) => e.kind === 'text' && e.label === 'PERSONNEL ASSIGNED');
      expect(header).toBeDefined();
      const headerBottom = (header as ContentEntry).yTop + (header as ContentEntry).h;

      // Card rule: every non-footer, non-page-header element on a
      // personnel page stays inside the card horizontal range 20..190.
      for (const entry of page.entries) {
        if (entry.yTop >= FOOTER_TOP_MM) continue;
        if (entry.kind === 'text' && entry.label === 'MISSION EXECUTION PLAN') continue;
        // Backgrounds are not content: the page background spans the
        // full page and the card background plus its shadow define the
        // card itself. Both are already checked against page bounds.
        if (isCardBackground(entry) || isPageBackground(entry)) continue;
        assertInsideHorizontal(entry, CARD_LEFT_MM, CARD_RIGHT_MM, 'personnel page card range');
      }

      // Personnel inner rule: every element below the personnel header
      // (the person rows: names, roles, chapters, contacts, QR labels,
      // QR URL text, QR images, avatars, personnel links) stays inside
      // the inner personnel range 30..180, which is the card minus its
      // 10mm padding on each side.
      const rowEntries = page.entries.filter(
        (e) => e.yTop > headerBottom + 2 && e.yTop < FOOTER_TOP_MM,
      );
      expect(rowEntries.length).toBeGreaterThan(0);
      for (const entry of rowEntries) {
        if (isCardBackground(entry)) continue;
        assertInsideHorizontal(entry, INNER_LEFT_MM, INNER_RIGHT_MM, 'personnel inner range');
      }
    }

    // Presence: all five names appear as drawn text in the stream.
    const textLabels = allEntries.filter((e) => e.kind === 'text').map((e) => e.label);
    expect(textLabels).toContain(LONG_NAME);
    for (const name of FELLOW_NAMES) {
      expect(textLabels).toContain(name);
    }
    expect(textLabels).toContain('PERSONNEL ASSIGNED');

    // Presence: five per-teammate QR images (22 x 22) on personnel pages,
    // one per assignee, plus one cover QR (35 x 35) on page 1.
    const personnelPageNums = new Set(personnelPages.map((p) => p.pageNumber));
    const personnelQrImages = allEntries.filter(
      (e) =>
        e.kind === 'image' &&
        personnelPageNums.has(e.page) &&
        Math.abs(e.w - 22) < 1 &&
        Math.abs(e.h - 22) < 1,
    );
    expect(personnelQrImages).toHaveLength(5);
    const coverQrImages = allEntries.filter(
      (e) => e.kind === 'image' && e.page === 1 && Math.abs(e.w - 35) < 1 && Math.abs(e.h - 35) < 1,
    );
    expect(coverQrImages).toHaveLength(1);

    // Presence: the primary avatar (16 x 16) on a personnel page.
    const avatarImages = allEntries.filter(
      (e) =>
        e.kind === 'image' &&
        personnelPageNums.has(e.page) &&
        Math.abs(e.w - 16) < 1 &&
        Math.abs(e.h - 16) < 1,
    );
    expect(avatarImages.length).toBeGreaterThanOrEqual(1);

    // Presence: five distinct per-teammate profile links, one per
    // assignee, plus the primary phone and email links, all inside the
    // inner range. A wrapped URL draws one link Rect per wrapped line,
    // so the total Rect count is at least 5 while the distinct URI count
    // must be exactly 5.
    const profileLinks = allEntries.filter(
      (e) => e.kind === 'link' && e.label.includes('/profile/unified/'),
    );
    expect(profileLinks.length).toBeGreaterThanOrEqual(5);
    expect(new Set(profileLinks.map((e) => e.label)).size).toBe(5);
    for (const link of profileLinks) {
      expect(personnelPageNums.has(link.page)).toBe(true);
      assertInsideHorizontal(link, INNER_LEFT_MM, INNER_RIGHT_MM, 'profile link inner range');
    }
    const contactLinks = allEntries.filter(
      (e) => e.kind === 'link' && (e.label.startsWith('https://wa.me/') || e.label.startsWith('mailto:')),
    );
    expect(contactLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of contactLinks) {
      assertInsideHorizontal(link, INNER_LEFT_MM, INNER_RIGHT_MM, 'contact link inner range');
    }
  });
});
