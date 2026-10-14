/**
 * Regression test (agent 3-7): Step 2 single-assignee personnel row visibility.
 *
 * Bug: in the workflow PDF export, only the FIRST assignee personnel row
 * renders visibly. Rows after it can be present in the file but drawn
 * with a white or near-white fill color, or with no QR image at all.
 *
 * Case: a workflow with TWO steps where Step 2 has exactly 1 assignee,
 * mirroring the live "Report back when done" step. The test asserts:
 * - every personnel name (both Step 1 rows and the Step 2 solo row) is
 *   drawn with a visible, non-white fill color in the actual PDF bytes;
 * - every personnel row has exactly one QR Do op in the actual PDF bytes,
 *   in drawing order: cover QR, then one Do after each personnel name,
 *   with the Step 2 Do coming after the Step 2 solo name.
 *
 * Approach: capture the PDF bytes from doc.save(), decompress every
 * content stream, and walk the operators in file order tracking the
 * nonstroking fill color (rg) in effect, including the q/Q graphics
 * state stack, plus every Do operator. This parses the real PDF bytes,
 * so it sees the color the renderer will use and the images the PDF
 * actually paints, not the color the exporter asked for at the call
 * site and not a call that was later swallowed.
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
          (globalThis as any).__pdfRowsVisibilityCapturesAgent37 ||
          ((globalThis as any).__pdfRowsVisibilityCapturesAgent37 = []);
        caps.push(new Uint8Array(bytes));
      };
    }
  }

  return { ...Actual, jsPDF: CapturingJsPDF };
});

import { exportWorkflowAsPDF } from '../../workflow-pdf-export';
import type { WorkflowPDFData } from '../../workflow-pdf-export';

const STEP1_PRIMARY = 'Step One Primary';
const STEP1_FELLOW = 'Step One Fellow';
const STEP2_SOLO = 'Step Two Solo';

function captures(): Uint8Array[] {
  const g = globalThis as unknown as { __pdfRowsVisibilityCapturesAgent37?: Uint8Array[] };
  if (!g.__pdfRowsVisibilityCapturesAgent37) g.__pdfRowsVisibilityCapturesAgent37 = [];
  return g.__pdfRowsVisibilityCapturesAgent37;
}

function buildWorkflow(): WorkflowPDFData {
  return {
    id: 'wf-agent-37-step2-solo',
    title: 'Agent 37 Step Two Solo Regression',
    progressPercentage: 0,
    totalSteps: 2,
    completedSteps: 0,
    isCompleted: false,
    chapterName: 'SEDS IST Chapter',
    description: 'A two step workflow built to pin down Step 2 row visibility.',
    steps: [
      {
        id: 'step-1-gather',
        title: 'Step One: Gather Evidence',
        description: 'Gather the evidence for the mission.',
        status: 'pending',
        assigneeId: 'user-step1-primary',
        assigneeName: STEP1_PRIMARY,
        assigneeEmail: 'step1primary@example.com',
        assigneeWhatsapp: '+923001111111',
        assigneeChapter: 'SEDS IST Chapter',
        assigneeRole: 'member',
        role: 'Evidence Lead',
        individualDeadline: '2026-10-20T15:30:00+05:00',
        assignees: [
          { id: 'user-step1-primary', name: STEP1_PRIMARY, role: 'member', chapterName: 'SEDS IST Chapter' },
          { id: 'user-step1-fellow', name: STEP1_FELLOW, role: 'member', chapterName: 'SEDS IST Chapter' },
        ],
      },
      {
        id: 'step-2-report-back',
        title: 'Step Two: Report back when done',
        description: 'Report back when done.',
        status: 'pending',
        assigneeId: 'user-step2-solo',
        assigneeName: STEP2_SOLO,
        assigneeEmail: 'step2solo@example.com',
        assigneeWhatsapp: '+923002222222',
        assigneeChapter: 'SEDS IST Chapter',
        assigneeRole: 'member',
        role: 'Reporter',
        individualDeadline: '2026-10-21T15:30:00+05:00',
        assignees: [
          { id: 'user-step2-solo', name: STEP2_SOLO, role: 'member', chapterName: 'SEDS IST Chapter' },
        ],
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

type PdfOp =
  | { kind: 'text'; text: string; color: [number, number, number] }
  | { kind: 'do'; name: string };

function inflateOrNull(data: Uint8Array): Uint8Array | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zlib = jest.requireActual('zlib') as typeof import('zlib');
    return new Uint8Array(zlib.inflateSync(Buffer.from(data)));
  } catch {
    return null;
  }
}

/**
 * Walk one decompressed content stream, tracking the nonstroking color
 * (rg) and the q/Q stack, and return every Tj/TJ text op (with the color
 * in effect at that op) and every Do op, in stream order.
 */
function opsFromStream(content: string): PdfOp[] {
  const ops: PdfOp[] = [];
  type State = { color: [number, number, number] };
  let state: State = { color: [0, 0, 0] };
  const stack: State[] = [];
  let i = 0;
  const pendingNumbers: number[] = [];
  const pendingStrings: string[] = [];
  let pendingArray: string[] | null = null;
  let arrayDepth = 0;
  let pendingName = '';
  let tjParts: string[] | undefined;
  const flushPending = () => {
    pendingNumbers.length = 0;
    pendingStrings.length = 0;
  };
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
      if (pendingArray) pendingArray.push(decoded);
      else pendingStrings.push(decoded);
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      let raw = '';
      i++;
      while (i < content.length && content[i] !== '>') { raw += content[i]; i++; }
      i++;
      const decoded = decodeHex(raw);
      if (pendingArray) pendingArray.push(decoded);
      else pendingStrings.push(decoded);
      continue;
    }
    if (ch === '[') {
      pendingArray = [];
      arrayDepth = 1;
      i++;
      continue;
    }
    if (ch === ']' && pendingArray) {
      arrayDepth--;
      if (arrayDepth === 0) {
        tjParts = pendingArray;
        pendingArray = null;
      }
      i++;
      continue;
    }
    if (ch === '/') {
      let name = '';
      i++;
      while (i < content.length && !/[\s\[\]()<>]/.test(content[i])) { name += content[i]; i++; }
      pendingName = name;
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      let depth = 0;
      while (i < content.length) {
        if (content.startsWith('<<', i)) { depth++; i += 2; continue; }
        if (content.startsWith('>>', i)) { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      continue;
    }
    let word = '';
    while (i < content.length && !/[\s\[\]()<>]/.test(content[i])) { word += content[i]; i++; }
    if (word === '') continue;
    const num = Number(word);
    if (!Number.isNaN(num) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      pendingNumbers.push(num);
      continue;
    }
    if (word === 'q') {
      stack.push({ color: [...state.color] as [number, number, number] });
    } else if (word === 'Q') {
      const prev = stack.pop();
      if (prev) state = prev;
    } else if (word === 'rg') {
      const [r, g, b] = pendingNumbers.slice(-3);
      if (r !== undefined && g !== undefined && b !== undefined) {
        state.color = [r, g, b];
      }
    } else if (word === 'g') {
      const v = pendingNumbers[pendingNumbers.length - 1];
      if (v !== undefined) state.color = [v, v, v];
    } else if (word === 'Tj') {
      const text = pendingStrings[pendingStrings.length - 1] ?? '';
      ops.push({ kind: 'text', text, color: [...state.color] as [number, number, number] });
    } else if (word === 'TJ') {
      const parts = tjParts ?? [];
      ops.push({ kind: 'text', text: parts.join(''), color: [...state.color] as [number, number, number] });
    } else if (word === "'" || word === '"') {
      const text = pendingStrings[pendingStrings.length - 1] ?? '';
      ops.push({ kind: 'text', text, color: [...state.color] as [number, number, number] });
    } else if (word === 'Do') {
      ops.push({ kind: 'do', name: pendingName });
    }
    if (word !== 'TJ') tjParts = undefined;
    pendingName = '';
    flushPending();
  }
  return ops;
}

function allOps(pdf: Uint8Array): PdfOp[] {
  const ops: PdfOp[] = [];
  const latin = Buffer.from(pdf).toString('latin1');
  // Consuming match: each match runs from a real "stream" keyword through
  // its own "endstream", so the "stream" inside "endstream" is never
  // re-matched as the start of a phantom stream. A naive
  // /stream/g + indexOf('endstream') scan double counts every page.
  const streamMatches = [...latin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
  for (const match of streamMatches) {
    const matchIndex = match.index ?? 0;
    // Skip image XObject streams: their dict carries /Subtype /Image.
    // Only content streams carry Tj/TJ/Do operators.
    const dictStart = latin.lastIndexOf('<<', matchIndex);
    const dict = dictStart >= 0 ? latin.slice(dictStart, matchIndex) : '';
    if (dict.includes('/Subtype /Image')) continue;
    let raw = Buffer.from(match[1], 'latin1');
    while (raw.length > 0 && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) {
      raw = raw.subarray(0, raw.length - 1);
    }
    const inflated = inflateOrNull(new Uint8Array(raw));
    const content = inflated
      ? Buffer.from(inflated).toString('latin1')
      : raw.toString('latin1');
    if (content.includes('Tj') || content.includes('TJ') || content.includes(' Do')) {
      ops.push(...opsFromStream(content));
    }
  }
  return ops;
}

function isVisible(color: [number, number, number]): boolean {
  const [r, g, b] = color;
  // jsPDF writes rg operands in 0..1. White is 1 1 1. Anything at or
  // above 0.97 on every channel is indistinguishable from the white
  // paper/card background and does not render visibly.
  return !(r >= 0.97 && g >= 0.97 && b >= 0.97);
}

function countDo(ops: PdfOp[], from: number, to: number): number {
  let n = 0;
  for (let k = from; k < to && k < ops.length; k++) {
    if (ops[k].kind === 'do') n++;
  }
  return n;
}

beforeEach(() => {
  captures().length = 0;
});

describe('workflow PDF Step 2 single-assignee row visibility (agent 3-7)', () => {
  test('Step 2 solo row and both Step 1 rows are drawn with visible non-white text and each has exactly one QR Do op', async () => {
    const workflow = buildWorkflow();
    // Fixture guard: Step 2 has exactly 1 assignee, Step 1 has 2.
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[1].assignees).toHaveLength(1);
    expect(workflow.steps[0].assignees).toHaveLength(2);

    await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: false });
    expect(captures()).toHaveLength(1);
    const ops = allOps(captures()[0]);

    // Visible non-white text for every personnel name.
    for (const name of [STEP1_PRIMARY, STEP1_FELLOW, STEP2_SOLO]) {
      const hits = ops.filter((o) => o.kind === 'text' && o.text.includes(name));
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        if (hit.kind !== 'text') continue;
        expect(isVisible(hit.color)).toBe(true);
      }
    }

    // Drawing order: Step 1 primary, then Step 1 fellow, then Step 2 solo.
    const firstIndex = (name: string): number =>
      ops.findIndex((o) => o.kind === 'text' && o.text.includes(name));
    const idxPrimary = firstIndex(STEP1_PRIMARY);
    const idxFellow = firstIndex(STEP1_FELLOW);
    const idxSolo = firstIndex(STEP2_SOLO);
    expect(idxPrimary).toBeGreaterThanOrEqual(0);
    expect(idxFellow).toBeGreaterThan(idxPrimary);
    expect(idxSolo).toBeGreaterThan(idxFellow);

    // One QR Do op per segment: cover QR before the first personnel row,
    // then exactly one Do after each personnel name. If the Step 2 row
    // loses its QR, its segment has 0 Do ops and the total drops below 4.
    expect(countDo(ops, 0, idxPrimary)).toBe(1);
    expect(countDo(ops, idxPrimary, idxFellow)).toBe(1);
    expect(countDo(ops, idxFellow, idxSolo)).toBe(1);
    expect(countDo(ops, idxSolo, ops.length)).toBe(1);

    const totalDo = ops.filter((o) => o.kind === 'do').length;
    expect(totalDo).toBe(4);
  });

  test('detector sensitivity: white text is flagged invisible and a row with no Do op is flagged as missing its QR', () => {
    // A synthetic stream with the Step 2 solo name in white and no Do op
    // after it: the exact failure the regression test guards against.
    const buggyOps = opsFromStream('1 1 1 rg (Step Two Solo) Tj');
    expect(buggyOps).toHaveLength(1);
    const buggyText = buggyOps[0];
    if (buggyText.kind !== 'text') throw new Error('Expected a text op');
    expect(isVisible(buggyText.color)).toBe(false);
    expect(countDo(buggyOps, 0, buggyOps.length)).toBe(0);

    // The same row drawn dark with a QR Do op passes both checks.
    const fixedOps = opsFromStream('0.06 0.09 0.16 rg (Step Two Solo) Tj /I1 Do');
    expect(fixedOps).toHaveLength(2);
    const fixedText = fixedOps[0];
    if (fixedText.kind !== 'text') throw new Error('Expected a text op');
    expect(isVisible(fixedText.color)).toBe(true);
    expect(countDo(fixedOps, 0, fixedOps.length)).toBe(1);
  });
});
