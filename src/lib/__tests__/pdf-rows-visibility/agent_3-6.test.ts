/**
 * Agent 3-6 regression test: 10-assignee personnel rows in the workflow PDF.
 *
 * Bug: in the workflow PDF export only the FIRST assignee personnel row
 * renders visibly. The remaining rows are present in the content stream
 * (their Tj text ops and QR Do ops are emitted) but a real PDF renderer
 * never paints them, so the exported directive ships with most of the
 * personnel block invisible.
 *
 * Root cause, verified against the emitted PDF bytes and a renderer
 * (PyMuPDF): the primary row draws a circular avatar with
 * saveGraphicsState, circle with style 'S', clip (W), addImage,
 * restoreGraphicsState, then a second circle with style 'S' for the
 * border. jsPDF's clip() emits a bare W with no following n
 * (discardPath). A W with no n leaves a pending clip that survives the
 * Q restore, and the next path-painting op (the border circle S, drawn
 * after the restore) applies the avatar circle as the clipping path of
 * the outer graphics state. Every text and image op drawn after that on
 * the same page is clipped to the 16 mm avatar circle, so rows 2 to 5
 * on the first personnel page are invisible. Rows on later pages use
 * fresh content streams with fresh graphics state, so they render.
 * The fix is to end the clipped path with n inside the saved state
 * (circle with null style, clip, discardPath, addImage, restore) or to
 * drop the clip, so no pending clip ever escapes the restore.
 *
 * What this test proves, for one step with exactly 10 assignees
 * (primary plus 9 fellows), with a primary assignee photo present
 * (the production path, where the admin page converts the photo to
 * base64 and the exporter draws the circular avatar):
 * - all 10 personnel row names are drawn as text with a visible
 *   non-white color,
 * - each row has exactly one personnel QR image, and the emitted PDF
 *   bytes contain a Do operator that paints that QR on the same page
 *   as the row name,
 * - each row is actually visible to a renderer: the name Tj and the QR
 *   Do are emitted while the current clipping path still covers them,
 *   not while a leaked avatar-circle clip is in effect,
 * - no row is split across pages: each row name, its role and chapter
 *   lines, and its QR all live on one page.
 *
 * Approach: same RecordingJsPDF harness as the geometry tests
 * (intercepted draw calls plus text-color tracking), plus a PDF
 * content-stream simulator. The simulator parses the real emitted
 * PDF bytes page by page, walks the operators, and tracks the
 * graphics-state stack, the current path, and the pending-clip flag
 * exactly as a renderer does: W sets a pending clip that is consumed
 * by the next path-terminating op (S, f, B, b, n), and that clip is
 * applied to the graphics state active at the terminating op, not at
 * the W. A pending clip therefore survives a Q restore when the
 * terminating op comes after the restore, which is the bug. Checking
 * intercepted boxes alone cannot catch this: the buggy code emits all
 * 10 rows and all 10 QRs, so interception passes while the rendered
 * page shows only the first row.
 *
 * This test must FAIL on the buggy code (rows 2 to 5 are clipped out
 * on the first personnel page) and PASS after the clip fix.
 *
 * Determinism: fixed workflow ids, fixed step id, fixed deadline,
 * fixed assignee names and ids. The cover Issue Date uses the current
 * date but is never asserted on.
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

// ── PDF content-stream parsing and clip simulation ──────────────────────────

interface ClipBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type ClipState = 'FULL' | 'EMPTY' | ClipBbox;

interface TextEvent {
  text: string;
  page: number;
  bbox: ClipBbox;
  clip: ClipState;
}

interface DoEvent {
  name: string;
  page: number;
  bbox: ClipBbox;
  clip: ClipState;
}

function intersectClip(a: ClipState, b: ClipBbox | null): ClipState {
  if (b === null) return 'EMPTY';
  if (a === 'FULL') return { ...b };
  if (a === 'EMPTY') return 'EMPTY';
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x0 >= x1 || y0 >= y1) return 'EMPTY';
  return { x0, y0, x1, y1 };
}

/** True when the box has more than a hairline of area inside the clip. */
function bboxVisible(box: ClipBbox, clip: ClipState): boolean {
  if (clip === 'FULL') return true;
  if (clip === 'EMPTY') return false;
  const overlapX = Math.min(box.x1, clip.x1) - Math.max(box.x0, clip.x0);
  const overlapY = Math.min(box.y1, clip.y1) - Math.max(box.y0, clip.y0);
  return overlapX > 0.5 && overlapY > 0.5;
}

function describeClip(clip: ClipState): string {
  if (clip === 'FULL') return 'FULL';
  if (clip === 'EMPTY') return 'EMPTY';
  return (
    `bbox x=${clip.x0.toFixed(1)}..${clip.x1.toFixed(1)}, ` +
    `y=${clip.y0.toFixed(1)}..${clip.y1.toFixed(1)}`
  );
}

/**
 * Extract the content stream of every page, in page order. Page order
 * comes from the /Pages /Kids array; the fallback is file order of the
 * /Type /Page objects. Only /Contents streams are returned, so binary
 * image data is never parsed.
 */
function extractContentStreams(pdfText: string): string[] {
  let pageRefs: number[] = [];
  const kidsMatch = pdfText.match(/\/Type\s*\/Pages[\s\S]{0,2000}?\/Kids\s*\[([^\]]*)\]/);
  if (kidsMatch) {
    const nums = kidsMatch[1].match(/(\d+)\s+0\s+R/g) || [];
    pageRefs = nums.map((s) => parseInt(s, 10));
  }
  if (pageRefs.length === 0) {
    const re = /\b(\d+)\s+0\s+obj[\s\S]{0,500}?\/Type\s*\/Page[^s]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pdfText)) !== null) pageRefs.push(parseInt(m[1], 10));
  }

  const objectBody = (ref: number): string | null => {
    const re = new RegExp(`\\b${ref}\\s+0\\s+obj([\\s\\S]*?)endobj`);
    const m = pdfText.match(re);
    return m ? m[1] : null;
  };

  const streams: string[] = [];
  for (const ref of pageRefs) {
    const body = objectBody(ref);
    if (!body) {
      streams.push('');
      continue;
    }
    const contentsMatch = body.match(/\/Contents\s+(?:\[([^\]]*)\]|(\d+)\s+0\s+R)/);
    if (!contentsMatch) {
      streams.push('');
      continue;
    }
    const contentRefs: number[] = [];
    if (contentsMatch[1]) {
      const nums = contentsMatch[1].match(/(\d+)\s+0\s+R/g) || [];
      for (const s of nums) contentRefs.push(parseInt(s, 10));
    } else if (contentsMatch[2]) {
      contentRefs.push(parseInt(contentsMatch[2], 10));
    }
    let combined = '';
    for (const cref of contentRefs) {
      const cBody = objectBody(cref);
      if (!cBody) continue;
      const streamIdx = cBody.indexOf('stream');
      if (streamIdx < 0) continue;
      const dictPart = cBody.slice(0, streamIdx);
      let streamPart = cBody.slice(streamIdx + 'stream'.length);
      streamPart = streamPart.replace(/^\r?\n/, '');
      const endIdx = streamPart.indexOf('endstream');
      if (endIdx >= 0) streamPart = streamPart.slice(0, endIdx);
      streamPart = streamPart.replace(/\r?\n$/, '');
      if (/FlateDecode/.test(dictPart)) {
        try {
          const zlib = jest.requireActual('zlib') as any;
          const inflated = zlib.inflateSync(Buffer.from(streamPart, 'latin1'));
          combined += inflated.toString('latin1') + '\n';
        } catch {
          combined += streamPart + '\n';
        }
      } else {
        combined += streamPart + '\n';
      }
    }
    streams.push(combined);
  }
  return streams;
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'array'; value: unknown[] };

function tokenize(stream: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isDelim = (ch: string): boolean => /\s/.test(ch) || '()<>[]{}/%'.includes(ch);
  while (i < stream.length) {
    const ch = stream[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '%') {
      while (i < stream.length && stream[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') {
      let depth = 0;
      let out = '';
      i++;
      while (i < stream.length) {
        const c = stream[i];
        if (c === '\\' && i + 1 < stream.length) {
          const n = stream[i + 1];
          if (n === 'n') out += '\n';
          else if (n === 'r') out += '\r';
          else if (n === 't') out += '\t';
          else if (n === 'b') out += '\b';
          else if (n === 'f') out += '\f';
          else if (/[0-7]/.test(n)) {
            let oct = '';
            let j = i + 1;
            while (j < stream.length && j < i + 4 && /[0-7]/.test(stream[j])) {
              oct += stream[j];
              j++;
            }
            out += String.fromCharCode(parseInt(oct, 8));
            i = j;
            continue;
          } else if (n === '\n' || n === '\r') {
            // Line continuation: contributes nothing.
          } else {
            out += n;
          }
          i += 2;
          continue;
        }
        if (c === '(') {
          depth++;
          out += c;
          i++;
          continue;
        }
        if (c === ')') {
          if (depth === 0) {
            i++;
            break;
          }
          depth--;
          out += c;
          i++;
          continue;
        }
        out += c;
        i++;
      }
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '<') {
      if (stream[i + 1] === '<') {
        tokens.push({ kind: 'op', value: '<<' });
        i += 2;
        continue;
      }
      let hex = '';
      i++;
      while (i < stream.length && stream[i] !== '>') {
        if (!/\s/.test(stream[i])) hex += stream[i];
        i++;
      }
      i++;
      let decoded = '';
      for (let h = 0; h < hex.length; h += 2) {
        decoded += String.fromCharCode(parseInt(hex.slice(h, h + 2) || '0', 16));
      }
      tokens.push({ kind: 'string', value: decoded });
      continue;
    }
    if (ch === '>') {
      if (stream[i + 1] === '>') {
        tokens.push({ kind: 'op', value: '>>' });
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (ch === '[') {
      // Collect until the matching ] as one array token.
      const values: unknown[] = [];
      i++;
      let depth = 1;
      while (i < stream.length && depth > 0) {
        const inner = stream[i];
        if (/\s/.test(inner)) {
          i++;
          continue;
        }
        if (inner === '[') {
          depth++;
          i++;
          continue;
        }
        if (inner === ']') {
          depth--;
          i++;
          continue;
        }
        if (inner === '(') {
          const start = i;
          let d = 0;
          i++;
          while (i < stream.length) {
            const c = stream[i];
            if (c === '\\') {
              i += 2;
              continue;
            }
            if (c === '(') d++;
            if (c === ')') {
              if (d === 0) {
                i++;
                break;
              }
              d--;
            }
            i++;
          }
          values.push(stream.slice(start, i));
          continue;
        }
        let j = i;
        while (j < stream.length && !isDelim(stream[j])) j++;
        const word = stream.slice(i, j);
        i = j;
        if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) {
          values.push(parseFloat(word));
        } else if (word.length > 0) {
          values.push(word);
        }
      }
      tokens.push({ kind: 'array', value: values });
      continue;
    }
    if (ch === ']') {
      i++;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < stream.length && !isDelim(stream[j])) j++;
      tokens.push({ kind: 'name', value: stream.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '{' || ch === '}') {
      i++;
      continue;
    }
    let j = i;
    while (j < stream.length && !isDelim(stream[j])) j++;
    const word = stream.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) {
      tokens.push({ kind: 'number', value: parseFloat(word) });
    } else if (word.length > 0) {
      tokens.push({ kind: 'op', value: word });
    }
  }
  return tokens;
}

const PATH_TERMINATORS = new Set([
  'S',
  's',
  'f',
  'F',
  'f*',
  'B',
  'B*',
  'b',
  'b*',
  'n',
]);

/**
 * Walk one page content stream and record every text (Tj) and image
 * (Do) event with the clipping path in effect when it was drawn.
 * The pending-clip rule matches a real renderer: W sets a pending clip
 * that is consumed by the next path-terminating op, and the clip is
 * applied to the graphics state active at that terminating op. A
 * pending clip therefore survives a Q restore when the terminating op
 * comes after the restore.
 */
function simulatePage(stream: string, page: number): { texts: TextEvent[]; dos: DoEvent[] } {
  const tokens = tokenize(stream);
  const texts: TextEvent[] = [];
  const dos: DoEvent[] = [];
  let clip: ClipState = 'FULL';
  const clipStack: ClipState[] = [];
  let clipPending = false;
  let pathBbox: ClipBbox | null = null;
  const addPoint = (x: number, y: number): void => {
    if (!pathBbox) pathBbox = { x0: x, y0: y, x1: x, y1: y };
    else {
      pathBbox.x0 = Math.min(pathBbox.x0, x);
      pathBbox.y0 = Math.min(pathBbox.y0, y);
      pathBbox.x1 = Math.max(pathBbox.x1, x);
      pathBbox.y1 = Math.max(pathBbox.y1, y);
    }
  };
  const endPath = (): void => {
    if (clipPending) {
      clip = intersectClip(clip, pathBbox);
      clipPending = false;
    }
    pathBbox = null;
  };

  let stack: unknown[] = [];
  let fontSize = 10;
  let textX = 0;
  let textY = 0;
  let lastCm: number[] | null = null;

  const numbers = (args: unknown[], count: number): number[] => {
    const out: number[] = [];
    for (let k = args.length - count; k < args.length; k++) {
      const v = args[k];
      out.push(typeof v === 'number' ? v : 0);
    }
    while (out.length < count) out.unshift(0);
    return out;
  };

  for (const token of tokens) {
    if (token.kind !== 'op') {
      if (token.kind === 'number') stack.push(token.value);
      else if (token.kind === 'string') stack.push(token.value);
      else if (token.kind === 'name') stack.push({ name: token.value });
      else if (token.kind === 'array') stack.push(token.value);
      continue;
    }
    const op = token.value;
    const args = stack;
    stack = [];

    if (op === 'q') {
      clipStack.push(clip);
      continue;
    }
    if (op === 'Q') {
      if (clipStack.length > 0) clip = clipStack.pop() as ClipState;
      continue;
    }
    if (op === 'W' || op === 'W*') {
      clipPending = true;
      continue;
    }
    if (PATH_TERMINATORS.has(op)) {
      endPath();
      continue;
    }
    if (op === 'BT') {
      textX = 0;
      textY = 0;
      continue;
    }
    if (op === 'ET') {
      continue;
    }
    if (op === 'Td' || op === 'TD') {
      const [tx, ty] = numbers(args, 2);
      textX += tx;
      textY += ty;
      continue;
    }
    if (op === 'Tm') {
      const vals = numbers(args, 6);
      textX = vals[4];
      textY = vals[5];
      continue;
    }
    if (op === 'Tf') {
      const size = numbers(args, 1)[0];
      if (size > 0) fontSize = size;
      continue;
    }
    if (op === 'Tj') {
      const text = typeof args[0] === 'string' ? (args[0] as string) : '';
      if (text.length > 0) {
        const width = text.length * fontSize * 0.6;
        texts.push({
          text,
          page,
          bbox: {
            x0: textX,
            y0: textY - fontSize * 0.3,
            x1: textX + width,
            y1: textY + fontSize * 0.8,
          },
          clip,
        });
      }
      continue;
    }
    if (op === 'TJ') {
      // jsPDF does not emit TJ, but handle an array of strings by
      // recording the concatenated text at the current position.
      const parts: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === 'string') parts.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
      };
      args.forEach(walk);
      const text = parts.join('');
      if (text.length > 0) {
        const width = text.length * fontSize * 0.6;
        texts.push({
          text,
          page,
          bbox: {
            x0: textX,
            y0: textY - fontSize * 0.3,
            x1: textX + width,
            y1: textY + fontSize * 0.8,
          },
          clip,
        });
      }
      continue;
    }
    if (op === 'cm') {
      lastCm = numbers(args, 6);
      continue;
    }
    if (op === 'Do') {
      const first = args[0] as { name?: string } | string | undefined;
      const name =
        typeof first === 'object' && first && 'name' in first
          ? (first as { name: string }).name
          : typeof first === 'string'
            ? first
            : '';
      if (lastCm) {
        const [a, b, c, d, e, f] = lastCm;
        const xs = [e, e + a, e + c, e + a + c];
        const ys = [f, f + b, f + d, f + b + d];
        dos.push({
          name,
          page,
          bbox: {
            x0: Math.min(...xs),
            y0: Math.min(...ys),
            x1: Math.max(...xs),
            y1: Math.max(...ys),
          },
          clip,
        });
      }
      continue;
    }
    if (op === 'm' || op === 'l') {
      const [x, y] = numbers(args, 2);
      addPoint(x, y);
      continue;
    }
    if (op === 'c') {
      const [x1, y1, x2, y2, x3, y3] = numbers(args, 6);
      addPoint(x1, y1);
      addPoint(x2, y2);
      addPoint(x3, y3);
      continue;
    }
    if (op === 'v') {
      const [x2, y2, x3, y3] = numbers(args, 4);
      addPoint(x2, y2);
      addPoint(x3, y3);
      continue;
    }
    if (op === 'y') {
      const [x1, y1, x3, y3] = numbers(args, 4);
      addPoint(x1, y1);
      addPoint(x3, y3);
      continue;
    }
    if (op === 're') {
      const [x, y, w, h] = numbers(args, 4);
      addPoint(x, y);
      addPoint(x + w, y + h);
      continue;
    }
    // Every other operator (colors, line width, fonts, leading) is
    // ignored. Its operands were already consumed above.
  }
  return { texts, dos };
}

// 1x1 PNG used as a stand-in assignee photo, same as the geometry tests.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Ten distinct assignee names, none a substring of another. */
const ASSIGNEE_NAMES = Array.from(
  { length: 10 },
  (_, i) => `Assignee ${String(i + 1).padStart(2, '0')}`,
);

describe('agent 3-6: ten-assignee personnel rows', () => {
  test(
    '10 assignees: every row has visible non-white text and a QR Do op, no row split',
    async () => {
      const workflow: WorkflowPDFData = {
        id: 'wf-agent-3-6-ten-assignees',
        title: 'Ten Assignee Personnel Workflow',
        progressPercentage: 0,
        totalSteps: 1,
        completedSteps: 0,
        isCompleted: false,
        chapterName: 'SEDS IST Chapter',
        description: 'Workflow with ten assignees on one step.',
        steps: [
          {
            id: 'step-1',
            title: 'Step One',
            description: 'A short step description.',
            status: 'pending',
            assigneeId: 'user-01',
            assigneeName: ASSIGNEE_NAMES[0],
            assigneeEmail: 'assignee01@example.com',
            assigneeWhatsapp: '+923001234501',
            assigneeChapter: 'SEDS IST Chapter',
            assigneeRole: 'member',
            role: 'Step Owner',
            individualDeadline: '2026-10-20T15:30:00+05:00',
            // The primary photo is the trigger: with a photo the
            // exporter draws the circular avatar, and the buggy clip
            // sequence hides the rows that follow on the same page.
            assigneePhoto: TINY_PNG,
            assignees: ASSIGNEE_NAMES.map((name, i) => ({
              id: `user-${String(i + 1).padStart(2, '0')}`,
              name,
              role: 'member',
              chapterName: i === 0 ? 'SEDS IST Chapter' : `Chapter ${i + 1}`,
            })),
          },
        ],
      };

      await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
      const rec = lastRecording();
      expect(rec.saved).toBe(true);
      const boxes = rec.boxes;

      // Interception guard: all 10 personnel QR boxes and all 10 names
      // are emitted. This passes on the buggy code; the rendered
      // visibility check below is what catches the bug.
      const stepQrBoxes = boxes.filter(
        (b: RecordedBox) =>
          b.kind === 'image' &&
          b.page > 1 &&
          b.label.includes('PNG') &&
          Math.abs(b.w - 22) < 1 &&
          Math.abs(b.h - 22) < 1,
      );
      expect(stepQrBoxes).toHaveLength(10);

      for (const name of ASSIGNEE_NAMES) {
        const nameBoxes = boxes.filter((b: RecordedBox) => b.kind === 'text' && b.label === name);
        expect(nameBoxes).toHaveLength(1);
        expect(nameBoxes[0].w).toBeGreaterThan(0);
        expect(nameBoxes[0].h).toBeGreaterThan(0);
        const nameColors = rec.textColors.filter((entry) => entry.label === name);
        expect(nameColors).toHaveLength(1);
        const [r, g, b] = nameColors[0].color;
        expect([r, g, b]).not.toEqual([255, 255, 255]);
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        expect(luminance).toBeLessThan(200);
      }

      // Rendered visibility: parse the real emitted PDF bytes and
      // simulate the clipping path a renderer applies.
      const pdfBytes = rec.doc.output('arraybuffer');
      const pdfText = Buffer.from(pdfBytes).toString('latin1');
      const pageStreams = extractContentStreams(pdfText);
      expect(pageStreams.length).toBeGreaterThanOrEqual(3);
      const pageTexts: TextEvent[][] = [];
      const pageDos: DoEvent[][] = [];
      pageStreams.forEach((stream, idx) => {
        const { texts, dos } = simulatePage(stream, idx + 1);
        pageTexts.push(texts);
        pageDos.push(dos);
      });
      const allTexts = pageTexts.flat();
      const allDos = pageDos.flat();

      // Personnel pages are the pages that carry the personnel header.
      const personnelPages = new Set(
        allTexts.filter((t) => t.text === 'PERSONNEL ASSIGNED').map((t) => t.page),
      );
      expect(personnelPages.size).toBeGreaterThan(0);

      // Personnel QR Do ops: 22 mm square images (62.36 pt) on
      // personnel pages. The cover QR is 35 mm on page 1 and the
      // avatar is 16 mm, so the size filter separates them.
      const personnelQrDos = allDos.filter((d) => {
        if (!personnelPages.has(d.page)) return false;
        const w = d.bbox.x1 - d.bbox.x0;
        const h = d.bbox.y1 - d.bbox.y0;
        return Math.abs(w - 62.36) < 2 && Math.abs(h - 62.36) < 2;
      });
      expect(personnelQrDos).toHaveLength(10);

      for (let i = 0; i < ASSIGNEE_NAMES.length; i++) {
        const name = ASSIGNEE_NAMES[i];
        const nameEvents = allTexts.filter((t) => t.text === name);
        expect(nameEvents).toHaveLength(1);
        const nameEvent = nameEvents[0];
        expect(personnelPages.has(nameEvent.page)).toBe(true);

        // The name text must be drawn where the clip still covers it.
        // On the buggy code rows 2 to 5 are drawn under the leaked
        // avatar-circle clip, so their name boxes do not overlap the
        // clip and this fails.
        if (!bboxVisible(nameEvent.bbox, nameEvent.clip)) {
          throw new Error(
            `Row ${i + 1} (${name}) name text is clipped out: ` +
              `clip is ${describeClip(nameEvent.clip)} on page ${nameEvent.page}`,
          );
        }

        // Row segment: the text events drawn after this name on the
        // same page, up to the next row name. The row is never split,
        // so the row role and chapter lines must be in this segment.
        const pageTextList = pageTexts[nameEvent.page - 1];
        const nameIdx = pageTextList.findIndex((t) => t.text === name);
        expect(nameIdx).toBeGreaterThanOrEqual(0);
        const nextNameIdx = pageTextList.findIndex(
          (t, idx) => idx > nameIdx && ASSIGNEE_NAMES.includes(t.text),
        );
        const segment = pageTextList.slice(
          nameIdx + 1,
          nextNameIdx >= 0 ? nextNameIdx : undefined,
        );
        const segmentTexts = segment.map((t) => t.text);
        expect(segmentTexts).toContain('Team Member');
        if (i === 0) {
          expect(segmentTexts).toContain('Responsibility: Step Owner');
          expect(segmentTexts).toContain('SEDS IST Chapter');
          expect(segmentTexts).toContain('+923001234501');
          expect(segmentTexts).toContain('assignee01@example.com');
        } else {
          expect(segmentTexts).toContain(`Chapter ${i + 1}`);
        }

        // Exactly one personnel QR Do on the same page, in the row
        // band, and drawn where the clip still covers it.
        const nameBaselineY = (nameEvent.bbox.y0 + nameEvent.bbox.y1) / 2;
        const rowQrDos = personnelQrDos.filter((d) => {
          if (d.page !== nameEvent.page) return false;
          const overlapsBand =
            d.bbox.y0 <= nameBaselineY + 5 && d.bbox.y1 >= nameBaselineY - 5;
          return overlapsBand;
        });
        expect(rowQrDos).toHaveLength(1);
        const qrDo = rowQrDos[0];
        if (!bboxVisible(qrDo.bbox, qrDo.clip)) {
          throw new Error(
            `Row ${i + 1} (${name}) QR Do op is clipped out: ` +
              `clip is ${describeClip(qrDo.clip)} on page ${qrDo.page}`,
          );
        }
      }
    },
    60000,
  );
});
