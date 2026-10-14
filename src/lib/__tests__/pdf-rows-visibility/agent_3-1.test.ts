/**
 * Regression test: all personnel rows in a workflow PDF must be VISIBLE.
 *
 * Bug: in the workflow PDF export only the FIRST assignee personnel row
 * renders visibly. Rows 2+ are present in the file but do not render.
 * The trigger is the primary assignee photo: drawCircularAvatar strokes
 * the avatar circle (which consumes the path), then calls clip(), which
 * emits a bare W with no live path. That W stays pending, and the next
 * stroke (the avatar border circle) applies it as a clip to the avatar
 * circle. The clip then covers the rest of the page, so every later
 * personnel row is drawn outside the clip region and never renders,
 * even though its text ops carry a dark, non-white fill color.
 *
 * Approach: generate a real PDF with 5 assignees through the repo export
 * code, capture the PDF bytes from doc.save(), slice each content stream
 * out of its object with /Length, and walk the operators tracking the
 * nonstroking fill color (rg / g) in effect plus the clip state (q / Q
 * stack, W, path construction, painting ops). For each assignee name,
 * find its Tj/TJ text op and assert the fill color in effect is
 * non-white AND the text is not clipped out. This parses the actual PDF
 * bytes, so it sees what a renderer will use, not what the exporter
 * asked for at the call site.
 *
 * Parser trap avoided: the stream keyword is matched with a
 * (?<!end) lookbehind so the "stream" inside "endstream" is never
 * matched, and each stream body is sliced by its /Length instead of
 * scanning to "endstream", so no content stream is counted twice.
 *
 * The main test uses a primary photo, because without one the avatar
 * clip path never runs and the bug does not trigger. The control test
 * without a photo pins that the photo is the trigger.
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
          (globalThis as any).__pdfRowsVisibilityCaptures ||
          ((globalThis as any).__pdfRowsVisibilityCaptures = []);
        caps.push(new Uint8Array(bytes));
      };
    }
  }

  return { ...Actual, jsPDF: CapturingJsPDF };
});

import { exportWorkflowAsPDF } from '../../workflow-pdf-export';
import type { WorkflowPDFData } from '../../workflow-pdf-export';

const NAMES = [
  'Alpha One Person',
  'Beta Two Person',
  'Gamma Three Person',
  'Delta Four Person',
  'Epsilon Five Person',
];

/** 1x1 PNG used as a stand-in primary assignee photo. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function captures(): Uint8Array[] {
  const g = globalThis as unknown as { __pdfRowsVisibilityCaptures?: Uint8Array[] };
  if (!g.__pdfRowsVisibilityCaptures) g.__pdfRowsVisibilityCaptures = [];
  return g.__pdfRowsVisibilityCaptures;
}

function buildWorkflow(withAvatar: boolean): WorkflowPDFData {
  return {
    id: 'wf-pdf-rows-visibility',
    title: 'Rows Visibility Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    chapterName: 'SEDS IST Chapter',
    description: 'A workflow built to pin down personnel row visibility.',
    steps: [
      {
        id: 'step-1',
        title: 'Step One',
        description: 'A short step description.',
        status: 'pending',
        assigneeId: 'user-1',
        assigneeName: NAMES[0],
        assigneeEmail: 'alpha@example.com',
        assigneeWhatsapp: '+923001111111',
        assigneeChapter: 'SEDS IST Chapter',
        assigneeRole: 'member',
        role: 'Step Owner',
        individualDeadline: '2026-10-20T15:30:00+05:00',
        assigneePhoto: withAvatar ? TINY_PNG : undefined,
        assignees: NAMES.map((name, i) => ({
          id: `user-${i + 1}`,
          name,
          role: 'member',
          chapterName: 'SEDS IST Chapter',
        })),
      },
    ],
  };
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

/**
 * Slice every content stream out of the PDF, one per object, in file
 * order (jsPDF writes pages in order). The stream keyword is matched
 * with a (?<!end) lookbehind so the "stream" inside "endstream" never
 * matches, and the body is sliced by the /Length in the object dict,
 * never by scanning for "endstream". Image XObjects are skipped.
 */
function contentStreams(pdf: Uint8Array): string[] {
  const latin = Buffer.from(pdf).toString('latin1');
  const streams: string[] = [];
  const objRe = /(\d+) 0 obj/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(latin)) !== null) {
    const objStart = m.index + m[0].length;
    const objEnd = latin.indexOf('endobj', objStart);
    if (objEnd === -1) break;
    const body = latin.slice(objStart, objEnd);
    const streamMatch = /(?<!end)stream/.exec(body);
    if (!streamMatch) {
      objRe.lastIndex = objEnd + 'endobj'.length;
      continue;
    }
    const dictPart = body.slice(0, streamMatch.index);
    if (/\/Subtype\s*\/Image/.test(dictPart)) {
      objRe.lastIndex = objEnd + 'endobj'.length;
      continue;
    }
    const lenMatch = /\/Length\s+(\d+)/.exec(dictPart);
    if (!lenMatch) {
      objRe.lastIndex = objEnd + 'endobj'.length;
      continue;
    }
    let dataStart = streamMatch.index + 'stream'.length;
    if (body[dataStart] === '\r') dataStart++;
    if (body[dataStart] === '\n') dataStart++;
    const len = parseInt(lenMatch[1], 10);
    const content = body.slice(dataStart, dataStart + len);
    if (content.includes('BT')) streams.push(content);
    objRe.lastIndex = objEnd + 'endobj'.length;
  }
  return streams;
}

type ClipBox = { x0: number; y0: number; x1: number; y1: number } | null;
/** null means an empty clip (nothing renders). */
const PAGE_BOX: Exclude<ClipBox, null> = { x0: 0, y0: 0, x1: 595.28, y1: 841.89 };

function intersectClip(
  a: ClipBox,
  b: ClipBox,
): ClipBox {
  if (a === null || b === null) return null;
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x0 >= x1 || y0 >= y1) return null;
  return { x0, y0, x1, y1 };
}

function boxesOverlap(
  a: Exclude<ClipBox, null>,
  b: Exclude<ClipBox, null>,
): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'array'; value: Token[] }
  | { kind: 'dict'; value: null }
  | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  let i = 0;
  const isSpace = (c: string): boolean =>
    c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0';
  const isDelim = (c: string): boolean => isSpace(c) || '()<>[]{}/%'.includes(c);

  function skipSpaceAndComments(): void {
    while (i < input.length) {
      const c = input[i];
      if (isSpace(c)) { i++; continue; }
      if (c === '%') { while (i < input.length && input[i] !== '\n') i++; continue; }
      break;
    }
  }

  function parseLiteral(): string {
    i++; // skip (
    let depth = 1;
    let raw = '';
    while (i < input.length && depth > 0) {
      const c = input[i];
      if (c === '\\' && i + 1 < input.length) { raw += c + input[i + 1]; i += 2; continue; }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (depth === 0) { i++; break; } }
      raw += c;
      i++;
    }
    return decodeLiteral(raw);
  }

  function parseHex(): string {
    i++; // skip <
    let raw = '';
    while (i < input.length && input[i] !== '>') { raw += input[i]; i++; }
    i++; // skip >
    return decodeHex(raw);
  }

  function parseToken(): Token | null {
    skipSpaceAndComments();
    if (i >= input.length) return null;
    const ch = input[i];
    if (ch === '(') return { kind: 'string', value: parseLiteral() };
    if (ch === '<') {
      if (input[i + 1] === '<') {
        let depth = 0;
        while (i < input.length) {
          if (input.startsWith('<<', i)) { depth++; i += 2; continue; }
          if (input.startsWith('>>', i)) { depth--; i += 2; if (depth === 0) break; continue; }
          i++;
        }
        return { kind: 'dict', value: null };
      }
      return { kind: 'string', value: parseHex() };
    }
    if (ch === '[') {
      i++;
      const items: Token[] = [];
      for (;;) {
        skipSpaceAndComments();
        if (i >= input.length) break;
        if (input[i] === ']') { i++; break; }
        const t = parseToken();
        if (t) items.push(t); else break;
      }
      return { kind: 'array', value: items };
    }
    if (ch === ']') { i++; return { kind: 'op', value: ']' }; }
    if (ch === '/') {
      i++;
      let name = '';
      while (i < input.length && !isDelim(input[i])) { name += input[i]; i++; }
      return { kind: 'name', value: name };
    }
    let word = '';
    while (i < input.length && !isDelim(input[i])) { word += input[i]; i++; }
    if (word === '') { i++; return parseToken(); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      return { kind: 'number', value: Number(word) };
    }
    return { kind: 'op', value: word };
  }

  const tokens: Token[] = [];
  for (;;) {
    const t = parseToken();
    if (!t) break;
    tokens.push(t);
  }
  return tokens;
}

interface TextOp {
  text: string;
  color: [number, number, number];
  colorVisible: boolean;
  clipped: boolean;
  visible: boolean;
  page: number;
  x: number;
  y: number;
}

function isVisibleColor(color: [number, number, number]): boolean {
  const [r, g, b] = color;
  // jsPDF writes rg operands in 0..1. White is 1 1 1. Anything at or
  // above 0.97 on every channel is indistinguishable from the white
  // paper/card background and does not render visibly.
  return !(r >= 0.97 && g >= 0.97 && b >= 0.97);
}

/**
 * Walk one content stream, tracking the nonstroking fill color and the
 * clip state, and return every Tj/TJ text op with the color in effect
 * and whether it is clipped out.
 *
 * Clip model, matching what MuPDF and Poppler do with jsPDF output:
 * - The current path is global (not saved/restored by q/Q). Painting
 *   ops (S, f, B, n, ...) end it; W does not consume it.
 * - A W with a live path narrows the current clip, scoped by q/Q.
 * - A W with NO live path (the path was already consumed by a stroke
 *   or fill) stays pending: the next painting op applies it, using the
 *   path current at that op, in whatever graphics state is current
 *   then. When that state is outside the q that held the W, the clip
 *   leaks for the rest of the page. That is the avatar bug: the stray
 *   W is followed, after the restores, by the avatar border stroke,
 *   which applies the clip to the avatar circle for the rest of the
 *   page, so rows 2+ are drawn outside the clip and never render.
 */
function textOpsFromStream(content: string, page: number): TextOp[] {
  const ops: TextOp[] = [];
  const tokens = tokenize(content);
  let color: [number, number, number] = [0, 0, 0];
  let clip: ClipBox = { ...PAGE_BOX };
  const stack: Array<{ color: [number, number, number]; clip: ClipBox }> = [];
  let qDepth = 0;
  let path: Exclude<ClipBox, null> | null = null;
  let pendingStray: { depth: number } | null = null;
  let leakedClip: ClipBox | undefined;
  let leakedDepth = -1;
  let fontSize = 0;
  let leading = 0;
  let textX = 0;
  let textY = 0;
  const pending: Token[] = [];

  const addPoint = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!path) path = { x0: x, y0: y, x1: x, y1: y };
    else {
      path.x0 = Math.min(path.x0, x);
      path.y0 = Math.min(path.y0, y);
      path.x1 = Math.max(path.x1, x);
      path.y1 = Math.max(path.y1, y);
    }
  };
  const addRect = (x: number, y: number, w: number, h: number): void => {
    if (![x, y, w, h].every(Number.isFinite)) return;
    addPoint(x, y);
    addPoint(x + w, y + h);
  };
  const emit = (text: string): void => {
    const estW = text.length * (fontSize || 10) * 0.55;
    const size = fontSize || 10;
    const bbox = {
      x0: textX,
      y0: textY - size * 0.25,
      x1: textX + estW,
      y1: textY + size * 0.9,
    };
    const effective = intersectClip(clip, leakedClip ?? { ...PAGE_BOX });
    const clipped = effective === null || !boxesOverlap(bbox, effective);
    const colorVisible = isVisibleColor(color);
    ops.push({
      text,
      color: [...color] as [number, number, number],
      colorVisible,
      clipped,
      visible: colorVisible && !clipped,
      page,
      x: textX,
      y: textY,
    });
  };

  for (const tok of tokens) {
    if (tok.kind !== 'op') {
      pending.push(tok);
      continue;
    }
    const op = tok.value;
    const nums = pending
      .filter((t): t is Extract<Token, { kind: 'number' }> => t.kind === 'number')
      .map((t) => t.value);
    const strs = pending
      .filter((t): t is Extract<Token, { kind: 'string' }> => t.kind === 'string')
      .map((t) => t.value);
    const arrs = pending
      .filter((t): t is Extract<Token, { kind: 'array' }> => t.kind === 'array')
      .map((t) => t.value);
    pending.length = 0;

    switch (op) {
      case 'q':
        stack.push({ color: [...color] as [number, number, number], clip });
        qDepth++;
        break;
      case 'Q': {
        const prev = stack.pop();
        if (prev) {
          color = prev.color;
          clip = prev.clip;
        }
        qDepth = Math.max(0, qDepth - 1);
        if (leakedClip !== undefined && qDepth < leakedDepth) {
          leakedClip = undefined;
          leakedDepth = -1;
        }
        break;
      }
      case 'rg':
        if (nums.length >= 3) {
          color = [
            nums[nums.length - 3],
            nums[nums.length - 2],
            nums[nums.length - 1],
          ];
        }
        break;
      case 'g':
        if (nums.length >= 1) {
          const v = nums[nums.length - 1];
          color = [v, v, v];
        }
        break;
      case 'm':
      case 'l':
        if (nums.length >= 2) addPoint(nums[nums.length - 2], nums[nums.length - 1]);
        break;
      case 'c':
        if (nums.length >= 6) {
          const p = nums.slice(-6);
          addPoint(p[0], p[1]);
          addPoint(p[2], p[3]);
          addPoint(p[4], p[5]);
        }
        break;
      case 'v':
      case 'y':
        if (nums.length >= 4) {
          const p = nums.slice(-4);
          addPoint(p[0], p[1]);
          addPoint(p[2], p[3]);
        }
        break;
      case 're':
        if (nums.length >= 4) {
          const p = nums.slice(-4);
          addRect(p[0], p[1], p[2], p[3]);
        }
        break;
      case 'h':
        break;
      case 'W':
      case 'W*':
        if (path) {
          clip = intersectClip(clip, path);
        } else {
          pendingStray = { depth: qDepth };
        }
        break;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        if (pendingStray) {
          if (path && qDepth <= pendingStray.depth) {
            leakedClip = path;
            leakedDepth = qDepth;
          } else if (path) {
            clip = intersectClip(clip, path);
          }
          pendingStray = null;
        }
        path = null;
        break;
      case 'n':
        if (pendingStray) {
          clip = null;
          pendingStray = null;
        }
        path = null;
        break;
      case 'BT':
        textX = 0;
        textY = 0;
        break;
      case 'Tf':
        if (nums.length >= 1) fontSize = nums[nums.length - 1];
        break;
      case 'TL':
        if (nums.length >= 1) leading = nums[nums.length - 1];
        break;
      case 'Td':
      case 'TD':
        if (nums.length >= 2) {
          textX += nums[nums.length - 2];
          textY += nums[nums.length - 1];
        }
        if (op === 'TD' && nums.length >= 1) leading = -nums[nums.length - 1];
        break;
      case 'Tm':
        if (nums.length >= 6) {
          textX = nums[nums.length - 2];
          textY = nums[nums.length - 1];
        }
        break;
      case 'T*':
        textY -= leading;
        break;
      case 'Tj': {
        const s = strs[strs.length - 1] ?? '';
        emit(s);
        break;
      }
      case 'TJ': {
        const parts: string[] = [];
        for (const arr of arrs) {
          for (const el of arr) {
            if (el.kind === 'string') parts.push(el.value);
          }
        }
        emit(parts.join(''));
        break;
      }
      case "'":
      case '"': {
        const s = strs[strs.length - 1] ?? '';
        emit(s);
        textY -= leading;
        break;
      }
      default:
        break;
    }
  }
  return ops;
}

function allTextOps(pdf: Uint8Array): TextOp[] {
  const ops: TextOp[] = [];
  contentStreams(pdf).forEach((content, idx) => {
    ops.push(...textOpsFromStream(content, idx + 1));
  });
  return ops;
}

function describeOp(o: TextOp): string {
  return (
    `page ${o.page} color=[${o.color.map((c) => c.toFixed(3)).join(', ')}] ` +
    `at (${o.x.toFixed(1)}, ${o.y.toFixed(1)}) ` +
    `colorVisible=${o.colorVisible} clipped=${o.clipped}`
  );
}

function assertAllNamesVisible(ops: TextOp[], label: string): void {
  const failures: string[] = [];
  for (const name of NAMES) {
    const hits = ops.filter((o) => o.text.includes(name));
    if (hits.length === 0) {
      failures.push(`${name}: no text op found in the PDF`);
      continue;
    }
    const visible = hits.filter((o) => o.visible);
    if (visible.length === 0) {
      failures.push(
        `${name}: ${hits.length} text op(s), none visible: ` +
          hits.map(describeOp).join('; '),
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`${label}: personnel rows are not visible:\n${failures.join('\n')}`);
  }
}

beforeEach(() => {
  captures().length = 0;
});

describe('workflow PDF personnel rows visibility', () => {
  test('all 5 assignee names are drawn visibly when the primary assignee has a photo', async () => {
    await exportWorkflowAsPDF(buildWorkflow(true), undefined, { hideQrCodes: false });
    expect(captures()).toHaveLength(1);
    const ops = allTextOps(captures()[0]);
    assertAllNamesVisible(ops, 'with primary photo');
  }, 30000);

  test('all 5 assignee names are drawn visibly without a primary photo (control)', async () => {
    await exportWorkflowAsPDF(buildWorkflow(false), undefined, { hideQrCodes: false });
    expect(captures()).toHaveLength(1);
    const ops = allTextOps(captures()[0]);
    assertAllNamesVisible(ops, 'without primary photo');
  }, 30000);
});
