/**
 * Fellow-assignee personnel block tests for workflow PDF export.
 *
 * Regression tests for the "bare names" bug: in standalone task PDFs the
 * second+ assignees used to render as a bare name with no phone, email or
 * photo, because the adapter and the fellow-row builder dropped those
 * fields. Every fellow now renders a full block (name, role, chapter,
 * phone, email, avatar, their own QR) exactly like the primary.
 *
 * Uses the same recording-fake approach as workflow-pdf-export-edge.test.ts.
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

    discardPath(): void {}

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
    title: 'Poster Blitz',
    description: 'Mount the induction posters.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: 'Primary Person',
    assigneeRole: 'President',
    assigneeChapter: 'SEDS IST',
    assigneeEmail: 'primary@example.com',
    assigneeWhatsapp: '+923001234567',
    assigneePhoto: 'base64-primary-photo',
    ...overrides,
  };
}

function baseWorkflow(overrides: Partial<WorkflowPDFData> = {}): WorkflowPDFData {
  return {
    id: 'wf-fellow-001',
    title: 'Fellow Rows Workflow',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    steps: [baseStep()],
    ...overrides,
  };
}

/** Two fellows with full contact details and photos. */
function fellowsStep(): WorkflowPDFStep {
  return baseStep({
    assignees: [
      // Primary is listed first in step.assignees but filtered out of the
      // fellow rows by assigneeId match; still include it for realism.
      {
        id: 'user-primary',
        name: 'Primary Person',
        role: 'President',
        chapterName: 'SEDS IST',
        email: 'primary@example.com',
        whatsapp: '+923001234567',
        photoBase64: 'base64-primary-photo',
      },
      {
        id: 'user-co1',
        name: 'Co Assignee One',
        role: 'VP',
        chapterName: 'SEDS IST',
        email: 'co1@example.com',
        whatsapp: '+923007654321',
        photoBase64: 'base64-co1-photo',
      },
      {
        id: 'user-co2',
        name: 'Co Assignee Two',
        role: 'Member',
        chapterName: 'SEDS Lahore',
        email: 'co2@example.com',
        whatsapp: '+923009998877',
      },
    ],
  });
}

async function runExport(workflow: WorkflowPDFData): Promise<FakePdfDoc> {
  await exportWorkflowAsPDF(workflow, undefined, { hideQrCodes: true });
  return lastDoc();
}

beforeEach(() => {
  fakeDocRegistry().length = 0;
});

describe('workflow PDF fellow personnel rows', () => {
  test('fellows with whatsapp/email render full contact blocks, never bare names', async () => {
    const doc = await runExport(baseWorkflow({ steps: [fellowsStep()] }));
    expect(doc.savedFilename).toBeTruthy();
    const text = allText(doc);

    // Every fellow renders name, role, chapter, phone and email.
    expect(text).toContain('Co Assignee One');
    expect(text).toContain('VP');
    expect(text).toContain('SEDS IST');
    expect(text).toContain('+923007654321');
    expect(text).toContain('co1@example.com');

    expect(text).toContain('Co Assignee Two');
    expect(text).toContain('Member');
    expect(text).toContain('SEDS Lahore');
    expect(text).toContain('+923009998877');
    expect(text).toContain('co2@example.com');

    // Primary still renders its own full block.
    expect(text).toContain('Primary Person');
    expect(text).toContain('+923001234567');
    expect(text).toContain('primary@example.com');
  });

  test('fellows with photos get avatars; a fellow without a photo gets none', async () => {
    const doc = await runExport(baseWorkflow({ steps: [fellowsStep()] }));
    // 16x16 draws are circular avatars; no other images render when QR
    // codes are hidden and no logo is passed.
    const avatars = doc.images.filter((img) => img.w === 16 && img.h === 16);
    // Primary + Co Assignee One (both have photos); Co Assignee Two has none.
    expect(avatars).toHaveLength(2);
  });

  test('phone/email segments render for fellows even when primary has none', async () => {
    const step = fellowsStep();
    step.assigneeEmail = undefined;
    step.assigneeWhatsapp = undefined;
    step.assigneePhoto = undefined;
    const doc = await runExport(baseWorkflow({ steps: [step] }));
    const text = allText(doc);
    // Primary renders without contacts; fellows still render theirs.
    expect(text).toContain('+923007654321');
    expect(text).toContain('co1@example.com');
    expect(text).not.toContain('primary@example.com');
    // Only one avatar now (Co Assignee One), the primary has no photo.
    const avatars = doc.images.filter((img) => img.w === 16 && img.h === 16);
    expect(avatars).toHaveLength(1);
  });
});
