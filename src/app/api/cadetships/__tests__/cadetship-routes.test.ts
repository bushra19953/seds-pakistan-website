/**
 * Route tests for the cadetship API (phase2_spec.md Sections F.3-F.5, F.7):
 * evidence-type permission matrix (attest / conduct / evaluations),
 * decision-route guards (actor split, checklist recompute, evaluations
 * agreement, dues gate on every attempt, ghost exception), and subject
 * evaluation visibility on the read route.
 */

const mockState = {
  uid: 'cadet-1' as string,
  duesStatus: 'paid' as string,
  classWriteFails: false,
  classWrites: [] as { uid: string; cls: string }[],
};

let mockDocs: Record<string, any> = {};
let autoId = 0;

function applyValue(existing: any, value: any): any {
  if (value && typeof value === 'object' && value.__fv === 'serverTimestamp') return new Date();
  if (value && typeof value === 'object' && value.__fv === 'increment') {
    return (typeof existing === 'number' ? existing : 0) + value.n;
  }
  return value;
}
function applyData(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) next[k] = applyValue(next[k], v);
  return next;
}

function makeDocRef(path: string): any {
  const id = path.split('/').pop()!;
  return {
    id,
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
      return { empty: docs.length === 0, docs, forEach: (fn: any) => docs.forEach(fn) };
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
      arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    },
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

class MockSessionError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}
jest.mock('@/lib/auth/verifySession', () => ({
  SessionError: MockSessionError,
  verifySession: async () => {
    if (!mockState.uid) throw new MockSessionError('unauthenticated', 401);
    return { uid: mockState.uid };
  },
}));

jest.mock('@/lib/server/cadetship/dues-adapter', () => ({
  getDuesStatusForConfirmation: async () => ({ duesStatus: mockState.duesStatus, paidThrough: null }),
  setMembershipClass: async (uid: string, cls: string) => {
    if (mockState.classWriteFails) throw new Error('class write unavailable');
    mockState.classWrites.push({ uid, cls });
  },
  MembershipClassUnavailableError: class extends Error {},
}));

import { POST as attestPOST } from '../[id]/attest/route';
import { POST as conductPOST } from '../me/acknowledge-conduct/route';
import { POST as evalPOST } from '../[id]/evaluations/route';
import { POST as decisionPOST } from '../[id]/decision/route';
import { GET as getOne } from '../[id]/route';

const DAY = 24 * 60 * 60 * 1000;
const now = () => new Date();
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function req(body?: any): any {
  return { json: async () => body ?? {}, url: 'http://localhost/api/cadetships', headers: { get: () => null }, cookies: { get: () => undefined } };
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function seedCadetship(overrides: Record<string, any> = {}): void {
  const startedAt = daysAgo(60);
  mockDocs['cadetships/c1'] = {
    personUid: 'cadet-1',
    applicationId: 'app-1',
    cohortId: '2027-cohort-1',
    chapterId: 'ist',
    createdVia: 'application_approval',
    status: 'under_review',
    startedAt,
    probationEnd: new Date(startedAt.getTime() + 56 * DAY),
    extendedTo: null,
    extensionUsed: false,
    items: {
      orientation: { done: true, attestedBy: 'cp-1', attestedAt: daysAgo(50) },
      workshops: { count: 2, attestations: [] },
      sprintTask: { taskId: 't1', completedAt: daysAgo(10), detectedBy: 'auto' },
    },
    conduct: { acknowledged: true, acknowledgedAt: daysAgo(40) },
    duesGate: { status: 'not_checked', lastCheckedAt: null, duesStatus: null },
    decision: { outcome: null, decidedBy: null, decidedByRole: null, decidedAt: null, round: 1, note: null, memberNote: null, exitReason: null, resolutionOf: null, chosenRecommendation: null },
    membershipClassWritePending: false,
    ...overrides,
  };
  mockDocs['applications/app-1'] = { userId: 'cadet-1', status: 'approved' };
}

function seedRoles(): void {
  mockDocs['roles/cp-1'] = { role: 'chapter_president', chapterId: 'ist' };
  mockDocs['roles/cp-2'] = { role: 'chapter_president', chapterId: 'other-chapter' };
  mockDocs['roles/nmd-1'] = { role: 'national_membership_director' };
  mockDocs['roles/lead-1'] = { role: 'member' };
  mockDocs['tasks/t1'] = { assignerId: 'lead-1', status: 'completed' };
}

function seedEvaluation(role: string, recommendation: string): void {
  mockDocs[`cadetships/c1/evaluations/${role}`] = {
    evaluatorUid: role === 'chapter_president' ? 'cp-1' : 'lead-1',
    evaluatorRoleKey: role,
    evaluatorChapterId: 'ist',
    recommendation,
    note: 'x'.repeat(45),
    submittedAt: daysAgo(2),
    revisedAt: null,
    singleEvaluatorReason: null,
  };
}

beforeEach(() => {
  mockDocs = {};
  autoId = 0;
  mockState.uid = 'cadet-1';
  mockState.duesStatus = 'paid';
  mockState.classWriteFails = false;
  mockState.classWrites = [];
  seedRoles();
  seedCadetship();
});

// ------------------------------------------------------------------- attest
describe('POST attest (F.4 evidence-type permissions)', () => {
  it('chapter president attests orientation', async () => {
    seedCadetship({ items: { orientation: { done: false, attestedBy: null, attestedAt: null }, workshops: { count: 0, attestations: [] }, sprintTask: { taskId: null, completedAt: null, detectedBy: null } } });
    mockState.uid = 'cp-1';
    const res: any = await attestPOST(req({ item: 'orientation' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].items.orientation.done).toBe(true);
    expect(mockDocs['cadetships/c1'].items.orientation.attestedBy).toBe('cp-1');
  });

  it('the cadet cannot attest their own orientation', async () => {
    mockState.uid = 'cadet-1';
    const res: any = await attestPOST(req({ item: 'orientation' }), params('c1'));
    expect(res.status).toBe(403);
  });

  it('an officer of ANOTHER chapter cannot attest', async () => {
    mockState.uid = 'cp-2';
    const res: any = await attestPOST(req({ item: 'orientation' }), params('c1'));
    expect(res.status).toBe(403);
  });

  it('workshops cap at 2: the third attestation is a 409', async () => {
    mockState.uid = 'nmd-1';
    const res: any = await attestPOST(req({ item: 'workshop', eventRef: 'WS3' }), params('c1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('WORKSHOPS_COMPLETE');
  });

  it('workshop attestation appends and increments below the cap', async () => {
    seedCadetship({ items: { orientation: { done: true, attestedBy: 'cp-1', attestedAt: daysAgo(50) }, workshops: { count: 1, attestations: [{ attestedBy: 'cp-1', attestedAt: daysAgo(30), eventRef: 'WS1' }] }, sprintTask: { taskId: 't1', completedAt: daysAgo(10), detectedBy: 'auto' } } });
    mockState.uid = 'cp-1';
    const res: any = await attestPOST(req({ item: 'workshop', eventRef: 'WS2' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].items.workshops.count).toBe(2);
    expect(mockDocs['cadetships/c1'].items.workshops.attestations[1].eventRef).toBe('WS2');
  });
});

// ------------------------------------------------------------------ conduct
describe('POST me/acknowledge-conduct (the only cadet self-write)', () => {
  it('the cadet acknowledges their own conduct block', async () => {
    seedCadetship({ conduct: { acknowledged: false, acknowledgedAt: null } });
    mockState.uid = 'cadet-1';
    const res: any = await conductPOST(req());
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].conduct.acknowledged).toBe(true);
  });

  it('an officer cannot acknowledge on the cadet behalf (404: not their record)', async () => {
    mockState.uid = 'cp-1';
    const res: any = await conductPOST(req());
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------- evaluations
describe('POST evaluations (F.5 eligibility + note lengths + collapse)', () => {
  it('CP submits the chapter_president doc; a bare confirm note (1 char) is enough', async () => {
    mockState.uid = 'cp-1';
    const res: any = await evalPOST(req({ evaluatorRole: 'chapter_president', recommendation: 'confirm', note: 'y' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1/evaluations/chapter_president'].recommendation).toBe('confirm');
  });

  it('an extend/exit note under 40 chars is rejected', async () => {
    mockState.uid = 'cp-1';
    const res: any = await evalPOST(req({ evaluatorRole: 'chapter_president', recommendation: 'exit', note: 'too short' }), params('c1'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NOTE_TOO_SHORT');
  });

  it('a non-CP cannot submit the CP doc', async () => {
    mockState.uid = 'lead-1';
    const res: any = await evalPOST(req({ evaluatorRole: 'chapter_president', recommendation: 'confirm', note: 'y' }), params('c1'));
    expect(res.status).toBe(403);
  });

  it('the resolved team lead submits the team_lead doc', async () => {
    mockState.uid = 'lead-1';
    const res: any = await evalPOST(req({ evaluatorRole: 'team_lead', recommendation: 'exit', note: 'x'.repeat(45) }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1/evaluations/team_lead'].evaluatorUid).toBe('lead-1');
  });

  it('the CP cannot submit the team_lead doc while a lead exists', async () => {
    mockState.uid = 'cp-1';
    const res: any = await evalPOST(req({ evaluatorRole: 'team_lead', recommendation: 'confirm', note: 'y' }), params('c1'));
    expect(res.status).toBe(403);
  });

  it('collapse: with no sprint task and no VP, the CP submits team_lead and the record says so', async () => {
    seedCadetship({ items: { orientation: { done: false, attestedBy: null, attestedAt: null }, workshops: { count: 0, attestations: [] }, sprintTask: { taskId: null, completedAt: null, detectedBy: null } } });
    delete mockDocs['tasks/t1'];
    mockState.uid = 'cp-1';
    const res: any = await evalPOST(req({ evaluatorRole: 'team_lead', recommendation: 'confirm', note: 'y' }), params('c1'));
    expect(res.status).toBe(200);
    const doc = mockDocs['cadetships/c1/evaluations/team_lead'];
    expect(doc.evaluatorUid).toBe('cp-1');
    expect(doc.singleEvaluatorReason).toBe('no_team_lead');
  });

  it('resubmission overwrites the own doc and stamps revisedAt', async () => {
    seedEvaluation('chapter_president', 'confirm');
    mockState.uid = 'cp-1';
    const res: any = await evalPOST(req({ evaluatorRole: 'chapter_president', recommendation: 'exit', note: 'x'.repeat(45) }), params('c1'));
    expect(res.status).toBe(200);
    const doc = mockDocs['cadetships/c1/evaluations/chapter_president'];
    expect(doc.recommendation).toBe('exit');
    expect(doc.revisedAt).not.toBeNull();
  });
});

// ----------------------------------------------------------------- decision
describe('POST decision (F.3 actor split, F.5 agreement, F.7 dues gate)', () => {
  function bothEval(rec: string): void {
    seedEvaluation('chapter_president', rec);
    seedEvaluation('team_lead', rec);
  }

  it('confirm happy path: checklist + both confirm + dues paid -> confirmed, no class write (retired, GOV-03), mirror', async () => {
    bothEval('confirm');
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'confirm' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].status).toBe('confirmed');
    expect(mockDocs['cadetships/c1'].decision.decidedByRole).toBe('national_membership_director');
    expect(mockDocs['cadetships/c1'].duesGate.status).toBe('passed');
    // Full Member status derives from the `member` role; confirmation
    // writes no membership class and leaves nothing pending.
    expect(mockState.classWrites).toEqual([]);
    expect((await res.json()).membershipClassWritePending).toBe(false);
    expect(mockDocs['applications/app-1'].cadetshipOutcome).toBe('confirmed');
  });

  it('dues no_record BLOCKS confirmation (Z-15): 409, snapshot stored, decision NOT recorded', async () => {
    bothEval('confirm');
    mockState.duesStatus = 'no_record';
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'confirm' }), params('c1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('DUES_UNPAID');
    expect(mockDocs['cadetships/c1'].status).toBe('under_review');
    expect(mockDocs['cadetships/c1'].decision.outcome).toBeNull();
    expect(mockDocs['cadetships/c1'].duesGate.status).toBe('blocked');
    expect(mockDocs['cadetships/c1'].duesGate.duesStatus).toBe('no_record');
    expect(mockState.classWrites).toHaveLength(0);
  });

  it('confirm by the CP is forbidden (actor split)', async () => {
    bothEval('confirm');
    mockState.uid = 'cp-1';
    const res: any = await decisionPOST(req({ outcome: 'confirm' }), params('c1'));
    expect(res.status).toBe(403);
  });

  it('confirm with one evaluation missing -> 409 EVALUATIONS_INCOMPLETE', async () => {
    seedEvaluation('chapter_president', 'confirm');
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'confirm' }), params('c1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('EVALUATIONS_INCOMPLETE');
  });

  it('confirm with an incomplete checklist -> 409 CHECKLIST_INCOMPLETE (server recompute)', async () => {
    seedCadetship({ conduct: { acknowledged: false, acknowledgedAt: null } });
    bothEval('confirm');
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'confirm' }), params('c1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('CHECKLIST_INCOMPLETE');
  });

  it('confirm never attempts a class write, so no write can pend (writer retired, GOV-03)', async () => {
    bothEval('confirm');
    // Even with the (mocked, now uncalled) writer set to fail, the
    // confirm path invokes no class write at all.
    mockState.classWriteFails = true;
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'confirm' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].status).toBe('confirmed');
    expect(mockState.classWrites).toEqual([]);
    expect(mockDocs['cadetships/c1'].membershipClassWritePending).toBe(false);
  });

  it('disagreement: NMD confirms by choosing a submitted recommendation', async () => {
    seedEvaluation('chapter_president', 'confirm');
    seedEvaluation('team_lead', 'exit');
    mockState.uid = 'nmd-1';
    const blocked: any = await decisionPOST(req({ outcome: 'confirm' }), params('c1'));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe('EVALUATION_DISAGREEMENT');
    const res: any = await decisionPOST(
      req({ outcome: 'confirm', resolutionOf: 'disagreement', chosenRecommendation: 'confirm' }),
      params('c1'),
    );
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].decision.resolutionOf).toBe('disagreement');
    expect(mockDocs['cadetships/c1'].decision.chosenRecommendation).toBe('confirm');
  });

  it('extend: both evaluators extend + CP + note -> extended once, +28 days from probationEnd', async () => {
    bothEval('extend');
    mockState.uid = 'cp-1';
    const res: any = await decisionPOST(req({ outcome: 'extend', note: 'Needs one more cycle.' }), params('c1'));
    expect(res.status).toBe(200);
    const doc = mockDocs['cadetships/c1'];
    expect(doc.status).toBe('extended');
    expect(doc.extensionUsed).toBe(true);
    const expected = new Date(doc.probationEnd.getTime() + 28 * DAY).toISOString();
    expect(doc.extendedTo.toISOString()).toBe(expected);
  });

  it('extension against BOTH evaluators is not permitted', async () => {
    bothEval('confirm');
    mockState.uid = 'cp-1';
    const res: any = await decisionPOST(req({ outcome: 'extend', note: 'More time anyway.' }), params('c1'));
    expect(res.status).toBe(409);
  });

  it('round 2: choosing extend as a disagreement resolution is rejected (one extension max)', async () => {
    seedCadetship({
      status: 'extended',
      extensionUsed: true,
      extendedTo: daysAgo(1),
      decision: { outcome: 'extended', decidedBy: 'cp-1', decidedByRole: 'chapter_president', decidedAt: daysAgo(30), round: 1, note: 'n', memberNote: null, exitReason: null, resolutionOf: null, chosenRecommendation: null },
    });
    seedEvaluation('chapter_president', 'extend');
    seedEvaluation('team_lead', 'confirm');
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(
      req({ outcome: 'extend', note: 'Again.', resolutionOf: 'disagreement', chosenRecommendation: 'extend' }),
      params('c1'),
    );
    expect(res.status).toBe(409);
  });

  it('exit: both evaluators exit + NMD + reason -> exited, mirrored', async () => {
    bothEval('exit');
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'exit', exitReason: 'evaluation_failed' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].status).toBe('exited');
    expect(mockDocs['cadetships/c1'].decision.exitReason).toBe('evaluation_failed');
    expect(mockDocs['applications/app-1'].cadetshipOutcome).toBe('exited');
  });

  it('ghost exception: zero items, zero evaluations, 19 days under review, no_engagement -> exit allowed', async () => {
    const startedAt = daysAgo(75); // probationEnd = 19 days ago
    seedCadetship({
      startedAt,
      probationEnd: new Date(startedAt.getTime() + 56 * DAY),
      items: {
        orientation: { done: false, attestedBy: null, attestedAt: null },
        workshops: { count: 0, attestations: [] },
        sprintTask: { taskId: null, completedAt: null, detectedBy: null },
      },
      conduct: { acknowledged: false, acknowledgedAt: null },
    });
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'exit', exitReason: 'no_engagement', note: 'Never engaged.' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].status).toBe('exited');
  });

  it('ghost exception does NOT apply before 14 days in under_review', async () => {
    const startedAt = daysAgo(60); // probationEnd = 4 days ago (default seed)
    seedCadetship({
      items: {
        orientation: { done: false, attestedBy: null, attestedAt: null },
        workshops: { count: 0, attestations: [] },
        sprintTask: { taskId: null, completedAt: null, detectedBy: null },
      },
      conduct: { acknowledged: false, acknowledgedAt: null },
    });
    void startedAt;
    mockState.uid = 'nmd-1';
    const res: any = await decisionPOST(req({ outcome: 'exit', exitReason: 'no_engagement' }), params('c1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('EVALUATIONS_INCOMPLETE');
  });

  it('early exit from active: withdrew is allowed mid-window; evaluation_failed is not', async () => {
    seedCadetship({ status: 'active', startedAt: daysAgo(10), probationEnd: daysAgo(-46) });
    mockState.uid = 'nmd-1';
    const bad: any = await decisionPOST(req({ outcome: 'exit', exitReason: 'evaluation_failed' }), params('c1'));
    expect(bad.status).toBe(409);
    const res: any = await decisionPOST(req({ outcome: 'exit', exitReason: 'withdrew' }), params('c1'));
    expect(res.status).toBe(200);
    expect(mockDocs['cadetships/c1'].status).toBe('exited');
  });
});

// --------------------------------------------------------------------- read
describe('GET /api/cadetships/[id] (subject evaluation visibility)', () => {
  it('the cadet does NOT see evaluations while under review', async () => {
    seedEvaluation('chapter_president', 'confirm');
    seedEvaluation('team_lead', 'confirm');
    mockState.uid = 'cadet-1';
    const res: any = await getOne(req(), params('c1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evaluations).toHaveLength(0);
    expect(body.cadetship.effectiveStatus).toBe('under_review');
  });

  it('the cadet sees evaluations once confirmed', async () => {
    seedCadetship({ status: 'confirmed' });
    seedEvaluation('chapter_president', 'confirm');
    seedEvaluation('team_lead', 'confirm');
    mockState.uid = 'cadet-1';
    const res: any = await getOne(req(), params('c1'));
    expect(res.status).toBe(200);
    expect((await res.json()).evaluations).toHaveLength(2);
  });

  it('an unrelated user is forbidden', async () => {
    mockState.uid = 'stranger-9';
    const res: any = await getOne(req(), params('c1'));
    expect(res.status).toBe(403);
  });
});
