/**
 * Compliance cron tests (spec G.5): six failure-isolated passes -
 * reminders with per-recipient receipts and missing-only retry, live
 * owner resolution (vacancy routing), the under_review overdue guard,
 * default drafts with ONE Audit Chair digest, cure expiry blocked by a
 * pending cure, seedHold invisibility, and pass failure isolation.
 */

const mockState = {
  sent: [] as { uid: string; type: string; link?: string }[],
  failFor: new Set<string>(),
  failChapters: false,
};

const remindersFor = (id: string) =>
  mockState.sent.filter((s) => s.type === 'compliance_reminder' && s.link?.endsWith(id));

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
      if (collectionPath === 'chapters' && mockState.failChapters) throw new Error('chapters read failed');
      let docs = Object.entries(mockDocs)
        .filter(([p]) => p.startsWith(`${collectionPath}/`) && p.split('/').length === collectionPath.split('/').length + 1)
        .map(([p, data]) => ({ id: p.split('/').pop()!, data: () => data, ref: makeDocRef(p), exists: true }));
      for (const f of filters) {
        docs = docs.filter((d) => {
          const v = d.data()[f.field];
          if (f.op === 'in') return f.value.includes(v);
          if (f.op === '!=') return v !== f.value && v !== undefined;
          if (f.op === 'array-contains') return Array.isArray(v) && v.includes(f.value);
          return v === f.value;
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
const mockDb = { collection: (name: string) => makeCollectionRef(name) };

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
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: async (uid: string, payload: { type: string; link?: string }) => {
      if (mockState.failFor.has(uid)) throw new Error('send failed');
      mockState.sent.push({ uid, type: payload.type, link: payload.link });
    },
  },
}));
jest.mock('@/lib/auth/verifySession', () => ({
  SessionError: class extends Error {},
  verifySession: async () => ({ uid: 'system' }),
}));

import { runComplianceCron } from '../cron';
import { FOUNDER_UID } from '@/lib/roles';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

function seedInstance(id: string, overrides: Record<string, any> = {}): void {
  mockDocs[`compliance_obligations/${id}`] = {
    templateKey: 'bank-reconciliation',
    templateVersion: 1,
    title: 'Monthly bank reconciliation',
    officeRole: 'national_treasurer',
    ownerUidSnapshot: null,
    chapterId: null,
    periodKey: '2026-11',
    dueDate: inDays(10),
    status: 'scheduled',
    evidence: null,
    review: null,
    waiver: null,
    remindersSent: { d30: null, d14: null, d7: null },
    reminderReceipts: [],
    overdueNotifiedAt: null,
    defaultNoticeId: null,
    escalation: { level: 'none', at: null, note: null },
    completedAt: null,
    completedVia: null,
    createdBy: 'generator',
    seedHold: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockDocs = {};
  autoId = 0;
  mockState.sent = [];
  mockState.failFor = new Set();
  mockState.failChapters = false;
  mockDocs['compliance_templates/bank-reconciliation'] = {
    title: 'Monthly bank reconciliation',
    officeRole: 'national_treasurer',
    cadence: 'monthly',
    deadlineRule: { kind: 'fixed_day_of_month', day: 15 },
    reminderOffsetsDays: [30, 14, 7],
    alsoNotifiedRoles: [],
    active: true,
    templateVersion: 1,
  };
  mockDocs['roles/treasurer-1'] = { role: 'national_treasurer' };
  mockDocs['roles/ngs-1'] = { role: 'national_general_secretary' };
  mockDocs['roles/pres-1'] = { role: 'president_national' };
  mockDocs['roles/ac-1'] = { role: 'national_audit_compliance_chair' };
  seedInstance('inst-1');
});

describe('reminder pass', () => {
  it('sends due offsets to the LIVE holder, stamps them, advances the ladder; re-run sends nothing', async () => {
    const first = await runComplianceCron(new Date());
    expect(first.passes.reminders.ok).toBe(true);
    // The generator also creates horizon instances in this run; assertions
    // are scoped to the seeded instance via its deep link.
    const reminderSends = remindersFor('inst-1');
    expect(reminderSends.map((s) => s.uid)).toEqual(['treasurer-1', 'treasurer-1']); // d30 + d14
    const doc = mockDocs['compliance_obligations/inst-1'];
    expect(doc.remindersSent.d30).not.toBeNull();
    expect(doc.remindersSent.d14).not.toBeNull();
    expect(doc.status).toBe('reminded_14');
    // Snapshot refreshed by pass 1 for display.
    expect(doc.ownerUidSnapshot).toBe('treasurer-1');

    mockState.sent = [];
    await runComplianceCron(new Date());
    expect(remindersFor('inst-1')).toHaveLength(0);
  });

  it('partial failure retries ONLY the missing recipient next run', async () => {
    mockDocs['compliance_templates/bank-reconciliation'].alsoNotifiedRoles = ['president_national'];
    mockState.failFor = new Set(['pres-1']);
    await runComplianceCron(new Date());
    let doc = mockDocs['compliance_obligations/inst-1'];
    expect(doc.remindersSent.d30).toBeNull(); // not all intended recipients ok

    mockState.failFor = new Set();
    mockState.sent = [];
    await runComplianceCron(new Date());
    const uids = remindersFor('inst-1').map((s) => s.uid);
    expect(uids).not.toContain('treasurer-1');
    expect(uids).toContain('pres-1');
    doc = mockDocs['compliance_obligations/inst-1'];
    expect(doc.remindersSent.d30).not.toBeNull();
  });

  it('vacancy: reminders route to Founder + NGS and the snapshot stays null', async () => {
    delete mockDocs['roles/treasurer-1'];
    await runComplianceCron(new Date());
    const uids = new Set(mockState.sent.filter((s) => s.type === 'compliance_reminder').map((s) => s.uid));
    expect(uids.has(FOUNDER_UID)).toBe(true);
    expect(uids.has('ngs-1')).toBe(true);
    expect(mockDocs['compliance_obligations/inst-1'].ownerUidSnapshot).toBeNull();
  });
});

describe('overdue + default draft passes', () => {
  it('due -> overdue after dueDate + 1 day; under_review is NEVER marked overdue', async () => {
    seedInstance('inst-due', { status: 'due', dueDate: inDays(-2) });
    seedInstance('inst-review', { status: 'under_review', dueDate: inDays(-2), evidence: { type: 'document', ref: 'x', submittedBy: 'treasurer-1', submittedAt: inDays(-3), note: null } });
    await runComplianceCron(new Date());
    expect(mockDocs['compliance_obligations/inst-due'].status).toBe('overdue');
    expect(mockDocs['compliance_obligations/inst-due'].overdueNotifiedAt).not.toBeNull();
    expect(mockDocs['compliance_obligations/inst-review'].status).toBe('under_review');
  });

  it('overdue + 7 days creates ONE draft notice and ONE Audit Chair digest', async () => {
    seedInstance('inst-old', { status: 'overdue', dueDate: inDays(-8) });
    await runComplianceCron(new Date());
    const notices = Object.entries(mockDocs).filter(([p]) => p.startsWith('default_notices/'));
    expect(notices).toHaveLength(1);
    expect(notices[0][1].issuedAt).toBeNull();
    expect(notices[0][1].outcome).toBe('open');
    expect(mockDocs['compliance_obligations/inst-old'].status).toBe('default_draft');
    const digests = mockState.sent.filter((s) => s.type === 'compliance_default_digest');
    expect(digests).toHaveLength(1);
    expect(digests[0].uid).toBe('ac-1');

    await runComplianceCron(new Date());
    expect(Object.entries(mockDocs).filter(([p]) => p.startsWith('default_notices/'))).toHaveLength(1);
  });
});

describe('cure expiry pass', () => {
  function seedCure(cure: any, cureReview: any = null): void {
    seedInstance('inst-cure', { status: 'cure_period', dueDate: inDays(-20), defaultNoticeId: 'notice-1' });
    mockDocs['default_notices/notice-1'] = {
      obligationId: 'inst-cure',
      templateKey: 'bank-reconciliation',
      officeRole: 'national_treasurer',
      issuedAt: inDays(-10),
      cureDeadline: inDays(-1),
      cure,
      cureReview,
      outcome: 'open',
      deliveryReceipts: {
        founder: { method: 'notification', ref: 'x', at: inDays(-10), ok: true },
        president: { method: 'notification', ref: 'x', at: inDays(-10), ok: true },
      },
    };
  }

  it('expired cure period with no cure escalates and notifies the Founder', async () => {
    seedCure(null);
    const summary = await runComplianceCron(new Date());
    expect(summary.passes.cureExpiry.counts.escalated).toBe(1);
    expect(mockDocs['compliance_obligations/inst-cure'].status).toBe('escalated');
    expect(mockDocs['compliance_obligations/inst-cure'].escalation.level).toBe('founder_notified');
    expect(mockDocs['default_notices/notice-1'].outcome).toBe('escalated');
    expect(mockState.sent.some((s) => s.uid === FOUNDER_UID && s.type === 'compliance_escalated')).toBe(true);
  });

  it('a submitted-but-unreviewed cure BLOCKS escalation', async () => {
    seedCure({ submittedBy: 'treasurer-1', submittedAt: inDays(-2), evidenceRef: 'doc', note: null });
    const summary = await runComplianceCron(new Date());
    expect(summary.passes.cureExpiry.counts.escalated).toBe(0);
    expect(summary.passes.cureExpiry.counts.blockedByPendingCure).toBe(1);
    expect(mockDocs['compliance_obligations/inst-cure'].status).toBe('cure_period');
  });

  it('a rejected cure does NOT block escalation after the deadline', async () => {
    seedCure(
      { submittedBy: 'treasurer-1', submittedAt: inDays(-3), evidenceRef: 'doc', note: null },
      { reviewedBy: 'ac-1', reviewedAt: inDays(-2), outcome: 'rejected', note: 'insufficient' },
    );
    const summary = await runComplianceCron(new Date());
    expect(summary.passes.cureExpiry.counts.escalated).toBe(1);
  });
});

describe('seedHold + failure isolation', () => {
  it('held instances are invisible to every pass', async () => {
    seedInstance('inst-held', { status: 'due', dueDate: inDays(-30), seedHold: true });
    await runComplianceCron(new Date());
    expect(mockDocs['compliance_obligations/inst-held'].status).toBe('due');
    expect(Object.keys(mockDocs).some((p) => p.startsWith('default_notices/'))).toBe(false);
  });

  it('a failing generator does not starve the other passes', async () => {
    mockState.failChapters = true;
    const summary = await runComplianceCron(new Date());
    expect(summary.passes.ownerResolution.ok).toBe(false);
    expect(summary.passes.reminders.ok).toBe(true);
    expect(mockState.sent.some((s) => s.type === 'compliance_reminder')).toBe(true);
  });
});
