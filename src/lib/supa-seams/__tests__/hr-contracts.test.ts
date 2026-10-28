/**
 * @jest-environment node
 *
 * HR cluster behavior contracts (leave / cadetships / evaluations /
 * probation), recorded from the CURRENT Firestore implementations at
 * base 4d5a1e16 and from the implementer seams as they land.
 * Map: ~/workspace/supabase-migration/HR_CONTRACTS_MAP.md
 *
 * Layers (same activation rule as the roles contract branch):
 * A. ALWAYS RUNS (any HR tree): characterization of the Firestore
 *    behavior consumers depend on today. The migrated implementations
 *    must reproduce these answers byte-identically with the flag OFF,
 *    with a null adapter, and with the flag ON over equivalent data.
 * B. CONDITIONAL (feat/supa-hr-1 seam src/lib/supa-seams/hr-leave.ts):
 *    flag states, null-adapter fallback, adapter-error signalling,
 *    Timestamp-like conversion, date-only preservation, mirrors.
 *    Activates automatically when the seam file is present on the
 *    tree under test; otherwise one skipped test records the debt.
 * C. CONDITIONAL (feat/supa-hr-2 seam hr-cadetships.ts): flag states,
 *    the epoch-date pin (verifier pin a), evaluations parent_path
 *    isolation (verifier pin b), mirrors.
 * D. CONDITIONAL (feat/supa-hr-3 seam hr-probation.ts): owed by the
 *    hr-3 slice, which had no worktree in this build round; the
 *    layer records the exact expected surface
 *    (listPendingProbationRestores) as a skipped test until it lands.
 *
 * ZERO live reads: every backend below is an in-memory mock.
 */

import * as fs from 'fs';
import * as path from 'path';

import { asDate, cadetshipFromFirestore, cadetshipToJson, evaluationFromFirestore } from '@/lib/server/cadetship/serialize';
import { isExemptForLeaveWindow } from '@/lib/server/leave-exemption';

/* ------------------------------------------------------------ mocks for
 * the probation adapter contract (layer A, C-PB-01): the adapter's two
 * collaborators are mocked; processProbationRestores itself is real. */
const mockRestore = jest.fn(async () => ({ ok: true }));
jest.mock('@/lib/server/discipline/adapters', () => ({
  restoreRoleViaWritePath: (...args: unknown[]) => mockRestore(...(args as [])),
  writeGovernanceAuditOrThrow: jest.fn(async () => undefined),
}));
import { processProbationRestores } from '@/lib/server/discipline/adapters-probation';

function seamPresent(file: string): boolean {
  return fs.existsSync(path.join(__dirname, '..', file));
}

function fakeProbationDb(docs: Record<string, Record<string, unknown>>) {
  const updated: Record<string, Record<string, unknown>> = {};
  return {
    updated,
    collection: () => ({
      where: () => ({
        get: async () => ({
          empty: Object.keys(docs).length === 0,
          docs: Object.entries(docs).map(([id, data]) => ({
            id,
            data: () => data,
            ref: {
              update: async (u: Record<string, unknown>) => {
                updated[id] = u;
              },
            },
          })),
        }),
      }),
    }),
  };
}

const DAY = 24 * 60 * 60 * 1000;

/* ============================================================ LAYER A */

describe('A. Firestore characterization (always runs)', () => {
  describe('C-TS-01 timestamp shapes at the serialize boundary', () => {
    it('asDate accepts Date, Timestamp-like and millis; returns the same instant', () => {
      const instant = new Date('2026-09-26T00:00:00.000Z');
      expect(asDate(instant)?.getTime()).toBe(instant.getTime());
      expect(asDate({ toDate: () => instant })?.getTime()).toBe(instant.getTime());
      expect(asDate(instant.getTime())?.getTime()).toBe(instant.getTime());
      expect(asDate(null)).toBeNull();
      expect(asDate(undefined)).toBeNull();
    });

    it('HAZARD PIN: asDate returns null for ISO strings and dumped-timestamp objects', () => {
      // This is WHY every seam must convert before serialize.ts: an
      // unconverted jsonb value silently becomes epoch downstream.
      expect(asDate('2026-09-26T00:00:00.000Z')).toBeNull();
      expect(asDate({ _seconds: 1790380800, _nanoseconds: 0 })).toBeNull();
      expect(asDate({ seconds: 1790380800, nanoseconds: 0 })).toBeNull();
    });

    it('cadetshipFromFirestore substitutes epoch for missing/unparseable dates (characterized)', () => {
      const doc = cadetshipFromFirestore('cX', {
        personUid: 'u1',
        startedAt: '2026-08-01T00:00:00.000Z',
        decision: { decidedAt: null },
        items: {},
        conduct: {},
        duesGate: {},
      } as Record<string, any>);
      expect(doc.startedAt.getTime()).toBe(0);
      expect(doc.probationEnd.getTime()).toBe(0);
    });
  });

  describe('C-CD-00 cadetship JSON shape over Firestore-shaped data', () => {
    it('cadetshipToJson emits ISO dates and decision.decidedAt ISO-or-null', () => {
      const started = new Date('2026-08-01T00:00:00.000Z');
      const doc = cadetshipFromFirestore('c1', {
        personUid: 'cadet-1',
        applicationId: 'app-1',
        cohortId: 'cohort-1',
        chapterId: 'ist',
        createdVia: 'application_approval',
        status: 'active',
        startedAt: started,
        probationEnd: new Date(started.getTime() + 56 * DAY),
        extendedTo: null,
        extensionUsed: false,
        reviewDue: false,
        items: {},
        conduct: {},
        duesGate: {},
        decision: { outcome: null, decidedAt: null },
        membershipClassWritePending: false,
        evaluationReminderSentAt: null,
        createdAt: started,
        updatedAt: started,
        updatedBy: 'cp-1',
      } as Record<string, any>);
      const json = cadetshipToJson(doc);
      expect(json.startedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(json.probationEnd).toBe('2026-09-26T00:00:00.000Z');
      expect(json.extendedTo).toBeNull();
      expect((json.decision as Record<string, unknown>).decidedAt).toBeNull();
    });

    it('evaluationFromFirestore shape: submittedAt is a Date, revisedAt null stays null', () => {
      const evaluation = evaluationFromFirestore({
        evaluatorUid: 'cp-1',
        evaluatorRoleKey: 'chapter_president',
        recommendation: 'confirm',
        note: 'ok',
        submittedAt: new Date('2026-09-20T00:00:00.000Z'),
        revisedAt: null,
        singleEvaluatorReason: null,
      } as Record<string, any>);
      expect(evaluation.submittedAt.toISOString()).toBe('2026-09-20T00:00:00.000Z');
      expect(evaluation.revisedAt).toBeNull();
      expect(evaluation.evaluatorChapterId).toBeNull();
    });
  });

  describe('C-LV-00 leave window representations are interchangeable (leave-exemption)', () => {
    // This contract pins the shared WINDOW MATH only: every date
    // representation of the same window must give the identical
    // decision. It therefore calls the pure matcher,
    // isExemptForLeaveWindow. The production entry point
    // (isExemptFromDeadlinePenalty) is async and record-based: it
    // first fetches the assignee's granted leave records
    // (leave_requests, status approved/completed) and then applies
    // this same matcher to each record's window. The on-leave flag
    // is not part of the rule anymore; the fixtures below carry
    // their windows exactly as before.
    const baseWindow = {
      vacationStartDate: '2026-11-01',
      vacationEndDate: '2026-11-05',
    };
    const task = { deadline: '2026-11-03' };

    it('date-only window exempts a deadline inside it and not outside it', () => {
      expect(isExemptForLeaveWindow(baseWindow as any, task as any).exempt).toBe(true);
      expect(
        isExemptForLeaveWindow(baseWindow as any, { deadline: '2026-11-09' } as any).exempt,
      ).toBe(false);
    });

    it('Timestamp-like, Date and ISO-string window bounds give the identical decision', () => {
      const variants = [
        { vacationStartDate: { toDate: () => new Date('2026-11-01T00:00:00.000Z') }, vacationEndDate: { toDate: () => new Date('2026-11-05T00:00:00.000Z') } },
        { vacationStartDate: new Date('2026-11-01T00:00:00.000Z'), vacationEndDate: new Date('2026-11-05T00:00:00.000Z') },
        { vacationStartDate: '2026-11-01T00:00:00.000Z', vacationEndDate: '2026-11-05T00:00:00.000Z' },
      ];
      for (const v of variants) {
        expect(isExemptForLeaveWindow(v as any, task as any).exempt).toBe(true);
      }
    });
  });

  describe('C-PB-01 probation dueAt representation (verifier pin c, adapter side)', () => {
    const now = new Date('2026-10-25T00:00:00.000Z');

    it('an ISO-string dueAt in the past restores exactly like a Timestamp-like dueAt', async () => {
      mockRestore.mockClear();
      const isoDb = fakeProbationDb({
        r1: { uid: 'u1', roleToRestore: 'member', status: 'pending', dueAt: '2026-10-20T00:00:00.000Z' },
      });
      await expect(processProbationRestores(isoDb as any, now)).resolves.toEqual({
        restored: 1, pending: 0, failed: 0,
      });
      expect(isoDb.updated.r1.status).toBe('restored');
      expect(typeof isoDb.updated.r1.restoredAt).toBe('string');

      mockRestore.mockClear();
      const tsDb = fakeProbationDb({
        r1: {
          uid: 'u1', roleToRestore: 'member', status: 'pending',
          dueAt: { toDate: () => new Date('2026-10-20T00:00:00.000Z') },
        },
      });
      await expect(processProbationRestores(tsDb as any, now)).resolves.toEqual({
        restored: 1, pending: 0, failed: 0,
      });
    });

    it('a future ISO-string dueAt stays pending (no restore attempted)', async () => {
      mockRestore.mockClear();
      const db = fakeProbationDb({
        r2: { uid: 'u2', roleToRestore: 'member', status: 'pending', dueAt: '2026-12-01T00:00:00.000Z' },
      });
      await expect(processProbationRestores(db as any, now)).resolves.toEqual({
        restored: 0, pending: 1, failed: 0,
      });
      expect(mockRestore).not.toHaveBeenCalled();
    });
  });
});

/* ============================================================ LAYER B */

const leaveSeamPath = '../hr-leave';
if (seamPresent('hr-leave.ts')) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const seam = require(leaveSeamPath) as Record<string, any>;

  describe('B. hr-leave seam contracts (feat/supa-hr-1)', () => {
    const LEAVE_DOC = {
      id: 'leave-1',
      userId: 'member-1',
      reason: 'Family',
      startDate: '2026-11-01',
      endDate: '2026-11-02',
      status: 'approved',
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-21T11:00:00.000Z',
      reviewedAt: null,
    };
    const makeAdapter = (overrides: Record<string, unknown> = {}) =>
      ({
        getDoc: jest.fn(async () => ({ ...LEAVE_DOC })),
        listDocs: jest.fn(async () => [{ ...LEAVE_DOC }]),
        countDocs: jest.fn(async () => 1),
        setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
        updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
        deleteDoc: jest.fn(async () => undefined),
        ...overrides,
      }) as any;

    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.SUPA_SURFACES;
      delete process.env.SUPA_SURFACES;
      seam.resetAdapterForTests();
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.SUPA_SURFACES;
      else process.env.SUPA_SURFACES = saved;
      seam.resetAdapterForTests();
      jest.restoreAllMocks();
    });

    it('C-LV-01 flag OFF / null adapter / other surfaces: reads disabled, Firestore behavior preserved', async () => {
      seam.setAdapterForTests(makeAdapter());
      await expect(seam.tryGetLeaveRequest('leave-1')).resolves.toEqual({ status: 'disabled' });
      process.env.SUPA_SURFACES = 'cadetships';
      await expect(seam.tryListLeaveRequests()).resolves.toEqual({ status: 'disabled' });
      process.env.SUPA_SURFACES = 'leave';
      seam.setAdapterForTests(null);
      expect(seam.isLeaveSupaEnabled()).toBe(false);
      await expect(seam.tryGetLeaveRequest('leave-1')).resolves.toEqual({ status: 'disabled' });
    });

    it('C-LV-02 flag ON + adapter error signals error (caller falls back), never throws', async () => {
      process.env.SUPA_SURFACES = 'leave';
      seam.setAdapterForTests(makeAdapter({
        getDoc: jest.fn(async () => { throw new Error('down'); }),
      }));
      const result = await seam.tryGetLeaveRequest('leave-1');
      expect(result.status).toBe('error');
    });

    it('C-LV-03 flag ON: timestamps become Timestamp-like, date-only fields stay strings', async () => {
      process.env.SUPA_SURFACES = '*';
      seam.setAdapterForTests(makeAdapter());
      const result = await seam.tryGetLeaveRequest('leave-1');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || !result.value) throw new Error('expected doc');
      const createdAt = result.value.createdAt as { toDate: () => Date };
      expect(typeof createdAt.toDate).toBe('function');
      expect(createdAt.toDate().toISOString()).toBe('2026-10-20T10:00:00.000Z');
      expect(result.value.startDate).toBe('2026-11-01');
      expect(result.value.endDate).toBe('2026-11-02');
    });

    it('C-LV-04 mirror serializes serverTimestamp sentinel to an ISO string and swallows errors', async () => {
      process.env.SUPA_SURFACES = 'leave';
      const adapter = makeAdapter();
      seam.setAdapterForTests(adapter);
      await expect(
        seam.mirrorLeaveRequestSet('leave-1', { status: 'pending', createdAt: { _methodName: 'serverTimestamp' } } as any),
      ).resolves.toBe(true);
      const written = (adapter.setDoc as jest.Mock).mock.calls[0][2];
      expect(typeof written.createdAt).toBe('string');
      seam.setAdapterForTests(makeAdapter({
        setDoc: jest.fn(async () => { throw new Error('down'); }),
      }));
      await expect(seam.mirrorLeaveRequestSet('leave-1', { status: 'pending' })).resolves.toBe(false);
    });
  });
} else {
  describe('B. hr-leave seam contracts (feat/supa-hr-1)', () => {
    it.skip('PENDING: src/lib/supa-seams/hr-leave.ts not present on this tree (lands with feat/supa-hr-1)', () => {});
  });
}

/* ============================================================ LAYER C */

if (seamPresent('hr-cadetships.ts')) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const seam = require('../hr-cadetships') as Record<string, any>;

  describe('C. hr-cadetships seam contracts (feat/supa-hr-2)', () => {
    const CADETSHIP_DOC = {
      id: 'c1',
      personUid: 'cadet-1',
      chapterId: 'ist',
      cohortId: 'cohort-1',
      status: 'under_review',
      startedAt: '2026-08-01T00:00:00.000Z',
      probationEnd: '2026-09-26T00:00:00.000Z',
      extendedTo: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      decision: { outcome: null, decidedAt: null },
      items: {},
      conduct: {},
      duesGate: {},
    };
    const makeAdapter = (overrides: Record<string, unknown> = {}) =>
      ({
        getDoc: jest.fn(async () => ({ ...CADETSHIP_DOC })),
        listDocs: jest.fn(async () => [{ ...CADETSHIP_DOC }]),
        countDocs: jest.fn(async () => 1),
        setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
        updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
        deleteDoc: jest.fn(async () => undefined),
        ...overrides,
      }) as any;

    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.SUPA_SURFACES;
      delete process.env.SUPA_SURFACES;
      seam.resetAdapterForTests();
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.SUPA_SURFACES;
      else process.env.SUPA_SURFACES = saved;
      seam.resetAdapterForTests();
      jest.restoreAllMocks();
    });

    it('C-CD-01 flag OFF / null adapter: disabled; flag ON + error: error signal', async () => {
      seam.setAdapterForTests(makeAdapter());
      await expect(seam.tryGetCadetship('c1')).resolves.toEqual({ status: 'disabled' });
      process.env.SUPA_SURFACES = 'cadetships';
      seam.setAdapterForTests(null);
      expect(seam.isCadetshipsSupaEnabled()).toBe(false);
      seam.setAdapterForTests(makeAdapter({
        getDoc: jest.fn(async () => { throw new Error('down'); }),
      }));
      expect((await seam.tryGetCadetship('c1')).status).toBe('error');
    });

    it('C-CD-02 verifier pin (a): seam dates are real Dates, cadetship JSON never epoch', async () => {
      process.env.SUPA_SURFACES = 'cadetships';
      seam.setAdapterForTests(makeAdapter());
      const result = await seam.tryGetCadetship('c1');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || !result.value) throw new Error('expected doc');
      const { id, ...rest } = result.value;
      const doc = cadetshipFromFirestore(id, rest as Record<string, any>);
      expect(doc.startedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(doc.probationEnd.toISOString()).toBe('2026-09-26T00:00:00.000Z');
      expect(cadetshipToJson(doc).startedAt).toBe('2026-08-01T00:00:00.000Z');
    });

    it('C-EV-01 verifier pin (b): same-role evaluations of two cadetships return distinct rows', async () => {
      process.env.SUPA_SURFACES = 'cadetships';
      const byPath: Record<string, unknown[]> = {
        'cadetships/c1/evaluations': [{ id: 'chapter_president', note: 'one', submittedAt: '2026-09-20T00:00:00.000Z', revisedAt: null }],
        'cadetships/c2/evaluations': [{ id: 'chapter_president', note: 'two', submittedAt: '2026-09-21T00:00:00.000Z', revisedAt: null }],
      };
      const adapter = makeAdapter({
        listDocs: jest.fn(async (p: string) => byPath[p] ?? []),
      });
      seam.setAdapterForTests(adapter);
      const one = await seam.tryListEvaluations('c1');
      const two = await seam.tryListEvaluations('c2');
      expect(one.status).toBe('ok');
      expect(two.status).toBe('ok');
      if (one.status !== 'ok' || two.status !== 'ok') throw new Error('expected ok');
      expect(one.value[0].note).toBe('one');
      expect(two.value[0].note).toBe('two');
      expect(adapter.listDocs).toHaveBeenCalledWith('cadetships/c1/evaluations');
      expect(adapter.listDocs).toHaveBeenCalledWith('cadetships/c2/evaluations');
    });

    it('C-CD-03 mirrors never throw and are no-ops with the flag OFF', async () => {
      const adapter = makeAdapter();
      seam.setAdapterForTests(adapter);
      await expect(seam.mirrorCadetshipUpdate('c1', { status: 'confirmed' })).resolves.toBe(false);
      expect(adapter.updateDoc).not.toHaveBeenCalled();
      process.env.SUPA_SURFACES = 'cadetships';
      seam.setAdapterForTests(makeAdapter({
        updateDoc: jest.fn(async () => { throw new Error('down'); }),
      }));
      await expect(seam.mirrorCadetshipUpdate('c1', { status: 'confirmed' })).resolves.toBe(false);
    });
  });
} else {
  describe('C. hr-cadetships seam contracts (feat/supa-hr-2)', () => {
    it.skip('PENDING: src/lib/supa-seams/hr-cadetships.ts not present on this tree (lands with feat/supa-hr-2)', () => {});
  });
}

/* ============================================================ LAYER D */

if (seamPresent('hr-probation.ts')) {
  describe('D. hr-probation seam contracts (feat/supa-hr-3)', () => {
    it('exposes listPendingProbationRestores on the probation surface', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const seam = require('../hr-probation') as Record<string, unknown>;
      expect(typeof seam.listPendingProbationRestores).toBe('function');
    });
  });
} else {
  describe('D. hr-probation seam contracts (feat/supa-hr-3)', () => {
    it.skip('PENDING: src/lib/supa-seams/hr-probation.ts not present on this tree (hr-3 slice: evaluations/probation reads; adapters-probation.ts is edited by NO ONE, verifier pin c)', () => {});
  });
}
