/**
 * @jest-environment node
 *
 * Batch filed consents (FC-2026-0054, live 2026-10-29): a founder
 * consent filed by hand under the role-catalog Reserved Matter whose
 * Act authorises creating a SET of roles ("Create 22 title-only
 * deputy roles with zero permission grants, per the founder's direct
 * order on 2026-10-29 (SEDS executive slate appointments).") carries
 * no subjectRef / gateMatterKey stamp and names no single slug, so
 * the decided-consent lookup behind the picker could never match it
 * to any role's create act: the Create New Role form rendered "No
 * decided consent for this act yet." for every one of the 22 roles
 * the consent was filed and decided for, and role creation stayed
 * blocked. The lookup must accept the batch create act for
 * role_definition/create subjects - and for nothing else: a batch
 * text must never authorise a delete or a permissions change, and a
 * filing that names one specific role must never leak onto another.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

import { createFakeDb, type FakeDb } from './fake-firestore';
import { listDecidedConsentsForAct } from '@/lib/server/consent-lookup';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

const D = (day: number) => new Date(2026, 9, day, 10, 0, 0);

const CREATE_SUBJECT: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'custom_president_s_executive_apprentice',
  action: 'create',
};

/** The FC-2026-0054 record exactly as filed and decided live. */
function seedBatchConsent(db: FakeDb, overrides: Record<string, unknown> = {}) {
  db.seed('consent_requests', 'fc0054', {
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
    ...overrides,
  });
}

describe('listDecidedConsentsForAct - batch filed consent (FC-2026-0054 shape)', () => {
  it('offers the batch consent for a role create act it covers', async () => {
    const db = createFakeDb();
    seedBatchConsent(db);
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
  });

  it('offers the same batch consent for another covered role create act', async () => {
    const db = createFakeDb();
    seedBatchConsent(db);
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', {
      type: 'role_definition',
      slug: 'custom_events_deputy_floor_marshalling',
      action: 'create',
    });
    expect(rows.map((r) => r.id)).toEqual(['fc0054']);
  });

  it('never offers the batch create consent for a delete act', async () => {
    const db = createFakeDb();
    seedBatchConsent(db);
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', {
      type: 'role_definition',
      slug: 'custom_president_s_executive_apprentice',
      action: 'delete',
    });
    expect(rows).toEqual([]);
  });

  it('never offers the batch create consent for a permissions act', async () => {
    const db = createFakeDb();
    seedBatchConsent(db);
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', {
      type: 'role_definition',
      slug: 'custom_president_s_executive_apprentice',
      action: 'permissions',
    });
    expect(rows).toEqual([]);
  });

  it('never offers a pending, refused, or consumed batch consent', async () => {
    for (const overrides of [
      { status: 'pending' },
      { status: 'refused' },
      { consumedAt: D(29) },
    ]) {
      const db = createFakeDb();
      seedBatchConsent(db, overrides);
      const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
      expect(rows).toEqual([]);
    }
  });

  it('a filing naming one specific role still matches only that role', async () => {
    const db = createFakeDb();
    db.seed('consent_requests', 'single', {
      requestNumber: 'FC-2026-0060',
      matterKey: 'amend_layer1_documents',
      gateMatterKey: null,
      subjectRef: null,
      proposedAct: 'Create role definition custom_finance_deputy_pipeline_tracking',
      status: 'consented',
      decisionDate: D(29),
      decidedAtSort: D(29),
      consumedAt: null,
    });
    const own = await listDecidedConsentsForAct(db as any, 'role_catalog', {
      type: 'role_definition',
      slug: 'custom_finance_deputy_pipeline_tracking',
      action: 'create',
    });
    expect(own.map((r) => r.id)).toEqual(['single']);
    const other = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(other).toEqual([]);
  });

  it('a singular create act naming no role does not become a batch consent', async () => {
    const db = createFakeDb();
    db.seed('consent_requests', 'vague', {
      requestNumber: 'FC-2026-0061',
      matterKey: 'amend_layer1_documents',
      gateMatterKey: null,
      subjectRef: null,
      proposedAct: 'Create 1 role for the finance team before the summit.',
      status: 'consented',
      decisionDate: D(29),
      decidedAtSort: D(29),
      consumedAt: null,
    });
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(rows).toEqual([]);
  });

  it('a batch delete text authorises neither a create nor a batch delete', async () => {
    const db = createFakeDb();
    db.seed('consent_requests', 'batch-delete', {
      requestNumber: 'FC-2026-0062',
      matterKey: 'amend_layer1_documents',
      gateMatterKey: null,
      subjectRef: null,
      proposedAct: 'Delete the 22 deputy roles created for the slate appointments.',
      status: 'consented',
      decisionDate: D(29),
      decidedAtSort: D(29),
      consumedAt: null,
    });
    const create = await listDecidedConsentsForAct(db as any, 'role_catalog', CREATE_SUBJECT);
    expect(create).toEqual([]);
    const del = await listDecidedConsentsForAct(db as any, 'role_catalog', {
      type: 'role_definition',
      slug: 'custom_president_s_executive_apprentice',
      action: 'delete',
    });
    expect(del).toEqual([]);
  });
});
