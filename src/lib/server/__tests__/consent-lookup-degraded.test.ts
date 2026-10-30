/**
 * @jest-environment node
 *
 * Degraded-lookup contract for listDecidedConsentsForAct
 * (fix/consent-picker-degraded, live defect 2026-10-30 16:14 PKT):
 * the Founder Consent picker on the live site rendered "Could not
 * load decided consents" after a long wait, and a bounded reproduction
 * of GET /api/admin/governance/consents/decided for the exact picker
 * parameters first returned a confident empty 200 and later took ~41s
 * before returning FC-2026-0054 - a record that was on file,
 * consented, and matched. Two rules follow:
 *   1. No arm read may hang the lookup: every arm is raced against a
 *      hard timeout, and a timeout is an arm failure.
 *   2. Degraded-and-empty is not "no consent": when any arm failed or
 *      timed out and nothing matched, the lookup throws
 *      ConsentLookupDegradedError (the endpoint maps it to 503 and
 *      the picker shows its load-error state). When a surviving arm
 *      matched, the matches are returned exactly as before; when
 *      every arm is healthy, an empty result is a truthful [].
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
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

function quotaError(): Error {
  const err = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.') as Error & { code?: number };
  err.code = 8;
  return err;
}

/**
 * Chained-query stub in the shape of consent-lookup-arm-resilience:
 * the candidates arm is the only chain that calls orderBy; the filed
 * arms are bare where(...).limit(...).get() chains keyed by their
 * first where field. `hang` makes every get() never settle.
 */
function makeDb(opts: {
  candidatesFail?: boolean;
  filedFail?: boolean;
  withFiled?: boolean;
  hang?: boolean;
}) {
  const filedDocs = opts.withFiled === false ? [] : [{ id: 'fc0054', data: FC0054 }];
  const chain = (wheres: Array<[string, string, unknown]>, ordered: boolean): any => ({
    where: (f: string, op: string, v: unknown) => chain([...wheres, [f, op, v]], ordered),
    orderBy: () => chain(wheres, true),
    limit: () => chain(wheres, ordered),
    get: async () => {
      if (opts.hang) return new Promise(() => undefined);
      if (ordered) {
        if (opts.candidatesFail) throw quotaError();
        return { docs: [] };
      }
      if (opts.filedFail) throw quotaError();
      const field = wheres[0]?.[0];
      if (field === 'matterKey') {
        return { docs: filedDocs.map((d) => ({ id: d.id, data: () => ({ ...d.data }) })) };
      }
      return { docs: [] };
    },
  });
  return {
    collection: (name: string) => {
      if (name !== 'consent_requests') throw new Error(`unexpected collection: ${name}`);
      return chain([], false);
    },
  };
}

describe('listDecidedConsentsForAct - degraded contract', () => {
  it('throws ConsentLookupDegradedError when one arm fails and no arm matches', async () => {
    const db = makeDb({ candidatesFail: true, withFiled: false });
    await expect(
      listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT),
    ).rejects.toBeInstanceOf(ConsentLookupDegradedError);
  });

  it('returns the matches of surviving arms even when another arm failed', async () => {
    const db = makeDb({ candidatesFail: true });
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
  });

  it('resolves a truthful empty list when every arm is healthy and nothing matches', async () => {
    const db = makeDb({ withFiled: false });
    await expect(
      listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT),
    ).resolves.toEqual([]);
  });

  it('bounds a hung arm by the arm timeout and reports degradation', async () => {
    const db = makeDb({ hang: true });
    const t0 = Date.now();
    await expect(
      listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT, {
        armTimeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(ConsentLookupDegradedError);
    // Three arms at 50ms each must finish far inside the old
    // unbounded behaviour (a live reproduction took ~41s).
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
