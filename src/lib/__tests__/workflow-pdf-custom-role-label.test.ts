/**
 * MSG47: the workflow mission PDF printed "Basic Member" for
 * custom-role holders. The exporter itself already resolved a custom
 * slug to its definition title when the caller supplied roleTitles —
 * but the role fed in was the PRIMARY role only (users doc), because
 * GET /api/workflows detail never read roles/{uid}.additionalRoles.
 * The fix adds `displayRole` (first held custom grant, else absent)
 * to the detail response, and both PDF callers feed the effective
 * role (displayRole first, else the primary) to the exporter.
 *
 * These tests prove the assembled chain end to end: the assembly
 * mirror below applies the callers' rule (displayRole || role) and
 * builds roleTitles from the collected custom slugs, exactly as
 * missions-tab.tsx handleExportPDF does. A custom-grant holder
 * prints the custom title, a standard holder prints the standard
 * title, and a true basic member still prints Basic Member.
 *
 * Uses the same recording-fake approach as
 * workflow-pdf-export-edge.test.ts / task-pdf-cover-role-lines.test.ts:
 * jspdf is mocked, every text call is captured, assertions run against
 * the recorded text.
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
import { isCustomRoleSlug } from '../custom-roles';

const CUSTOM_SLUG = 'custom_president_s_executive_apprentice';
const CUSTOM_NAME = "President's Executive Apprentice";

// Fake custom-role registry: the definition `name` for the slug, as
// getCustomRoleDefinitions would return it to the callers.
const DEFINITIONS: Record<string, string> = {
  [CUSTOM_SLUG]: CUSTOM_NAME,
};

function lastDoc(): FakePdfDoc {
  const docs = fakeDocRegistry();
  const doc = docs[docs.length - 1];
  if (!doc) throw new Error('No PDF was generated');
  return doc;
}

function allText(doc: FakePdfDoc): string {
  return doc.texts.map((t) => t.text).join('\n');
}

/**
 * Mirror of the callers' assembly (missions-tab.tsx handleExportPDF /
 * tasks/page.tsx handleExportTaskPDF) AFTER the MSG47 fix: the
 * effective role fed to the exporter is displayRole first, else the
 * primary role, and roleTitles is built from the custom slugs the
 * effective roles carry. The `displayRole` fields below are the
 * detail API's new fields, fed in exactly as the response carries
 * them.
 */
function assemble(
  apiStep: {
    assigneeRole?: string;
    assigneeDisplayRole?: string;
    assigneeName: string;
    assignees?: Array<{ id: string; name: string; role?: string | null; displayRole?: string | null }>;
  },
): { data: WorkflowPDFData; roleTitles?: Record<string, string> } {
  const step: WorkflowPDFStep = {
    id: 'step-1',
    title: 'Crucible Quality Review',
    description: 'Review the mission evidence.',
    status: 'pending',
    assigneeId: 'user-primary',
    assigneeName: apiStep.assigneeName,
    assigneeRole: apiStep.assigneeDisplayRole || apiStep.assigneeRole,
    assignees: (apiStep.assignees || []).map((a) => ({
      id: a.id,
      name: a.name,
      role: a.displayRole || a.role || undefined,
    })),
  };
  const customSlugs = new Set<string>();
  if (step.assigneeRole && isCustomRoleSlug(step.assigneeRole)) customSlugs.add(step.assigneeRole);
  for (const a of step.assignees || []) {
    if (a.role && isCustomRoleSlug(a.role)) customSlugs.add(a.role);
  }
  let roleTitles: Record<string, string> | undefined;
  if (customSlugs.size > 0) {
    const map: Record<string, string> = {};
    for (const slug of customSlugs) {
      if (DEFINITIONS[slug]) map[slug] = DEFINITIONS[slug];
    }
    if (Object.keys(map).length > 0) roleTitles = map;
  }
  return {
    data: {
      id: 'wf-47',
      title: 'Crucible Quality Review and Elevation',
      progressPercentage: 0,
      totalSteps: 1,
      completedSteps: 0,
      isCompleted: false,
      steps: [step],
    },
    roleTitles,
  };
}

async function runExport(assembled: { data: WorkflowPDFData; roleTitles?: Record<string, string> }): Promise<FakePdfDoc> {
  await exportWorkflowAsPDF(assembled.data, undefined, { hideQrCodes: true, roleTitles: assembled.roleTitles });
  return lastDoc();
}

beforeEach(() => {
  fakeDocRegistry().length = 0;
});

describe('MSG47 PDF personnel role labels for custom-grant holders', () => {
  test('a custom-grant holder as primary prints the custom title, never Basic Member', async () => {
    const doc = await runExport(
      assemble({
        assigneeName: 'Atika Saroosh',
        assigneeRole: 'member_basic',
        assigneeDisplayRole: CUSTOM_SLUG,
        assignees: [
          { id: 'user-primary', name: 'Atika Saroosh', role: 'member_basic', displayRole: CUSTOM_SLUG },
        ],
      }),
    );
    const flat = allText(doc).replace(/\s+/g, ' ');
    expect(flat).toContain(`${CUSTOM_NAME} (custom)`);
    expect(allText(doc).replace(/\s+/g, '')).not.toContain(CUSTOM_SLUG);
    expect(allText(doc)).not.toContain('Basic Member');
  });

  test('a custom-grant holder as fellow prints the custom title, never Basic Member', async () => {
    const doc = await runExport(
      assemble({
        assigneeName: 'Ahmed Kamran',
        assigneeRole: 'chapter_events_chair',
        assignees: [
          { id: 'user-primary', name: 'Ahmed Kamran', role: 'chapter_events_chair' },
          { id: 'user-custom', name: 'Atika Saroosh', role: 'member_basic', displayRole: CUSTOM_SLUG },
        ],
      }),
    );
    const flat = allText(doc).replace(/\s+/g, ' ');
    expect(flat).toContain(`${CUSTOM_NAME} (custom)`);
    expect(allText(doc)).not.toContain('Basic Member');
    expect(flat).toContain('Chapter Events Chair');
  });

  test('a standard role holder prints the standard title', async () => {
    const doc = await runExport(
      assemble({
        assigneeName: 'Ahmed Kamran',
        assigneeRole: 'chapter_events_chair',
        assignees: [{ id: 'user-primary', name: 'Ahmed Kamran', role: 'chapter_events_chair' }],
      }),
    );
    const flat = allText(doc).replace(/\s+/g, ' ');
    expect(flat).toContain('Chapter Events Chair');
    expect(allText(doc)).not.toContain('Basic Member');
  });

  test('a true basic member still prints Basic Member', async () => {
    const doc = await runExport(
      assemble({
        assigneeName: 'Bilal Ahmed',
        assigneeRole: 'member_basic',
        assignees: [{ id: 'user-primary', name: 'Bilal Ahmed', role: 'member_basic' }],
      }),
    );
    expect(allText(doc)).toContain('Basic Member');
  });

  test('fall-through guard: without the displayRole preference the same holder prints Basic Member (the bug)', async () => {
    // The OLD assembly fed the primary role only, so the custom slug
    // never entered roleTitles and the exporter fell back to the
    // primary's title. This pins the mechanism the fix removes; it
    // passes before and after, and proves the first test is sensitive
    // to the assembly, not just to the exporter.
    const data: WorkflowPDFData = {
      id: 'wf-47',
      title: 'Crucible Quality Review and Elevation',
      progressPercentage: 0,
      totalSteps: 1,
      completedSteps: 0,
      isCompleted: false,
      steps: [
        {
          id: 'step-1',
          title: 'Crucible Quality Review',
          description: 'Review the mission evidence.',
          status: 'pending',
          assigneeId: 'user-primary',
          assigneeName: 'Atika Saroosh',
          assigneeRole: 'member_basic',
          assignees: [{ id: 'user-primary', name: 'Atika Saroosh', role: 'member_basic' }],
        },
      ],
    };
    await exportWorkflowAsPDF(data, undefined, { hideQrCodes: true });
    expect(allText(lastDoc())).toContain('Basic Member');
  });
});
