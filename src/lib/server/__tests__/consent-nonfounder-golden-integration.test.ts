/**
 * @jest-environment node
 *
 * GOLDEN non-founder INTEGRATION (agent 15, Test Author C).
 *
 * Store-level companion to consent-gate-nonfounder-golden.test.ts.
 * That suite mocks the writer, so it proves the gate never CALLS the
 * auto-consent machinery for a non-founder. This suite composes the
 * REAL gate (assertConsentFor) + REAL writer (createFounderActConsent,
 * NOT mocked) + REAL lookup / settings / audit over the fake
 * Firestore, so it proves the observable end state a3c9702 produced:
 *
 *   (a) no consent on file      -> ConsentRequiredError, 409 shape,
 *                                  consent_requests stays EMPTY;
 *   (b) a PENDING consent       -> ConsentRequiredError 'not_decided',
 *                                  the pending doc is untouched
 *                                  (status, consumedAt, decidedVia);
 *   (c) a DECIDED consent       -> passes 'consented', the SAME doc
 *                                  is consumed in place, and NO new
 *                                  consent_requests doc appears.
 *
 * In no case does any doc in consent_requests carry
 * decidedVia 'founder-act' after a non-founder act.
 *
 * The main actor is a powerful non-founder (stored primary role
 * president_national in the seeded roles doc). Two further cases use
 * an IMPOSTOR actor whose stored primary role is 'founder_patron'
 * itself: since f97d446 founder admission is UID-only (as at
 * a3c9702), that planted role must buy nothing — no reuse of a
 * decided consent, no mint, no pass — with the REAL resolver and
 * REAL writer in the loop.
 *
 * Only outer seams are mocked, exactly as in
 * consent-founder-act-integration.test.ts: the firebase-admin handle
 * (db is passed in), the pure isFounderUid seam of founder-gate, the
 * notification sink, and FieldValue.serverTimestamp.
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

jest.mock('@/lib/server/founder-gate', () => {
  const { FOUNDER_UID: FOUNDER } = require('@/lib/roles');
  return {
    isFounderUid: (uid: string | null | undefined) =>
      typeof uid === 'string' && uid.length > 0 && uid === FOUNDER,
  };
});

import { createFakeDb, type FakeDb } from './fake-firestore';
import {
  assertConsentFor,
  consentGateHttpError,
  ConsentRequiredError,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate';

const NOW = new Date(2026, 9, 21, 12, 0, 0); // Oct 21 2026
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = 'officer-1'; // president_national — powerful, NOT founder

const SUBJECT: ConsentSubjectRef = {
  type: 'user_role',
  targetUid: 'user-1',
  roleKey: 'president_national',
  action: 'appoint',
};

const FILE_URL =
  '/admin/governance/consents/new?matter=catb_officer&subjectType=user_role&subject=' +
  '%7B%22type%22%3A%22user_role%22%2C%22targetUid%22%3A%22user-1%22%2C%22roleKey%22%3A%22president_national%22%2C%22action%22%3A%22appoint%22%7D';

function seedBase(db: FakeDb) {
  db.seed('users', ACTOR, { displayName: 'Officer One' });
  db.seed('roles', ACTOR, { role: 'president_national' });
  // Real governance-settings read: hard mode, explicit validity.
  db.seed('governance_settings', 'phase2', {
    consentGateMode: { catb_officer: 'hard' },
    matterValidityDays: { catb_officer: 90 },
  });
}

function seedConsent(
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
    proposedActDate: new Date(NOW.getTime() + 10 * DAY),
    decidedAtSort: new Date(NOW.getTime() - 1 * DAY),
    ...overrides,
  });
}

function act(db: FakeDb, consentRequestId?: string, actorUid: string = ACTOR) {
  return assertConsentFor({
    db: db as never,
    actorUid,
    matterKey: 'catb_officer',
    consentRequestId,
    subjectRef: SUBJECT,
    actSummary: 'Appoint user-1 as president_national',
    now: NOW,
  });
}

const IMPOSTOR = 'patron-impostor-1';

function seedImpostor(db: FakeDb) {
  // The Reviewer 1 attack (f97d446): a non-founder whose stored
  // primary role IS 'founder_patron' (client-plantable under the
  // rules for canManageRoles holders). UID is not the founder UID.
  db.seed('users', IMPOSTOR, { displayName: 'Patron Impostor' });
  db.seed('roles', IMPOSTOR, { role: 'founder_patron' });
}

function expectNoFounderActRecords(db: FakeDb) {
  const all = db.all('consent_requests');
  expect(all.some((r) => r.data.decidedVia === 'founder-act')).toBe(false);
  expect(
    db
      .all('audit_logs')
      .some(
        (a) =>
          a.data.action === 'consent_decided' &&
          (a.data.details as Record<string, unknown> | undefined)?.decidedVia ===
            'founder-act',
      ),
  ).toBe(false);
}

async function expectStoreBlock(
  db: FakeDb,
  consentRequestId: string | undefined,
  reason: string,
  bodyConsentId: string | null,
  actorUid: string = ACTOR,
) {
  const err = await act(db, consentRequestId, actorUid).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConsentRequiredError);
  const e = err as ConsentRequiredError;
  expect(e.httpStatus).toBe(409);
  expect(e.code).toBe('CONSENT_REQUIRED');
  expect(consentGateHttpError(e)).toEqual({
    status: 409,
    body: {
      error: 'CONSENT_REQUIRED',
      code: 'CONSENT_REQUIRED',
      matter: 'catb_officer',
      reason,
      subject: SUBJECT,
      consentRequestId: bodyConsentId,
      fileRequestUrl: FILE_URL,
    },
  });
  expectNoFounderActRecords(db);
  return e;
}

describe('GOLDEN integration: real gate + real writer, non-founder actor', () => {
  it('(a) no consent on file and no id supplied: blocks missing, consent_requests stays empty, no founder-act artefacts', async () => {
    const db = createFakeDb();
    seedBase(db);
    await expectStoreBlock(db, undefined, 'missing', null);
    expect(db.all('consent_requests')).toHaveLength(0);
    expect(
      db.all('audit_logs').filter((a) => a.data.action === 'consent_gate_pass'),
    ).toHaveLength(0);
  });

  it('(a) an id is supplied but nothing is on file for it: blocks not_found, store stays empty', async () => {
    const db = createFakeDb();
    seedBase(db);
    await expectStoreBlock(db, 'cr-absent', 'not_found', 'cr-absent');
    expect(db.all('consent_requests')).toHaveLength(0);
  });

  it('(a/c boundary) a usable DECIDED consent for the same subject is on file but the non-founder supplied no id: still blocks missing and the decided doc is NOT consumed or reused', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedConsent(db, 'cr-decided');
    await expectStoreBlock(db, undefined, 'missing', null);
    const records = db.all('consent_requests');
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('cr-decided');
    expect(records[0].data.consumedAt).toBeNull();
    expect(records[0].data.status).toBe('consented');
  });

  it('(b) a PENDING consent on file: blocks not_decided, the pending doc is byte-untouched and nothing new is written', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedConsent(db, 'cr-pending', {
      status: 'pending',
      decidedAt: null,
      decidedAtSort: null,
      proposedActDate: '2026-10-31',
    });
    const before = db.read('consent_requests', 'cr-pending');
    await expectStoreBlock(db, 'cr-pending', 'not_decided', 'cr-pending');
    expect(db.all('consent_requests')).toHaveLength(1);
    expect(db.read('consent_requests', 'cr-pending')).toEqual(before);
    expect(db.read('consent_requests', 'cr-pending')?.status).toBe('pending');
    expect(db.read('consent_requests', 'cr-pending')?.consumedAt).toBeNull();
  });

  it('(a) IMPOSTOR: stored role founder_patron + a usable decided consent on file, no id supplied: still blocks missing, decided doc NOT reused or consumed, nothing minted (UID-only admission, f97d446)', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedImpostor(db);
    seedConsent(db, 'cr-decided');
    await expectStoreBlock(db, undefined, 'missing', null, IMPOSTOR);
    const records = db.all('consent_requests');
    expect(records).toHaveLength(1);
    expect(db.read('consent_requests', 'cr-decided')?.consumedAt).toBeNull();
    expect(
      db.all('audit_logs').filter((a) => a.data.action === 'consent_gate_pass'),
    ).toHaveLength(0);
  });

  it('(b) IMPOSTOR: stored role founder_patron + a PENDING consent supplied by id: blocks not_decided, pending doc untouched', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedImpostor(db);
    seedConsent(db, 'cr-pending', {
      status: 'pending',
      decidedAt: null,
      decidedAtSort: null,
      proposedActDate: '2026-10-31',
    });
    await expectStoreBlock(db, 'cr-pending', 'not_decided', 'cr-pending', IMPOSTOR);
    expect(db.all('consent_requests')).toHaveLength(1);
    expect(db.read('consent_requests', 'cr-pending')?.status).toBe('pending');
    expect(db.read('consent_requests', 'cr-pending')?.consumedAt).toBeNull();
  });

  it('(c) a DECIDED consent on file: passes consented, the same doc is consumed in place, no new record is minted', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedConsent(db, 'cr-decided');
    const result: unknown = await act(db, 'cr-decided');
    expect(result).toEqual({
      mode: 'hard',
      outcome: 'consented',
      consentRequestId: 'cr-decided',
    });
    const records = db.all('consent_requests');
    expect(records).toHaveLength(1);
    const doc = db.read('consent_requests', 'cr-decided');
    expect(doc?.status).toBe('consented');
    expect(doc?.consumedAt).not.toBeNull();
    expect(doc?.consumedAt).toBeDefined();
    expect(doc?.consumedBy).toBe(ACTOR);
    expect(doc?.consumedActRef).toBe('roles/user-1');
    expectNoFounderActRecords(db);
    // Exactly the a3c9702 pass audit: consent_gate_pass, no founder basis.
    const passes = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'consent_gate_pass');
    expect(passes).toHaveLength(1);
    const details = passes[0].data.details as Record<string, unknown>;
    expect(details.consentBasis).toBeUndefined();
    expect(details.decidedVia).toBeUndefined();
    expect(details.consentRequestId).toBe('cr-decided');
  });
});
