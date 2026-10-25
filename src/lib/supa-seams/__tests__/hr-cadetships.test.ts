/**
 * @jest-environment node
 *
 * Unit tests for the HR cadetships Supabase seam
 * (src/lib/supa-seams/hr-cadetships.ts). The adapter is a mocked
 * fake -- no live Supabase or Firestore calls.
 * Covers: flag on/off/'*', null adapter, adapter error fallback
 * signalling, date conversion (the epoch trap: ISO strings must
 * become real Dates, never Date(0) via serialize.ts), evaluations
 * parent_path addressing (full subcollection path, never a bare
 * 'evaluations' lookup), and dual-write mirror behaviour.
 */

import {
  convertCadetshipDates,
  convertEvaluationDates,
  evaluationsPath,
  getAdapter,
  isCadetshipsSupaEnabled,
  mirrorCadetshipUpdate,
  mirrorEvaluationSet,
  resetAdapterForTests,
  serializeDataForSupa,
  setAdapterForTests,
  tryFindLiveCadetshipForPerson,
  tryGetCadetship,
  tryListCadetships,
  tryListEvaluations,
  useSupa,
  type SupaAdapter,
  type SupaDoc,
} from '@/lib/supa-seams/hr-cadetships';
import { cadetshipFromFirestore, cadetshipToJson, evaluationFromFirestore } from '@/lib/server/cadetship/serialize';

const STARTED = '2026-08-01T00:00:00.000Z';
const PROBATION_END = '2026-09-26T00:00:00.000Z';

const CADETSHIP_DOC: SupaDoc = {
  id: 'c1',
  personUid: 'cadet-1',
  applicationId: 'app-1',
  cohortId: '2027-cohort-1',
  chapterId: 'ist',
  createdVia: 'application_approval',
  status: 'under_review',
  startedAt: STARTED,
  probationEnd: PROBATION_END,
  extendedTo: null,
  extensionUsed: false,
  reviewDue: false,
  items: {
    orientation: { done: true, attestedBy: 'cp-1', attestedAt: '2026-08-10T00:00:00.000Z' },
    workshops: { count: 1, attestations: [{ attestedBy: 'cp-1', attestedAt: '2026-08-15T00:00:00.000Z', eventRef: null }] },
    sprintTask: { taskId: 't1', completedAt: '2026-09-01T00:00:00.000Z', detectedBy: 'auto' },
  },
  conduct: { acknowledged: true, acknowledgedAt: '2026-08-05T00:00:00.000Z' },
  duesGate: { status: 'not_checked', lastCheckedAt: null, duesStatus: null },
  decision: {
    outcome: null, decidedBy: null, decidedByRole: null, decidedAt: null,
    round: 1, note: null, memberNote: null, exitReason: null,
    resolutionOf: null, chosenRecommendation: null,
  },
  membershipClassWritePending: false,
  evaluationReminderSentAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  updatedBy: 'cp-1',
};

const EVALUATION_DOC: SupaDoc = {
  id: 'chapter_president',
  evaluatorUid: 'cp-1',
  evaluatorRoleKey: 'chapter_president',
  evaluatorChapterId: 'ist',
  recommendation: 'confirm',
  note: 'Strong probation.',
  submittedAt: '2026-09-20T00:00:00.000Z',
  revisedAt: null,
  singleEvaluatorReason: null,
};

function makeAdapter(overrides: Partial<SupaAdapter> = {}): SupaAdapter {
  return {
    getDoc: jest.fn(async () => ({ ...CADETSHIP_DOC })),
    listDocs: jest.fn(async () => [{ ...CADETSHIP_DOC }]),
    countDocs: jest.fn(async () => 1),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  resetAdapterForTests();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  resetAdapterForTests();
  jest.restoreAllMocks();
});

describe('flag gate', () => {
  it('is OFF when SUPA_SURFACES is unset, even with an adapter', () => {
    setAdapterForTests(makeAdapter());
    expect(useSupa('cadetships')).toBe(false);
    expect(isCadetshipsSupaEnabled()).toBe(false);
  });

  it('is OFF for other surfaces only (the skeleton bug: no implicit on)', () => {
    process.env[ENV_KEY] = 'leave,tasks';
    setAdapterForTests(makeAdapter());
    expect(isCadetshipsSupaEnabled()).toBe(false);
  });

  it('is ON for cadetships (case-insensitive, whitespace tolerant)', () => {
    process.env[ENV_KEY] = ' Leave , CADETSHIPS ';
    setAdapterForTests(makeAdapter());
    expect(useSupa('cadetships')).toBe(true);
    expect(isCadetshipsSupaEnabled()).toBe(true);
  });

  it("is ON for '*'", () => {
    process.env[ENV_KEY] = '*';
    setAdapterForTests(makeAdapter());
    expect(isCadetshipsSupaEnabled()).toBe(true);
  });

  it('is OFF when the flag is ON but the adapter is null', () => {
    process.env[ENV_KEY] = 'cadetships';
    setAdapterForTests(null);
    expect(getAdapter()).toBeNull();
    expect(isCadetshipsSupaEnabled()).toBe(false);
  });

  it('getAdapter returns null by default in this branch (merge not landed)', () => {
    process.env[ENV_KEY] = 'cadetships';
    expect(getAdapter()).toBeNull();
    expect(isCadetshipsSupaEnabled()).toBe(false);
  });
});

describe('reads', () => {
  it('returns disabled when the flag is OFF and never calls the adapter', async () => {
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    await expect(tryGetCadetship('c1')).resolves.toEqual({ status: 'disabled' });
    await expect(tryListCadetships()).resolves.toEqual({ status: 'disabled' });
    await expect(tryListEvaluations('c1')).resolves.toEqual({ status: 'disabled' });
    expect(adapter.getDoc).not.toHaveBeenCalled();
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('returns error (fallback signal) when the adapter throws', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter({
      getDoc: jest.fn(async () => { throw new Error('supa down'); }),
      listDocs: jest.fn(async () => { throw new Error('supa down'); }),
    });
    setAdapterForTests(adapter);
    const got = await tryGetCadetship('c1');
    expect(got.status).toBe('error');
    const listed = await tryListEvaluations('c1');
    expect(listed.status).toBe('error');
  });

  it('returns null for a missing cadetship (not an error)', async () => {
    process.env[ENV_KEY] = 'cadetships';
    setAdapterForTests(makeAdapter({ getDoc: jest.fn(async () => null) }));
    await expect(tryGetCadetship('missing')).resolves.toEqual({ status: 'ok', value: null });
  });
});

describe('date conversion — the epoch trap (verifier pin a)', () => {
  it('converts ISO strings to real Dates on the cadetship read', async () => {
    process.env[ENV_KEY] = 'cadetships';
    setAdapterForTests(makeAdapter());
    const result = await tryGetCadetship('c1');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || !result.value) throw new Error('expected doc');
    expect(result.value.startedAt).toBeInstanceOf(Date);
    expect((result.value.startedAt as Date).toISOString()).toBe(STARTED);
  });

  it('cadetshipFromFirestore over a seam doc yields the real dates, never epoch', async () => {
    process.env[ENV_KEY] = 'cadetships';
    setAdapterForTests(makeAdapter());
    const result = await tryListCadetships();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    const { id, ...rest } = result.value[0];
    const doc = cadetshipFromFirestore(id, rest as Record<string, any>);
    expect(doc.startedAt.toISOString()).toBe(STARTED);
    expect(doc.probationEnd.toISOString()).toBe(PROBATION_END);
    expect(doc.startedAt.getTime()).not.toBe(0);
    const json = cadetshipToJson(doc);
    expect(json.startedAt).toBe(STARTED);
    expect(json.probationEnd).toBe(PROBATION_END);
    expect(json.extendedTo).toBeNull();
  });

  it('converts nested decision / items / conduct dates', () => {
    const converted = convertCadetshipDates({
      ...CADETSHIP_DOC,
      decision: { ...(CADETSHIP_DOC.decision as Record<string, unknown>), decidedAt: '2026-09-27T00:00:00.000Z' },
    } as Record<string, unknown>);
    const decision = converted.decision as Record<string, unknown>;
    expect(decision.decidedAt).toBeInstanceOf(Date);
    const items = converted.items as Record<string, any>;
    expect(items.orientation.attestedAt).toBeInstanceOf(Date);
    expect(items.workshops.attestations[0].attestedAt).toBeInstanceOf(Date);
    expect(items.sprintTask.completedAt).toBeInstanceOf(Date);
    expect((converted.conduct as Record<string, unknown>).acknowledgedAt).toBeInstanceOf(Date);
  });

  it('evaluation dates convert so evaluationFromFirestore keeps submittedAt', () => {
    const converted = convertEvaluationDates({ ...EVALUATION_DOC });
    const evaluation = evaluationFromFirestore(converted as Record<string, any>);
    expect(evaluation.submittedAt.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(evaluation.revisedAt).toBeNull();
  });
});

describe('evaluations addressing (verifier pin b)', () => {
  it('addresses evaluations by the full subcollection path only', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [{ ...EVALUATION_DOC }]),
    });
    setAdapterForTests(adapter);
    const result = await tryListEvaluations('c1');
    expect(result.status).toBe('ok');
    expect(adapter.listDocs).toHaveBeenCalledWith('cadetships/c1/evaluations');
    expect(evaluationsPath('c1')).toBe('cadetships/c1/evaluations');
  });

  it('two cadetships with same-role evaluations stay distinct rows', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const byPath: Record<string, SupaDoc[]> = {
      'cadetships/c1/evaluations': [{ ...EVALUATION_DOC, note: 'For cadet one.' }],
      'cadetships/c2/evaluations': [{ ...EVALUATION_DOC, note: 'For cadet two.' }],
    };
    const adapter = makeAdapter({
      listDocs: jest.fn(async (path: string) => byPath[path] ?? []),
    });
    setAdapterForTests(adapter);
    const one = await tryListEvaluations('c1');
    const two = await tryListEvaluations('c2');
    expect(one.status).toBe('ok');
    expect(two.status).toBe('ok');
    if (one.status !== 'ok' || two.status !== 'ok') throw new Error('expected ok');
    expect(one.value).toHaveLength(1);
    expect(two.value).toHaveLength(1);
    expect(one.value[0].note).toBe('For cadet one.');
    expect(two.value[0].note).toBe('For cadet two.');
    expect(one.value[0].id).toBe('chapter_president');
    expect(two.value[0].id).toBe('chapter_president');
  });
});

describe('live cadetship lookup (acknowledge-conduct)', () => {
  it('filters on personUid + status in, never on firebase_uid', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const result = await tryFindLiveCadetshipForPerson('cadet-1', ['active', 'under_review']);
    expect(result.status).toBe('ok');
    const call = (adapter.listDocs as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('cadetships');
    expect(JSON.stringify(call[1])).toContain('personUid');
    expect(JSON.stringify(call[1])).not.toContain('firebase_uid');
  });
});

describe('mirrors (dual-write, Firestore primary)', () => {
  it('serializes Dates and serverTimestamp sentinels to ISO strings', () => {
    const out = serializeDataForSupa({
      startedAt: new Date(STARTED),
      updatedAt: { _methodName: 'serverTimestamp' },
      decision: { decidedAt: new Date('2026-09-27T00:00:00.000Z') },
    });
    expect(out.startedAt).toBe(STARTED);
    expect(typeof out.updatedAt).toBe('string');
    expect((out.decision as Record<string, unknown>).decidedAt).toBe('2026-09-27T00:00:00.000Z');
  });

  it('mirror update calls the adapter on cadetships and swallows errors', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    await expect(mirrorCadetshipUpdate('c1', { status: 'confirmed' })).resolves.toBe(true);
    expect(adapter.updateDoc).toHaveBeenCalledWith('cadetships', 'c1', { status: 'confirmed' });

    setAdapterForTests(makeAdapter({
      updateDoc: jest.fn(async () => { throw new Error('supa down'); }),
    }));
    await expect(mirrorCadetshipUpdate('c1', { status: 'confirmed' })).resolves.toBe(false);
  });

  it('mirror evaluation set uses the full subcollection path', async () => {
    process.env[ENV_KEY] = 'cadetships';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    await expect(
      mirrorEvaluationSet('c1', 'team_lead', { recommendation: 'extend' }),
    ).resolves.toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledWith(
      'cadetships/c1/evaluations',
      'team_lead',
      { recommendation: 'extend' },
    );
  });

  it('mirrors are no-ops when the flag is OFF', async () => {
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    await expect(mirrorCadetshipUpdate('c1', { status: 'confirmed' })).resolves.toBe(false);
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });
});
