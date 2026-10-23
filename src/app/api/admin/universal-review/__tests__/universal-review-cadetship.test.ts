/**
 * Tests for the cadetship enrolment hook in PATCH /api/admin/universal-review
 * (phase2_spec.md Section F.6).
 *
 * CONTRACT UNDER TEST:
 * - cadetshipLive OFF: approving an application behaves exactly as before
 *   (status flips; no cadetship, cohort, counter, or audit writes).
 * - cadetshipLive ON: approval and enrolment commit in the SAME batch -
 *   the application is stamped with cadetshipId, a cadetship doc exists,
 *   the cohort doc counts the cadet, and a governance audit entry exists.
 * - two approvals in the same FY land in the SAME cohort (cadetCount 2).
 * - re-approval is idempotent (one live cadetship per person).
 * - enrolment failure fails the approval (status stays pending).
 */

const mockFlags = { cadetshipLive: false, failCadetshipQuery: false };

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
let mockDocs: Record<string, any> = {};
let autoIdCounter = 0;
let committedUpTo = 0;

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function applyValue(existing: any, value: any): any {
  if (isSentinel(value, 'serverTimestamp')) return 'SERVER_TIMESTAMP';
  if (isSentinel(value, 'increment')) return (typeof existing === 'number' ? existing : 0) + value.n;
  if (isSentinel(value, 'arrayUnion')) {
    const base = Array.isArray(existing) ? [...existing] : [];
    for (const v of value.vals) if (!base.includes(v)) base.push(v);
    return base;
  }
  return value;
}

function applyDataToDoc(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) next[key] = applyValue(next[key], value);
  return next;
}

function applyBatchOps(ops: Array<{ op: string; path: string; data?: any; opts?: any }>): void {
  for (const op of ops) {
    if (op.op === 'set') {
      const base = op.opts?.merge ? (mockDocs[op.path] ?? {}) : {};
      mockDocs[op.path] = applyDataToDoc(base, op.data ?? {});
    } else if (op.op === 'update') {
      mockDocs[op.path] = applyDataToDoc(mockDocs[op.path] ?? {}, op.data ?? {});
    } else if (op.op === 'delete') {
      delete mockDocs[op.path];
    }
  }
}

function makeDocRef(collectionName: string, id?: string): any {
  const docId = id ?? `generated-${++autoIdCounter}`;
  const path = `${collectionName}/${docId}`;
  return {
    id: docId,
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      const base = opts?.merge ? (mockDocs[path] ?? {}) : {};
      mockDocs[path] = applyDataToDoc(base, data ?? {});
    },
    update: async (data: any) => {
      mockDocs[path] = applyDataToDoc(mockDocs[path] ?? {}, data ?? {});
    },
    collection: (sub: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${sub}`, subId),
    }),
  };
}

function makeQuery(collectionName: string, filters: { field: string; op: string; value: any }[], limitN?: number): any {
  return {
    where: (field: string, op: string, value: any) => makeQuery(collectionName, [...filters, { field, op, value }], limitN),
    limit: (n: number) => makeQuery(collectionName, filters, n),
    get: async () => {
      if (collectionName === 'cadetships' && mockFlags.failCadetshipQuery) {
        throw new Error('simulated cadetship read failure');
      }
      let docs = Object.entries(mockDocs)
        .filter(([path]) => {
          const parts = path.split('/');
          return parts.length === 2 && parts[0] === collectionName;
        })
        .map(([path, data]) => ({
          id: path.split('/')[1],
          data: () => data,
          ref: makeDocRef(collectionName, path.split('/')[1]),
          exists: true,
        }));
      for (const f of filters) {
        docs = docs.filter((d) => {
          const v = d.data()[f.field];
          return f.op === 'in' ? (f.value as any[]).includes(v) : v === f.value;
        });
      }
      if (limitN) docs = docs.slice(0, limitN);
      return { empty: docs.length === 0, docs, forEach: (fn: any) => docs.forEach(fn) };
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => makeDocRef(name, id),
    where: (field: string, op: string, value: any) => makeQuery(name, [{ field, op, value }]),
  }),
  batch: () => ({
    set: (ref: any, data: any, opts?: any) => mockBatchOps.push({ op: 'set', path: ref.path, data, opts }),
    update: (ref: any, data: any) => mockBatchOps.push({ op: 'update', path: ref.path, data }),
    delete: (ref: any) => mockBatchOps.push({ op: 'delete', path: ref.path }),
    commit: async () => {
      applyBatchOps(mockBatchOps.slice(committedUpTo));
      committedUpTo = mockBatchOps.length;
    },
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    private payload: any;
    constructor(payload: any, init?: { status?: number }) {
      this.payload = payload;
      this.status = init?.status ?? 200;
    }
    static json(payload: any, init?: { status?: number }) {
      return new MockNextResponse(payload, init);
    }
    async json() {
      return this.payload;
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  const Timestamp = { fromDate: (d: Date) => ({ toDate: () => d }) };
  return { firestore: { FieldValue, Timestamp } };
});

jest.mock('@/lib/server/leave-return', () => ({
  returnFromLeave: jest.fn(),
  RESTORABLE_TASK_STATUSES: ['pending', 'in_progress', 'in-progress', 'locked'],
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: {
      userId: 'reviewer-1',
      email: 'reviewer@example.com',
      displayName: 'Reviewer Admin',
      emailVerified: true,
      role: 'admin',
      user: {},
    },
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/server/governance-settings', () => ({
  isPhase2Live: async (flag: string) => flag === 'cadetshipLive' && mockFlags.cadetshipLive,
}));

import { PATCH } from '../route';
import { fiscalYearOf, cohortIdFor } from '@/lib/server/cadetship/clock';

function makeRequest(body: any): any {
  return { json: async () => body };
}

function seedApplication(appId: string, uid: string, overrides: Record<string, any> = {}): void {
  mockDocs[`applications/${appId}`] = {
    userId: uid,
    title: 'Induction Application',
    status: 'pending',
    skills: [],
    chapterId: 'seds-ist-chapter',
    ...overrides,
  };
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs[`users/${uid}`] = { displayName: 'Applicant', chapterId: 'seds-ist-chapter' };
}

function docsIn(collectionName: string): [string, any][] {
  return Object.entries(mockDocs).filter(([p]) => {
    const parts = p.split('/');
    return parts.length === 2 && parts[0] === collectionName;
  });
}

const approve = (appId: string) => ({ collection: 'applications', ids: [appId], action: 'approve' });

describe('PATCH universal-review cadetship hook (F.6)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    mockFlags.cadetshipLive = false;
    mockFlags.failCadetshipQuery = false;
  });

  test('flag OFF: approval is byte-identical to pre-Phase-2 behaviour (no cadetship writes)', async () => {
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(approve('app-1')));
    expect(res.status).toBe(200);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
    expect(mockDocs['applications/app-1'].cadetshipId).toBeUndefined();
    expect(docsIn('cadetships')).toHaveLength(0);
    expect(docsIn('cohorts')).toHaveLength(0);
    expect(docsIn('audit_logs')).toHaveLength(0);
  });

  test('flag ON: approval enrols in the same commit (cadetship + cohort + audit + stamp)', async () => {
    mockFlags.cadetshipLive = true;
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(approve('app-1')));
    expect(res.status).toBe(200);

    const cadetships = docsIn('cadetships');
    expect(cadetships).toHaveLength(1);
    const [, cadet] = cadetships[0];
    expect(cadet.status).toBe('active');
    expect(cadet.personUid).toBe('member-1');
    expect(cadet.applicationId).toBe('app-1');
    expect(cadet.createdVia).toBe('application_approval');

    const stamp = mockDocs['applications/app-1'].cadetshipId;
    expect(typeof stamp).toBe('string');
    expect(mockDocs[`cadetships/${stamp}`]).toBeDefined();

    const fy = fiscalYearOf(new Date());
    const expectedCohort = cohortIdFor(fy.fyEndYear, 1);
    expect(cadet.cohortId).toBe(expectedCohort);
    expect(mockDocs[`cohorts/${expectedCohort}`].cadetCount).toBe(1);

    const audits = docsIn('audit_logs').map(([, d]) => d);
    expect(audits.some((a) => a.action === 'cadetship.enrolled' && a.subjectId === stamp)).toBe(true);
  });

  test('flag ON: two approvals in the same FY land in the SAME cohort with cadetCount 2', async () => {
    mockFlags.cadetshipLive = true;
    seedApplication('app-1', 'member-1');
    seedApplication('app-2', 'member-2');
    await PATCH(makeRequest(approve('app-1')));
    await PATCH(makeRequest(approve('app-2')));

    const cadetships = docsIn('cadetships');
    expect(cadetships).toHaveLength(2);
    expect(cadetships[0][1].cohortId).toBe(cadetships[1][1].cohortId);
    const cohorts = docsIn('cohorts');
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0][1].cadetCount).toBe(2);
  });

  test('flag ON: re-approval is idempotent (no second cadetship, count unchanged)', async () => {
    mockFlags.cadetshipLive = true;
    seedApplication('app-1', 'member-1');
    await PATCH(makeRequest(approve('app-1')));
    const res: any = await PATCH(makeRequest(approve('app-1')));
    expect(res.status).toBe(200);
    expect(docsIn('cadetships')).toHaveLength(1);
    expect(docsIn('cohorts')[0][1].cadetCount).toBe(1);
  });

  test('flag ON: enrolment failure FAILS the approval (status stays pending)', async () => {
    mockFlags.cadetshipLive = true;
    mockFlags.failCadetshipQuery = true;
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(approve('app-1')));
    expect(res.status).not.toBe(200);
    expect(mockDocs['applications/app-1'].status).toBe('pending');
    expect(mockDocs['applications/app-1'].cadetshipId).toBeUndefined();
    expect(docsIn('cadetships')).toHaveLength(0);
  });
});
