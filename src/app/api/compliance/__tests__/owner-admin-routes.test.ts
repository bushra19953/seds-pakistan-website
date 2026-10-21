/**
 * Owner + admin API tests (spec G.7): the evidence state-guard matrix
 * (an overdue instance can NEVER re-enter review through evidence),
 * holder-only evidence, review accept/reject semantics with the original
 * dueDate preserved, template PATCH version bumps, NO DELETE on the
 * templates surface, and /mine scoping to the caller's office.
 */

import { readFileSync } from 'fs';
import path from 'path';

const mockState = { uid: 'treasurer-1' };

let mockDocs: Record<string, any> = {};
let autoId = 0;

function applyData(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) {
    next[k] = v && typeof v === 'object' && v.__fv === 'serverTimestamp' ? new Date() : v;
  }
  return next;
}
function makeDocRef(path_: string): any {
  return {
    id: path_.split('/').pop(),
    path: path_,
    get: async () => {
      const data = mockDocs[path_];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      mockDocs[path_] = opts?.merge ? applyData(mockDocs[path_] ?? {}, data) : { ...data };
    },
    update: async (data: any) => {
      mockDocs[path_] = applyData(mockDocs[path_] ?? {}, data);
    },
    collection: (sub: string) => makeCollectionRef(`${path_}/${sub}`),
  };
}
function makeQuery(collectionPath: string, filters: any[] = [], limitN?: number): any {
  return {
    where: (field: string, op: string, value: any) => makeQuery(collectionPath, [...filters, { field, op, value }], limitN),
    limit: (n: number) => makeQuery(collectionPath, filters, n),
    get: async () => {
      let docs = Object.entries(mockDocs)
        .filter(([p]) => p.startsWith(`${collectionPath}/`) && p.split('/').length === collectionPath.split('/').length + 1)
        .map(([p, data]) => ({ id: p.split('/').pop()!, data: () => data, ref: makeDocRef(p), exists: true }));
      for (const f of filters) {
        docs = docs.filter((d) => {
          const v = d.data()[f.field];
          return f.op === 'in' ? f.value.includes(v) : v === f.value;
        });
      }
      if (limitN) docs = docs.slice(0, limitN);
      return { empty: docs.length === 0, docs, size: docs.length, forEach: (fn: any) => docs.forEach(fn) };
    },
  };
}
function makeCollectionRef(path_: string): any {
  return {
    doc: (id?: string) => makeDocRef(`${path_}/${id ?? `auto-${++autoId}`}`),
    where: (field: string, op: string, value: any) => makeQuery(path_, [{ field, op, value }]),
    get: async () => makeQuery(path_).get(),
  };
}
const mockDb = { collection: (name: string) => makeCollectionRef(name) };

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
  return {
    NextRequest: class {},
    NextResponse: MockNextResponse,
  };
});
jest.mock('firebase-admin', () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
      increment: (n: number) => ({ __fv: 'increment', n }),
    },
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));
class MockSessionError extends Error {
  statusCode = 401;
}
jest.mock('@/lib/auth/verifySession', () => ({
  SessionError: MockSessionError,
  verifySession: async () => ({ uid: mockState.uid }),
}));

import { POST as evidencePOST } from '../obligations/[id]/evidence/route';
import { POST as reviewPOST } from '../obligations/[id]/review/route';
import { GET as mineGET } from '../mine/route';
import { GET as obligationGET } from '../obligations/[id]/route';
import { PATCH as templatePATCH } from '../../admin/compliance/templates/[key]/route';
import { FOUNDER_UID } from '@/lib/roles';

function req(body?: any, search = ''): any {
  return {
    json: async () => body ?? {},
    url: `http://localhost/x${search}`,
    nextUrl: { searchParams: new URLSearchParams(search) },
    headers: { get: () => null },
  };
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });

function seedObligation(status: string): void {
  mockDocs['compliance_obligations/ob-1'] = {
    templateKey: 'bank-reconciliation',
    templateVersion: 3,
    title: 'Bank reconciliation',
    officeRole: 'national_treasurer',
    ownerUidSnapshot: 'treasurer-1',
    chapterId: null,
    dueDate: new Date('2026-10-15'),
    status,
    evidence: null,
    review: null,
    defaultNoticeId: null,
  };
}

beforeEach(() => {
  mockDocs = {};
  autoId = 0;
  mockState.uid = 'treasurer-1';
  mockDocs['roles/treasurer-1'] = { role: 'national_treasurer' };
  mockDocs['roles/ac-1'] = { role: 'national_audit_compliance_chair' };
  mockDocs['roles/ngs-1'] = { role: 'national_general_secretary' };
  mockDocs['roles/member-1'] = { role: 'member' };
  mockDocs['compliance_templates/bank-reconciliation'] = {
    title: 'Monthly bank reconciliation',
    officeRole: 'national_treasurer',
    reviewerRole: 'national_audit_compliance_chair',
    proofTypes: ['document', 'link'],
    templateVersion: 3,
  };
  seedObligation('due');
});

describe('evidence route - the state guard (G.4)', () => {
  it.each(['scheduled', 'reminded_30', 'due'])(
    'accepts evidence from %s and advances to under_review',
    async (status) => {
      seedObligation(status);
      const res: any = await evidencePOST(req({ type: 'document', ref: 'https://drive/x' }), params('ob-1'));
      expect(res.status).toBe(200);
      expect(mockDocs['compliance_obligations/ob-1'].status).toBe('under_review');
      expect(mockDocs['compliance_obligations/ob-1'].evidence.submittedBy).toBe('treasurer-1');
    },
  );

  it.each(['overdue', 'default_draft', 'cure_period', 'escalated', 'completed', 'waived'])(
    'REJECTS evidence from %s - past-deadline states only move via the cure path',
    async (status) => {
      seedObligation(status);
      const res: any = await evidencePOST(req({ type: 'document', ref: 'https://drive/x' }), params('ob-1'));
      expect(res.status).toBe(409);
      expect(mockDocs['compliance_obligations/ob-1'].status).toBe(status);
    },
  );

  it('rejects a non-holder and an unlisted evidence type', async () => {
    mockState.uid = 'member-1';
    const forbidden: any = await evidencePOST(req({ type: 'document', ref: 'x' }), params('ob-1'));
    expect(forbidden.status).toBe(403);
    mockState.uid = 'treasurer-1';
    const badType: any = await evidencePOST(req({ type: 'screenshot', ref: 'x' }), params('ob-1'));
    expect(badType.status).toBe(400);
  });
});

describe('review route', () => {
  it('accept completes via review, recorded against the template reviewerRole', async () => {
    seedObligation('under_review');
    mockState.uid = 'ac-1';
    const res: any = await reviewPOST(req({ outcome: 'accepted' }), params('ob-1'));
    expect(res.status).toBe(200);
    const doc = mockDocs['compliance_obligations/ob-1'];
    expect(doc.status).toBe('completed');
    expect(doc.completedVia).toBe('review');
    expect(doc.review.reviewerRole).toBe('national_audit_compliance_chair');
  });

  it('reject returns to due with the ORIGINAL dueDate and requires a note', async () => {
    seedObligation('under_review');
    mockState.uid = 'ac-1';
    const noNote: any = await reviewPOST(req({ outcome: 'rejected' }), params('ob-1'));
    expect(noNote.status).toBe(400);
    const res: any = await reviewPOST(req({ outcome: 'rejected', note: 'Wrong period' }), params('ob-1'));
    expect(res.status).toBe(200);
    const doc = mockDocs['compliance_obligations/ob-1'];
    expect(doc.status).toBe('due');
    expect(doc.dueDate.toISOString()).toBe(new Date('2026-10-15').toISOString());
  });

  it('the office holder cannot review their own submission', async () => {
    seedObligation('under_review');
    const res: any = await reviewPOST(req({ outcome: 'accepted' }), params('ob-1'));
    expect(res.status).toBe(403);
  });
});

describe('GET obligation access', () => {
  it('holder, reviewer, Founder, NGS may read; a former holder may not', async () => {
    for (const uid of ['treasurer-1', 'ac-1', FOUNDER_UID, 'ngs-1']) {
      mockState.uid = uid;
      const res: any = await obligationGET(req(), params('ob-1'));
      expect(res.status).toBe(200);
    }
    // Holder changed: treasurer-1 is now a FORMER holder.
    delete mockDocs['roles/treasurer-1'];
    mockDocs['roles/treasurer-2'] = { role: 'national_treasurer' };
    mockState.uid = 'treasurer-1';
    const res: any = await obligationGET(req(), params('ob-1'));
    expect(res.status).toBe(403);
  });
});

describe('GET /mine scoping', () => {
  it("returns only the caller's office instances, due-sorted", async () => {
    mockDocs['compliance_obligations/ob-2'] = {
      templateKey: 'membership-return',
      officeRole: 'national_membership_director',
      chapterId: null,
      dueDate: new Date('2026-10-01'),
      status: 'scheduled',
    };
    const res: any = await mineGET(req());
    const body = await res.json();
    expect(body.officeRole).toBe('national_treasurer');
    expect(body.obligations.map((o: any) => o.id)).toEqual(['ob-1']);
  });
});

describe('templates PATCH', () => {
  it('NGS can patch; the version bumps and only editable fields move', async () => {
    mockState.uid = 'ngs-1';
    const res: any = await templatePATCH(
      req({ title: 'Bank reconciliation (revised)', officeRole: 'someone_else' }),
      keyParams('bank-reconciliation'),
    );
    expect(res.status).toBe(200);
    const doc = mockDocs['compliance_templates/bank-reconciliation'];
    expect(doc.templateVersion).toBe(4);
    expect(doc.title).toBe('Bank reconciliation (revised)');
    expect(doc.officeRole).toBe('national_treasurer'); // not editable
  });

  it('a non-Founder non-NGS caller is rejected', async () => {
    mockState.uid = 'ac-1';
    const res: any = await templatePATCH(req({ title: 'x' }), keyParams('bank-reconciliation'));
    expect(res.status).toBe(403);
  });

  it('there is NO DELETE handler anywhere on the templates surface', () => {
    for (const rel of [
      'src/app/api/admin/compliance/templates/route.ts',
      'src/app/api/admin/compliance/templates/[key]/route.ts',
    ]) {
      const source = readFileSync(path.resolve(__dirname, '../../../../..', rel), 'utf8');
      expect(source).not.toMatch(/export async function DELETE/);
    }
  });
});
