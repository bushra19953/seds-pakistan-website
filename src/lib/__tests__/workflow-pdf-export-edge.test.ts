/**
 * Edge-case tests for workflow PDF export.
 *
 * The exporter builds its own jsPDF instance and ends with doc.save(), so
 * these tests mock 'jspdf' with a recording fake: every text call, image
 * call, page break, and save call is captured, and assertions run against
 * the SAVED output snapshot. 'qrcode' is mocked to a fixed data URL so no
 * real QR encoding runs. No geometry helper is exported from the source
 * module, so overflow cases assert successful generation per the spec.
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

    addImage(format: string, x: number, y: number, w: number, h: number): void {
      this.images.push({ format: String(format), x, y, w, h });
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

import { exportWorkflowAsPDF } from '../workflow-pdf-export';
import type { WorkflowPDFData, WorkflowPDFStep } from '../workflow-pdf-export';

function lastDoc(): FakePdfDoc {
  const docs = fakeDocRegistry();
  const doc = docs[docs.length - 1];
  if (!doc) throw new Error('No PDF was generated');
  return doc;
}

function allText(doc: FakePdfDoc): string {
  return doc.texts.map((t) => t.text).join('\n');
}

function baseStep(overrides: Partial<WorkflowPDFStep> = {}): WorkflowPDFStep {
  return {
    id: 'step-1',
    title: 'Edge Step',
    description: 'A step used to exercise PDF edge cases.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: 'Primary Person',
    ...overrides,
  };
}

function baseWorkflow(overrides: Partial<WorkflowPDFData> = {}): WorkflowPDFData {
  return {
    id: 'wf-edge-001',
    title: 'Edge Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    steps: [baseStep()],
    ...overrides,
  };
}

async function runExport(
  workflow: WorkflowPDFData,
  options?: { hideQrCodes?: boolean; hideAssetInventory?: boolean },
): Promise<FakePdfDoc> {
  await exportWorkflowAsPDF(workflow, undefined, options);
  return lastDoc();
}

beforeEach(() => {
  fakeDocRegistry().length = 0;
});

describe('workflow PDF export edge cases', () => {
  test('1. assigneeName that is an email address renders as Pending Assignment, not the email', async () => {
    const emailName = 'someone@example.com';
    const doc = await runExport(
      baseWorkflow({
        steps: [baseStep({ assigneeName: emailName, assigneeEmail: undefined, assigneeWhatsapp: undefined })],
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(allText(doc)).toContain('Pending Assignment');
    expect(doc.savedOutput).not.toContain(emailName);
  });

  test('2. assigneeWhatsapp with spaces and dashes generates a PDF without crashing', async () => {
    const doc = await runExport(
      baseWorkflow({
        steps: [baseStep({ assigneeWhatsapp: '+92 321 123-4567' })],
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(allText(doc)).toContain('+92 321 123-4567');
  });

  test('3. assigneeEmail of 60+ chars generates a PDF', async () => {
    const longEmail = `${'a'.repeat(50)}@example.com`;
    expect(longEmail.length).toBeGreaterThanOrEqual(60);
    const doc = await runExport(
      baseWorkflow({
        steps: [baseStep({ assigneeEmail: longEmail })],
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(doc.savedOutput).toContain(longEmail);
  });

  test('4. step.role of 120+ chars generates a PDF without crashing', async () => {
    const longRole = `Lead ${'Responsibility '.repeat(10)}Owner`.slice(0, 130);
    expect(longRole.length).toBeGreaterThanOrEqual(120);
    const doc = await runExport(
      baseWorkflow({
        steps: [baseStep({ role: longRole })],
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(doc.savedOutput).toContain('Responsibility:');
  });

  test('5. fellow assignee with a 50-char name generates a PDF and the name is present', async () => {
    const fellowName = `Fellow ${'A'.repeat(43)}`;
    expect(fellowName.length).toBe(50);
    const doc = await runExport(
      baseWorkflow({
        steps: [
          baseStep({
            assignees: [
              { id: 'user-primary', name: 'Primary Person' },
              { id: 'user-fellow-1', name: fellowName },
            ],
          }),
        ],
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(doc.savedOutput).toContain(fellowName);
  });

  test('6. resource with empty title and empty url generates a PDF without crashing', async () => {
    const doc = await runExport(
      baseWorkflow({
        steps: [baseStep({ resources: [{ title: '', url: '', type: 'link' }] })],
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(allText(doc)).toContain('MISSION ASSETS:');
  });

  test('7. resource with a 200-char URL generates a PDF without crashing', async () => {
    const longUrl = `https://example.com/docs/${'a'.repeat(175)}`;
    expect(longUrl.length).toBe(200);
    const doc = await runExport(
      baseWorkflow({
        steps: [baseStep({ resources: [{ title: 'Long link', url: longUrl, type: 'link' }] })],
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(doc.savedOutput).toContain('example.com');
  });

  test('8. commanderStatement of 600 chars generates a PDF without crashing', async () => {
    const statement = 'D'.repeat(600);
    const doc = await runExport(baseWorkflow({ commanderStatement: statement }));
    expect(doc.savedFilename).toBeTruthy();
    expect(allText(doc)).toContain('COMMANDER');
  });

  test('9. workflow.title of 150 chars generates a PDF without crashing', async () => {
    const title = 'T'.repeat(150);
    const doc = await runExport(baseWorkflow({ title }));
    expect(doc.savedFilename).toBeTruthy();
    expect(doc.savedOutput).toContain('TTTT');
  });

  test('10. hideQrCodes with 5 assignees adds no QR images and does not crash', async () => {
    const doc = await runExport(
      baseWorkflow({
        steps: [
          baseStep({
            assignees: [
              { id: 'user-primary', name: 'Primary Person' },
              { id: 'user-2', name: 'Second Person' },
              { id: 'user-3', name: 'Third Person' },
              { id: 'user-4', name: 'Fourth Person' },
              { id: 'user-5', name: 'Fifth Person' },
            ],
          }),
        ],
      }),
      { hideQrCodes: true },
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(doc.images).toHaveLength(0);
    expect(allText(doc)).not.toContain('SCAN TO VIEW LIVE MISSION STATUS');
  });

  test('11. hideAssetInventory generates a PDF without crashing', async () => {
    const doc = await runExport(baseWorkflow(), { hideAssetInventory: true });
    expect(doc.savedFilename).toBeTruthy();
    expect(allText(doc)).not.toContain('MISSION ASSET INVENTORY');
  });

  test('12. appendix text of 2000 chars produces more than 2 pages without crashing', async () => {
    const appendixText = 'A'.repeat(2000);
    const doc = await runExport(
      baseWorkflow({
        steps: [],
        totalSteps: 0,
        appendixTitle: 'APPENDIX: EDGE',
        appendixText,
      }),
    );
    expect(doc.savedFilename).toBeTruthy();
    expect(doc.pages).toBeGreaterThan(2);
    expect(allText(doc)).toContain('APPENDIX: EDGE');
  });
});
