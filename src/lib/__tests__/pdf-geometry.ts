/**
 * Reusable PDF geometry helpers for workflow PDF regression tests.
 *
 * captureDrawCalls runs a drawing function against a jsPDF document whose
 * text, image, and rectangle calls are intercepted, and returns the recorded
 * bounding boxes. Tests then assert on geometry (no overlap, inside a
 * container) instead of parsing PDF bytes.
 *
 * Coordinate conventions, all in the document unit (mm in production):
 * - Text: jsPDF treats the y argument as the baseline for the default
 *   alphabetic baseline. A recorded text box therefore starts at
 *   baseline minus line height, with height equal to one line height.
 * - Line height is fontSize * 0.55 per line, matching the codebase
 *   convention in workflow-pdf-export.ts (drawClickableUrl uses the same
 *   factor). For array text, each line gets its own box, stepped by one
 *   line height. Note this is the codebase convention, not jsPDF's native
 *   1.15 line-height factor for array text.
 * - Rects and rounded rects: x, y, w, h are recorded as passed.
 * - Images: x, y, w, h are recorded as passed to addImage.
 * - Page numbers start at 1. Boxes on different pages never count as
 *   overlapping in assertNoOverlap.
 *
 * The interceptor is written to work with both real jsPDF and the
 * recording fake used by workflow-pdf-export-edge.test.ts. Where the two
 * differ (fake has no getFontSize or getCurrentPageInfo, and its addImage
 * takes a different argument order), the helper falls back to the
 * tracked page number and to the doc.fontSize property, and it parses
 * addImage arguments in both the real and the fake order.
 *
 * Limitations, stated so callers do not over-read the boxes:
 * - Text rotation (angle) is ignored. Boxes are axis-aligned approximations.
 * - options.maxWidth splitting is not re-applied. Callers should pre-split
 *   long text with splitTextToSize, as production code does.
 * - addImage is geometry only. If the original addImage throws (for
 *   example a placeholder image string in a fixture), the error is
 *   swallowed and the box is still recorded, so geometry tests do not
 *   fail on fake image data.
 */

import { jsPDF } from 'jspdf';

/** One recorded draw call: an axis-aligned box in mm on one page. */
export interface RecordedBox {
  kind: 'text' | 'image' | 'rect';
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** For text, the exact line string. For images, alias or image:FORMAT. */
  label: string;
}

/** Short alias for RecordedBox. */
export type PdfBox = RecordedBox;

/** Line height factor, matching the codebase convention (fontSize * 0.55). */
export const PDF_LINE_HEIGHT_FACTOR = 0.55;

/** Minimum overlap on each axis for two boxes to count as overlapping. */
export const PDF_OVERLAP_THRESHOLD_MM = 0.5;

/** Small tolerance for floating point noise in containment checks. */
const CONTAIN_EPSILON_MM = 0.001;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatBox(box: RecordedBox): string {
  return (
    `"${box.label}" (page ${box.page}, ${box.kind}, ` +
    `x=${box.x.toFixed(2)}, y=${box.y.toFixed(2)}, ` +
    `w=${box.w.toFixed(2)}, h=${box.h.toFixed(2)})`
  );
}

function currentFontSize(doc: unknown): number {
  const d = doc as {
    getFontSize?: () => number;
    fontSize?: number;
    internal?: { getFontSize?: () => number };
  };
  try {
    if (typeof d.getFontSize === 'function') {
      const size = d.getFontSize();
      if (isFiniteNumber(size) && size > 0) return size;
    }
  } catch {
    // Fall through to the property fallback.
  }
  if (isFiniteNumber(d.fontSize) && (d.fontSize as number) > 0) {
    return d.fontSize as number;
  }
  try {
    if (d.internal && typeof d.internal.getFontSize === 'function') {
      const size = d.internal.getFontSize();
      if (isFiniteNumber(size) && size > 0) return size;
    }
  } catch {
    // Fall through to the default.
  }
  return 16;
}

function textWidth(doc: unknown, line: string, fontSize: number): number {
  const d = doc as { getTextWidth?: (text: string) => number };
  try {
    if (typeof d.getTextWidth === 'function') {
      const w = d.getTextWidth(line);
      if (isFiniteNumber(w) && w >= 0) return w;
    }
  } catch {
    // Fall through to the estimate.
  }
  return line.length * fontSize * 0.5;
}

/**
 * True if the two boxes intersect with more than 0.5mm overlap on both
 * axes, so rounding hairlines do not count. This is a pure 2D check: it
 * does not compare pages. Use assertNoOverlap for page-aware checks.
 */
export function boxesOverlap(a: RecordedBox, b: RecordedBox): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX > PDF_OVERLAP_THRESHOLD_MM && overlapY > PDF_OVERLAP_THRESHOLD_MM;
}

/**
 * Throws a readable error listing the first overlapping pair. Pairs on
 * different pages are skipped, since they cannot overlap in the document.
 */
export function assertNoOverlap(boxes: RecordedBox[], regionLabel: string): void {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.page !== b.page) continue;
      if (!boxesOverlap(a, b)) continue;
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      throw new Error(
        `Overlap in ${regionLabel}: ${formatBox(a)} overlaps ${formatBox(b)} ` +
          `by ${overlapX.toFixed(2)}mm x ${overlapY.toFixed(2)}mm.`,
      );
    }
  }
}

/**
 * Throws if the box extends outside the container on any side. A box on
 * a different page than the container also throws, since it is not
 * inside that container.
 */
export function assertInside(box: RecordedBox, container: RecordedBox, label: string): void {
  if (box.page !== container.page) {
    throw new Error(
      `${label}: box ${formatBox(box)} is on page ${box.page}, ` +
        `not container page ${container.page}.`,
    );
  }
  const violations: string[] = [];
  if (box.x < container.x - CONTAIN_EPSILON_MM) {
    violations.push(
      `left edge ${box.x.toFixed(2)} is left of container left ${container.x.toFixed(2)}`,
    );
  }
  if (box.y < container.y - CONTAIN_EPSILON_MM) {
    violations.push(
      `top edge ${box.y.toFixed(2)} is above container top ${container.y.toFixed(2)}`,
    );
  }
  const boxRight = box.x + box.w;
  const containerRight = container.x + container.w;
  if (boxRight > containerRight + CONTAIN_EPSILON_MM) {
    violations.push(
      `right edge ${boxRight.toFixed(2)} is right of container right ${containerRight.toFixed(2)}`,
    );
  }
  const boxBottom = box.y + box.h;
  const containerBottom = container.y + container.h;
  if (boxBottom > containerBottom + CONTAIN_EPSILON_MM) {
    violations.push(
      `bottom edge ${boxBottom.toFixed(2)} is below container bottom ${containerBottom.toFixed(2)}`,
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `${label}: box ${formatBox(box)} extends outside container ` +
        `${formatBox(container)}: ${violations.join('; ')}.`,
    );
  }
}

/** Returns text boxes whose recorded label contains the given substring. */
export function textBoxesFor(content: string, boxes: RecordedBox[]): RecordedBox[] {
  return boxes.filter((box) => box.kind === 'text' && box.label.includes(content));
}

type AnyDoc = Record<string, unknown> & {
  getCurrentPageInfo?: () => { pageNumber?: number };
  getCurrentPage?: () => number;
  internal?: { getCurrentPageInfo?: () => { pageNumber?: number } };
};

type DocMethod = (...args: never[]) => unknown;

function installInterceptor(doc: jsPDF, boxes: RecordedBox[]): () => void {
  const d = doc as unknown as AnyDoc;
  let trackedPage = 1;
  let restored = false;

  // Capture every original before patching. Methods may live on the
  // prototype (real jsPDF and the class-based fake both do this), so the
  // restore step deletes the own-property wrapper when the method was
  // not an own property, revealing the prototype original again.
  const origText = typeof d['text'] === 'function' ? (d['text'] as DocMethod) : null;
  const origRect = typeof d['rect'] === 'function' ? (d['rect'] as DocMethod) : null;
  const origRoundedRect =
    typeof d['roundedRect'] === 'function' ? (d['roundedRect'] as DocMethod) : null;
  const origAddImage =
    typeof d['addImage'] === 'function' ? (d['addImage'] as DocMethod) : null;
  const origAddPage =
    typeof d['addPage'] === 'function' ? (d['addPage'] as DocMethod) : null;
  const origSetPage =
    typeof d['setPage'] === 'function' ? (d['setPage'] as DocMethod) : null;
  const patched: Array<{ name: string; hadOwn: boolean }> = [];

  const getCurrentPage = (): number => {
    // jsPDF 4.2 has no getCurrentPage; the equivalent is
    // getCurrentPageInfo().pageNumber (also on doc.internal). The fake
    // has neither, so the tracked page is the fallback.
    try {
      if (typeof d.getCurrentPageInfo === 'function') {
        const info = d.getCurrentPageInfo();
        if (info && isFiniteNumber(info.pageNumber)) return info.pageNumber;
      }
    } catch {
      // Fall through to the next source.
    }
    try {
      if (typeof d.getCurrentPage === 'function') {
        const page = d.getCurrentPage();
        if (isFiniteNumber(page)) return page;
      }
    } catch {
      // Fall through to the tracked page.
    }
    try {
      if (d.internal && typeof d.internal.getCurrentPageInfo === 'function') {
        const info = d.internal.getCurrentPageInfo();
        if (info && isFiniteNumber(info.pageNumber)) return info.pageNumber;
      }
    } catch {
      // Fall through to the tracked page.
    }
    return trackedPage;
  };

  const setWrapper = (name: string, wrapper: DocMethod): void => {
    patched.push({ name, hadOwn: Object.prototype.hasOwnProperty.call(d, name) });
    d[name] = wrapper;
  };

  if (origAddPage) {
    const original = origAddPage;
    setWrapper('addPage', function (...args: never[]) {
      const result = original.apply(d, args);
      // Prefer the doc's own page info when it exists; otherwise step on.
      const reported = getCurrentPage();
      trackedPage = reported !== trackedPage ? reported : trackedPage + 1;
      return result;
    });
  }

  if (origSetPage) {
    const original = origSetPage;
    setWrapper('setPage', function (...args: never[]) {
      const result = original.apply(d, args);
      const next = args[0] as unknown;
      if (isFiniteNumber(next)) trackedPage = next;
      else trackedPage = getCurrentPage();
      return result;
    });
  }

  if (origText) {
    const original = origText;
    setWrapper('text', function (...args: never[]) {
      recordText(args as unknown[]);
      return original.apply(d, args);
    });
  }

  if (origRect) {
    const original = origRect;
    setWrapper('rect', function (...args: never[]) {
      const rawArgs = args as unknown[];
      const x = rawArgs[0];
      const y = rawArgs[1];
      const w = rawArgs[2];
      const h = rawArgs[3];
      if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
        boxes.push({ kind: 'rect', page: getCurrentPage(), x, y, w, h, label: 'rect' });
      }
      return original.apply(d, args);
    });
  }

  if (origRoundedRect) {
    const original = origRoundedRect;
    setWrapper('roundedRect', function (...args: never[]) {
      const rawArgs = args as unknown[];
      const x = rawArgs[0];
      const y = rawArgs[1];
      const w = rawArgs[2];
      const h = rawArgs[3];
      if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
        boxes.push({
          kind: 'rect',
          page: getCurrentPage(),
          x,
          y,
          w,
          h,
          label: 'roundedRect',
        });
      }
      return original.apply(d, args);
    });
  }

  if (origAddImage) {
    const original = origAddImage;
    setWrapper('addImage', function (...args: never[]) {
      const parsed = parseAddImageArgs(args as unknown[]);
      if (parsed) {
        boxes.push({
          kind: 'image',
          page: getCurrentPage(),
          x: parsed.x,
          y: parsed.y,
          w: parsed.w,
          h: parsed.h,
          label: parsed.label,
        });
      }
      try {
        return original.apply(d, args);
      } catch {
        // Geometry only: placeholder image data in fixtures must not
        // break a geometry test. Return the doc for chaining.
        return d;
      }
    });
  }

  function recordText(rawArgs: unknown[]): void {
    // Support the legacy flipped form text(x, y, text, ...).
    let textArg: unknown = rawArgs[0];
    let xArg: unknown = rawArgs[1];
    let yArg: unknown = rawArgs[2];
    let optionsArg: unknown = rawArgs[3];
    if (
      typeof textArg === 'number' &&
      typeof xArg === 'number' &&
      (typeof yArg === 'string' || Array.isArray(yArg))
    ) {
      textArg = rawArgs[2];
      xArg = rawArgs[0];
      yArg = rawArgs[1];
      optionsArg = rawArgs[3];
    }

    const options =
      optionsArg && typeof optionsArg === 'object'
        ? (optionsArg as Record<string, unknown>)
        : undefined;
    const alignFromOptions =
      options && typeof options['align'] === 'string' ? (options['align'] as string) : undefined;
    const alignFromLegacy =
      typeof rawArgs[5] === 'string'
        ? (rawArgs[5] as string)
        : typeof rawArgs[3] === 'string'
          ? (rawArgs[3] as string)
          : undefined;
    const align = alignFromOptions ?? alignFromLegacy ?? 'left';
    const baseline =
      options && typeof options['baseline'] === 'string'
        ? (options['baseline'] as string)
        : 'alphabetic';

    const fontSize =
      options && isFiniteNumber(options['fontSize'])
        ? (options['fontSize'] as number)
        : currentFontSize(d);
    const lineHeight = fontSize * PDF_LINE_HEIGHT_FACTOR;

    // Normalize to one entry per drawn line. A plain string may contain
    // newlines (jsPDF splits those); an array is already per line; an
    // array element may itself be a [text, x, y] tuple with per-line
    // coordinates.
    type LineEntry = { text: string; x: number | undefined; y: number | undefined };
    const entries: LineEntry[] = [];
    // Plain and array string lines share the call's x/y and step down by
    // one line height per line, so they keep x/y undefined here and let
    // the stepping below place them. Only [text, x, y] tuples carry
    // per-line coordinates.
    const pushStringLines = (value: string): void => {
      for (const line of value.split(/\r\n|\r|\n/g)) {
        entries.push({ text: line, x: undefined, y: undefined });
      }
    };
    if (typeof textArg === 'string') {
      pushStringLines(textArg);
    } else if (Array.isArray(textArg)) {
      for (const item of textArg as unknown[]) {
        if (typeof item === 'string') {
          pushStringLines(item);
        } else if (Array.isArray(item)) {
          const tuple = item as unknown[];
          entries.push({
            text: typeof tuple[0] === 'string' ? (tuple[0] as string) : String(tuple[0] ?? ''),
            x: isFiniteNumber(tuple[1]) ? (tuple[1] as number) : undefined,
            y: isFiniteNumber(tuple[2]) ? (tuple[2] as number) : undefined,
          });
        } else {
          entries.push({
            text: String(item ?? ''),
            x: undefined,
            y: undefined,
          });
        }
      }
    } else {
      return;
    }

    const baseX = isFiniteNumber(xArg) ? (xArg as number) : 0;
    const baseY = isFiniteNumber(yArg) ? (yArg as number) : 0;
    const topForBaseline = (baselineY: number): number => {
      if (baseline === 'top') return baselineY;
      if (baseline === 'middle') return baselineY - lineHeight / 2;
      // Default alphabetic baseline, bottom, and hanging: the box sits
      // one line height above the given y.
      return baselineY - lineHeight;
    };
    const firstLineTop = topForBaseline(baseY);

    entries.forEach((entry, index) => {
      if (entry.text.length === 0) return;
      const lineTop =
        entry.y !== undefined ? topForBaseline(entry.y) : firstLineTop + index * lineHeight;
      const lineX = entry.x !== undefined ? entry.x : baseX;
      const w = textWidth(d, entry.text, fontSize);
      let left = lineX;
      if (align === 'center') left = lineX - w / 2;
      else if (align === 'right') left = lineX - w;
      boxes.push({
        kind: 'text',
        page: getCurrentPage(),
        x: left,
        y: lineTop,
        w,
        h: lineHeight,
        label: entry.text,
      });
    });
  }

  return () => {
    if (restored) return;
    restored = true;
    for (let i = patched.length - 1; i >= 0; i--) {
      try {
        const { name, hadOwn } = patched[i];
        if (hadOwn) {
          // Own-property originals were overwritten in place; the
          // wrapper replaced them, so restore from the captured
          // originals held above.
          switch (name) {
            case 'text':
              if (origText) d[name] = origText;
              break;
            case 'rect':
              if (origRect) d[name] = origRect;
              break;
            case 'roundedRect':
              if (origRoundedRect) d[name] = origRoundedRect;
              break;
            case 'addImage':
              if (origAddImage) d[name] = origAddImage;
              break;
            case 'addPage':
              if (origAddPage) d[name] = origAddPage;
              break;
            case 'setPage':
              if (origSetPage) d[name] = origSetPage;
              break;
            default:
              delete d[name];
              break;
          }
        } else {
          delete d[name];
        }
      } catch {
        // Restore must not throw.
      }
    }
  };
}

function parseAddImageArgs(
  rawArgs: unknown[],
): { x: number; y: number; w: number; h: number; label: string } | null {
  // Object form: addImage({ imageData, format, x, y, w, h, alias }).
  const first = rawArgs[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const obj = first as Record<string, unknown>;
    const x = obj['x'];
    const y = obj['y'];
    const w = obj['w'] ?? obj['width'];
    const h = obj['h'] ?? obj['height'];
    if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
      const alias = obj['alias'];
      const format = obj['format'];
      return {
        x,
        y,
        w,
        h,
        label:
          typeof alias === 'string' && alias
            ? alias
            : typeof format === 'string' && format
              ? `image:${format}`
              : 'image',
      };
    }
    return null;
  }
  // Format-omitted form: addImage(data, x, y, w, h, ...). This also
  // covers the fake doc's addImage(format, x, y, w, h) shape.
  if (isFiniteNumber(rawArgs[1])) {
    const x = rawArgs[1] as number;
    const y = rawArgs[2];
    const w = rawArgs[3];
    const h = rawArgs[4];
    if (isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
      const alias = rawArgs[5];
      return {
        x,
        y: y as number,
        w: w as number,
        h: h as number,
        label: typeof alias === 'string' && alias ? alias : 'image',
      };
    }
    return null;
  }
  // Real form: addImage(data, format, x, y, w, h, alias, ...).
  const format = rawArgs[1];
  const x = rawArgs[2];
  const y = rawArgs[3];
  const w = rawArgs[4];
  const h = rawArgs[5];
  if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
    const alias = rawArgs[6];
    return {
      x: x as number,
      y: y as number,
      w: w as number,
      h: h as number,
      label:
        typeof alias === 'string' && alias
          ? alias
          : typeof format === 'string' && format
            ? `image:${format}`
            : 'image',
    };
  }
  return null;
}

/** Drawing function passed to captureDrawCalls. Receives the intercepted doc. */
export type PdfDrawFn = (doc: jsPDF) => void | Promise<void>;

/**
 * Runs makePdf against a fresh intercepted jsPDF document and returns the
 * recorded boxes. When makePdf is sync, the return value is a plain array;
 * when it is async, a Promise of the array. Awaiting the result works in
 * both cases, so callers should await it.
 *
 * The doc is created with portrait A4 in mm, matching production. Pass
 * jsPDFOptions to override. The interceptor is always restored, even when
 * makePdf throws.
 */
/** jsPDF constructor options accepted by captureDrawCalls. */
export interface CaptureDocOptions {
  orientation?: 'portrait' | 'landscape' | 'p' | 'l';
  unit?: 'mm' | 'pt' | 'px' | 'in' | 'cm' | 'ex' | 'em' | 'pc';
  format?: string | number[];
}

export function captureDrawCalls(
  makePdf: PdfDrawFn,
  jsPDFOptions?: CaptureDocOptions,
): RecordedBox[] | Promise<RecordedBox[]> {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    ...(jsPDFOptions ?? {}),
  });
  const { boxes, restore } = interceptDoc(doc);
  let result: void | Promise<void>;
  try {
    result = makePdf(doc);
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof (result as Promise<void>).then === 'function') {
    return (result as Promise<void>).then(
      () => {
        restore();
        return boxes;
      },
      (error: unknown) => {
        restore();
        throw error;
      },
    );
  }
  restore();
  return boxes;
}

/**
 * Intercepts draw calls on an existing doc (one the caller created, or a
 * mocked doc). Returns the live boxes array plus a restore function that
 * puts the original methods back. Callers must call restore when done,
 * ideally in a finally block. captureDrawCalls is the simpler entry
 * point when the caller does not already own a doc.
 */
export function interceptDoc(doc: jsPDF): { boxes: RecordedBox[]; restore: () => void } {
  const boxes: RecordedBox[] = [];
  const restore = installInterceptor(doc, boxes);
  return { boxes, restore };
}
