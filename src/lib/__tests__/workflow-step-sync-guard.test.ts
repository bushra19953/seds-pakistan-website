/**
 * Regression test for workflow step sync on task completion.
 *
 * In this codebase workflows are virtual: a workflow mission is a set of
 * task docs in the tasks collection sharing one workflowId, ordered by
 * sequenceIndex, one doc per step (see the workflows API, which aggregates
 * steps from the tasks collection). So "its workflow step" for a
 * workflow-linked task is that task doc itself, and "completing the task
 * updates its workflow step to completed" means the completion path
 * (PATCH /api/tasks plus the real executeGamificationTransaction) must
 * leave the step doc Completed, release the next step, and not throw when
 * a step assignee differs from the completed task assignees.
 *
 * What this file proves, through the real PATCH handler and the real
 * gamification transaction (that module is NOT mocked):
 * 1. Completing step 0 marks that step doc Completed and releases step 1,
 *    even though step 1 assignee (Tahir) differs from step 0 assignees (Maira).
 * 2. Reassigning the next step in the same save (step assignee Yahya, who
 *    is not among the completed task assignees and not even a workflow
 *    participant yet) still completes without throwing, and the next step
 *    is released to the reassigned assignee.
 * 3. Completing the final step (assignee Tahir, differing from the first
 *    step assignees) marks the final step Completed and awards the
 *    workflow bonus to every participant, without throwing.
 *
 * Approach: same fake Firestore as
 * src/lib/__tests__/task-completion-update.test.ts. Only the Firestore
 * Admin SDK and the surrounding notification, permission, and validation
 * helpers are faked. The fake Firestore enforces the real SDK rule that
 * set/update with any undefined field value throws.
 *
 * No em dashes are used in this file.
 */

const written: Array<{ op: string; path: string; data?: any }> = [];
const batchOps: Array<{ op: string; path: string; data?: any }> = [];

/**
 * Mirror the real Firestore SDK: undefined field values are rejected.
 * FieldValue and Timestamp sentinels from the admin mock carry __fv/__ts
 * markers and are allowed through.
 */
function assertNoUndefined(value: any, fieldPath = ''): void {
  if (value === undefined) {
    throw new Error(
      `Function set() called with invalid data. Unsupported field value: undefined (found in field ${fieldPath || 'root'})`,
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date) return;
  if (value.__fv !== undefined || value.__ts !== undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${fieldPath}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
  }
}

/** Resolve FieldValue sentinels the way Firestore would on write. */
function resolveValue(existing: any, value: any): any {
  if (value !== null && typeof value === 'object' && value.__fv !== undefined) {
    if (value.__fv === 'delete') return undefined;
    if (value.__fv === 'increment') {
      return (typeof existing === 'number' ? existing : 0) + value.n;
    }
    if (value.__fv === 'arrayUnion') {
      const base = Array.isArray(existing) ? [...existing] : [];
      for (const v of value.vals) {
        if (!base.includes(v)) base.push(v);
      }
      return base;
    }
    return value;
  }
  return value;
}

function applySet(existing: any, data: any, opts?: any): any {
  const base = opts && opts.merge ? { ...(existing || {}) } : {};
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(data)) {
    const resolved = resolveValue(out[k], v);
    if (resolved === undefined && v !== null && typeof v === 'object' && (v as any).__fv === 'delete') {
      delete out[k];
    } else {
      out[k] = resolved;
    }
  }
  return out;
}

function applyUpdate(existing: any, data: any): any {
  const out: Record<string, any> = { ...(existing || {}) };
  for (const [k, v] of Object.entries(data)) {
    const resolved = resolveValue(out[k], v);
    if (resolved === undefined && v !== null && typeof v === 'object' && (v as any).__fv === 'delete') {
      delete out[k];
    } else {
      out[k] = resolved;
    }
  }
  return out;
}

function applyBatchOp(op: { op: string; path: string; data?: any; opts?: any }): void {
  if (op.op === 'delete') {
    delete store[op.path];
    return;
  }
  assertNoUndefined(op.data);
  if (op.op === 'set') {
    store[op.path] = applySet(store[op.path], op.data, op.opts);
  } else if (op.op === 'update') {
    store[op.path] = applyUpdate(store[op.path], op.data);
  }
}

let genCounter = 0;
function nextId(): string {
  genCounter += 1;
  return `gen-${genCounter}`;
}

function makeDocRef(path: string): any {
  const id = path.split('/').pop() as string;
  return {
    id,
    path,
    get: async () => {
      const data = store[path];
      return { exists: data !== undefined, data: () => data, ref: makeDocRef(path) };
    },
    set: async (data: any, opts?: any) => {
      assertNoUndefined(data);
      store[path] = applySet(store[path], data, opts);
    },
    update: async (data: any) => {
      assertNoUndefined(data);
      store[path] = applyUpdate(store[path], data);
    },
    collection: (subName: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${subName}/${subId ?? nextId()}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${path}/${subName}/${nextId()}`);
        await ref.set(data);
        return ref;
      },
    }),
  };
}

function makeQuery(
  collectionName: string,
  filters: Array<{ field: string; op: string; val: any }>,
  limitN?: number,
): any {
  const q: any = {
    __kind: 'query',
    where: (field: string, op: string, val: any) =>
      makeQuery(collectionName, [...filters, { field, op, val }], limitN),
    limit: (n: number) => makeQuery(collectionName, filters, n),
    get: async () => {
      const docs = Object.entries(store)
        .filter(([p]) => {
          const parts = p.split('/');
          return parts.length === 2 && parts[0] === collectionName;
        })
        .filter(([, data]) => filters.every((f) => f.op === '==' && (data as any)[f.field] === f.val))
        .slice(0, limitN ?? Number.POSITIVE_INFINITY)
        .map(([p, data]) => {
          const docId = p.split('/')[1];
          return { id: docId, ref: makeDocRef(`${collectionName}/${docId}`), data: () => data };
        });
      return { empty: docs.length === 0, docs };
    },
  };
  return q;
}

function makeCollection(name: string): any {
  return {
    doc: (id?: string) => makeDocRef(`${name}/${id ?? nextId()}`),
    where: (field: string, op: string, val: any) =>
      makeQuery(name, [{ field, op, val }]),
  };
}

const fakeTx = {
  get: async (refOrQuery: any) => {
    if (refOrQuery.__kind === 'query') return refOrQuery.get();
    const data = store[refOrQuery.path];
    return { exists: data !== undefined, data: () => data, ref: refOrQuery };
  },
  set: (ref: any, data: any, opts?: any) => {
    assertNoUndefined(data);
    written.push({ op: 'set', path: ref.path, data });
    store[ref.path] = applySet(store[ref.path], data, opts);
  },
  update: (ref: any, data: any) => {
    assertNoUndefined(data);
    written.push({ op: 'update', path: ref.path, data });
    store[ref.path] = applyUpdate(store[ref.path], data);
  },
};

const mockDb = {
  collection: (name: string) => makeCollection(name),
  batch: () => {
    const ops: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
    return {
      update: (ref: any, data: any) => {
        ops.push({ op: 'update', path: ref.path, data });
      },
      set: (ref: any, data: any, opts?: any) => {
        ops.push({ op: 'set', path: ref.path, data, opts });
      },
      delete: (ref: any) => {
        ops.push({ op: 'delete', path: ref.path });
      },
      commit: async () => {
        for (const op of ops) {
          batchOps.push(op);
          applyBatchOp(op);
        }
      },
    };
  },
  runTransaction: async (fn: any) => fn(fakeTx),
};

// In-memory docs the fake Firestore serves (path -> data). Repopulated in
// beforeEach so each test starts from a two-step workflow mission where
// step 0 (Deliverable A) is Pending and current, step 1 (Deliverable B)
// is Pending, and the step 1 assignee (Tahir) differs from the step 0
// assignees (Maira only).
const store: Record<string, any> = {};

function resetStore(): void {
  for (const k of Object.keys(store)) delete store[k];
  store['tasks/task-a'] = {
    title: 'Deliverable A: The 60-90s Executive Briefing Cut (Deans & ORIC)',
    description: 'Deliverable A description.',
    status: 'pending',
    assigneeId: 'maira-uid',
    assigneeIds: ['maira-uid'],
    assignerId: 'admin-uid',
    chapterId: 'seds-ist-chapter',
    workflowId: 'wf-1',
    workflowTitle: 'Produce China Aerospace Sourcing Bridge Executive Briefing & Social Launch Videos',
    workflowParticipantIds: ['maira-uid', 'tahir-uid'],
    sequenceIndex: 0,
    isCurrentStep: true,
    points: 4,
    penaltyPoints: 5,
    workflowBonusPoints: 10,
  };
  store['tasks/task-b'] = {
    title: 'Deliverable B: The 30-45s Social Recruitment Teaser (Mobile Vertical)',
    description: 'Deliverable B description.',
    status: 'pending',
    assigneeId: 'tahir-uid',
    assigneeIds: ['tahir-uid'],
    assignerId: 'admin-uid',
    chapterId: 'seds-ist-chapter',
    workflowId: 'wf-1',
    workflowTitle: 'Produce China Aerospace Sourcing Bridge Executive Briefing & Social Launch Videos',
    workflowParticipantIds: ['maira-uid', 'tahir-uid'],
    sequenceIndex: 1,
    isCurrentStep: false,
    points: 3,
    penaltyPoints: 5,
    workflowBonusPoints: 10,
  };
}

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

jest.mock('@/lib/server/firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return {
    admin: {
      firestore: {
        Timestamp: {
          now: () => ({ __ts: 'now', toDate: () => new Date() }),
        },
        FieldValue,
      },
    },
    getDb: () => mockDb,
  };
});

jest.mock('@/lib/auth/verifySession', () => {
  class MockSessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    extractBearerToken: () => 'test-bearer-token',
    verifyIdTokenString: async () => {
      const projectId =
        process.env.FIREBASE_PROJECT_ID ||
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
        'test-project';
      return {
        uid: 'admin-uid',
        role: 'admin',
        permissions: { manageTasks: true },
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
      };
    },
    SessionError: MockSessionError,
  };
});

jest.mock('@/lib/mailer', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/user-status', () => ({
  validateUserStatus: jest.fn().mockResolvedValue({ isValid: true }),
}));

jest.mock('@/lib/server/hierarchy-utils', () => ({
  isManagerAbove: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/lib/server/hierarchy', () => ({
  canValidateTask: jest
    .fn()
    .mockResolvedValue({ allowed: true, reason: 'role', via: 'role', depth: 0 }),
  getValidatorChainUids: jest.fn().mockResolvedValue([]),
  resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
}));

jest.mock('@/lib/server/validation-notifications', () => ({
  notifyValidatorsOnSubmission: jest.fn().mockResolvedValue(undefined),
  notifyOnDecision: jest.fn().mockResolvedValue(undefined),
  notifyAcceptanceRequest: jest.fn().mockResolvedValue(undefined),
  notifyChainOnDecline: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/validation-audit', () => ({
  logValidationDecision: jest.fn().mockResolvedValue(undefined),
  logDeniedValidationAttempt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  resolveUserRole: jest.fn().mockResolvedValue('admin'),
  assertChapterAccess: jest.fn().mockResolvedValue({ allowed: true }),
}));

// NOTE: '@/lib/server/gamification-transaction' is deliberately NOT mocked.
// The real transaction runs against the fake Firestore above, so this test
// covers the full completion path the Admin Edit Task form uses.
import { PATCH } from '../../app/api/tasks/route';

function makeRequest(body: any): any {
  const req: any = { json: async () => body };
  req.clone = () => req;
  return req;
}

function stepEntry(
  id: string,
  title: string,
  description: string,
  assigneeId: string,
  points: number,
): any {
  return {
    id,
    title,
    description,
    assigneeId,
    assigneeIds: [assigneeId],
    points,
    resources: [],
  };
}

/**
 * The payload the Admin Edit Task form sends when completing one step of
 * a workflow-linked task: top-level fields for the edited task plus a
 * steps array carrying every workflow step.
 */
function completePayload(args: {
  taskId: string;
  assigneeId: string;
  points: number;
  steps: Array<any>;
}): any {
  return {
    taskId: args.taskId,
    updates: {
      title: args.taskId === 'task-a'
        ? 'Deliverable A: The 60-90s Executive Briefing Cut (Deans & ORIC)'
        : 'Deliverable B: The 30-45s Social Recruitment Teaser (Mobile Vertical)',
      description: args.taskId === 'task-a' ? 'Deliverable A description.' : 'Deliverable B description.',
      assigneeId: args.assigneeId,
      assigneeIds: [args.assigneeId],
      points: args.points,
      chapterId: 'seds-ist-chapter',
      resources: [],
      deadline: '2026-12-31T23:59:00.000Z',
      status: 'completed',
      steps: args.steps,
    },
  };
}

function stepA(assigneeId = 'maira-uid'): any {
  return stepEntry(
    'task-a',
    'Deliverable A: The 60-90s Executive Briefing Cut (Deans & ORIC)',
    'Deliverable A description.',
    assigneeId,
    4,
  );
}

function stepB(assigneeId = 'tahir-uid'): any {
  return stepEntry(
    'task-b',
    'Deliverable B: The 30-45s Social Recruitment Teaser (Mobile Vertical)',
    'Deliverable B description.',
    assigneeId,
    3,
  );
}

describe('PATCH /api/tasks workflow step sync guard', () => {
  beforeEach(() => {
    resetStore();
    written.length = 0;
    batchOps.length = 0;
    genCounter = 0;
  });

  test('completing step 0 marks its workflow step Completed and releases step 1, whose assignee differs from the completed task assignees', async () => {
    // Step 1 assignee Tahir differs from step 0 assignees (Maira only).
    // The completion must not throw on that mismatch.
    const res: any = await PATCH(
      makeRequest(
        completePayload({
          taskId: 'task-a',
          assigneeId: 'maira-uid',
          points: 4,
          steps: [stepA(), stepB('tahir-uid')],
        }),
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transitionedToCompleted).toBe(true);

    // The completed task IS its workflow step doc: it ends up Completed,
    // no longer the current step.
    expect(store['tasks/task-a'].status).toBe('completed');
    expect(store['tasks/task-a'].isCurrentStep).toBe(false);
    const taskUpdate = written.find(
      (w) => w.op === 'update' && w.path === 'tasks/task-a',
    );
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate!.data.status).toBe('completed');

    // The next workflow step is released to its own assignee, Tahir.
    expect(store['tasks/task-b'].isCurrentStep).toBe(true);
    expect(store['tasks/task-b'].status).toBe('pending');
    expect(store['tasks/task-b'].assigneeId).toBe('tahir-uid');
    const nextUpdate = written.find(
      (w) => w.op === 'update' && w.path === 'tasks/task-b',
    );
    expect(nextUpdate).toBeDefined();
    expect(nextUpdate!.data.isCurrentStep).toBe(true);

    // The handoff notification reaches Tahir, the differing next-step
    // assignee, with a link, and no notification carries an undefined link.
    const notifs = written.filter(
      (w) => w.op === 'set' && w.path.includes('/notifications/'),
    );
    const nextNotif = notifs.find((w) => w.data.type === 'task_assigned');
    expect(nextNotif).toBeDefined();
    expect(typeof nextNotif!.data.link).toBe('string');
    for (const n of notifs) {
      expect(n.data).not.toHaveProperty('link', undefined);
    }
  });

  test('reassigning the next step in the same save still completes without throwing, and the next step is released to the reassigned assignee', async () => {
    // The next step entry carries Yahya, who is neither among the
    // completed task assignees (Maira) nor a workflow participant yet.
    // The step edit plus the completion must compose without throwing.
    const res: any = await PATCH(
      makeRequest(
        completePayload({
          taskId: 'task-a',
          assigneeId: 'maira-uid',
          points: 4,
          steps: [stepA(), stepB('yahya-uid')],
        }),
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transitionedToCompleted).toBe(true);

    expect(store['tasks/task-a'].status).toBe('completed');

    // The step reassignment persisted through the completion save, and
    // the handoff released the step to the new assignee.
    expect(store['tasks/task-b'].assigneeId).toBe('yahya-uid');
    expect(store['tasks/task-b'].assigneeIds).toEqual(['yahya-uid']);
    expect(store['tasks/task-b'].isCurrentStep).toBe(true);
    const stepEdit = batchOps.find(
      (o) => o.op === 'update' && o.path === 'tasks/task-b',
    );
    expect(stepEdit).toBeDefined();
    expect(stepEdit!.data.assigneeId).toBe('yahya-uid');

    // Yahya, the differing next-step assignee, gets the handoff
    // notification with a link.
    const notifs = written.filter(
      (w) => w.op === 'set' && w.path.includes('/notifications/'),
    );
    const nextNotif = notifs.find((w) => w.data.type === 'task_assigned');
    expect(nextNotif).toBeDefined();
    expect(typeof nextNotif!.data.link).toBe('string');
    expect(nextNotif!.path).toContain('users/yahya-uid');
  });

  test('completing the final step marks it Completed and awards the workflow bonus, even though its assignee differs from the first step assignees', async () => {
    // Step 0 already completed, step 1 is now current and final.
    store['tasks/task-a'].status = 'completed';
    store['tasks/task-a'].isCurrentStep = false;
    store['tasks/task-b'].isCurrentStep = true;

    const res: any = await PATCH(
      makeRequest(
        completePayload({
          taskId: 'task-b',
          assigneeId: 'tahir-uid',
          points: 3,
          steps: [stepA(), stepB('tahir-uid')],
        }),
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transitionedToCompleted).toBe(true);

    // The final workflow step doc ends up Completed.
    expect(store['tasks/task-b'].status).toBe('completed');
    expect(store['tasks/task-b'].isCurrentStep).toBe(false);

    // The final workflow bonus (10) is awarded to every participant,
    // including Maira, who is not the final step assignee.
    const bonusEntries = written.filter(
      (w) =>
        w.op === 'set' &&
        w.path.startsWith('points_ledger/') &&
        w.data.action === 'WORKFLOW_BONUS',
    );
    expect(bonusEntries).toHaveLength(2);
    expect(bonusEntries.map((e) => e.data.user_id).sort()).toEqual([
      'maira-uid',
      'tahir-uid',
    ]);
    for (const e of bonusEntries) {
      expect(e.data.points_awarded).toBe(10);
    }
  });
});
