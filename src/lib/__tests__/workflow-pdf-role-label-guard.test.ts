/**
 * Regression test for the 2026-11-07 role-grant PDF defect: the
 * exported mission PDF printed "Marketing Deputy - Social Media
 * (custom)" under a step primary who never held that grant. The
 * custom slug belongs to a different person; the platform record was
 * clean. The step-level role field fed to the exporter carried the
 * wrong person's slug while each person's OWN assignees[] entry was
 * correct.
 *
 * Two guards now stand between that payload and print:
 *  (b) the missions-tab assembly cross-checks the step-level
 *      assigneeDisplayRole against the step's own assignees[] entry
 *      for the same uid and drops it on disagreement (mirrored in
 *      `assembleChecked` below, same mirror pattern as
 *      workflow-pdf-custom-role-label.test.ts);
 *  (c) the exporter itself prints a "(custom)" label for the primary
 *      only when the primary's own assignees[] entry carries the same
 *      slug (exercised directly with the misaligned payload).
 *
 * Uses the same recording-fake approach as
 * workflow-pdf-custom-role-label.test.ts: jspdf is mocked, every
 * text call is captured, assertions run against the recorded text.
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

// The incident's real slugs/titles: the custom grant belongs to the
// fellow (uid-emaan); the primary (uid-ahmed) holds only the primary
// catalog role.
const CUSTOM_SLUG = 'custom_marketing_deputy_social_media';
const CUSTOM_LABEL = 'Marketing Deputy - Social Media (custom)';
const PRIMARY_ROLE = 'chapter_vice_president';
const PRIMARY_TITLE = 'Chapter Vice President';

const ROLE_TITLES: Record<string, string> = {
  [CUSTOM_SLUG]: 'Marketing Deputy - Social Media',
};

function lastDoc(): FakePdfDoc {
  const docs = fakeDocRegistry();
  const doc = docs[docs.length - 1];
  if (!doc) throw new Error('No PDF was generated');
  return doc;
}

function flatText(doc: FakePdfDoc): string {
  return doc.texts.map((t) => t.text).join('\n').replace(/\s+/g, ' ');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function workflowWith(step: WorkflowPDFStep): WorkflowPDFData {
  return {
    id: 'wf-role-grant',
    title: 'Audit, Provision & Grant Platform RBAC Roles',
    progressPercentage: 0,
    totalSteps: 1,
    completedSteps: 0,
    isCompleted: false,
    steps: [step],
  };
}

async function runExport(data: WorkflowPDFData, roleTitles?: Record<string, string>): Promise<FakePdfDoc> {
  await exportWorkflowAsPDF(data, undefined, { hideQrCodes: true, roleTitles });
  return lastDoc();
}

beforeEach(() => {
  fakeDocRegistry().length = 0;
});

describe('PDF role-label guard: a stale step-level displayRole cannot relabel the primary', () => {
  test('misaligned payload: the custom label prints once, for its real holder only', async () => {
    // Exactly what the pre-guard assembly produced from the stale
    // response: the step-level role for Ahmed's step carries Emaan's
    // custom slug, while Ahmed's OWN assignees entry carries his real
    // primary role and Emaan's own entry carries the slug.
    const doc = await runExport(
      workflowWith({
        id: 'step-1',
        title: 'Audit and lock the confirmed officer set',
        description: 'Verify the officer rows.',
        status: 'pending',
        assigneeId: 'uid-ahmed',
        assigneeName: 'Ahmed Ali',
        assigneeRole: CUSTOM_SLUG,
        assignees: [
          { id: 'uid-ahmed', name: 'Ahmed Ali', role: PRIMARY_ROLE },
          { id: 'uid-emaan', name: 'Emaan Yasir', role: CUSTOM_SLUG },
        ],
      }),
      ROLE_TITLES,
    );
    const flat = flatText(doc);
    // Each person prints their OWN label, in row order: the primary's
    // own title after his name, the custom label after the fellow's.
    expect(occurrences(flat, CUSTOM_LABEL)).toBe(1);
    expect(flat).toContain(PRIMARY_TITLE);
    const ahmedAt = flat.indexOf('Ahmed Ali');
    const vpAt = flat.indexOf(PRIMARY_TITLE);
    const emaanAt = flat.indexOf('Emaan Yasir');
    const customAt = flat.indexOf(CUSTOM_LABEL);
    expect(ahmedAt).toBeGreaterThanOrEqual(0);
    expect(vpAt).toBeGreaterThan(ahmedAt);
    expect(emaanAt).toBeGreaterThan(vpAt);
    expect(customAt).toBeGreaterThan(emaanAt);
  });

  test('misaligned payload with no other holder: the custom label never prints', async () => {
    const doc = await runExport(
      workflowWith({
        id: 'step-1',
        title: 'Final RBAC audit',
        description: 'Close the audit.',
        status: 'pending',
        assigneeId: 'uid-ahmed',
        assigneeName: 'Ahmed Ali',
        assigneeRole: CUSTOM_SLUG,
        assignees: [{ id: 'uid-ahmed', name: 'Ahmed Ali', role: PRIMARY_ROLE }],
      }),
      ROLE_TITLES,
    );
    const flat = flatText(doc);
    expect(occurrences(flat, CUSTOM_LABEL)).toBe(0);
    expect(flat).toContain(PRIMARY_TITLE);
  });

  test('corroborated custom primary still prints the custom label (MSG47 behaviour kept)', async () => {
    const doc = await runExport(
      workflowWith({
        id: 'step-1',
        title: 'Provision the discipline leads',
        description: 'Grant the ratified leads.',
        status: 'pending',
        assigneeId: 'uid-emaan',
        assigneeName: 'Emaan Yasir',
        assigneeRole: CUSTOM_SLUG,
        assignees: [{ id: 'uid-emaan', name: 'Emaan Yasir', role: CUSTOM_SLUG }],
      }),
      ROLE_TITLES,
    );
    const flat = flatText(doc);
    expect(occurrences(flat, CUSTOM_LABEL)).toBe(1);
    expect(flat).not.toContain(PRIMARY_TITLE);
  });
});

/**
 * Mirror of missions-tab.tsx handleExportPDF AFTER the cross-check
 * fix: the step-level assigneeDisplayRole is fed to the exporter only
 * when the step's own assignees[] entry for the same uid carries the
 * same displayRole; on disagreement it is dropped and the primary
 * role is fed instead. roleTitles is built from the surviving custom
 * slugs, as in the component.
 */
function assembleChecked(apiStep: {
  assigneeId: string;
  assigneeName: string;
  assigneeRole?: string;
  assigneeDisplayRole?: string;
  assignees: Array<{ id: string; name: string; role?: string | null; displayRole?: string | null }>;
}): { data: WorkflowPDFData; roleTitles?: Record<string, string> } {
  const own = apiStep.assignees.find((a) => a.id === apiStep.assigneeId);
  const effectiveRole =
    apiStep.assigneeDisplayRole && own?.displayRole === apiStep.assigneeDisplayRole
      ? apiStep.assigneeDisplayRole
      : apiStep.assigneeRole;
  const step: WorkflowPDFStep = {
    id: 'step-1',
    title: 'Audit and lock the confirmed officer set',
    description: 'Verify the officer rows.',
    status: 'pending',
    assigneeId: apiStep.assigneeId,
    assigneeName: apiStep.assigneeName,
    assigneeRole: effectiveRole,
    assignees: apiStep.assignees.map((a) => ({
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
      if (ROLE_TITLES[slug]) map[slug] = ROLE_TITLES[slug];
    }
    if (Object.keys(map).length > 0) roleTitles = map;
  }
  return { data: workflowWith(step), roleTitles };
}

describe('missions-tab cross-check (assembly mirror): a disagreeing displayRole is dropped before export', () => {
  test('step-level slug contradicted by the primary own entry: primary title prints', async () => {
    const assembled = assembleChecked({
      assigneeId: 'uid-ahmed',
      assigneeName: 'Ahmed Ali',
      assigneeRole: PRIMARY_ROLE,
      // The stale step-level field: another person's slug.
      assigneeDisplayRole: CUSTOM_SLUG,
      assignees: [
        { id: 'uid-ahmed', name: 'Ahmed Ali', role: PRIMARY_ROLE },
        { id: 'uid-emaan', name: 'Emaan Yasir', role: 'member_basic', displayRole: CUSTOM_SLUG },
      ],
    });
    // The cross-check drops the step-level slug from the feed...
    expect(assembled.data.steps[0].assigneeRole).toBe(PRIMARY_ROLE);
    const doc = await runExport(assembled.data, assembled.roleTitles);
    const flat = flatText(doc);
    // ...and in print the custom label belongs to its holder alone.
    expect(occurrences(flat, CUSTOM_LABEL)).toBe(1);
    expect(flat).toContain(PRIMARY_TITLE);
  });

  test('step-level slug confirmed by the primary own entry: custom label prints for the primary', async () => {
    const assembled = assembleChecked({
      assigneeId: 'uid-emaan',
      assigneeName: 'Emaan Yasir',
      assigneeRole: 'chapter_recruitment_chair',
      assigneeDisplayRole: CUSTOM_SLUG,
      assignees: [
        { id: 'uid-emaan', name: 'Emaan Yasir', role: 'chapter_recruitment_chair', displayRole: CUSTOM_SLUG },
      ],
    });
    expect(assembled.data.steps[0].assigneeRole).toBe(CUSTOM_SLUG);
    const doc = await runExport(assembled.data, assembled.roleTitles);
    expect(occurrences(flatText(doc), CUSTOM_LABEL)).toBe(1);
  });
});
