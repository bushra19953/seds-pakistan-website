/**
 * Regression test: every personnel row in a workflow PDF must place a QR image.
 *
 * Bug: in the workflow PDF export only the FIRST assignee personnel row
 * renders visibly. Rows 2+ QR codes do not render.
 *
 * Approach: generate a real PDF with 5 assignees through the repo export
 * code, capture the PDF bytes from doc.save(), and parse the actual PDF
 * content streams for Do operators plus their placement matrices. Each
 * personnel QR must appear as one Do operator on a personnel page whose
 * cm matrix places a 22mm x 22mm rect with a sane non-zero position
 * inside the page bounds. This parses the real bytes, so it sees what a
 * renderer will draw, not what the exporter asked for at the call site.
 * Counting addImage calls would not catch this bug: the exporter can
 * call addImage while the emitted PDF still lacks the Do operator.
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
          (globalThis as any).__pdfRowsVisibilityCaptures32 ||
          ((globalThis as any).__pdfRowsVisibilityCaptures32 = []);
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

/** Personnel QR size in mm, from PERSONNEL_QR_SIZE in the exporter. */
const PERSONNEL_QR_MM = 22;
/** Tolerance in mm for the placed QR rect size (point conversion noise). */
const QR_SIZE_TOLERANCE_MM = 1.5;
/** Points per mm. */
const PT_PER_MM = 72 / 25.4;

function captures(): Uint8Array[] {
  const g = globalThis as unknown as { __pdfRowsVisibilityCaptures32?: Uint8Array[] };
  if (!g.__pdfRowsVisibilityCaptures32) g.__pdfRowsVisibilityCaptures32 = [];
  return g.__pdfRowsVisibilityCaptures32;
}

function buildWorkflow(): WorkflowPDFData {
  return {
    id: 'wf-pdf-rows-qr-do',
    title: 'Rows QR Do Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    chapterName: 'SEDS IST Chapter',
    description: 'A workflow built to pin down personnel QR placement.',
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
        assigneePhoto:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        role: 'Step Owner',
        individualDeadline: '2026-10-20T15:30:00+05:00',
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

interface PdfObject {
  num: number;
  dict: string;
  stream: Buffer | null;
}

interface PlacedImage {
  page: number;
  name: string;
  xMm: number;
  yTopMm: number;
  wMm: number;
  hMm: number;
  filter: string;
  pageWMm: number;
  pageHMm: number;
}

function inflateOrNull(data: Buffer): Buffer | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zlib = jest.requireActual('zlib') as typeof import('zlib');
    return zlib.inflateSync(data);
  } catch {
    return null;
  }
}

/** Split the PDF into numbered indirect objects with dicts and raw streams. */
function parseObjects(pdf: Uint8Array): Map<number, PdfObject> {
  const latin = Buffer.from(pdf).toString('latin1');
  const objects = new Map<number, PdfObject>();
  const objRe = /(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = objRe.exec(latin)) !== null) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endIdx = latin.indexOf('endobj', bodyStart);
    if (endIdx === -1) break;
    const body = latin.slice(bodyStart, endIdx);
    const streamIdx = body.search(/stream\r?\n/);
    let dict = body;
    let stream: Buffer | null = null;
    if (streamIdx !== -1) {
      dict = body.slice(0, streamIdx);
      const streamMarker = body.slice(streamIdx).match(/stream\r?\n/);
      const dataStart = streamIdx + (streamMarker ? streamMarker[0].length : 7);
      const endStreamIdx = body.indexOf('endstream', dataStart);
      if (endStreamIdx !== -1) {
        let raw = Buffer.from(body.slice(dataStart, endStreamIdx), 'latin1');
        while (
          raw.length > 0 &&
          (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)
        ) {
          raw = raw.subarray(0, raw.length - 1);
        }
        stream = raw;
      }
    }
    objects.set(num, { num, dict, stream });
  }
  return objects;
}

function decompressedStream(obj: PdfObject): string | null {
  if (!obj.stream) return null;
  if (/\/FlateDecode/.test(obj.dict)) {
    const inflated = inflateOrNull(obj.stream);
    if (!inflated) return null;
    return inflated.toString('latin1');
  }
  return obj.stream.toString('latin1');
}

/** Refs of the form "12 0 R" found in a dict fragment. */
function refsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(\d+)\s+\d+\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/** Ordered page object numbers from the /Pages /Kids array, or null. */
function orderedPageNums(objects: Map<number, PdfObject>): number[] | null {
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const kids = obj.dict.match(/\/Kids\s*\[([^\]]*)\]/);
      if (kids) {
        const nums = refsIn(kids[1]);
        if (nums.length > 0) return nums;
      }
    }
  }
  return null;
}

/** XObject name to object number map for one page, following indirect Resources. */
function xobjectMap(
  pageDict: string,
  objects: Map<number, PdfObject>,
): Map<string, number> {
  const map = new Map<string, number>();
  let resourcesText = pageDict;
  const resourcesRef = pageDict.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
  if (resourcesRef) {
    const resObj = objects.get(Number(resourcesRef[1]));
    if (resObj) resourcesText = resObj.dict;
  }
  const xobj = resourcesText.match(/\/XObject\s*<<([\s\S]*?)>>/);
  if (!xobj) return map;
  const entryRe = /\/([A-Za-z0-9_]+)\s+(\d+)\s+\d+\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xobj[1])) !== null) {
    map.set(m[1], Number(m[2]));
  }
  return map;
}

interface Token {
  kind: 'number' | 'name' | 'op' | 'string' | 'other';
  value: string;
}

/** Minimal content-stream tokenizer that keeps operator order. */
function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '%') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      i++;
      while (i < content.length && depth > 0) {
        const c = content[i];
        if (c === '\\' && i + 1 < content.length) {
          i += 2;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') depth--;
        i++;
      }
      tokens.push({ kind: 'string', value: '' });
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      i = end === -1 ? content.length : end + 1;
      tokens.push({ kind: 'string', value: '' });
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      let depth = 0;
      while (i < content.length) {
        if (content.startsWith('<<', i)) {
          depth++;
          i += 2;
          continue;
        }
        if (content.startsWith('>>', i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i++;
      }
      tokens.push({ kind: 'other', value: 'dict' });
      continue;
    }
    if (ch === '[' || ch === ']') {
      tokens.push({ kind: 'other', value: ch });
      i++;
      continue;
    }
    if (ch === '/') {
      let name = '';
      i++;
      while (i < content.length && !/[\s\[\]()<>/]/.test(content[i])) {
        name += content[i];
        i++;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    let word = '';
    while (i < content.length && !/[\s\[\]()<>]/.test(content[i])) {
      word += content[i];
      i++;
    }
    if (word === '') {
      i++;
      continue;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      tokens.push({ kind: 'number', value: word });
    } else {
      tokens.push({ kind: 'op', value: word });
    }
  }
  return tokens;
}

/**
 * Walk every page content stream and return every Do operator that paints
 * an image XObject, with the placement rect from the cm matrix in effect
 * at that Do. Rects are reported in mm with y measured from the top of
 * the page, matching the exporter coordinate convention.
 */
function placedImages(pdf: Uint8Array): PlacedImage[] {
  const objects = parseObjects(pdf);
  const ordered = orderedPageNums(objects);
  const pageObjs = ordered
    ? ordered
        .map((n) => objects.get(n))
        .filter((o): o is PdfObject => !!o)
    : [...objects.values()].filter((o) => /\/Type\s*\/Page(?![sA-Za-z])/.test(o.dict));
  const placed: PlacedImage[] = [];
  pageObjs.forEach((pageObj, pageIndex) => {
    const page = pageIndex + 1;
    const mediaBox = pageObj.dict.match(/\/MediaBox\s*\[([^\]]*)\]/);
    const boxNums = mediaBox
      ? mediaBox[1].trim().split(/\s+/).map(Number)
      : [0, 0, 595.28, 841.89];
    const pageWpt = boxNums[2] - boxNums[0];
    const pageHpt = boxNums[3] - boxNums[1];
    const xobjects = xobjectMap(pageObj.dict, objects);
    const contentsMatch = pageObj.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
    if (!contentsMatch) return;
    const contentNums = refsIn(contentsMatch[1]);
    for (const contentNum of contentNums) {
      const contentObj = objects.get(contentNum);
      if (!contentObj) continue;
      const content = decompressedStream(contentObj);
      if (!content) continue;
      const tokens = tokenize(content);
      let pendingNumbers: number[] = [];
      let pendingName: string | null = null;
      let lastCm: number[] | null = null;
      for (const tok of tokens) {
        if (tok.kind === 'number') {
          pendingNumbers.push(Number(tok.value));
          continue;
        }
        if (tok.kind === 'name') {
          pendingName = tok.value;
          continue;
        }
        if (tok.kind !== 'op') {
          pendingNumbers = [];
          pendingName = null;
          continue;
        }
        if (tok.value === 'cm' && pendingNumbers.length >= 6) {
          lastCm = pendingNumbers.slice(-6);
        } else if (tok.value === 'Do' && pendingName && lastCm) {
          const targetNum = xobjects.get(pendingName);
          const target = targetNum !== undefined ? objects.get(targetNum) : undefined;
          if (target && /\/Subtype\s*\/Image/.test(target.dict)) {
            const [a, b, c, d, e, f] = lastCm;
            const wPt = Math.hypot(a, b);
            const hPt = Math.hypot(c, d);
            const filter = /\/DCTDecode/.test(target.dict)
              ? 'DCTDecode'
              : /\/FlateDecode/.test(target.dict)
                ? 'FlateDecode'
                : 'other';
            placed.push({
              page,
              name: pendingName,
              xMm: e / PT_PER_MM,
              // PDF y is measured from the bottom; convert to top origin.
              yTopMm: (pageHpt - (f + hPt)) / PT_PER_MM,
              wMm: wPt / PT_PER_MM,
              hMm: hPt / PT_PER_MM,
              filter,
              pageWMm: pageWpt / PT_PER_MM,
              pageHMm: pageHpt / PT_PER_MM,
            });
          }
        }
        if (tok.value !== 'cm') {
          // Keep lastCm across the name token that precedes Do; clear the
          // number buffer after every operator.
          pendingNumbers = [];
        } else {
          pendingNumbers = [];
        }
        if (tok.value !== 'Do') {
          // pendingName is consumed by Do; any other operator clears it.
        } else {
          pendingName = null;
        }
      }
    }
  });
  return placed;
}

beforeEach(() => {
  captures().length = 0;
});

describe('workflow PDF personnel rows QR Do operators', () => {
  test('5 assignees produce 5 personnel QR Do placements, one per row', async () => {
    await exportWorkflowAsPDF(buildWorkflow(), undefined, { hideQrCodes: false });
    expect(captures()).toHaveLength(1);
    const placed = placedImages(captures()[0]);

    // Personnel QRs live on step pages, never on the cover (page 1). The
    // cover QR is 35mm and the avatar is 16mm, so the 22mm size filter
    // separates personnel QRs from every other image in the file.
    const personnelQrs = placed.filter(
      (p) =>
        p.page > 1 &&
        Math.abs(p.wMm - PERSONNEL_QR_MM) <= QR_SIZE_TOLERANCE_MM &&
        Math.abs(p.hMm - PERSONNEL_QR_MM) <= QR_SIZE_TOLERANCE_MM,
    );

    expect(personnelQrs).toHaveLength(5);

    const seen = new Set<string>();
    for (const qr of personnelQrs) {
      expect(qr.wMm).toBeGreaterThan(0);
      expect(qr.hMm).toBeGreaterThan(0);
      expect(qr.xMm).toBeGreaterThanOrEqual(0);
      expect(qr.yTopMm).toBeGreaterThanOrEqual(0);
      expect(qr.xMm + qr.wMm).toBeLessThanOrEqual(qr.pageWMm + 0.5);
      expect(qr.yTopMm + qr.hMm).toBeLessThanOrEqual(qr.pageHMm + 0.5);
      const key = `${qr.page}:${qr.xMm.toFixed(2)}:${qr.yTopMm.toFixed(2)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Five rows means five distinct placements, not one placement counted
    // five times.
    expect(seen.size).toBe(5);
  });
});
