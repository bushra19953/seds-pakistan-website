/**
 * CONTRACT TEST — GET /api/tasks/team excludes terminal tasks (M4).
 *
 * The team route previously applied NO status filter at all, so every
 * finished task stayed on the assigner's My Team list forever. The fix
 * excludes terminal statuses server-side, where terminal means the
 * canonical 'completed' OR the legacy 'approved' spelling.
 *
 * Real handler, in-memory fake Firestore; auth, chapter scoping and the
 * Admin SDK are faked. No em dashes are used in this file.
 */

// --- Fake Firestore ---------------------------------------------------

const collections: Record<string, Record<string, any>> = {
  users: {
    'manager-uid': { displayName: 'Manager One', role: 'chapter_president', chapterId: 'seds-ist-chapter' },
    'sub-uid': { displayName: 'Sub Ordinate', role: 'member', chapterId: 'seds-ist-chapter' },
    'outsider-uid': { displayName: 'Outside Assignee', role: 'member', chapterId: 'seds-ist-chapter' },
  },
  reporting_relationships: {
    'rel-1': { managerId: 'manager-uid', subordinateId: 'sub-uid' },
  },
  tasks: {
    't-active': { title: 'Active', status: 'in-progress', assigneeId: 'sub-uid', assignerId: 'manager-uid', points: 5 },
    't-review': { title: 'In review', status: 'submitted-for-review', assigneeId: 'manager-uid', assignerId: 'someone-else', points: 5 },
    't-done': { title: 'Done', status: 'completed', assigneeId: 'sub-uid', assignerId: 'manager-uid', points: 5 },
    't-legacy': { title: 'Legacy approved', status: 'approved', assigneeId: 'sub-uid', assignerId: 'manager-uid', points: 5 },
    't-assigned-out': { title: 'Assigned out, open', status: 'pending', assigneeId: 'outsider-uid', assignerId: 'manager-uid', points: 5 },
    't-assigned-out-done': { title: 'Assigned out, finished', status: 'completed', assigneeId: 'outsider-uid', assignerId: 'manager-uid', points: 5 },
  },
};

function matchesFilters(id: string, data: any, filters: Array<{ field: string; op: string; val: any }>): boolean {
  return filters.every((f) => {
    const actual = f.field === '__name__' ? id : data[f.field];
    if (f.op === '==') return actual === f.val;
    if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(actual);
    if (f.op === 'array-contains') return Array.isArray(actual) && actual.includes(f.val);
    return false;
  });
}

function makeQuery(collectionName: string, filters: Array<{ field: string; op: string; val: any }>): any {
  return {
    where: (field: string, op: string, val: any) => makeQuery(collectionName, [...filters, { field, op, val }]),
    get: async () => {
      const docs = Object.entries(collections[collectionName] || {})
        .filter(([id, data]) => matchesFilters(id, data, filters))
        .map(([id, data]) => ({ id, data: () => data }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
}

const fakeDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => {
        const data = (collections[name] || {})[id];
        return { exists: data !== undefined, data: () => data };
      },
    }),
    where: (field: string, op: string, val: any) => makeQuery(name, [{ field, op, val }]),
  }),
};

// --- Module mocks -----------------------------------------------------

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

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => {},
  getDb: () => fakeDb,
  admin: {
    firestore: {
      FieldPath: { documentId: () => '__name__' },
      FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }) },
      Timestamp: { now: () => ({ __ts: 'now', toDate: () => new Date() }) },
    },
  },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn().mockResolvedValue({
    authenticated: true,
    user: { uid: 'manager-uid' },
  }),
}));

jest.mock('@/lib/server/chapter-scoping', () => ({
  applyChapterScope: async (query: any) => query,
}));

import { GET } from '../route';

describe('GET /api/tasks/team terminal exclusion', () => {
  test('finished tasks (completed + legacy approved) never reach the team list', async () => {
    const res: any = await GET({} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.tasks.map((t: any) => t.id).sort();
    expect(ids).toEqual(['t-active', 't-assigned-out', 't-review']);
    expect(body.teamSize).toBe(2);
  });

  test('control: every returned task is in a non-terminal status', async () => {
    const res: any = await GET({} as any);
    const body = await res.json();
    for (const t of body.tasks) {
      expect(t.status).not.toBe('completed');
      expect(t.status).not.toBe('approved');
    }
  });
});
