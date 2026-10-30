/**
 * @jest-environment node
 *
 * Parallel-arm shape for listDecidedConsentsForAct
 * (fix/consent-picker-degraded, second half): the timeout + degraded
 * contract alone still left the lookup SEQUENTIAL - three arms end to
 * end, each filed arm's mirror attempt and Firestore fallback racing
 * their own fresh timeouts - which is how one live call reached
 * ~41s (five sub-reads, up to 8s each, summed) and the platform edge
 * failed another at ~34s (502). The arms are independent reads of
 * one collection, so they now run in parallel under ONE per-arm
 * deadline shared by the arm's sub-reads: the lookup costs the
 * slowest arm, never the sum, and a hung mirror attempt consumes
 * the arm instead of handing the fallback a second full budget.
 *
 * The consents seam is mocked so the sub-read budget can be proven:
 * by default it reports unavailable (null), which is exactly the
 * test-environment behaviour the Firestore-path suites rely on.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

const mockListViaSeam = jest.fn(
  async (_opts: unknown): Promise<Array<Record<string, any>> | null> => null,
);
jest.mock('@/lib/server/consents-supa', () => ({
  CONSENTS_SURFACE: 'consents',
  CONSENTS_COLLECTION: 'consent_requests',
  CONSENT_HISTORY_TABLE: 'fs_consent_requests_history',
  CONSENT_TIMESTAMP_FIELDS: [],
  consentsSupaEnabled: () => false,
  resolveConsentsAdapter: () => null,
  getConsentViaSeam: async () => null,
  listConsentsViaSeam: (opts: unknown) => mockListViaSeam(opts),
  listConsentHistoryViaSeam: async () => null,
  mirrorConsentSet: async () => undefined,
  mirrorConsentUpdate: async () => undefined,
  mirrorConsentHistorySet: async () => undefined,
  mirrorConsentDelete: async () => false,
  mirrorConsentHistoryDelete: async () => false,
  __setConsentsSupaAdapterForTests: () => undefined,
  __resetConsentsSupaAdapterForTests: () => undefined,
  __setConsentsHistoryClientForTests: () => undefined,
  __resetConsentsHistoryClientForTests: () => undefined,
}));

import {
  ConsentLookupDegradedError,
  listDecidedConsentsForAct,
} from '@/lib/server/consent-lookup';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

const D = (day: number) => new Date(2026, 9, day, 10, 0, 0);

const CREATE_SUBJECT: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'custom_finance_deputy_pipeline_tracking',
  action: 'create',
};

/** The FC-2026-0054 record exactly as filed and decided live. */
const FC0054: Record<string, unknown> = {
  requestNumber: 'FC-2026-0054',
  matterKey: 'amend_layer1_documents',
  gateMatterKey: null,
  subjectRef: null,
  proposedAct:
    "Create 22 title-only deputy roles with zero permission grants, per the founder's direct order on 2026-10-29 (SEDS executive slate appointments).",
  status: 'consented',
  decision: 'consent_given',
  decisionDate: D(29),
  decidedAtSort: D(29),
  proposedActDate: '2026-10-29',
  consumedAt: null,
};

/** A gate-shaped record: structured subjectRef under the gate matter key. */
const GATE_DOC: Record<string, unknown> = {
  requestNumber: 'FC-2026-0099',
  matterKey: 'role_catalog',
  subjectRef: {
    type: 'role_definition',
    slug: 'custom_finance_deputy_pipeline_tracking',
    action: 'create',
  },
  status: 'consented',
  decision: 'consent_given',
  decisionDate: D(29),
  decidedAtSort: D(29),
  consumedAt: null,
};

function quotaError(): Error {
  const err = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.') as Error & { code?: number };
  err.code = 8;
  return err;
}

interface ArmBehaviour {
  docs?: Array<{ id: string; data: Record<string, unknown> }>;
  fail?: boolean;
  delayMs?: number;
  hang?: boolean;
}

/**
 * Chained-query stub keyed like the real arms: the ordered chain is
 * the candidates arm; the bare chains are the filed arms, keyed by
 * their first where field. `onFiledGet` observes Firestore reads the
 * filed arms actually issue (the shared-budget proof below).
 */
function makeDb(behaviour: {
  candidates?: ArmBehaviour;
  gateFiled?: ArmBehaviour;
  matterFiled?: ArmBehaviour;
  onFiledGet?: (field: string) => void;
}) {
  const pick = (wheres: Array<[string, string, unknown]>, ordered: boolean): ArmBehaviour => {
    if (ordered) return behaviour.candidates ?? {};
    const field = wheres[0]?.[0];
    if (field === 'gateMatterKey') return behaviour.gateFiled ?? {};
    return behaviour.matterFiled ?? {};
  };
  const chain = (wheres: Array<[string, string, unknown]>, ordered: boolean): any => ({
    where: (f: string, op: string, v: unknown) => chain([...wheres, [f, op, v]], ordered),
    orderBy: () => chain(wheres, true),
    limit: () => chain(wheres, ordered),
    get: async () => {
      const b = pick(wheres, ordered);
      if (!ordered) behaviour.onFiledGet?.(String(wheres[0]?.[0]));
      if (b.hang) return new Promise(() => undefined);
      if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
      if (b.fail) throw quotaError();
      return {
        docs: (b.docs ?? []).map((d) => ({ id: d.id, data: () => ({ ...d.data }) })),
      };
    },
  });
  return {
    collection: (name: string) => {
      if (name !== 'consent_requests') throw new Error(`unexpected collection: ${name}`);
      return chain([], false);
    },
  };
}

beforeEach(() => {
  mockListViaSeam.mockReset();
  mockListViaSeam.mockImplementation(async () => null);
});

describe('listDecidedConsentsForAct - parallel arms, shared budget', () => {
  it('runs the three arms in parallel: three 300ms arms finish far under the sequential 900ms', async () => {
    const db = makeDb({
      candidates: { delayMs: 300 },
      gateFiled: { delayMs: 300 },
      matterFiled: { delayMs: 300, docs: [{ id: 'fc0054', data: FC0054 }] },
    });
    const t0 = Date.now();
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    const elapsed = Date.now() - t0;
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
    expect(elapsed).toBeLessThan(700);
  });

  it('a hung arm does not block a surviving arm match (isolation under hang, not just throw)', async () => {
    const db = makeDb({
      candidates: { hang: true },
      matterFiled: { docs: [{ id: 'fc0054', data: FC0054 }] },
    });
    const t0 = Date.now();
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT, {
      armTimeoutMs: 150,
    });
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('returns the candidates-arm match when both filed arms fail', async () => {
    const db = makeDb({
      candidates: { docs: [{ id: 'gate-doc', data: GATE_DOC }] },
      gateFiled: { fail: true },
      matterFiled: { fail: true },
    });
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(rows.map((r) => r.id)).toEqual(['gate-doc']);
  });

  it('shares one budget across sub-reads: a hung seam consumes the filed arm and no Firestore read is issued', async () => {
    mockListViaSeam.mockImplementation(() => new Promise(() => undefined));
    let filedGetCalls = 0;
    const db = makeDb({
      candidates: { hang: true },
      gateFiled: { hang: true },
      matterFiled: { hang: true },
      onFiledGet: () => {
        filedGetCalls += 1;
      },
    });
    const t0 = Date.now();
    await expect(
      listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT, {
        armTimeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(ConsentLookupDegradedError);
    // The seam timeout ate the whole arm budget, so the Firestore
    // fallback was never even issued - under per-sub-read budgets it
    // would have been, with a second full timeout of its own.
    expect(filedGetCalls).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('a fast seam failure still falls back to Firestore inside the same arm budget', async () => {
    mockListViaSeam.mockImplementation(async () => {
      throw new Error('adapter unavailable');
    });
    let filedGetCalls = 0;
    const db = makeDb({
      candidates: {},
      gateFiled: { hang: true },
      matterFiled: { hang: true },
      onFiledGet: () => {
        filedGetCalls += 1;
      },
    });
    const t0 = Date.now();
    await expect(
      listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT, {
        armTimeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(ConsentLookupDegradedError);
    // The fallback WAS issued (a seam error alone is not an arm
    // failure), then bounded by what remained of the arm budget.
    expect(filedGetCalls).toBeGreaterThanOrEqual(1);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('FC-2026-0054 batch act matches any role_definition/create slug (71d081e6 semantics)', async () => {
    const db = makeDb({
      matterFiled: { docs: [{ id: 'fc0054', data: FC0054 }] },
    });
    const otherSlug: ConsentSubjectRef = {
      type: 'role_definition',
      slug: 'custom_events_deputy_floor_marshalling',
      action: 'create',
    };
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', otherSlug);
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
  });
});
