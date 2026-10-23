/**
 * @jest-environment node
 *
 * Chapter consent gates inside the server actions (spec B.7 cases 10-12).
 * The gate is mocked; everything downstream of it is the real action code
 * against a fake Firestore, so a block provably leaves zero side effects.
 */

jest.mock('@/lib/server/consent-gate', () => ({
  assertConsentFor: jest.fn(),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: async () => mockDbHolder.db,
  admin: {},
}));

import {
  updateChapterApplicationStatus,
  deleteChapterWithCleanup,
} from '@/app/actions/chapter-applications';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';

const mockGate = assertConsentFor as jest.Mock;

function gateError(reason: 'missing' | 'refused') {
  return new ConsentRequiredError({
    matterKey: 'chapter_lifecycle',
    subjectRef: { type: 'chapter_application', applicationId: 'app-1', action: 'admit' },
    consentRequestId: null,
    reason,
  });
}

function makeDb(opts: { chapterExists?: boolean } = {}) {
  const writes = {
    chaptersSet: [] as Array<{ id: string; data: unknown }>,
    updates: [] as Array<{ col: string; id: string; data: Record<string, unknown> }>,
    deletes: [] as Array<{ col: string; id: string }>,
    audit: [] as Array<Record<string, unknown>>,
  };
  const appData: Record<string, unknown> = {
    proposedChapterName: 'SEDS Test University',
    city: 'Lahore',
    country: 'Pakistan',
    universityName: 'Test University',
    applicantId: 'applicant-1',
    applicantEmail: 'lead@example.com',
    teamMembers: [],
    facultyAdvisor: null,
    orderId: null,
  };
  const chapterData: Record<string, unknown> = {
    name: 'SEDS Test',
    applicationId: 'app-1',
  };
  const db = {
    __writes: writes,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'chapter_applications') {
            return { exists: true, id, data: () => appData };
          }
          if (name === 'chapters') {
            return opts.chapterExists
              ? { exists: true, id, data: () => chapterData }
              : { exists: false, id, data: () => undefined };
          }
          return { exists: false, id, data: () => undefined };
        },
        set: async (data: unknown) => {
          writes.chaptersSet.push({ id, data });
        },
        update: async (data: Record<string, unknown>) => {
          writes.updates.push({ col: name, id, data });
        },
        delete: async () => {
          writes.deletes.push({ col: name, id });
        },
      }),
      add: async (data: Record<string, unknown>) => {
        if (name === 'audit_logs') writes.audit.push(data);
        return { id: 'log-1' };
      },
      where: () => ({
        limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
        get: async () => ({ empty: true, docs: [] }),
      }),
    }),
    batch: () => ({ update: () => undefined, commit: async () => undefined }),
  };
  return db;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.mockResolvedValue({ mode: 'hard', outcome: 'consented', consentRequestId: 'cr-1' });
  mockDbHolder.db = makeDb();
});

it('approval without consent throws the typed gate error and changes nothing', async () => {
  mockGate.mockRejectedValue(gateError('missing'));
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  await expect(
    updateChapterApplicationStatus('app-1', 'approved', 'admin-1'),
  ).rejects.toBeInstanceOf(ConsentRequiredError);
  expect(db.__writes.chaptersSet).toHaveLength(0);
  expect(db.__writes.updates).toHaveLength(0);
});

it('approval with consent creates the chapter under the proposed slug and stamps the audit', async () => {
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const result = await updateChapterApplicationStatus('app-1', 'approved', 'admin-1', undefined, {
    consentRequestId: 'cr-1',
  });
  expect(result.success).toBe(true);
  expect(result.chapterId).toBe('seds-test-university');
  expect(db.__writes.chaptersSet).toHaveLength(1);
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      actorUid: 'admin-1',
      matterKey: 'chapter_lifecycle',
      subjectRef: { type: 'chapter_application', applicationId: 'app-1', action: 'admit' },
    }),
  );
  const auditEntry = db.__writes.audit.find(
    (a) => a.action === 'CHAPTER_APPLICATION_APPROVED',
  );
  expect((auditEntry?.payload as Record<string, unknown>)?.consentRequestId).toBe('cr-1');
});

it('rejection is not gated', async () => {
  const result = await updateChapterApplicationStatus('app-1', 'rejected', 'admin-1', {
    rejectionReason: 'Incomplete team roster',
  });
  expect(result.success).toBe(true);
  expect(mockGate).not.toHaveBeenCalled();
});

it('record-mode gate pass lets the approval complete (the Founder task path lives in the gate)', async () => {
  mockGate.mockResolvedValue({ mode: 'record', outcome: 'recorded', consentRequestId: null });
  const result = await updateChapterApplicationStatus('app-1', 'approved', 'admin-1');
  expect(result.success).toBe(true);
});

it('chapter delete without consent throws and deletes nothing', async () => {
  mockDbHolder.db = makeDb({ chapterExists: true });
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  mockGate.mockRejectedValue(gateError('refused'));
  await expect(deleteChapterWithCleanup('seds-test', 'admin-1')).rejects.toBeInstanceOf(
    ConsentRequiredError,
  );
  expect(db.__writes.deletes).toHaveLength(0);
});

it('chapter delete with consent completes the cleanup', async () => {
  mockDbHolder.db = makeDb({ chapterExists: true });
  const db = mockDbHolder.db as ReturnType<typeof makeDb>;
  const result = await deleteChapterWithCleanup('seds-test', 'admin-1', {
    consentRequestId: 'cr-1',
  });
  expect(result.success).toBe(true);
  expect(db.__writes.deletes).toContainEqual({ col: 'chapters', id: 'seds-test' });
  expect(mockGate).toHaveBeenCalledWith(
    expect.objectContaining({
      subjectRef: { type: 'chapter', chapterId: 'seds-test', action: 'delete' },
    }),
  );
});

// ---------------------------------------------------------------------------
// Fix 1 Tier 2 (plan 4.2, G1/G2): founder-act pass-through and the
// invalid-request ordering property. The gate is mocked, so (ii) is a
// mock-resolution case — the real founder logic is Tier 1's job. The
// ordering cases are the invariant-(a) proof for these sites: validation
// failure happens BEFORE the gate call, and because the auto-consent
// writer is reachable only from inside assertConsentFor, a request that
// never reaches the gate can never leave a consent record.
// ---------------------------------------------------------------------------

describe('Fix 1 Tier 2: founder act + invalid ordering (G1/G2)', () => {
  it('G1 founder act: gate resolving founder_act lets the approval complete', async () => {
    mockGate.mockResolvedValue({
      mode: 'hard',
      outcome: 'founder_act',
      consentRequestId: 'cr-auto-1',
    });
    const db = mockDbHolder.db as ReturnType<typeof makeDb>;
    const result = await updateChapterApplicationStatus('app-1', 'approved', 'founder-uid', undefined, {
      consentRequestId: null,
    });
    expect(result.success).toBe(true);
    expect(db.__writes.chaptersSet).toHaveLength(1);
    expect(mockGate).toHaveBeenCalledTimes(1);
  });

  it('G2 founder act: gate resolving founder_act lets the chapter delete complete', async () => {
    mockDbHolder.db = makeDb({ chapterExists: true });
    mockGate.mockResolvedValue({
      mode: 'hard',
      outcome: 'founder_act',
      consentRequestId: 'cr-auto-1',
    });
    const result = await deleteChapterWithCleanup('seds-test', 'founder-uid');
    expect(result.success).toBe(true);
    expect(mockGate).toHaveBeenCalledTimes(1);
  });

  it('G2 invalid request: deleting a chapter that does not exist fails BEFORE the gate (gate never called, no record possible)', async () => {
    mockDbHolder.db = makeDb({ chapterExists: false });
    // The action converts the not-found throw into its failure envelope
    // (only ConsentRequiredError propagates); either way the existence
    // check at the top of the action runs before the gate.
    const result = await deleteChapterWithCleanup('missing-chapter', 'admin-1');
    expect(result.success).toBe(false);
    expect(mockGate).not.toHaveBeenCalled();
  });
});
