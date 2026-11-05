/**
 * MSG46: the workflow mission PDF must print the parent workflow
 * description under OPERATIONAL INTENT. The renderer already accepted
 * workflow.description; the API never returned one, so every export
 * fell back to the generic boilerplate. These tests prove the renderer
 * side of the chain: a real description prints (and the boilerplate
 * does not), and a workflow with no description anywhere still gets
 * the boilerplate.
 *
 * Harness: the exporter builds its own jsPDF instance and ends with
 * doc.save(), so (like workflow-pdf-export-edge.test.ts) this file
 * mocks 'jspdf' with a recording fake and 'qrcode' with a fixed data
 * URL. Assertions run against the recorded texts, in order.
 */

type RecordedText = { text: string; x: number; y: number };

type FakePdfDoc = {
  texts: RecordedText[];
  pages: number;
  savedFilename: string | null;
  savedOutput: string;
};

function fakeDocRegistry(): FakePdfDoc[] {
  const g = globalThis as unknown as { __fakePdfDocs?: FakePdfDoc[] };
  if (!g.__fakePdfDocs) g.__fakePdfDocs = [];
  return g.__fakePdfDocs;
}

jest.mock('jspdf', () => {
  class FakeJsPDF {
    internal = {
      pageSize: {
        getWidth: () => 210,
        getHeight: () => 297,
      },
    };

    fontSize = 11;
    texts: RecordedText[] = [];
    pages = 1;
    savedFilename: string | null = null;
    savedOutput = '';

    constructor(_options?: Record<string, unknown>) {
      const g = globalThis as unknown as { __fakePdfDocs?: unknown[] };
      if (!g.__fakePdfDocs) g.__fakePdfDocs = [];
      g.__fakePdfDocs.push(this);
    }

    setFont(_family: string, _style?: string): void {}

    setFontSize(size: number): void {
      this.fontSize = size;
    }

    setTextColor(..._args: number[]): void {}

    setDrawColor(..._args: number[]): void {}

    setFillColor(..._args: number[]): void {}

    setLineWidth(_width: number): void {}

    rect(..._args: unknown[]): void {}

    roundedRect(..._args: unknown[]): void {}

    line(..._args: unknown[]): void {}

    circle(..._args: unknown[]): void {}

    clip(): void {}

    saveGraphicsState(): void {}

    restoreGraphicsState(): void {}

    getTextWidth(text: string | string[]): number {
      const longest = Array.isArray(text)
        ? Math.max(0, ...text.map((t) => String(t).length))
        : String(text).length;
      return longest * this.fontSize * 0.5;
    }

    splitTextToSize(text: string, maxWidth: number): string[] {
      const input = String(text ?? '');
      if (!input) return [];
      const charWidth = Math.max(0.5, this.fontSize * 0.5);
      const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
      const words = input.split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      const lines: string[] = [];
      let current = '';
      const pushCurrent = () => {
        if (current) {
          lines.push(current);
          current = '';
        }
      };
      for (const word of words) {
        if (word.length > maxChars) {
          pushCurrent();
          for (let i = 0; i < word.length; i += maxChars) {
            lines.push(word.slice(i, i + maxChars));
          }
          continue;
        }
        const trial = current ? `${current} ${word}` : word;
        if (trial.length <= maxChars) {
          current = trial;
        } else {
          pushCurrent();
          current = word;
        }
      }
      pushCurrent();
      return lines;
    }

    text(textArg: string | string[], x: number, y: number, _options?: unknown): void {
      const lines = Array.isArray(textArg) ? textArg : [String(textArg)];
      for (const line of lines) {
        this.texts.push({ text: String(line), x, y });
      }
    }

    link(..._args: unknown[]): void {}

    addImage(..._args: unknown[]): void {}

    getImageProperties(_data: string): { width: number; height: number } {
      return { width: 100, height: 100 };
    }

    addPage(): void {
      this.pages += 1;
    }

    setPage(_page: number): void {}

    getNumberOfPages(): number {
      return this.pages;
    }

    save(filename: string): void {
      this.savedFilename = filename;
      this.savedOutput = JSON.stringify({
        filename,
        pages: this.pages,
        texts: this.texts,
      });
    }

    output(): string {
      return this.savedOutput;
    }
  }

  return { jsPDF: FakeJsPDF };
});

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: async () => 'data:image/png;base64,FAKEQRDATA',
  },
}));

import { exportWorkflowAsPDF } from '../workflow-pdf-export';
import type { WorkflowPDFData, WorkflowPDFStep } from '../workflow-pdf-export';

const BOILERPLATE =
  "The primary objective of this mission is to advance SEDS Pakistan's core objectives";

/** Single-token marker, short enough that the fake's word-wrap (29 chars/line at 11.5pt) cannot split it. */
const MARKER = 'MSG46-PARENT-MARKER-7F3A9';

function lastDoc(): FakePdfDoc {
  const docs = fakeDocRegistry();
  const doc = docs[docs.length - 1];
  if (!doc) throw new Error('No PDF was generated');
  return doc;
}

function allText(doc: FakePdfDoc): string {
  // The fake wraps long prose across lines; normalizing whitespace
  // rejoins wrapped lines into the original sentences for substring
  // assertions (wrapping only ever breaks at spaces).
  return doc.texts.map((t) => t.text).join('\n').replace(/\s+/g, ' ');
}

function baseStep(overrides: Partial<WorkflowPDFStep> = {}): WorkflowPDFStep {
  return {
    id: 'step-1',
    title: 'Intent Step',
    description: 'A step used to exercise the parent description.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: 'Primary Person',
    ...overrides,
  };
}

function baseWorkflow(overrides: Partial<WorkflowPDFData> = {}): WorkflowPDFData {
  return {
    id: 'wf-msg46-001',
    title: 'Parent Description Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    steps: [baseStep()],
    ...overrides,
  };
}

async function runExport(workflow: WorkflowPDFData): Promise<FakePdfDoc> {
  await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: true });
  return lastDoc();
}

beforeEach(() => {
  fakeDocRegistry().length = 0;
});

describe('MSG46 workflow PDF prints the parent description', () => {
  test('real description renders under OPERATIONAL INTENT and the boilerplate is absent', async () => {
    const description = `Review criteria and verdict format for this mission. ${MARKER} Every verdict must cite evidence.`;
    const doc = await runExport(baseWorkflow({ description }));
    const text = allText(doc);
    expect(doc.savedFilename).toBeTruthy();
    expect(text).toContain(MARKER);
    expect(text).not.toContain(BOILERPLATE);
    // Order: heading, then the description, then the next section.
    const lines = doc.texts.map((t) => t.text);
    const intentIdx = lines.indexOf('OPERATIONAL INTENT');
    const markerIdx = lines.findIndex((l) => l.includes(MARKER));
    const commanderIdx = lines.indexOf("COMMANDER'S DIRECTIVE");
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(intentIdx);
    expect(commanderIdx).toBeGreaterThan(markerIdx);
  });

  test('no description anywhere still falls back to the boilerplate', async () => {
    const doc = await runExport(baseWorkflow({ description: undefined }));
    expect(allText(doc)).toContain(BOILERPLATE);
  });

  test('empty-string description still falls back to the boilerplate', async () => {
    const doc = await runExport(baseWorkflow({ description: '' }));
    expect(allText(doc)).toContain(BOILERPLATE);
  });

  test('a URL inside the description is printed in the intent text', async () => {
    // Short URL on purpose: the fake wraps at 29 chars/line at 11.5pt,
    // so a long URL would be hard-split by the fake (not a production
    // behavior — real jsPDF fits ~85 chars/line here). The long-URL
    // geometry and clickability case lives in the geometry suite.
    const url = 'https://sedspakistan.live/x';
    const doc = await runExport(
      baseWorkflow({ description: `See the full plan at ${url} before starting. ${MARKER}` }),
    );
    const text = allText(doc);
    expect(text).toContain(url);
    expect(text).toContain(MARKER);
  });
});
