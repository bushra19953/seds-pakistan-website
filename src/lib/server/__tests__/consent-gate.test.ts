/**
 * Consent gate unit tests (spec B.7). The A lookup, the settings reader, and
 * the audit writer are mocked; the gate logic itself is the real module.
 */

jest.mock('@/lib/server/consent-lookup', () => ({
  getDecidedConsent: jest.fn(),
  consumeConsent: jest.fn(),
  listDecidedConsentCandidates: jest.fn(),
}));

jest.mock('@/lib/server/governance-settings', () => ({
  getConsentMatterSettings: jest.fn(),
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(),
  GovernanceAuditError: class GovernanceAuditError extends Error {},
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => null,
}));

// founder-gate's assertFounder pulls in next/server via verifySession, which
// jsdom cannot load; the gate only consumes the pure isFounderUid from it.
jest.mock('@/lib/server/founder-gate', () => {
  const { FOUNDER_UID: FOUNDER } = require('@/lib/roles');
  return {
    isFounderUid: (uid: string | null | undefined) =>
      typeof uid === 'string' && uid.length > 0 && uid === FOUNDER,
  };
});

// Fix 1 (plan 3.1.2/3.1.4): the gate resolves the founder_patron role arm
// through permissions.resolveUserRole and writes the auto-consent record
// through consent-service.createFounderActConsent. Both are mocked here
// following the neighbouring per-module mock pattern above.
jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: jest.fn(),
}));

jest.mock('@/lib/server/consent-service', () => ({
  createFounderActConsent: jest.fn(),
}));

import { FOUNDER_UID } from '@/lib/roles';
import {
  assertConsentFor,
  ConsentRequiredError,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate';
import {
  getDecidedConsent,
  consumeConsent,
  listDecidedConsentCandidates,
} from '@/lib/server/consent-lookup';
import { getConsentMatterSettings } from '@/lib/server/governance-settings';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { resolveUserRole } from '@/lib/server/permissions';
import { createFounderActConsent } from '@/lib/server/consent-service';

const mockGetDecided = getDecidedConsent as jest.Mock;
const mockConsume = consumeConsent as jest.Mock;
const mockSettings = getConsentMatterSettings as jest.Mock;
const mockAudit = writeGovernanceAuditOrThrow as jest.Mock;
const mockResolveRole = resolveUserRole as jest.Mock;
const mockCreateFounder = createFounderActConsent as jest.Mock;
const mockListCandidates = listDecidedConsentCandidates as jest.Mock;

const NOW = new Date('2026-10-21T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const SUBJECT: ConsentSubjectRef = {
  type: 'user_role',
  targetUid: 'user-1',
  roleKey: 'president_national',
  action: 'appoint',
};

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cr-1',
    matterKey: 'catb_officer',
    status: 'consented',
    subjectRef: { ...SUBJECT },
    decidedAt: new Date(NOW.getTime() - 1 * DAY),
    proposedActDate: new Date(NOW.getTime() + 10 * DAY),
    consumedAt: null,
    ...overrides,
  };
}

function makeFakeDb(opts: { taskAddFails?: boolean } = {}) {
  const added: Array<{ collection: string; data: Record<string, unknown> }> = [];
  const sets: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const db = {
    collection: (name: string) => ({
      add: async (data: Record<string, unknown>) => {
        if (opts.taskAddFails && name === 'tasks') throw new Error('tasks write failed');
        added.push({ collection: name, data });
        return { id: 'task-1' };
      },
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>) => {
          sets.push({ collection: name, id, data });
        },
      }),
    }),
  };
  return { db: db as never, added, sets };
}

function baseArgs(db: never, overrides: Record<string, unknown> = {}) {
  return {
    db,
    actorUid: 'admin-1',
    matterKey: 'catb_officer' as const,
    consentRequestId: 'cr-1',
    subjectRef: SUBJECT,
    actSummary: 'Appoint officer',
    now: NOW,
    ...overrides,
  };
}

async function expectBlock(promise: Promise<unknown>, reason: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConsentRequiredError);
  expect((err as ConsentRequiredError).reason).toBe(reason);
  expect((err as ConsentRequiredError).httpStatus).toBe(409);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings.mockResolvedValue({ mode: 'hard', validityDays: 90, source: 'doc' });
  mockAudit.mockResolvedValue('audit-1');
  mockConsume.mockResolvedValue('consumed');
  mockGetDecided.mockResolvedValue(baseRequest());
  // Fix 1 defaults: actor is not a founder_patron holder, no pre-existing
  // decided candidates, and the writer mints a fresh record.
  mockResolveRole.mockResolvedValue(null);
  mockListCandidates.mockResolvedValue([]);
  mockCreateFounder.mockResolvedValue({
    id: 'cr-auto-1',
    requestNumber: 'FC-2026-0007',
    reused: false,
  });
});

describe('hard mode passes', () => {
  it('passes on consented status with matching matter and subject', async () => {
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db));
    expect(result).toEqual({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  });

  it('consumes the consent on pass and stamps consumedBy and consumedActRef', async () => {
    const { db } = makeFakeDb();
    await assertConsentFor(baseArgs(db));
    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockConsume).toHaveBeenCalledWith(db, 'cr-1', 'admin-1', 'roles/user-1');
  });

  it('passes on conditional consent satisfied by the Founder', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({
        status: 'conditional',
        conditionsSatisfied: true,
        conditionsSatisfiedBy: FOUNDER_UID,
      }),
    );
    const { db } = makeFakeDb();
    await expect(assertConsentFor(baseArgs(db))).resolves.toMatchObject({ outcome: 'consented' });
  });

  it('passes on conditional consent satisfied by the named verifier', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({
        status: 'conditional',
        conditionsSatisfied: true,
        conditionsSatisfiedBy: 'verifier-1',
        conditionsVerifierUid: 'verifier-1',
      }),
    );
    const { db } = makeFakeDb();
    await expect(assertConsentFor(baseArgs(db))).resolves.toMatchObject({ outcome: 'consented' });
  });

  it('passes one day inside the validity window', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({
        decidedAt: new Date(NOW.getTime() - 10 * DAY),
        proposedActDate: new Date(NOW.getTime() - 1 * DAY),
      }),
    );
    const { db } = makeFakeDb();
    await expect(assertConsentFor(baseArgs(db))).resolves.toMatchObject({ outcome: 'consented' });
  });

  // UPDATED for Fix 1 (plan 4.2a): the old founder_actor pass wrote no
  // record. A founder act now writes exactly one decided consent record
  // through createFounderActConsent and returns outcome founder_act.
  it('founder actor writes exactly one auto-consent record and passes as founder_act', async () => {
    const { db } = makeFakeDb();
    const result = await assertConsentFor(
      baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }),
    );
    expect(result).toEqual({ mode: 'hard', outcome: 'founder_act', consentRequestId: 'cr-auto-1' });
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
    expect(mockCreateFounder).toHaveBeenCalledWith(db, {
      actorUid: FOUNDER_UID,
      matterKey: 'catb_officer',
      subjectRef: SUBJECT,
      proposedAct: 'Appoint officer',
      gateMode: 'hard',
      now: NOW,
    });
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'consent_gate_pass',
        details: expect.objectContaining({
          consentBasis: 'founder_act',
          decidedVia: 'founder-act',
          consentRequestId: 'cr-auto-1',
        }),
      }),
    );
  });
});

describe('hard mode blocks', () => {
  it('blocks conditional consent when conditions are not satisfied', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({ status: 'conditional', conditionsSatisfied: false }),
    );
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'conditional_unmet');
  });

  it('blocks conditional consent satisfied by the requester', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({
        status: 'conditional',
        conditionsSatisfied: true,
        conditionsSatisfiedBy: 'admin-1',
      }),
    );
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'conditional_unmet');
  });

  it('blocks on refused', async () => {
    mockGetDecided.mockResolvedValue(baseRequest({ status: 'refused' }));
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'refused');
  });

  it('blocks on deemed_withheld (silence is never consent)', async () => {
    mockGetDecided.mockResolvedValue(baseRequest({ status: 'deemed_withheld' }));
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'deemed_withheld');
  });

  it('blocks on pending (not_decided)', async () => {
    mockGetDecided.mockResolvedValue(baseRequest({ status: 'pending' }));
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'not_decided');
  });

  it('blocks when consentRequestId is missing in hard mode', async () => {
    const { db } = makeFakeDb();
    await expectBlock(
      assertConsentFor(baseArgs(db, { consentRequestId: undefined })),
      'missing',
    );
    expect(mockGetDecided).not.toHaveBeenCalled();
  });

  it('blocks when the request does not exist', async () => {
    mockGetDecided.mockResolvedValue(null);
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'not_found');
  });

  it('blocks on wrong matter', async () => {
    mockGetDecided.mockResolvedValue(baseRequest({ matterKey: 'chapter_lifecycle' }));
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'wrong_matter');
  });

  it('blocks on wrong subject uid', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({ subjectRef: { ...SUBJECT, targetUid: 'someone-else' } }),
    );
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'wrong_subject');
  });

  it('blocks on wrong subject action (appoint consent used for removal)', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({ subjectRef: { ...SUBJECT, action: 'remove' } }),
    );
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'wrong_subject');
  });

  it('blocks on expired consent past decidedAt + validityDays', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({
        decidedAt: new Date(NOW.getTime() - 100 * DAY),
        proposedActDate: null,
      }),
    );
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'expired');
  });

  it('blocks on expired consent past proposedActDate + 30 days even inside validityDays (earliest-of)', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({
        decidedAt: new Date(NOW.getTime() - 10 * DAY),
        proposedActDate: new Date(NOW.getTime() - 40 * DAY),
      }),
    );
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'expired');
  });

  it('blocks a second use when the consent is already consumed', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({ consumedAt: new Date(NOW.getTime() - 1 * DAY), consumedBy: 'admin-9' }),
    );
    const { db } = makeFakeDb();
    await expectBlock(assertConsentFor(baseArgs(db)), 'already_consumed');
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('concurrent double-call: exactly one wins, the loser gets already_consumed', async () => {
    mockConsume
      .mockResolvedValueOnce('consumed')
      .mockResolvedValueOnce('already_consumed');
    const { db } = makeFakeDb();
    const results = await Promise.allSettled([
      assertConsentFor(baseArgs(db)),
      assertConsentFor(baseArgs(db)),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as ConsentRequiredError;
    expect(reason).toBeInstanceOf(ConsentRequiredError);
    expect(reason.reason).toBe('already_consumed');
  });

  it('infrastructure failure in hard mode throws a non-ConsentRequiredError (fail closed)', async () => {
    mockGetDecided.mockRejectedValue(new Error('firestore unavailable'));
    const { db } = makeFakeDb();
    const err = await assertConsentFor(baseArgs(db)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConsentRequiredError);
  });
});

describe('record mode', () => {
  beforeEach(() => {
    mockSettings.mockResolvedValue({ mode: 'record', validityDays: 90, source: 'doc' });
  });

  it('never throws: proceeds with no id, writes audit + Founder task, does not consume', async () => {
    const { db, added } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db, { consentRequestId: undefined }));
    expect(result).toMatchObject({ mode: 'record', outcome: 'recorded' });
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'consent_gate_record',
        details: expect.objectContaining({ observation: 'would_block:missing' }),
      }),
    );
    const task = added.find((a) => a.collection === 'tasks');
    expect(task).toBeDefined();
    expect(task?.data.assigneeIds).toEqual([FOUNDER_UID]);
    expect(task?.data.consentGateRecord).toBe(true);
  });

  it('never throws with a refused consent and reports the observation', async () => {
    mockGetDecided.mockResolvedValue(baseRequest({ status: 'refused' }));
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db));
    expect(result).toMatchObject({ mode: 'record', outcome: 'recorded' });
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'consent_gate_record',
        details: expect.objectContaining({ observation: 'would_block:refused' }),
      }),
    );
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('never throws with an expired consent', async () => {
    mockGetDecided.mockResolvedValue(
      baseRequest({
        decidedAt: new Date(NOW.getTime() - 100 * DAY),
        proposedActDate: null,
      }),
    );
    const { db } = makeFakeDb();
    await expect(assertConsentFor(baseArgs(db))).resolves.toMatchObject({
      mode: 'record',
      outcome: 'recorded',
    });
  });

  it('still proceeds when retroactive task creation fails', async () => {
    const { db } = makeFakeDb({ taskAddFails: true });
    await expect(assertConsentFor(baseArgs(db))).resolves.toMatchObject({
      mode: 'record',
      outcome: 'recorded',
    });
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: 'consent_gate_record' }),
    );
  });

  it('missing settings doc defaults the matter to record and logs', async () => {
    mockSettings.mockResolvedValue({ mode: 'record', validityDays: 90, source: 'missing' });
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db));
    expect(result).toMatchObject({ mode: 'record', outcome: 'recorded' });
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: 'consent_gate_settings_missing' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 1 Tier 1 (plan 4.2a): founder recognition arms, dedupe, record mode,
// the G12 opt-out, and fail-closed writer behaviour. The real record shape
// is proven in consent-service.test.ts (createFounderActConsent); here the
// writer is a mock and the gate's decisions about WHEN to call it are the
// subject under test.
// ---------------------------------------------------------------------------

describe('founder auto-consent (Fix 1)', () => {
  it('role arm: a founder_patron holder who is not the founder UID passes as founder_act with one writer call', async () => {
    mockResolveRole.mockResolvedValue('founder_patron');
    const { db } = makeFakeDb();
    const result = await assertConsentFor(
      baseArgs(db, { actorUid: 'patron-2', consentRequestId: undefined }),
    );
    expect(result).toEqual({ mode: 'hard', outcome: 'founder_act', consentRequestId: 'cr-auto-1' });
    expect(mockResolveRole).toHaveBeenCalledWith(db, 'patron-2');
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
    expect(mockCreateFounder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ actorUid: 'patron-2' }),
    );
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it.each(['chief_technology_officer', 'superadmin', 'president_national'])(
    'no third path: resolveUserRole -> %s is NOT a founder and blocks missing with no writer call',
    async (role) => {
      mockResolveRole.mockResolvedValue(role);
      const { db } = makeFakeDb();
      await expectBlock(
        assertConsentFor(baseArgs(db, { actorUid: 'admin-9', consentRequestId: undefined })),
        'missing',
      );
      expect(mockCreateFounder).not.toHaveBeenCalled();
    },
  );

  it('no third path: an unresolvable role (null) falls to the normal gate and blocks missing', async () => {
    mockResolveRole.mockResolvedValue(null);
    const { db } = makeFakeDb();
    await expectBlock(
      assertConsentFor(baseArgs(db, { actorUid: 'admin-9', consentRequestId: undefined })),
      'missing',
    );
    expect(mockCreateFounder).not.toHaveBeenCalled();
  });

  it('dedupe by supplied id: a usable decided consent is reused WITHOUT consumption and WITHOUT a writer call', async () => {
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db, { actorUid: FOUNDER_UID }));
    expect(result).toEqual({ mode: 'hard', outcome: 'founder_act', consentRequestId: 'cr-1' });
    expect(mockCreateFounder).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'consent_gate_pass',
        details: expect.objectContaining({
          consentBasis: 'existing_decided',
          consentRequestId: 'cr-1',
        }),
      }),
    );
  });

  it('dedupe by supplied id: a legacy filed doc with no subjectRef cannot be proven for this subject, so a fresh record is written instead', async () => {
    mockGetDecided.mockResolvedValue(baseRequest({ subjectRef: undefined }));
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db, { actorUid: FOUNDER_UID }));
    expect(result).toEqual({ mode: 'hard', outcome: 'founder_act', consentRequestId: 'cr-auto-1' });
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('dedupe by subject: an existing decided consent for the same subject+action is reused, writer not called', async () => {
    mockListCandidates.mockResolvedValue([baseRequest({ id: 'cand-9' })]);
    const { db } = makeFakeDb();
    const result = await assertConsentFor(
      baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }),
    );
    expect(result).toEqual({ mode: 'hard', outcome: 'founder_act', consentRequestId: 'cand-9' });
    expect(mockListCandidates).toHaveBeenCalledWith(db, 'catb_officer');
    expect(mockCreateFounder).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('dedupe by subject: a consumed candidate is NOT reused (writer called instead)', async () => {
    mockListCandidates.mockResolvedValue([
      baseRequest({ id: 'cand-used', consumedAt: new Date(NOW.getTime() - DAY) }),
    ]);
    const { db } = makeFakeDb();
    const result = await assertConsentFor(
      baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }),
    );
    expect(result).toEqual({ mode: 'hard', outcome: 'founder_act', consentRequestId: 'cr-auto-1' });
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
  });

  it('dedupe by subject: an expired candidate is NOT reused (writer called instead)', async () => {
    mockListCandidates.mockResolvedValue([
      baseRequest({
        id: 'cand-old',
        decidedAt: new Date(NOW.getTime() - 100 * DAY),
        proposedActDate: null,
      }),
    ]);
    const { db } = makeFakeDb();
    await assertConsentFor(baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }));
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
  });

  it('dedupe by subject: a candidate for a different subject is NOT reused (writer called instead)', async () => {
    mockListCandidates.mockResolvedValue([
      baseRequest({ id: 'cand-other', subjectRef: { ...SUBJECT, targetUid: 'someone-else' } }),
    ]);
    const { db } = makeFakeDb();
    await assertConsentFor(baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }));
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
  });

  it('dedupe by subject: a conditional candidate with unmet conditions is NOT reused (writer called instead)', async () => {
    mockListCandidates.mockResolvedValue([
      baseRequest({ id: 'cand-cond', status: 'conditional', conditionsSatisfied: false }),
    ]);
    const { db } = makeFakeDb();
    await assertConsentFor(baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }));
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
  });

  it('record mode: a founder act writes the consent record and produces NO retroactive-consent task or record-mode audit', async () => {
    mockSettings.mockResolvedValue({ mode: 'record', validityDays: 90, source: 'doc' });
    const { db, added } = makeFakeDb();
    const result = await assertConsentFor(
      baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }),
    );
    expect(result).toEqual({ mode: 'record', outcome: 'founder_act', consentRequestId: 'cr-auto-1' });
    expect(mockCreateFounder).toHaveBeenCalledTimes(1);
    expect(mockCreateFounder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ gateMode: 'record' }),
    );
    expect(added.filter((a) => a.collection === 'tasks')).toHaveLength(0);
    const auditActions = mockAudit.mock.calls.map(
      (c) => (c[1] as { action?: string })?.action,
    );
    expect(auditActions).not.toContain('consent_gate_record');
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('opt-out (G12): allowFounderAutoConsent:false keeps the legacy founder_actor pass and writes NO record', async () => {
    const { db } = makeFakeDb();
    const result = await assertConsentFor(
      baseArgs(db, {
        actorUid: FOUNDER_UID,
        consentRequestId: undefined,
        allowFounderAutoConsent: false,
      }),
    );
    expect(result).toEqual({ mode: 'hard', outcome: 'founder_actor' });
    expect(mockCreateFounder).not.toHaveBeenCalled();
    expect(mockListCandidates).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'consent_gate_pass',
        details: expect.objectContaining({ consentBasis: 'founder_actor' }),
      }),
    );
  });

  it('writer failure propagates as a non-ConsentRequiredError and the act does not proceed (fail closed)', async () => {
    mockCreateFounder.mockRejectedValue(new Error('consent write failed'));
    const { db } = makeFakeDb();
    const err = await assertConsentFor(
      baseArgs(db, { actorUid: FOUNDER_UID, consentRequestId: undefined }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConsentRequiredError);
    expect((err as Error).message).toBe('consent write failed');
  });

  it('no db: a founder act fails closed before any record can be written', async () => {
    const err = await assertConsentFor(
      baseArgs(undefined as never, { actorUid: FOUNDER_UID, consentRequestId: undefined }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConsentRequiredError);
    expect(mockCreateFounder).not.toHaveBeenCalled();
  });
});
