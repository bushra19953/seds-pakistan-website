/**
 * @jest-environment node
 *
 * Gate acceptance of USER-FILED consents (consent matcher fix,
 * 2026-10-26). A consent filed through /admin/consents/new carries a
 * Reserved-Matter key ('amend_layer1_documents') and a free-text
 * proposedAct, never the gate's matterKey/subjectRef pair. Before the
 * fix, evaluateConsent rejected every such record ('wrong_matter'),
 * so a consent selected in the Role Registry delete dialog could
 * never actually authorize the delete for a non-founder actor (the
 * founder only passed via the auto-consent mint). Fixtures are
 * modeled on FC-2026-0020 / FC-2026-0048, the real records filed for
 * the president_chapter deletion.
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

const mockGetDecided = getDecidedConsent as jest.Mock;
const mockConsume = consumeConsent as jest.Mock;
const mockSettings = getConsentMatterSettings as jest.Mock;
const mockAudit = writeGovernanceAuditOrThrow as jest.Mock;
const mockListCandidates = listDecidedConsentCandidates as jest.Mock;

const NOW = new Date('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const DELETE_SUBJECT: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'president_chapter',
  action: 'delete',
};

// The filed shape as decideRequest leaves it: decision lands in
// decisionDate / decidedAtSort, never in a `decidedAt` field.
function filedRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ljmImIzqMFUEnCD37l6w',
    requestNumber: 'FC-2026-0048',
    matterKey: 'amend_layer1_documents',
    scheduleSection: '3.1(b)',
    proposedAct: 'Delete role definition president_chapter',
    proposedActDate: '2026-10-26',
    status: 'consented',
    decision: 'consent_given',
    decisionDate: new Date(NOW.getTime() - 1 * DAY),
    decidedAtSort: new Date(NOW.getTime() - 1 * DAY),
    consumedAt: null,
    ...overrides,
  };
}

function makeFakeDb() {
  const db = {
    collection: (name: string) => ({
      add: async () => ({ id: 'task-1' }),
      doc: (id: string) => ({ set: async () => undefined }),
    }),
  };
  return db as never;
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    db: makeFakeDb(),
    actorUid: 'admin-1',
    matterKey: 'role_catalog' as const,
    consentRequestId: 'ljmImIzqMFUEnCD37l6w',
    subjectRef: DELETE_SUBJECT,
    actSummary: 'Delete role definition president_chapter',
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
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings.mockResolvedValue({ mode: 'hard', validityDays: 90, source: 'doc' });
  mockAudit.mockResolvedValue('audit-1');
  mockConsume.mockResolvedValue('consumed');
  mockListCandidates.mockResolvedValue([]);
  mockGetDecided.mockResolvedValue(filedRequest());
});

describe('assertConsentFor with a user-filed consent selected by id', () => {
  it('passes for the FC-2026-0048 shape and consumes it', async () => {
    const result = await assertConsentFor(baseArgs());
    expect(result).toEqual({
      mode: 'hard',
      outcome: 'consented',
      consentRequestId: 'ljmImIzqMFUEnCD37l6w',
    });
    expect(mockConsume).toHaveBeenCalledTimes(1);
  });

  it('passes for the FC-2026-0020 free-text shape', async () => {
    mockGetDecided.mockResolvedValue(
      filedRequest({
        id: 'eZRlEAbZ6tfTOLFlwgQl',
        requestNumber: 'FC-2026-0020',
        proposedAct:
          'Delete the president_chapter role definition (shown in the Role Registry as PRESIDENT / LOCAL OPERATIONS, 30/46) and its permission record.',
      }),
    );
    const result = await assertConsentFor(
      baseArgs({ consentRequestId: 'eZRlEAbZ6tfTOLFlwgQl' }),
    );
    expect(result).toMatchObject({ outcome: 'consented' });
  });

  it('passes for a post-fix stamped filing (gateMatterKey + subjectRef)', async () => {
    mockGetDecided.mockResolvedValue(
      filedRequest({
        gateMatterKey: 'role_catalog',
        subjectRef: { type: 'role_definition', slug: 'president_chapter', action: 'delete' },
        proposedAct: 'Some other wording entirely',
      }),
    );
    const result = await assertConsentFor(baseArgs());
    expect(result).toMatchObject({ outcome: 'consented' });
  });

  it('blocks a pending filed consent as not_decided', async () => {
    mockGetDecided.mockResolvedValue(filedRequest({ status: 'pending', decision: null }));
    await expectBlock(assertConsentFor(baseArgs()), 'not_decided');
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('blocks a refused filed consent as refused', async () => {
    mockGetDecided.mockResolvedValue(
      filedRequest({ status: 'refused', decision: 'consent_refused' }),
    );
    await expectBlock(assertConsentFor(baseArgs()), 'refused');
  });

  it('blocks a filed consent for a different slug as wrong_subject', async () => {
    mockGetDecided.mockResolvedValue(
      filedRequest({ proposedAct: 'Delete role definition hr_director' }),
    );
    await expectBlock(assertConsentFor(baseArgs()), 'wrong_subject');
  });

  it('blocks a filed consent for a different action as wrong_subject', async () => {
    mockGetDecided.mockResolvedValue(
      filedRequest({ proposedAct: 'Create role definition president_chapter' }),
    );
    await expectBlock(assertConsentFor(baseArgs()), 'wrong_subject');
  });

  it('blocks the same act text filed under an unrelated matter as wrong_matter', async () => {
    mockGetDecided.mockResolvedValue(
      filedRequest({ matterKey: 'related_party_contract', scheduleSection: '3.4(c)' }),
    );
    await expectBlock(assertConsentFor(baseArgs()), 'wrong_matter');
  });

  it('blocks a filed consent decided outside the validity window as expired', async () => {
    mockGetDecided.mockResolvedValue(
      filedRequest({
        decisionDate: new Date(NOW.getTime() - 200 * DAY),
        decidedAtSort: new Date(NOW.getTime() - 200 * DAY),
        proposedActDate: '2026-01-01',
      }),
    );
    await expectBlock(assertConsentFor(baseArgs()), 'expired');
  });
});
