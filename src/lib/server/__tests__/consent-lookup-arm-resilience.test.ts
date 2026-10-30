/**
 * @jest-environment node
 *
 * Arm resilience for listDecidedConsentsForAct (live defect, 2026-10-30):
 * the gate-shaped candidates arm (arm a) was awaited UNGUARDED while the
 * two filed-consent arms below it were individually try/caught. When the
 * Firestore daily quota exhausted mid-evening, arm (a)'s query threw
 * RESOURCE_EXHAUSTED, the whole lookup threw, the decided-consents
 * endpoint 500'd, and the picker rendered "No decided consent for this
 * act yet." - even though the filed arm could still read FC-2026-0054,
 * the batch consent the founder had filed and decided for exactly these
 * role creations. One arm's failure must never hide records another arm
 * can read; the lookup fails closed only when NO arm can read a match.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

import { listDecidedConsentsForAct } from '@/lib/server/consent-lookup';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

const D = (day: number) => new Date(2026, 9, day, 10, 0, 0);

const CREATE_SUBJECT: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'custom_president_s_executive_apprentice',
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
 * Minimal chained-query stub for consent_requests. The candidates arm is
 * the only chain that calls orderBy; the filed arms are bare
 * where(...).limit(...).get() chains keyed by their first where field.
 */
function makeDb(opts: { candidatesFail?: boolean; filedFail?: boolean; withFiled?: boolean }) {
  const filedDocs = opts.withFiled === false ? [] : [{ id: 'fc0054', data: FC0054 }];
  const chain = (wheres: Array<[string, string, unknown]>, ordered: boolean): any => ({
    where: (f: string, op: string, v: unknown) => chain([...wheres, [f, op, v]], ordered),
    orderBy: () => chain(wheres, true),
    limit: () => chain(wheres, ordered),
    get: async () => {
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

describe('listDecidedConsentsForAct - arm resilience', () => {
  it('still offers the filed batch consent when the candidates arm fails (quota)', async () => {
    const db = makeDb({ candidatesFail: true });
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
  });

  it('resolves to an empty list instead of throwing when every arm fails', async () => {
    const db = makeDb({ candidatesFail: true, filedFail: true });
    await expect(
      listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT),
    ).resolves.toEqual([]);
  });

  it('still offers the filed batch consent when the candidates arm is healthy', async () => {
    const db = makeDb({});
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
  });
});
