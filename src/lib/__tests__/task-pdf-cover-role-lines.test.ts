/**
 * Task PDF personnel + cover-label tests for the workflow exporter.
 *
 * Regression coverage for the standalone-task PDF bugs:
 *  - raw role keys (e.g. 'vice_president', legacy 'chair_design')
 *    must render as canonical role title lines on primary AND fellow
 *    personnel rows (via canonicalRoleTitle, same as workflow PDFs);
 *  - documentKind: 'task' must draw "TASK ID" on the cover stat box instead
 *    of "WORKFLOW ID" (task PDFs show a task doc id).
 *
 * Uses the same recording-fake approach as workflow-pdf-export-edge.test.ts:
 * jspdf is mocked, every text call is captured, assertions run against the
 * recorded text.
 */

type RecordedText = { text: string; x: number; y: number };
type RecordedImage = { format: string; x: number; y: number; w: number; h: number };

type FakePdfDoc = {
  texts: RecordedText[];
  images: RecordedImage[];
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
    images: RecordedImage[] = [];
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

    addImage(dataUrl: string, _format: string, x: number, y: number, w: number, h: number): void {
      this.images.push({ format: String(dataUrl), x, y, w, h });
    }

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
        images: this.images,
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

import { exportWorkflowAsPDF, type WorkflowPDFData, type WorkflowPDFStep } from '../workflow-pdf-export';
import type { WorkflowPDFExportOptions } from '../workflow-pdf-export';

function lastDoc(): FakePdfDoc {
  const docs = fakeDocRegistry();
  const doc = docs[docs.length - 1];
  if (!doc) throw new Error('No PDF was generated');
  return doc;
}

function allText(doc: FakePdfDoc): string {
  return doc.texts.map((t) => t.text).join('\n');
}

function roleLinesWorkflow(): WorkflowPDFData {
  const step: WorkflowPDFStep = {
    id: 'step-1',
    title: 'Poster Blitz',
    description: 'Mount the induction posters.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: 'Primary Person',
    // Raw role keys as passed by handleExportTaskPDF: canonicalization
    // happens inside the exporter.
    assigneeRole: 'vice_president',
    assigneeChapter: 'SEDS IST',
    assigneeEmail: 'primary@example.com',
    assigneeWhatsapp: '+923001234567',
    assignees: [
      { id: 'user-primary', name: 'Primary Person', role: 'vice_president', chapterName: 'SEDS IST' },
      { id: 'user-fellow', name: 'Fellow Person', role: 'chair_design', chapterName: 'SEDS IST' },
    ],
  };
  return {
    id: 'task-abc-123',
    title: 'Poster Blitz Task',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    steps: [step],
  };
}

async function runExport(
  workflow: WorkflowPDFData,
  options?: WorkflowPDFExportOptions,
): Promise<FakePdfDoc> {
  await exportWorkflowAsPDF(workflow, undefined, options);
  return lastDoc();
}

beforeEach(() => {
  fakeDocRegistry().length = 0;
});

describe('task PDF cover label', () => {
  test("documentKind 'task' draws TASK ID on the cover stat box", async () => {
    const doc = await runExport(roleLinesWorkflow(), { documentKind: 'task' });
    const text = allText(doc);
    expect(text).toContain('TASK ID');
    expect(text).not.toContain('WORKFLOW ID');
  });

  test("default (no documentKind) draws WORKFLOW ID", async () => {
    const doc = await runExport(roleLinesWorkflow());
    const text = allText(doc);
    expect(text).toContain('WORKFLOW ID');
    expect(text).not.toContain('TASK ID');
  });

  test("documentKind 'workflow' draws WORKFLOW ID", async () => {
    const doc = await runExport(roleLinesWorkflow(), { documentKind: 'workflow' });
    const text = allText(doc);
    expect(text).toContain('WORKFLOW ID');
    expect(text).not.toContain('TASK ID');
  });
});

describe('task PDF personnel role + chapter lines', () => {
  test('primary row renders canonical role title and chapter from raw role keys', async () => {
    const doc = await runExport(roleLinesWorkflow(), { documentKind: 'task' });
    const text = allText(doc);
    expect(text).toContain('Primary Person');
    expect(text).toContain('National Vice President');
    expect(text).toContain('SEDS IST');
  });

  test('fellow row renders canonical title for a legacy role key plus chapter', async () => {
    const doc = await runExport(roleLinesWorkflow(), { documentKind: 'task' });
    const text = allText(doc);
    expect(text).toContain('Fellow Person');
    // Legacy key 'chair_design' resolves to the catalog title (Phase 1
    // taxonomy). The 30-char title wraps in the row, so the extracted text
    // carries it as two lines.
    expect(text).toContain('Chapter Design and Media');
    expect(text).toContain('Chair');
    expect(text).toContain('SEDS IST');
  });

  test('missing role never renders a Guest line', async () => {
    const workflow = roleLinesWorkflow();
    workflow.steps[0].assignees = [
      { id: 'user-primary', name: 'Primary Person', chapterName: 'SEDS IST' },
      { id: 'user-fellow', name: 'Fellow Person' },
    ];
    workflow.steps[0].assigneeRole = undefined;
    const doc = await runExport(workflow, { documentKind: 'task' });
    const text = allText(doc);
    expect(text).not.toMatch(/(^|\n)Guest(\n|$)/);
  });
});
