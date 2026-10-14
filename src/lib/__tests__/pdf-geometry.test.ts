/**
 * Self-test for the pdf-geometry helper. Proves the helper detects a
 * deliberately overlapping pair and passes a non-overlapping pair, plus
 * the page, align, array-text, rect, image, and containment behavior
 * the other PDF tests rely on.
 */

jest.mock('jspdf', () => {
  // jspdf.node.js needs TextEncoder/TextDecoder, which jsdom does not provide.
  const util = require('util');
  if (!(global as any).TextEncoder) (global as any).TextEncoder = util.TextEncoder;
  if (!(global as any).TextDecoder) (global as any).TextDecoder = util.TextDecoder;
  return jest.requireActual('jspdf/dist/jspdf.node.js');
});

import { jsPDF } from 'jspdf';
import {
  assertInside,
  assertNoOverlap,
  boxesOverlap,
  captureDrawCalls,
  interceptDoc,
  textBoxesFor,
} from './pdf-geometry';
import type { RecordedBox } from './pdf-geometry';

function box(overrides: Partial<RecordedBox> = {}): RecordedBox {
  return {
    kind: 'text',
    page: 1,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    label: 'box',
    ...overrides,
  };
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('pdf-geometry helper', () => {
  test('detects a deliberately overlapping pair', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.setFontSize(10);
      doc.text('AAA', 10, 20);
      doc.text('BBB', 10, 21);
    });
    expect(boxes).toHaveLength(2);
    expect(() => assertNoOverlap(boxes, 'personnel block')).toThrow(/Overlap in personnel block/);
    expect(() => assertNoOverlap(boxes, 'personnel block')).toThrow(/AAA/);
    expect(() => assertNoOverlap(boxes, 'personnel block')).toThrow(/BBB/);
  });

  test('passes a non-overlapping pair', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.setFontSize(10);
      doc.text('AAA', 10, 20);
      doc.text('BBB', 10, 40);
    });
    expect(boxes).toHaveLength(2);
    expect(() => assertNoOverlap(boxes, 'personnel block')).not.toThrow();
  });

  test('boxesOverlap ignores rounding hairlines under 0.5mm', () => {
    const a = box({ label: 'a' });
    expect(boxesOverlap(a, box({ label: 'b', x: 9.6 }))).toBe(false);
    expect(boxesOverlap(a, box({ label: 'b', x: 9.4 }))).toBe(true);
    expect(boxesOverlap(a, box({ label: 'b', y: 9.6 }))).toBe(false);
    expect(boxesOverlap(a, box({ label: 'b', x: 5, y: 9.6 }))).toBe(false);
    expect(boxesOverlap(a, box({ label: 'b', x: 5, y: 5 }))).toBe(true);
  });

  test('expands array text to one box per line, stepped by fontSize * 0.55', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.setFontSize(10);
      doc.text(['Line one', 'Line two'], 10, 20);
    });
    expect(boxes).toHaveLength(2);
    expect(boxes[0].label).toBe('Line one');
    expect(boxes[1].label).toBe('Line two');
    expect(boxes[1].y - boxes[0].y).toBeCloseTo(10 * 0.55, 6);
    expect(boxes[0].h).toBeCloseTo(10 * 0.55, 6);
  });

  test('adjusts x for center and right align', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.setFontSize(10);
      doc.text('Hello', 100, 20, { align: 'center' });
      doc.text('Hello', 100, 40, { align: 'right' });
    });
    expect(boxes).toHaveLength(2);
    expect(boxes[0].x).toBeLessThan(100);
    expect(boxes[0].x + boxes[0].w).toBeGreaterThan(100);
    expect(boxes[0].x + boxes[0].w / 2).toBeCloseTo(100, 6);
    expect(boxes[1].x + boxes[1].w).toBeCloseTo(100, 6);
  });

  test('records rect, roundedRect, and image boxes', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.rect(10, 10, 20, 20, 'F');
      doc.roundedRect(40, 10, 20, 20, 2, 2, 'F');
      doc.addImage(TINY_PNG, 'PNG', 70, 10, 20, 20);
    });
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toMatchObject({ kind: 'rect', x: 10, y: 10, w: 20, h: 20 });
    expect(boxes[1]).toMatchObject({ kind: 'rect', x: 40, y: 10, w: 20, h: 20 });
    expect(boxes[2]).toMatchObject({ kind: 'image', x: 70, y: 10, w: 20, h: 20 });
  });

  test('still records an image box when the image data is a placeholder', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.addImage('not-a-real-image', 'PNG', 70, 10, 20, 20);
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ kind: 'image', x: 70, y: 10, w: 20, h: 20 });
  });

  test('tracks pages across addPage and setPage, and skips cross-page pairs', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.setFontSize(10);
      doc.text('Page one', 10, 20);
      doc.addPage();
      doc.text('Page two', 10, 20);
      doc.setPage(1);
      doc.text('Back on one', 10, 40);
    });
    expect(boxes.map((b) => b.page)).toEqual([1, 2, 1]);
    // Same coordinates on different pages must not count as overlap.
    expect(() => assertNoOverlap(boxes, 'multi-page')).not.toThrow();
  });

  test('textBoxesFor finds text boxes by substring', async () => {
    const boxes = await captureDrawCalls((doc) => {
      doc.setFontSize(10);
      doc.text('PERSONNEL ASSIGNED', 10, 20);
      doc.text('MISSION DEADLINE', 10, 40);
      doc.rect(10, 50, 20, 20, 'F');
    });
    expect(textBoxesFor('PERSONNEL', boxes).map((b) => b.label)).toEqual([
      'PERSONNEL ASSIGNED',
    ]);
    expect(textBoxesFor('MISSION', boxes)).toHaveLength(1);
    expect(textBoxesFor('missing', boxes)).toHaveLength(0);
  });

  test('assertInside passes inside and throws outside', () => {
    const container = box({ label: 'card', x: 10, y: 10, w: 100, h: 100 });
    expect(() =>
      assertInside(box({ label: 'inner', x: 20, y: 20, w: 10, h: 10 }), container, 'card'),
    ).not.toThrow();
    expect(() =>
      assertInside(
        box({ label: 'spills right', x: 20, y: 20, w: 100, h: 10 }),
        container,
        'card',
      ),
    ).toThrow(/extends outside container/);
    expect(() =>
      assertInside(
        box({ label: 'wrong page', page: 2, x: 20, y: 20, w: 10, h: 10 }),
        container,
        'card',
      ),
    ).toThrow(/page 2/);
  });

  test('supports an async drawing function', async () => {
    const boxes = await captureDrawCalls(async (doc) => {
      doc.setFontSize(10);
      await Promise.resolve();
      doc.text('Async line', 10, 20);
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0].label).toBe('Async line');
  });

  test('works with a fake doc that has no getFontSize or getCurrentPageInfo', () => {
    // Mirrors the recording fake in workflow-pdf-export-edge.test.ts: font
    // size lives on a property, page state is tracked via addPage/setPage.
    class FakeDoc {
      fontSize = 10;
      pages = 1;
      setFontSize(size: number): void {
        this.fontSize = size;
      }
      getTextWidth(text: string): number {
        return String(text).length * this.fontSize * 0.5;
      }
      text(): this {
        return this;
      }
      rect(): this {
        return this;
      }
      roundedRect(): this {
        return this;
      }
      addImage(): this {
        return this;
      }
      addPage(): this {
        this.pages += 1;
        return this;
      }
      setPage(): this {
        return this;
      }
      getNumberOfPages(): number {
        return this.pages;
      }
    }
    const fake = new FakeDoc() as unknown as jsPDF;
    const { boxes, restore } = interceptDoc(fake);
    try {
      (fake as unknown as { setFontSize: (n: number) => void }).setFontSize(10);
      (fake as unknown as { text: (t: string, x: number, y: number) => void }).text(
        'Fake line',
        10,
        20,
      );
      (fake as unknown as { addPage: () => void }).addPage();
      (fake as unknown as { text: (t: string, x: number, y: number) => void }).text(
        'Page two',
        10,
        20,
      );
    } finally {
      restore();
    }
    expect(boxes).toHaveLength(2);
    expect(boxes[0].page).toBe(1);
    expect(boxes[1].page).toBe(2);
    expect(boxes[0].h).toBeCloseTo(10 * 0.55, 6);
    expect(() => assertNoOverlap(boxes, 'fake doc')).not.toThrow();
  });

  test('interceptDoc restores the original methods', () => {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const before = (doc as unknown as Record<string, unknown>)['text'];
    const { boxes, restore } = interceptDoc(doc);
    expect((doc as unknown as Record<string, unknown>)['text']).not.toBe(before);
    (doc as unknown as { text: (t: string, x: number, y: number) => void }).text('Hi', 10, 20);
    expect(boxes).toHaveLength(1);
    restore();
    expect((doc as unknown as Record<string, unknown>)['text']).toBe(before);
  });
});
