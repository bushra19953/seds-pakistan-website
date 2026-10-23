/**
 * @jest-environment node
 *
 * B1 INTEGRATION (security-review.md, finding B1): the REAL gate
 * (assertConsentFor) composed with the REAL writer
 * (createFounderActConsent) over the fake Firestore.
 *
 * Why this file exists: the gate suite mocks createFounderActConsent,
 * so its expired / conditional-unmet cases could only assert that the
 * (mock) writer was CALLED — the mock always returned a fresh id. The
 * service suite tests the real writer in isolation but never seeded an
 * expired or conditional dedupe candidate. The B1 defect lived exactly
 * in that untested composition: Step B correctly rejected an unusable
 * candidate, then the writer's in-transaction re-check (status +
 * consumedAt + deep subject equality only, no expiry / conditional
 * test) resurrected the same doc as { reused: true } and the gate
 * audited it as consentBasis 'existing_decided'.
 *
 * Here the writer is NOT mocked, and neither are consent-lookup,
 * governance-settings, or governance-audit (the fake store is the
 * audit sink). The only mocks are the outer seams the neighbouring
 * gate suite mocks: the firebase-admin handle (db is passed in
 * explicitly), the pure isFounderUid seam of founder-gate (its real
 * module pulls in next/server via verifySession), the notification
 * sink, and FieldValue.serverTimestamp. The actor is the UID-arm
 * founder, so no role-resolution input is needed.
 *
 * Expiry seeding (derived from founderActConsentExpiryDate /
 * consentExpiryDate semantics): a record's expiry is the EARLIEST of
 * proposedActDate + 30d, decidedAt + validityDays, and expiresAt when
 * present. The settings doc seeded below sets validityDays EXPLICITLY
 * to 30 for this matter (matterValidityDays), not the 90-day default,
 * so every bound below is deliberate:
 *   - "expired" seeds: decidedAt / proposedActDate 40 days before NOW
 *     (both bounds land 10 days before NOW), or an explicit expiresAt
 *     in the past;
 *   - "unexpired" seeds: decidedAt / proposedActDate 1-10 days before
 *     NOW, so both bounds land ~20-29 days after NOW.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => null,
  admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
}));

// founder-gate's assertFounder pulls in next/server via verifySession;
// the gate only consumes the pure isFounderUid from it (same mock as
// consent-gate.test.ts).
jest.mock('@/lib/server/founder-gate', () => {
  const { FOUNDER_UID: FOUNDER } = require('@/lib/roles');
  return {
    isFounderUid: (uid: string | null | undefined) =>
      typeof uid === 'string' && uid.length > 0 && uid === FOUNDER,
  };
});

import { FOUNDER_UID } from '@/lib/roles';
import { createFakeDb, type FakeDb } from './fake-firestore';
import {
  assertConsentFor,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate';

const NOW = new Date(2026, 9, 21, 12, 0, 0); // Oct 21 2026
const DAY = 24 * 60 * 60 * 1000;
const VALIDITY_DAYS = 30; // explicit via matterValidityDays, see header

const SUBJECT: ConsentSubjectRef = {
  type: 'user_role',
  targetUid: 'user-1',
  roleKey: 'president_national',
  action: 'appoint',
};

function seedBase(db: FakeDb) {
  db.seed('users', FOUNDER_UID, { displayName: 'The Founder' });
  db.seed('roles', FOUNDER_UID, { role: 'founder_patron' });
  // Real governance-settings read: mode hard + explicit validityDays.
  db.seed('governance_settings', 'phase2', {
    consentGateMode: { catb_officer: 'hard' },
    matterValidityDays: { catb_officer: VALIDITY_DAYS },
  });
}

function seedDecided(
  db: FakeDb,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  db.seed('consent_requests', id, {
    matterKey: 'catb_officer',
    status: 'consented',
    subjectRef: { ...SUBJECT },
    consumedAt: null,
    requestNumber: `FC-2026-seed-${id}`,
    decidedAt: new Date(NOW.getTime() - 1 * DAY),
    proposedActDate: new Date(NOW.getTime() - 1 * DAY),
    decidedAtSort: new Date(NOW.getTime() - 1 * DAY),
    ...overrides,
  });
}

function act(db: FakeDb) {
  return assertConsentFor({
    db: db as never,
    actorUid: FOUNDER_UID,
    matterKey: 'catb_officer',
    subjectRef: SUBJECT,
    actSummary: 'Appoint user-1 as president_national',
    now: NOW,
  });
}

function subjectRecords(db: FakeDb) {
  return db
    .all('consent_requests')
    .filter((r) => {
      const s = r.data.subjectRef as Record<string, unknown> | undefined;
      return (
        r.data.matterKey === 'catb_officer' &&
        s?.type === SUBJECT.type &&
        s?.targetUid === SUBJECT.targetUid &&
        s?.roleKey === SUBJECT.roleKey &&
        s?.action === SUBJECT.action
      );
    });
}

function gatePassAudits(db: FakeDb) {
  return db
    .all('audit_logs')
    .filter((a) => a.data.action === 'consent_gate_pass');
}

/** Shared assertions for (a)/(b)/(c): a fresh founder-act record is minted. */
async function expectFreshMint(db: FakeDb, seedIds: string[]) {
  const result: any = await act(db);
  expect(result.mode).toBe('hard');
  expect(result.outcome).toBe('founder_act');
  expect(seedIds).not.toContain(result.consentRequestId);

  const records = subjectRecords(db);
  expect(records).toHaveLength(seedIds.length + 1);
  const fresh = records.find((r) => r.id === result.consentRequestId);
  expect(fresh).toBeDefined();
  expect(fresh?.data.status).toBe('consented');
  expect(fresh?.data.decidedVia).toBe('founder-act');
  expect(fresh?.data.decidedByUid).toBe(FOUNDER_UID);

  // The gate audit must cite the FRESH record with basis founder_act,
  // never the rejected seed as existing_decided (that was B1).
  const passes = gatePassAudits(db);
  expect(passes).toHaveLength(1);
  expect((passes[0].data.details as any)?.consentBasis).toBe('founder_act');
  expect((passes[0].data.details as any)?.consentRequestId).toBe(
    result.consentRequestId,
  );
  return result;
}

/** Shared assertions for (d)/(e): a usable record is reused, none minted. */
async function expectReuse(db: FakeDb, reusedId: string, totalRecords: number) {
  const result: any = await act(db);
  expect(result.mode).toBe('hard');
  expect(result.outcome).toBe('founder_act');
  expect(result.consentRequestId).toBe(reusedId);

  expect(subjectRecords(db)).toHaveLength(totalRecords);
  // No writer mint happened: no founder-act record, no consent_decided audit.
  expect(
    subjectRecords(db).some((r) => r.data.decidedVia === 'founder-act'),
  ).toBe(false);
  expect(
    db.all('audit_logs').some((a) => a.data.action === 'consent_decided'),
  ).toBe(false);

  const passes = gatePassAudits(db);
  expect(passes).toHaveLength(1);
  expect((passes[0].data.details as any)?.consentBasis).toBe('existing_decided');
  expect((passes[0].data.details as any)?.consentRequestId).toBe(reusedId);
  return result;
}

describe('B1 integration: real gate + real writer (createFounderActConsent NOT mocked)', () => {
  it('(a) an EXPIRED consented same-subject record is NOT resurrected: a fresh founder-act record is minted', async () => {
    const db = createFakeDb();
    seedBase(db);
    // Both expiry bounds (proposedActDate + 30d, decidedAt + 30d
    // validity) land at NOW - 10d: unambiguously expired.
    seedDecided(db, 'seed-expired', {
      decidedAt: new Date(NOW.getTime() - 40 * DAY),
      proposedActDate: new Date(NOW.getTime() - 40 * DAY),
      decidedAtSort: new Date(NOW.getTime() - 40 * DAY),
    });
    await expectFreshMint(db, ['seed-expired']);
  });

  it('(b) a conditional same-subject record with unsatisfied conditions is NOT resurrected: a fresh record is minted', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedDecided(db, 'seed-cond-unmet', {
      status: 'conditional',
      conditionsSatisfied: false,
      conditionsSatisfiedBy: null,
      conditionsVerifierUid: 'verifier-1',
    });
    await expectFreshMint(db, ['seed-cond-unmet']);
  });

  it('(c) a conditional record satisfied by a stranger (not founder, not verifier) is NOT resurrected: a fresh record is minted', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedDecided(db, 'seed-cond-stranger', {
      status: 'conditional',
      conditionsSatisfied: true,
      conditionsSatisfiedBy: 'stranger-1',
      conditionsVerifierUid: 'verifier-1',
    });
    await expectFreshMint(db, ['seed-cond-stranger']);
  });

  it('(d) an UNEXPIRED consented same-subject record is reused: no new record, basis existing_decided', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedDecided(db, 'seed-usable', {});
    await expectReuse(db, 'seed-usable', 1);
  });

  it('(e) an unusable (expired) record NEWER than a usable one does not stop the scan: the usable one is reused', async () => {
    const db = createFakeDb();
    seedBase(db);
    // Newer in scan order (decidedAtSort desc): decided 2 days ago but
    // carrying an explicit expiresAt yesterday, so it is expired
    // despite its recent decidedAt / proposedActDate bounds.
    seedDecided(db, 'seed-expired-newer', {
      decidedAt: new Date(NOW.getTime() - 2 * DAY),
      proposedActDate: new Date(NOW.getTime() - 2 * DAY),
      decidedAtSort: new Date(NOW.getTime() - 2 * DAY),
      expiresAt: new Date(NOW.getTime() - 1 * DAY),
    });
    // Older but usable: decided 10 days ago, bounds land at NOW + 20d.
    seedDecided(db, 'seed-usable-older', {
      decidedAt: new Date(NOW.getTime() - 10 * DAY),
      proposedActDate: new Date(NOW.getTime() - 10 * DAY),
      decidedAtSort: new Date(NOW.getTime() - 10 * DAY),
    });
    await expectReuse(db, 'seed-usable-older', 2);
  });

  it('(f) sanity: with NO prior record, exactly one founder-act record is created end-to-end', async () => {
    const db = createFakeDb();
    seedBase(db);
    const result = await expectFreshMint(db, []);
    const records = subjectRecords(db);
    expect(records).toHaveLength(1);
    // The writer's own transaction artefacts are present too.
    const history = db.all(`consent_requests/${result.consentRequestId}/history`);
    expect(history).toHaveLength(1);
    expect(history[0].data.event).toBe('consent_given');
    expect(
      db
        .all('audit_logs')
        .filter(
          (a) =>
            a.data.action === 'consent_decided' &&
            (a.data.details as any)?.decidedVia === 'founder-act',
        ),
    ).toHaveLength(1);
  });
});
