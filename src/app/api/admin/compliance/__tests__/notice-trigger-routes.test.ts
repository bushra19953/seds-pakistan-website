/**
 * Notice / cure / intervention / waive / trigger route tests (spec G.6,
 * G.8): the Audit Chair alone issues (Founder rejected), the holder is
 * re-resolved at issue with priorHolderUid recorded, cureDeadline is
 * stored once and never moves on rejection, intervention outcomes follow
 * G.4 exactly, waiver exists only on the Founder route with an
 * instrument, and trigger recording is idempotent.
 */

const mockState = {
  uid: 'ac-1',
  sent: [] as { uid: string; type: string }[],
};

let mockDocs: Record<string, any> = {};
let autoId = 0;

function applyData(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) {
    next[k] = v && typeof v === 'object' && v.__fv === 'serverTimestamp' ? new Date() : v;
  }
  return next;
}
function makeDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      mockDocs[path] = opts?.merge ? applyData(mockDocs[path] ?? {}, data) : { ...data };
    },
    update: async (data: any) => {
      mockDocs[path] = applyData(mockDocs[path] ?? {}, data);
    },
    collection: (sub: string) => makeCollectionRef(`${path}/${sub}`),
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
function makeCollectionRef(path: string): any {
  return {
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${++autoId}`}`),
    where: (field: string, op: string, value: any) => makeQuery(path, [{ field, op, value }]),
    get: async () => makeQuery(path).get(),
  };
}
const mockDb = {
  collection: (name: string) => makeCollectionRef(name),
  runTransaction: async (fn: any) =>
    fn({
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      update: (ref: any, data: any) => ref.update(data),
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
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: async (uid: string, payload: { type: string }) => {
      mockState.sent.push({ uid, type: payload.type });
    },
  },
}));

import { POST as issuePOST } from '../notices/[id]/issue/route';
import { POST as curePOST } from '../obligations/[id]/cure/route';
import { POST as cureReviewPOST } from '../notices/[id]/cure-review/route';
import { POST as interventionPOST } from '../notices/[id]/intervention/route';
import { POST as waivePOST } from '../obligations/[id]/waive/route';
import { POST as triggersPOST } from '../triggers/route';
import { FOUNDER_UID } from '@/lib/roles';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function req(body?: any): any {
  return { json: async () => body ?? {}, url: 'http://localhost/x', headers: { get: () => null } };
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function seedDraft(snapshotHolder: string | null = 'treasurer-1'): void {
  mockDocs['compliance_obligations/ob-1'] = {
    templateKey: 'bank-reconciliation',
    templateVersion: 1,
    title: 'Monthly bank reconciliation',
    officeRole: 'national_treasurer',
    ownerUidSnapshot: snapshotHolder,
    chapterId: null,
    dueDate: daysAgo(9),
    status: 'default_draft',
    defaultNoticeId: 'notice-1',
    escalation: { level: 'none', at: null, note: null },
  };
  mockDocs['default_notices/notice-1'] = {
    obligationId: 'ob-1',
    templateKey: 'bank-reconciliation',
    officeRole: 'national_treasurer',
    issuedToUid: null,
    issuedToName: null,
    priorHolderUid: null,
    issuedBy: null,
    issuedAt: null,
    cureDeadline: null,
    deliveryReceipts: {
      founder: { method: 'notification', ref: null, at: null, ok: false },
      president: { method: 'notification', ref: null, at: null, ok: false },
    },
    cure: null,
    cureReview: null,
    outcome: 'open',
    escalatedAt: null,
    intervention: null,
  };
}

beforeEach(() => {
  mockDocs = {};
  autoId = 0;
  mockState.uid = 'ac-1';
  mockState.sent = [];
  mockDocs['roles/ac-1'] = { role: 'national_audit_compliance_chair' };
  mockDocs['roles/ngs-1'] = { role: 'national_general_secretary' };
  mockDocs['roles/treasurer-1'] = { role: 'national_treasurer' };
  mockDocs['roles/pres-1'] = { role: 'president_national' };
  mockDocs['roles/member-1'] = { role: 'member' };
  mockDocs['users/treasurer-1'] = { displayName: 'Treasurer One' };
  seedDraft();
});

describe('POST notices/[id]/issue', () => {
  it('the Audit Chair issues: cure_period, cureDeadline = issuedAt + 7d stored, receipts ok', async () => {
    const res: any = await issuePOST(req(), params('notice-1'));
    expect(res.status).toBe(200);
    const notice = mockDocs['default_notices/notice-1'];
    expect(notice.issuedBy).toBe('ac-1');
    expect(notice.issuedToUid).toBe('treasurer-1');
    expect(notice.issuedToName).toBe('Treasurer One');
    expect(notice.cureDeadline.getTime() - notice.issuedAt.getTime()).toBe(7 * DAY);
    expect(mockDocs['compliance_obligations/ob-1'].status).toBe('cure_period');
    expect(notice.deliveryReceipts.founder.ok).toBe(true);
    expect(notice.deliveryReceipts.president.ok).toBe(true);
  });

  it('the Founder attempting to issue is rejected (the Chair is the issuing office)', async () => {
    mockState.uid = FOUNDER_UID;
    const res: any = await issuePOST(req(), params('notice-1'));
    expect(res.status).toBe(403);
    expect(mockDocs['default_notices/notice-1'].issuedAt).toBeNull();
  });

  it('holder changed since the draft: notice issues to the NEW holder, prior recorded', async () => {
    delete mockDocs['roles/treasurer-1'];
    mockDocs['roles/treasurer-2'] = { role: 'national_treasurer' };
    mockDocs['users/treasurer-2'] = { displayName: 'Treasurer Two' };
    const res: any = await issuePOST(req(), params('notice-1'));
    expect(res.status).toBe(200);
    const notice = mockDocs['default_notices/notice-1'];
    expect(notice.issuedToUid).toBe('treasurer-2');
    expect(notice.priorHolderUid).toBe('treasurer-1');
  });

  it('issuing twice is a 409', async () => {
    await issuePOST(req(), params('notice-1'));
    const res: any = await issuePOST(req(), params('notice-1'));
    expect(res.status).toBe(409);
  });
});

describe('cure + cure-review', () => {
  async function issueAndCure(): Promise<void> {
    await issuePOST(req(), params('notice-1'));
    mockState.uid = 'treasurer-1';
    const res: any = await curePOST(req({ evidenceRef: 'drive://cure-doc', note: 'done' }), params('ob-1'));
    expect(res.status).toBe(200);
    mockState.uid = 'ac-1';
  }

  it('the current holder submits a cure; the instance stays in cure_period', async () => {
    await issuePOST(req(), params('notice-1'));
    mockState.uid = 'treasurer-1';
    const res: any = await curePOST(req({ evidenceRef: 'drive://cure-doc' }), params('ob-1'));
    expect(res.status).toBe(200);
    expect(mockDocs['default_notices/notice-1'].cure.evidenceRef).toBe('drive://cure-doc');
    expect(mockDocs['compliance_obligations/ob-1'].status).toBe('cure_period');
  });

  it('a non-holder cannot cure', async () => {
    await issuePOST(req(), params('notice-1'));
    mockState.uid = 'member-1';
    const res: any = await curePOST(req({ evidenceRef: 'x' }), params('ob-1'));
    expect(res.status).toBe(403);
  });

  it('accept: notice cured, instance completed via cure', async () => {
    await issueAndCure();
    const res: any = await cureReviewPOST(req({ outcome: 'accepted' }), params('notice-1'));
    expect(res.status).toBe(200);
    expect(mockDocs['default_notices/notice-1'].outcome).toBe('cured');
    expect(mockDocs['compliance_obligations/ob-1'].status).toBe('completed');
    expect(mockDocs['compliance_obligations/ob-1'].completedVia).toBe('cure');
  });

  it('reject: cure marked, cureDeadline does NOT move, instance stays in cure_period', async () => {
    await issueAndCure();
    const deadlineBefore = mockDocs['default_notices/notice-1'].cureDeadline.getTime();
    const res: any = await cureReviewPOST(req({ outcome: 'rejected', note: 'insufficient' }), params('notice-1'));
    expect(res.status).toBe(200);
    expect(mockDocs['default_notices/notice-1'].cureReview.outcome).toBe('rejected');
    expect(mockDocs['default_notices/notice-1'].cureDeadline.getTime()).toBe(deadlineBefore);
    expect(mockDocs['compliance_obligations/ob-1'].status).toBe('cure_period');
  });
});

describe('POST notices/[id]/intervention (Founder only, post-escalation)', () => {
  function seedEscalated(): void {
    seedDraft();
    mockDocs['compliance_obligations/ob-1'].status = 'escalated';
    mockDocs['default_notices/notice-1'].outcome = 'escalated';
    mockDocs['default_notices/notice-1'].issuedAt = daysAgo(10);
    mockDocs['default_notices/notice-1'].cureDeadline = daysAgo(3);
    mockState.uid = FOUNDER_UID;
  }

  it('performed_directly completes the instance via founder_intervention', async () => {
    seedEscalated();
    const res: any = await interventionPOST(req({ type: 'performed_directly', note: 'Filed it myself' }), params('notice-1'));
    expect(res.status).toBe(200);
    expect(mockDocs['compliance_obligations/ob-1'].status).toBe('completed');
    expect(mockDocs['compliance_obligations/ob-1'].completedVia).toBe('founder_intervention');
  });

  it('interim_appointed requires newDueDate, then supersedes + creates a fresh instance', async () => {
    seedEscalated();
    const bad: any = await interventionPOST(req({ type: 'interim_appointed' }), params('notice-1'));
    expect(bad.status).toBe(400);
    const newDue = new Date(Date.now() + 21 * DAY).toISOString();
    const res: any = await interventionPOST(req({ type: 'interim_appointed', newDueDate: newDue }), params('notice-1'));
    expect(res.status).toBe(200);
    expect(mockDocs['compliance_obligations/ob-1'].completedVia).toBe('superseded');
    const body = await res.json();
    const fresh = mockDocs[`compliance_obligations/${body.newObligationId}`];
    expect(fresh.status).toBe('scheduled');
    expect(fresh.dueDate.toDate().toISOString()).toBe(newDue);
  });

  it('officer_removed leaves the instance escalated with level founder_intervention', async () => {
    seedEscalated();
    const res: any = await interventionPOST(req({ type: 'officer_removed' }), params('notice-1'));
    expect(res.status).toBe(200);
    expect(mockDocs['compliance_obligations/ob-1'].status).toBe('escalated');
    expect(mockDocs['compliance_obligations/ob-1'].escalation.level).toBe('founder_intervention');
  });

  it('a non-Founder is rejected, and a non-escalated notice is a 409', async () => {
    seedEscalated();
    mockState.uid = 'ac-1';
    const forbidden: any = await interventionPOST(req({ type: 'performed_directly' }), params('notice-1'));
    expect(forbidden.status).toBe(403);
    mockState.uid = FOUNDER_UID;
    mockDocs['default_notices/notice-1'].outcome = 'open';
    const conflict: any = await interventionPOST(req({ type: 'performed_directly' }), params('notice-1'));
    expect(conflict.status).toBe(409);
  });
});

describe('POST obligations/[id]/waive (the only waiver path)', () => {
  it('Founder waives with a recorded instrument', async () => {
    mockDocs['compliance_obligations/ob-1'].status = 'overdue';
    mockState.uid = FOUNDER_UID;
    const res: any = await waivePOST(
      req({ instrumentType: 'board_resolution', instrumentRef: 'Board Res 2026-14', note: 'AGM clash' }),
      params('ob-1'),
    );
    expect(res.status).toBe(200);
    expect(mockDocs['compliance_obligations/ob-1'].status).toBe('waived');
    expect(mockDocs['compliance_obligations/ob-1'].waiver.instrumentRef).toBe('Board Res 2026-14');
  });

  it('an empty instrumentRef is a 400; a non-Founder is a 403', async () => {
    mockState.uid = FOUNDER_UID;
    const bad: any = await waivePOST(req({ instrumentType: 'founder_act', instrumentRef: '  ' }), params('ob-1'));
    expect(bad.status).toBe(400);
    mockState.uid = 'ac-1';
    const forbidden: any = await waivePOST(
      req({ instrumentType: 'founder_act', instrumentRef: 'Act 1' }),
      params('ob-1'),
    );
    expect(forbidden.status).toBe(403);
  });
});

describe('POST triggers (G.8)', () => {
  function seedEventTemplate(): void {
    mockDocs['compliance_templates/change-of-officer-filing'] = {
      title: 'Change of officer filing',
      officeRole: 'national_general_secretary',
      cadence: 'event',
      deadlineRule: { kind: 'days_after_trigger', days: 30 },
      alsoRecordableBy: ['president_national'],
      active: true,
      templateVersion: 1,
    };
  }

  it('NGS records a trigger: instance due triggerDate + 30d, holder notified at trigger time', async () => {
    seedEventTemplate();
    mockState.uid = 'ngs-1';
    const res: any = await triggersPOST(
      req({ templateKey: 'change-of-officer-filing', triggerDate: '2026-10-20T00:00:00Z', idempotencyKey: 'evt-1', subjectRef: { kind: 'person', id: 'u9', label: 'New treasurer' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const instance = mockDocs[`compliance_obligations/${body.obligationId}`];
    expect(instance.status).toBe('scheduled');
    expect(instance.createdBy).toBe('trigger');
    expect(instance.dueDate.toDate().toISOString()).toBe('2026-11-19T00:00:00.000Z');
    expect(mockState.sent.some((s) => s.uid === 'ngs-1' && s.type === 'compliance_trigger')).toBe(true);
  });

  it('duplicate idempotencyKey returns 200 with the same obligationId and no second instance', async () => {
    seedEventTemplate();
    mockState.uid = 'ngs-1';
    const body = { templateKey: 'change-of-officer-filing', triggerDate: '2026-10-20T00:00:00Z', idempotencyKey: 'evt-dup' };
    const first: any = await triggersPOST(req(body));
    const firstBody = await first.json();
    const second: any = await triggersPOST(req(body));
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.obligationId).toBe(firstBody.obligationId);
    expect(Object.keys(mockDocs).filter((p) => p.startsWith('compliance_obligations/'))).toHaveLength(2); // ob-1 seed + 1 event instance
  });

  it('an alsoRecordableBy holder may record; an unrelated member may not', async () => {
    seedEventTemplate();
    mockState.uid = 'member-1';
    const forbidden: any = await triggersPOST(
      req({ templateKey: 'change-of-officer-filing', idempotencyKey: 'evt-2' }),
    );
    expect(forbidden.status).toBe(403);
    mockState.uid = 'pres-1';
    const ok: any = await triggersPOST(
      req({ templateKey: 'change-of-officer-filing', idempotencyKey: 'evt-3' }),
    );
    expect(ok.status).toBe(200);
  });

  it('a recurring template cannot be triggered', async () => {
    mockDocs['compliance_templates/bank-reconciliation'] = { cadence: 'monthly', title: 'x', officeRole: 'ngs', deadlineRule: { kind: 'fixed_day_of_month', day: 15 } };
    mockState.uid = 'ngs-1';
    const res: any = await triggersPOST(req({ templateKey: 'bank-reconciliation', idempotencyKey: 'evt-4' }));
    expect(res.status).toBe(400);
  });
});
