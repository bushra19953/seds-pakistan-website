/**
 * GOLDEN non-founder behaviour (agent 15, Test Author C).
 *
 * Invariant under test: for NON-founders, Reserved Matter behaviour on
 * this branch (feat/founder-consent-fix) is identical to production
 * a3c9702 — same gate outcome, same status, same error body — in the
 * three consent states:
 *   (a) no consent on file,
 *   (b) a PENDING (undecided) consent on file,
 *   (c) a DECIDED consent on file,
 * and in NO non-founder case is a consent record auto-written or
 * marked decidedVia 'founder-act'.
 *
 * a3c9702 reference (git show a3c9702:src/lib/server/consent-gate.ts):
 *   - assertConsentFor checks the founder UID exemption first, then
 *     settings, then (hard mode) evaluateConsent:
 *       no id               -> block 'missing'
 *       id, lookup null     -> block 'not_found'
 *       status 'pending' (or any non-'consented', non-'refused',
 *         non-'deemed_withheld', unmet-'conditional' status)
 *                           -> block 'not_decided' / etc.
 *       status 'consented' (+ matching matter/subject, unexpired,
 *         unconsumed)       -> consume single-use, audit, pass
 *         { mode:'hard', outcome:'consented', consentRequestId }
 *   - Every block is a ConsentRequiredError (consent-gate-types.ts):
 *     code 'CONSENT_REQUIRED', httpStatus 409, message
 *     `Founder Consent required (<matter>: <reason>)`, fileRequestUrl
 *     from buildConsentFileUrl. consentGateHttpError maps it to
 *     status 409 + body { error, code, matter, reason, subject,
 *     consentRequestId, fileRequestUrl } — exactly, no extra keys.
 *
 * What the pre-existing branch suites did NOT pin (the gaps filled here):
 *   - the exact consentGateHttpError body (deep equality) for any
 *     non-founder block — consent-gate.test.ts only asserted
 *     err.reason + err.httpStatus;
 *   - createFounderActConsent / listDecidedConsentCandidates NOT called
 *     on the ordinary (a)/(b)/(c) non-founder paths — the old block/pass
 *     tests never asserted the writer mock;
 *   - the dedupe-leak guard: a usable decided consent for the same
 *     subject existing in the candidate list must NOT rescue a
 *     non-founder who supplied no id (founder Step B is founder-only);
 *   - powerful non-founder roles (president_national, CTO) and an
 *     explicit allowFounderAutoConsent:true flag must not turn a
 *     non-founder into a founder_act pass.
 *
 * Harness: identical mock pattern to consent-gate.test.ts (lookup,
 * settings, audit, role resolver and writer are mocked; the gate and
 * consentGateHttpError are the real modules). The store-level proof
 * with the REAL writer lives in
 * consent-nonfounder-golden-integration.test.ts.
 *
 * Branch movement note (2026-10-24): this suite was first written at
 * fc7d513, where founder admission was UID + a founder_patron role
 * arm via resolveUserRole. Commit f97d446 (Independent Security
 * Reviewer 1) then removed the role arm — admission is UID-ONLY,
 * exactly as at a3c9702, and resolveUserRole is never consulted for
 * founder recognition. The golden invariant is unchanged; the
 * powerful-role cases below now pin the stronger property: even a
 * resolved 'founder_patron' role does not qualify a non-founder UID.
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

jest.mock('@/lib/server/founder-gate', () => {
  const { FOUNDER_UID: FOUNDER } = require('@/lib/roles');
  return {
    isFounderUid: (uid: string | null | undefined) =>
      typeof uid === 'string' && uid.length > 0 && uid === FOUNDER,
  };
});

jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: jest.fn(),
}));

jest.mock('@/lib/server/consent-service', () => ({
  createFounderActConsent: jest.fn(),
}));

import { FOUNDER_UID } from '@/lib/roles';
import {
  assertConsentFor,
  consentGateHttpError,
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

// Exact a3c9702 fileRequestUrl for (catb_officer, SUBJECT):
// buildConsentFileUrl in consent-gate-types.ts (unchanged on branch).
const FILE_URL =
  '/admin/governance/consents/new?matter=catb_officer&subjectType=user_role&subject=' +
  '%7B%22type%22%3A%22user_role%22%2C%22targetUid%22%3A%22user-1%22%2C%22roleKey%22%3A%22president_national%22%2C%22action%22%3A%22appoint%22%7D';

function decidedRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function makeFakeDb() {
  const added: Array<{ collection: string; data: Record<string, unknown> }> = [];
  const sets: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const db = {
    collection: (name: string) => ({
      add: async (data: Record<string, unknown>) => {
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

/** No auto-consent machinery may run for a non-founder, in any state. */
function expectNoAutoConsent() {
  expect(mockCreateFounder).not.toHaveBeenCalled();
  expect(mockListCandidates).not.toHaveBeenCalled();
  // No audit entry may carry the founder-act provenance either.
  for (const call of mockAudit.mock.calls) {
    const details = (call[1] as { details?: Record<string, unknown> })?.details ?? {};
    expect(details.decidedVia).not.toBe('founder-act');
    expect(details.consentBasis).not.toBe('founder_act');
    expect(details.consentBasis).not.toBe('existing_decided');
  }
}

/**
 * Assert the block is byte-identical to a3c9702: the error object's own
 * fields AND the full consentGateHttpError mapping (deep equality —
 * an added or renamed body key fails this).
 */
async function expectGoldenBlock(
  promise: Promise<unknown>,
  reason: string,
  consentRequestId: string | null,
) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConsentRequiredError);
  const e = err as ConsentRequiredError;
  expect(e.name).toBe('ConsentRequiredError');
  expect(e.code).toBe('CONSENT_REQUIRED');
  expect(e.httpStatus).toBe(409);
  expect(e.message).toBe(`Founder Consent required (catb_officer: ${reason})`);
  expect(e.matterKey).toBe('catb_officer');
  expect(e.subjectRef).toEqual(SUBJECT);
  expect(e.consentRequestId).toBe(consentRequestId);
  expect(e.reason).toBe(reason);
  expect(e.fileRequestUrl).toBe(FILE_URL);
  expect(consentGateHttpError(e)).toEqual({
    status: 409,
    body: {
      error: 'CONSENT_REQUIRED',
      code: 'CONSENT_REQUIRED',
      matter: 'catb_officer',
      reason,
      subject: SUBJECT,
      consentRequestId,
      fileRequestUrl: FILE_URL,
    },
  });
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings.mockResolvedValue({ mode: 'hard', validityDays: 90, source: 'doc' });
  mockAudit.mockResolvedValue('audit-1');
  mockConsume.mockResolvedValue('consumed');
  mockGetDecided.mockResolvedValue(decidedRequest());
  // Default actor is a non-founder: no resolvable founder_patron role.
  mockResolveRole.mockResolvedValue(null);
  mockListCandidates.mockResolvedValue([]);
  mockCreateFounder.mockResolvedValue({
    id: 'cr-auto-1',
    requestNumber: 'FC-2026-0007',
    reused: false,
  });
});

// ---------------------------------------------------------------------------
// (a) No consent on file — hard mode blocks identically to a3c9702.
// ---------------------------------------------------------------------------

describe('GOLDEN (a) non-founder, no consent on file (hard mode)', () => {
  it('no consentRequestId at all: blocks missing with the exact 409 body, nothing written or consumed', async () => {
    const { db, added, sets } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(baseArgs(db, { consentRequestId: undefined })),
      'missing',
      null,
    );
    expect(mockGetDecided).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expectNoAutoConsent();
    expect(added).toHaveLength(0);
    expect(sets).toHaveLength(0);
  });

  it('explicit null consentRequestId: blocks missing identically', async () => {
    const { db } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(baseArgs(db, { consentRequestId: null })),
      'missing',
      null,
    );
    expect(mockConsume).not.toHaveBeenCalled();
    expectNoAutoConsent();
  });

  it('an id is supplied but no consent is on file for it: blocks not_found with the exact 409 body', async () => {
    mockGetDecided.mockResolvedValue(null);
    const { db } = makeFakeDb();
    await expectGoldenBlock(assertConsentFor(baseArgs(db)), 'not_found', 'cr-1');
    expect(mockGetDecided).toHaveBeenCalledWith(db, 'cr-1');
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expectNoAutoConsent();
  });

  it('dedupe-leak guard: a usable decided consent for the same subject exists in the candidate list, but a non-founder who supplied no id still blocks missing', async () => {
    // If founder Step B ever leaked to non-founders, this candidate
    // would rescue the call (or the writer would mint a record).
    mockListCandidates.mockResolvedValue([decidedRequest({ id: 'cand-usable' })]);
    const { db } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(baseArgs(db, { consentRequestId: undefined })),
      'missing',
      null,
    );
    expect(mockListCandidates).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expectNoAutoConsent();
  });

  it.each([
    ['president_national', 'officer-1'],
    ['chief_technology_officer', 'cto-1'],
    ['superadmin', 'legacy-admin-1'],
    ['founder_patron', 'patron-impostor-1'],
  ])(
    'powerful non-founder role %s: still blocks missing, no founder_act pass, no writer call, role resolver never consulted (UID-only admission, f97d446)',
    async (role, uid) => {
      // Even if a resolver WOULD return this role, the gate must not
      // consult it: founder admission is UID equality only.
      mockResolveRole.mockResolvedValue(role);
      const { db } = makeFakeDb();
      await expectGoldenBlock(
        assertConsentFor(baseArgs(db, { actorUid: uid, consentRequestId: undefined })),
        'missing',
        null,
      );
      expect(mockResolveRole).not.toHaveBeenCalled();
      expectNoAutoConsent();
    },
  );

  it('allowFounderAutoConsent:true does not help a non-founder (the flag is founder-branch only)', async () => {
    const { db } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(
        baseArgs(db, { consentRequestId: undefined, allowFounderAutoConsent: true }),
      ),
      'missing',
      null,
    );
    expectNoAutoConsent();
  });

  it('allowFounderAutoConsent:false does not change a non-founder block either', async () => {
    const { db } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(
        baseArgs(db, { consentRequestId: undefined, allowFounderAutoConsent: false }),
      ),
      'missing',
      null,
    );
    expectNoAutoConsent();
  });

  it('an actor whose resolved primary role is founder_patron but whose UID is not the founder UID blocks missing with the exact body (Reviewer 1 regression, golden form)', async () => {
    // firestore.rules permits a canManageRoles holder to client-write
    // roles/{own-uid}.role='founder_patron' (f97d446 header). That
    // planted role must buy nothing at this gate.
    mockResolveRole.mockResolvedValue('founder_patron');
    const { db } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(baseArgs(db, { actorUid: 'patron-impostor-1', consentRequestId: undefined })),
      'missing',
      null,
    );
    expect(mockResolveRole).not.toHaveBeenCalled();
    expectNoAutoConsent();
  });
});

// ---------------------------------------------------------------------------
// (b) A PENDING consent on file — still blocked identically.
// ---------------------------------------------------------------------------

describe('GOLDEN (b) non-founder, PENDING consent on file (hard mode)', () => {
  it('status pending: blocks not_decided with the exact 409 body, consent not consumed, nothing auto-written', async () => {
    mockGetDecided.mockResolvedValue(decidedRequest({ status: 'pending', decidedAt: null }));
    const { db, added, sets } = makeFakeDb();
    await expectGoldenBlock(assertConsentFor(baseArgs(db)), 'not_decided', 'cr-1');
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expectNoAutoConsent();
    expect(added).toHaveLength(0);
    expect(sets).toHaveLength(0);
  });

  it.each(['draft', 'further_information_requested', 'waived', 'cancelled', 'executed'])(
    'other undecided status %s: blocks not_decided identically (a3c9702 else-branch)',
    async (status) => {
      mockGetDecided.mockResolvedValue(decidedRequest({ status, decidedAt: null }));
      const { db } = makeFakeDb();
      await expectGoldenBlock(assertConsentFor(baseArgs(db)), 'not_decided', 'cr-1');
      expect(mockConsume).not.toHaveBeenCalled();
      expectNoAutoConsent();
    },
  );

  it('a pending consent for the same subject exists, but the caller supplied no id: blocks missing (by-id gate, no subject scan for non-founders)', async () => {
    mockListCandidates.mockResolvedValue([
      decidedRequest({ id: 'cand-pending', status: 'pending', decidedAt: null }),
    ]);
    const { db } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(baseArgs(db, { consentRequestId: undefined })),
      'missing',
      null,
    );
    expect(mockListCandidates).not.toHaveBeenCalled();
    expectNoAutoConsent();
  });

  it('pending consent held by a powerful non-founder (president_national) still blocks not_decided', async () => {
    mockResolveRole.mockResolvedValue('president_national');
    mockGetDecided.mockResolvedValue(decidedRequest({ status: 'pending', decidedAt: null }));
    const { db } = makeFakeDb();
    await expectGoldenBlock(
      assertConsentFor(baseArgs(db, { actorUid: 'officer-1' })),
      'not_decided',
      'cr-1',
    );
    expect(mockConsume).not.toHaveBeenCalled();
    expectNoAutoConsent();
  });
});

// ---------------------------------------------------------------------------
// (c) A DECIDED consent on file — proceeds exactly as a3c9702.
// ---------------------------------------------------------------------------

describe('GOLDEN (c) non-founder, DECIDED consent on file (hard mode)', () => {
  it('consented + matching matter/subject: passes consented, consumes once, audits without any founder provenance, writes no new consent', async () => {
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db));
    expect(result).toEqual({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockConsume).toHaveBeenCalledWith(db, 'cr-1', 'admin-1', 'roles/user-1');
    // a3c9702 pass audit, exact shape: no consentBasis, no decidedVia.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(db, {
      action: 'consent_gate_pass',
      actorUid: 'admin-1',
      targetType: 'consent_gate',
      targetId: 'catb_officer',
      details: {
        matterKey: 'catb_officer',
        consentRequestId: 'cr-1',
        actorUid: 'admin-1',
        subjectRef: SUBJECT,
        mode: 'hard',
      },
    });
    expectNoAutoConsent();
  });

  it('conditional consent satisfied by the FOUNDER as decider still passes the non-founder actor as consented (not founder_act)', async () => {
    mockGetDecided.mockResolvedValue(
      decidedRequest({
        status: 'conditional',
        conditionsSatisfied: true,
        conditionsSatisfiedBy: FOUNDER_UID,
      }),
    );
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db));
    expect(result).toEqual({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
    expect(mockConsume).toHaveBeenCalledTimes(1);
    expectNoAutoConsent();
  });

  it('conditional consent satisfied by the named verifier passes as consented, no writer call', async () => {
    mockGetDecided.mockResolvedValue(
      decidedRequest({
        status: 'conditional',
        conditionsSatisfied: true,
        conditionsSatisfiedBy: 'verifier-1',
        conditionsVerifierUid: 'verifier-1',
      }),
    );
    const { db } = makeFakeDb();
    await expect(assertConsentFor(baseArgs(db))).resolves.toEqual({
      mode: 'hard',
      outcome: 'consented',
      consentRequestId: 'cr-1',
    });
    expectNoAutoConsent();
  });

  it('decided consent supplied by a powerful non-founder (CTO) proceeds as consented and is consumed under the actor uid', async () => {
    mockResolveRole.mockResolvedValue('chief_technology_officer');
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db, { actorUid: 'cto-1' }));
    expect(result).toEqual({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
    expect(mockConsume).toHaveBeenCalledWith(db, 'cr-1', 'cto-1', 'roles/user-1');
    expectNoAutoConsent();
  });
});

// ---------------------------------------------------------------------------
// Cross-mode guard: record mode for a non-founder is the a3c9702
// recorded pass (never a founder_act), included so the no-auto-write
// invariant is pinned in BOTH modes, not only hard mode.
// ---------------------------------------------------------------------------

describe('GOLDEN (cross-mode) non-founder in record mode', () => {
  beforeEach(() => {
    mockSettings.mockResolvedValue({ mode: 'record', validityDays: 90, source: 'doc' });
  });

  it('no consent: proceeds recorded with the retroactive task, writer never called, no founder-act record', async () => {
    const { db, added } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db, { consentRequestId: undefined }));
    expect(result).toEqual({ mode: 'record', outcome: 'recorded', consentRequestId: null });
    expect(mockConsume).not.toHaveBeenCalled();
    expectNoAutoConsent();
    const task = added.find((a) => a.collection === 'tasks');
    expect(task).toBeDefined();
    expect(task?.data.consentGateRecord).toBe(true);
    expect(task?.data.assigneeIds).toEqual([FOUNDER_UID]);
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'consent_gate_record',
        details: expect.objectContaining({ observation: 'would_block:missing' }),
      }),
    );
  });

  it('pending consent: proceeds recorded with would_block:not_decided, writer never called', async () => {
    mockGetDecided.mockResolvedValue(decidedRequest({ status: 'pending', decidedAt: null }));
    const { db } = makeFakeDb();
    const result = await assertConsentFor(baseArgs(db));
    expect(result).toEqual({ mode: 'record', outcome: 'recorded', consentRequestId: 'cr-1' });
    expect(mockAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'consent_gate_record',
        details: expect.objectContaining({ observation: 'would_block:not_decided' }),
      }),
    );
    expectNoAutoConsent();
  });
});
