/**
 * @jest-environment node
 *
 * (Node env because next/server needs the web Request global jsdom
 * lacks. Consequence for the QR pins: with no window, the exporter's
 * baseUrl falls back to 'https://sedspakistan.live'
 * (workflow-pdf-export.ts:366) — that fallback is what gets pinned.)
 *
 * CONTRACT 3 — workflow PDF export data (feat/supa-wf-5 surface) and the
 * workflow_members gate (feat/supa-wf-4 surface), plus CONTRACT 4
 * flag-state behavior for GET /api/workflows?workflowId=.
 *
 * The PDF exporter's data is assembled by missions-tab.tsx
 * (handleExportPDF) from this route's detail response:
 *   { ok, tasks, progress, analytics, assigneeInfo, chapterName }
 * tasks[] carry the personnel fields (assigneeName/Email/Whatsapp/
 * Chapter/Photo, assignees[]), assigneeInfo carries per-uid contact
 * fields, and workflow-pdf-export.ts turns each personnel row into a QR
 * whose payload is `${origin}/profile/unified/<uid>?task=<stepId>`
 * (cover QR: `${origin}/missions/<workflowId>`).
 *
 * This suite pins that whole chain against the CURRENT tree:
 *   Firestore-shaped docs (Timestamp objects) and jsonb-shaped docs
 *   (ISO strings) must yield byte-identical route responses, identical
 *   assembled WorkflowPDFData, and identical QR payloads captured from
 *   the REAL exportWorkflowAsPDF.
 *
 * Masking pins (current behavior, stated neutrally):
 *   - a viewer who is not admin / participant / workflow member gets
 *     tasks[].assigneeWhatsapp and assigneeEmail nulled;
 *   - assigneeInfo is returned as fetched (masking applies to the
 *     per-task singular fields only);
 *   - a workflow_members doc `${workflowId}_${uid}` alone (no task
 *     assignment) is enough to unmask — this is the wf-4 membership
 *     surface the migration must preserve.
 */

const mockState = {
  viewer: { uid: 'u1', role: 'member' } as Record<string, any>,
  tasks: [] as Array<Record<string, any>>,
  users: {} as Record<string, Record<string, any>>,
  chapters: {} as Record<string, Record<string, any>>,
  roles: {} as Record<string, Record<string, any>>,
  workflowMembers: {} as Record<string, Record<string, any>>,
};

const mockQrPayloads: string[] = [];
jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn(async (payload: string) => {
      mockQrPayloads.push(payload);
      return 'data:image/png;base64,iVBORw0KGgo=';
    }),
  },
}));

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
      (this as any).save = () => undefined;
    }
  }
  return { ...Actual, jsPDF: CapturingJsPDF };
});

function storeFor(name: string): Record<string, any> {
  switch (name) {
    case 'users': return mockState.users;
    case 'chapters': return mockState.chapters;
    case 'roles': return mockState.roles;
    case 'workflow_members': return mockState.workflowMembers;
    default: return {};
  }
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  admin: {
    auth: () => ({
      verifyIdToken: jest.fn(async () => ({ ...mockState.viewer })),
    }),
  },
  getDb: jest.fn(() => ({
    collection: (name: string) => ({
      where: (field: string, _op: string, value: any) => ({
        get: async () => {
          const docs =
            name === 'tasks'
              ? mockState.tasks.filter((t) => t[field] === value)
              : [];
          return { empty: docs.length === 0, docs: docs.map((t) => ({ id: t.id, data: () => t })) };
        },
        orderBy: () => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
      doc: (id: string) => ({
        get: async () => {
          if (name === 'tasks') {
            const data = mockState.tasks.find((t) => t.id === id);
            return { id, exists: !!data, data: () => data };
          }
          const data = storeFor(name)[id];
          return { id, exists: !!data, data: () => data };
        },
      }),
    }),
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => false),
}));
jest.mock('@/lib/workflow-utils', () => ({
  calculateWorkflowDeadlines: jest.fn(() => []),
}));
jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn(async () => ({ isValid: true })),
}));
jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn(async () => undefined),
}));

// Real computeWorkflowProgress — canonical semantics are part of the pin.

import { GET } from '@/app/api/workflows/route';
import { NextRequest } from 'next/server';
import { exportWorkflowAsPDF } from '@/lib/workflow-pdf-export';
import type { WorkflowPDFData } from '@/lib/workflow-pdf-export';
const ORIGIN = 'https://sedspakistan.live'; // exporter fallback when window is undefined

import {
  WF_ID,
  firestoreSteps,
  firestoreUsers,
  firestoreChapters,
  jsonbSteps,
  jsonbUsers,
  jsonbChapters,
} from '@/lib/__tests__/supa-wf-fixtures';

async function getDetail() {
  const req = new NextRequest(`http://localhost/api/workflows?workflowId=${WF_ID}`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  const res = await GET(req);
  return { res, body: await res.json() };
}

function seed(shape: 'firestore' | 'jsonb') {
  mockState.tasks = shape === 'firestore' ? firestoreSteps() : jsonbSteps();
  mockState.users = shape === 'firestore' ? firestoreUsers() : jsonbUsers();
  mockState.chapters = shape === 'firestore' ? firestoreChapters() : jsonbChapters();
}

/**
 * Mirror of the WorkflowPDFData assembly in missions-tab.tsx
 * handleExportPDF (the field picks that feed the exporter), minus the
 * browser-only photo conversion (photos arrive as URLs in this suite's
 * fixtures only on user docs; processedPhoto stays undefined).
 */
function assemblePdfData(body: any): WorkflowPDFData {
  const pdfAssigneeInfo = body.assigneeInfo || {};
  return {
    id: WF_ID,
    title: 'Poster Blitz',
    progressPercentage: body.progress.progressPercentage,
    totalSteps: body.progress.totalSteps,
    completedSteps: body.progress.completedSteps,
    isCompleted: body.progress.isCompleted,
    chapterName: body.chapterName || '',
    createdAt: '2026-10-17T08:00:00.000Z',
    participants: ['Huzaifah Shujjah', 'Ahmed Kamran'],
    description: 'Strategic intent text',
    steps: (body.tasks || []).map((s: any) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      role: s.role,
      assigneeRole: s.assigneeRole,
      assigneeName: s.assigneeName,
      assigneeEmail: s.assigneeEmail,
      assigneeWhatsapp: s.assigneeWhatsapp,
      assigneeChapter: s.assigneeChapter || body.chapterName || undefined,
      assigneePhoto: undefined,
      assignees: (s.assignees || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        role: a.role || undefined,
        chapterName: a.chapterName || undefined,
        email: pdfAssigneeInfo?.[a.id]?.email || undefined,
        whatsapp: pdfAssigneeInfo?.[a.id]?.whatsapp || undefined,
        photoBase64: undefined,
      })),
      status: s.status,
      individualDeadline: s.individualDeadline,
      sequenceIndex: s.sequenceIndex,
      assigneeId: s.assigneeId,
      points: s.points,
      penaltyPoints: s.penaltyPoints,
      workflowBonusPoints: s.workflowBonusPoints,
      guidance: s.guidance,
      stepInstructions: s.stepInstructions,
      complexity: s.workflowPriority
        ? s.workflowPriority === 'critical' ? 5 : s.workflowPriority === 'high' ? 4 : s.workflowPriority === 'medium' ? 3 : 2
        : undefined,
      domain: s.workflowTags && s.workflowTags.length > 0 ? s.workflowTags[0] : undefined,
      resources: [
        ...(s.resources || []),
        ...String(s.resourceLinks || '')
          .split('\n')
          .map((l: string) => l.trim())
          .filter(Boolean)
          .map((url: string) => ({ type: 'link' as const, url, title: url })),
      ],
    })),
  };
}

const ENV_KEYS = [
  'SUPA_SURFACES', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
];
let savedEnv: Record<string, string | undefined> = {};
let baselineBodyJson = '';

beforeEach(async () => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  mockState.viewer = { uid: 'u1', role: 'member' };
  mockState.roles = { u1: { role: 'member' } };
  mockState.workflowMembers = {};
  seed('firestore');
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const { body } = await getDetail();
  baselineBodyJson = JSON.stringify(body);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

describe('contract 3: workflows GET detail — the PDF export data source', () => {
  it('returns the detail payload: tasks, progress, analytics, assigneeInfo, chapterName', async () => {
    const { res, body } = await getDetail();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      ['ok', 'tasks', 'progress', 'analytics', 'assigneeInfo', 'chapterName'].sort(),
    );
    expect(res.headers.get('cache-control')).toBe(
      'private, max-age=60, stale-while-revalidate=300',
    );
    expect(body.chapterName).toBe('SEDS IST');
    expect(body.tasks).toHaveLength(3);
    expect(body.progress).toEqual({
      workflowId: WF_ID,
      totalSteps: 3,
      completedSteps: 2, // completed + submitted-for-review (real helper)
      currentStepIndex: 1, // step2 carries isCurrentStep
      progressPercentage: 67,
      isCompleted: false,
    });
    expect(body.analytics).toEqual({
      workflowId: WF_ID,
      totalDuration: 210,
      onTimeCompletionRate: 0,
      averageStepDuration: 0,
      participantCount: 2,
      efficiencyScore: 0,
    });
  });

  it('tasks are sorted by sequenceIndex with timestamps serialized to ISO strings', async () => {
    const { body } = await getDetail();
    expect(body.tasks.map((t: any) => t.id)).toEqual(['step1', 'step2', 'step3']);
    const s1 = body.tasks[0];
    expect(s1.deadline).toBe('2026-10-20T10:00:00.000Z');
    expect(s1.individualDeadline).toBe('2026-10-19T10:00:00.000Z');
    expect(s1.completedAt).toBe('2026-10-18T09:30:00.000Z');
    expect(s1.createdAt).toBe('2026-10-17T08:00:00.000Z');
    expect(s1.updatedAt).toBe('2026-10-18T09:30:00.000Z');
    expect(s1.releasedAt).toBe('2026-10-17T08:05:00.000Z');
    expect(body.tasks[1].completedAt).toBeNull();
  });

  it('personnel fields: assignees[] shape and primary contact fields per step', async () => {
    const { body } = await getDetail();
    const s1 = body.tasks[0];
    expect(s1.assignees).toEqual([
      { id: 'u1', name: 'Huzaifah Shujjah', photoURL: 'https://example.com/u1.png', role: 'vice_president', chapterName: 'SEDS IST' },
      { id: 'u2', name: 'Ahmed Kamran', photoURL: 'https://example.com/u2.png', role: 'chapter_events_chair', chapterName: 'SEDS IST' },
    ]);
    expect(s1.assigneeName).toBe('Huzaifah Shujjah');
    expect(s1.assigneePhoto).toBe('https://example.com/u1.png');
    expect(s1.assigneePosition).toBe('National VP Operations');
    expect(s1.assigneeRole).toBe('vice_president');
    // Viewer u1 is a participant: contact fields are visible.
    expect(s1.assigneeWhatsapp).toBe('03001111111');
    expect(s1.assigneeEmail).toBe('huzaifah@example.com');
    expect(s1.assigneeChapter).toBe('SEDS IST');
    const s2 = body.tasks[1];
    expect(s2.assigneeName).toBe('Ahmed Kamran');
    expect(s2.assigneeWhatsapp).toBe('03002222222');
    expect(s2.assigneeEmail).toBe('ahmed@example.com');
  });

  it('assigneeInfo carries the full per-uid contact record the PDF assembly reads', async () => {
    const { body } = await getDetail();
    expect(body.assigneeInfo.u1).toEqual({
      name: 'Huzaifah Shujjah',
      photoURL: 'https://example.com/u1.png',
      position: 'National VP Operations',
      role: 'vice_president',
      whatsapp: '03001111111',
      email: 'huzaifah@example.com',
      chapterName: 'SEDS IST',
    });
    expect(body.assigneeInfo.u2).toEqual({
      name: 'Ahmed Kamran',
      photoURL: 'https://example.com/u2.png', // profileImageUrl fallback
      position: 'Chair Events', // title fallback
      role: 'chapter_events_chair',
      whatsapp: '03002222222',
      email: 'ahmed@example.com',
      chapterName: 'SEDS IST',
    });
  });

  it('byte-identical detail response: Firestore docs vs jsonb docs', async () => {
    seed('jsonb');
    const { res, body } = await getDetail();
    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).toBe(baselineBodyJson);
  });

  it('assembled WorkflowPDFData is identical from both data sources', async () => {
    const { body: fsBody } = await getDetail();
    seed('jsonb');
    const { body: jsonbBody } = await getDetail();
    expect(assemblePdfData(jsonbBody)).toEqual(assemblePdfData(fsBody));
    const data = assemblePdfData(fsBody);
    expect(data.steps[0]).toMatchObject({
      assigneeEmail: 'huzaifah@example.com',
      assigneeWhatsapp: '03001111111',
      complexity: 4, // workflowPriority 'high'
      domain: 'Outreach', // workflowTags[0]
      penaltyPoints: 2,
      workflowBonusPoints: 3,
    });
    expect(data.steps[0].resources).toEqual([
      { type: 'drive', url: 'https://drive.example.com/poster-files', title: 'Poster files' },
      { type: 'link', url: 'https://example.com/spec-a', title: 'https://example.com/spec-a' },
      { type: 'link', url: 'https://example.com/spec-b', title: 'https://example.com/spec-b' },
    ]);
    expect(data.steps[0].assignees?.[1]).toEqual({
      id: 'u2',
      name: 'Ahmed Kamran',
      role: 'chapter_events_chair',
      chapterName: 'SEDS IST',
      email: 'ahmed@example.com', // via assigneeInfo, as missions-tab does
      whatsapp: '03002222222',
      photoBase64: undefined,
    });
  });

  it('QR payloads from the REAL exporter: cover = mission URL, personnel = profile URL per row, identical across sources', async () => {
    const { body: fsBody } = await getDetail();
    mockQrPayloads.length = 0;
    await exportWorkflowAsPDF(assemblePdfData(fsBody));
    const fsPayloads = [...mockQrPayloads];

    seed('jsonb');
    const { body: jsonbBody } = await getDetail();
    mockQrPayloads.length = 0;
    await exportWorkflowAsPDF(assemblePdfData(jsonbBody));
    const jsonbPayloads = [...mockQrPayloads];

    expect(jsonbPayloads).toEqual(fsPayloads);
    expect(fsPayloads).toEqual([
      `${ORIGIN}/missions/${WF_ID}`,
      `${ORIGIN}/profile/unified/u1?task=step1`,
      `${ORIGIN}/profile/unified/u2?task=step1`,
      `${ORIGIN}/profile/unified/u2?task=step2`,
      `${ORIGIN}/profile/unified/u1?task=step3`,
    ]);
  });
});

describe('contract 3/4: contact masking and the workflow_members gate (wf-4 surface)', () => {
  it('outsider without a membership doc: per-task contact fields are nulled', async () => {
    mockState.viewer = { uid: 'outsider1', role: 'member' };
    mockState.roles = { outsider1: { role: 'member' } };
    const { body } = await getDetail();
    for (const t of body.tasks) {
      expect(t.assigneeWhatsapp).toBeNull();
      expect(t.assigneeEmail).toBeNull();
    }
    // PIN (current behavior): assigneeInfo itself is returned as fetched;
    // masking applies to the per-task singular fields only.
    expect(body.assigneeInfo.u1.email).toBe('huzaifah@example.com');
    expect(body.assigneeInfo.u1.whatsapp).toBe('03001111111');
  });

  it('outsider WITH a workflow_members doc `${workflowId}_${uid}`: contact visible (membership gate)', async () => {
    mockState.viewer = { uid: 'outsider1', role: 'member' };
    mockState.roles = { outsider1: { role: 'member' } };
    mockState.workflowMembers = {
      [`${WF_ID}_outsider1`]: { workflowId: WF_ID, userId: 'outsider1', role: 'member' },
    };
    const { body } = await getDetail();
    expect(body.tasks[0].assigneeWhatsapp).toBe('03001111111');
    expect(body.tasks[0].assigneeEmail).toBe('huzaifah@example.com');
  });

  it('a workflow_members doc for a DIFFERENT workflow does not unmask', async () => {
    mockState.viewer = { uid: 'outsider1', role: 'member' };
    mockState.roles = { outsider1: { role: 'member' } };
    mockState.workflowMembers = {
      [`wf_other_outsider1`]: { workflowId: 'wf_other', userId: 'outsider1', role: 'member' },
    };
    const { body } = await getDetail();
    expect(body.tasks[0].assigneeWhatsapp).toBeNull();
  });
});

describe('contract 4: flag-state behavior for the workflows detail route (env-driven)', () => {
  it('flag OFF: baseline output', async () => {
    const { body } = await getDetail();
    expect(JSON.stringify(body)).toBe(baselineBodyJson);
  });

  it("flag ON for a different surface only: 'workflows' unaffected", async () => {
    process.env.SUPA_SURFACES = 'announcements';
    const { body } = await getDetail();
    expect(JSON.stringify(body)).toBe(baselineBodyJson);
  });

  it('flag ON + no Supabase credentials: Firestore fallback, identical output', async () => {
    process.env.SUPA_SURFACES = 'workflows';
    const { body } = await getDetail();
    expect(JSON.stringify(body)).toBe(baselineBodyJson);
  });

  it('flag ON + unreachable Supabase: Firestore fallback, identical output', async () => {
    process.env.SUPA_SURFACES = 'workflows';
    process.env.SUPABASE_URL = 'https://localhost:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
    const { body } = await getDetail();
    expect(JSON.stringify(body)).toBe(baselineBodyJson);
  }, 20000);
});
