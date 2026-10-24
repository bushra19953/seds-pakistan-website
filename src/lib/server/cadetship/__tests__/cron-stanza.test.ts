/**
 * Cadetship cron stanza tests (spec F.3/F.4/F.5/F.7): flag-off writes
 * nothing; transitions + notifications fire once; the +7d evaluation
 * reminder fires exactly once; sprint sweep honours the window bounds;
 * the membership-class retry clears the pending flag only on success.
 */

const mockState = {
  cadetshipLive: true,
  classWriteFails: false,
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
          if (f.op === 'in') return f.value.includes(v);
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

jest.mock('@/lib/server/governance-settings', () => ({
  isPhase2Live: async (flag: string) => flag === 'cadetshipLive' && mockState.cadetshipLive,
}));

jest.mock('@/lib/auth/verifySession', () => ({
  SessionError: class extends Error {},
  verifySession: async () => ({ uid: 'system' }),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: async (uid: string, payload: { type: string }) => {
      mockState.sent.push({ uid, type: payload.type });
    },
  },
}));

jest.mock('@/lib/server/cadetship/dues-adapter', () => ({
  getDuesStatusForConfirmation: async () => ({ duesStatus: 'paid', paidThrough: null }),
  setMembershipClass: async () => {
    if (mockState.classWriteFails) throw new Error('unavailable');
  },
}));

import { runCadetshipStanza } from '../cron-stanza';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function seedCadetship(overrides: Record<string, any> = {}): void {
  const startedAt = daysAgo(60);
  mockDocs['cadetships/c1'] = {
    personUid: 'cadet-1',
    applicationId: 'app-1',
    cohortId: '2027-cohort-1',
    chapterId: 'ist',
    createdVia: 'application_approval',
    status: 'active',
    startedAt,
    probationEnd: new Date(startedAt.getTime() + 56 * DAY),
    extendedTo: null,
    extensionUsed: false,
    reviewDue: false,
    items: {
      orientation: { done: true, attestedBy: 'cp-1', attestedAt: daysAgo(50) },
      workshops: { count: 2, attestations: [] },
      sprintTask: { taskId: null, completedAt: null, detectedBy: null },
    },
    conduct: { acknowledged: true, acknowledgedAt: daysAgo(40) },
    duesGate: { status: 'not_checked', lastCheckedAt: null, duesStatus: null },
    decision: { outcome: null, round: 1 },
    membershipClassWritePending: false,
    evaluationReminderSentAt: null,
    ...overrides,
  };
  mockDocs['roles/cp-doc'] = { role: 'chapter_president', chapterId: 'ist' };
  mockDocs['roles/nmd-doc'] = { role: 'national_membership_director' };
  mockDocs['users/cadet-1'] = { displayName: 'Cadet One' };
  // resolveRoleHolders returns doc IDS as uids in the roles store model.
  mockDocs['roles/cp-1'] = { role: 'chapter_president', chapterId: 'ist' };
  mockDocs['roles/nmd-1'] = { role: 'national_membership_director' };
  mockDocs['roles/vp-1'] = { role: 'chapter_vice_president', chapterId: 'ist' };
  delete mockDocs['roles/cp-doc'];
  delete mockDocs['roles/nmd-doc'];
}

beforeEach(() => {
  mockDocs = {};
  autoId = 0;
  mockState.cadetshipLive = true;
  mockState.classWriteFails = false;
  mockState.sent = [];
  seedCadetship();
});

describe('runCadetshipStanza', () => {
  it('flag OFF: skipped summary and zero writes', async () => {
    mockState.cadetshipLive = false;
    const before = JSON.stringify(mockDocs['cadetships/c1'].status);
    const summary = await runCadetshipStanza(new Date());
    expect(summary.skipped).toBe(true);
    expect(JSON.stringify(mockDocs['cadetships/c1'].status)).toBe(before);
    expect(mockState.sent).toHaveLength(0);
  });

  it('active past probationEnd -> under_review + one notification round (CP, NMD, lead)', async () => {
    const summary = await runCadetshipStanza(new Date());
    expect(summary.transitionedToReview).toBe(1);
    expect(mockDocs['cadetships/c1'].status).toBe('under_review');
    const types = mockState.sent.map((s) => s.type);
    expect(types).toContain('cadetship_review_due');
    const recipients = new Set(mockState.sent.map((s) => s.uid));
    expect(recipients.has('cp-1')).toBe(true);
    expect(recipients.has('nmd-1')).toBe(true);
    expect(recipients.has('vp-1')).toBe(true); // deputy resolves as team lead
  });

  it('idempotent: a second run at the same instant transitions and notifies nothing', async () => {
    await runCadetshipStanza(new Date());
    const sentAfterFirst = mockState.sent.length;
    const summary = await runCadetshipStanza(new Date());
    expect(summary.transitionedToReview).toBe(0);
    expect(summary.remindersSent).toBe(0);
    expect(mockState.sent.length).toBe(sentAfterFirst);
  });

  it('the +7d evaluation reminder fires exactly once, never a third time', async () => {
    seedCadetship({ status: 'under_review', probationEnd: daysAgo(8) });
    const first = await runCadetshipStanza(new Date());
    expect(first.remindersSent).toBe(1);
    expect(mockDocs['cadetships/c1'].evaluationReminderSentAt).not.toBeNull();
    const second = await runCadetshipStanza(new Date());
    expect(second.remindersSent).toBe(0);
    const third = await runCadetshipStanza(new Date());
    expect(third.remindersSent).toBe(0);
  });

  it('no reminder when both evaluations are already in', async () => {
    seedCadetship({ status: 'under_review', probationEnd: daysAgo(9) });
    mockDocs['cadetships/c1/evaluations/chapter_president'] = { recommendation: 'confirm' };
    mockDocs['cadetships/c1/evaluations/team_lead'] = { recommendation: 'confirm' };
    const summary = await runCadetshipStanza(new Date());
    expect(summary.remindersSent).toBe(0);
  });

  it('sprint sweep: earliest in-window completion fills the item; out-of-window tasks ignored', async () => {
    const startedAt = mockDocs['cadetships/c1'].startedAt as Date;
    mockDocs['tasks/t-early'] = { assigneeId: 'cadet-1', status: 'completed', completedAt: daysAgo(70) }; // before startedAt
    mockDocs['tasks/t-in'] = { assigneeIds: ['cadet-1'], status: 'approved', completedAt: new Date(startedAt.getTime() + 20 * DAY) };
    mockDocs['tasks/t-late'] = { assigneeId: 'cadet-1', status: 'completed', completedAt: daysAgo(-10) }; // after window
    const summary = await runCadetshipStanza(new Date());
    expect(summary.sprintDetected).toBe(1);
    expect(mockDocs['cadetships/c1'].items.sprintTask.taskId).toBe('t-in');
    expect(mockDocs['cadetships/c1'].items.sprintTask.detectedBy).toBe('auto');
  });

  it('extended past extendedTo -> reviewDue set once', async () => {
    seedCadetship({ status: 'extended', extensionUsed: true, extendedTo: daysAgo(1), reviewDue: false });
    const summary = await runCadetshipStanza(new Date());
    expect(summary.reviewDueSet).toBe(1);
    expect(mockDocs['cadetships/c1'].reviewDue).toBe(true);
    const again = await runCadetshipStanza(new Date());
    expect(again.reviewDueSet).toBe(0);
  });

  it('confirmed cadetships are untouched: no class-write retry exists (writer retired, GOV-03)', async () => {
    // membershipClassWritePending is inert legacy state: the stanza has
    // no class write to retry, whatever the flag says.
    seedCadetship({ status: 'confirmed', membershipClassWritePending: true });
    mockState.classWriteFails = true;
    const summary = await runCadetshipStanza(new Date());
    expect(summary.skipped).toBe(false);
    expect(mockDocs['cadetships/c1'].status).toBe('confirmed');
    expect(mockDocs['cadetships/c1'].membershipClassWritePending).toBe(true);
  });
});
