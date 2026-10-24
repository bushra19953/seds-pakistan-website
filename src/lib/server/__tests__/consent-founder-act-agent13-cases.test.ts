/**
 * @jest-environment node
 *
 * Agent 13 (TEST AUTHOR A): the four assigned founder auto-consent cases,
 * composed end-to-end — REAL gate (assertConsentFor) + REAL writer
 * (createFounderActConsent) over the fake Firestore.
 *
 * Coverage inventory behind this file (branch feat/founder-consent-fix,
 * HEAD fc7d513 at time of writing):
 *  - Case (1) valid founder act: covered at gate level with a MOCKED
 *    writer (consent-gate.test.ts), at writer level in isolation
 *    (consent-service.test.ts createFounderActConsent), and end-to-end
 *    only for the no-prior-record sanity path (consent-founder-act-
 *    integration.test.ts case (f)). This file re-pins it with the
 *    downstream act write included, so "consent written AND the action
 *    proceeds" is asserted in one place.
 *  - Case (2) invalid request: covered per-route ONLY as "the mocked
 *    gate was never called" (Tier 2 suites G1-G16). No existing test
 *    runs an invalid founder request against the real gate+writer and
 *    asserts the consent_requests collection is actually EMPTY
 *    afterwards. That is the genuinely missing assertion, pinned here.
 *  - Case (3) reuse of an existing decided consent for the same
 *    matter/target/action: covered (gate dedupe tests, service dedupe
 *    test, integration (d)/(e)). Re-pinned here with the downstream
 *    act proceeding and an exact decided-consent count of one.
 *  - Case (4) existing decided consent for a DIFFERENT target: covered
 *    only with a mocked writer at gate level and as a counter test at
 *    writer level. NO real gate+writer (integration) case existed —
 *    the B1 defect lived exactly in that composition — so this is the
 *    second genuinely missing case, pinned here for both a different
 *    targetUid and a different action on the same target.
 *
 * Ordering fixture: `performReservedMatter` below mirrors the route
 * contract the Tier 2 suites pin per-route — request validation runs
 * BEFORE assertConsentFor, and the gated write runs only after the
 * gate passes. It is a thin fixture, not code under test; everything
 * it composes (gate, writer, lookup, settings, audit) is real. The
 * only mocks are the outer seams the neighbouring B1 suite mocks:
 * firebase-admin handle, the pure isFounderUid seam of founder-gate,
 * the notification sink, and FieldValue.serverTimestamp.
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
// consent-gate.test.ts / consent-founder-act-integration.test.ts).
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
  ConsentRequiredError,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate';

const NOW = new Date(2026, 9, 21, 12, 0, 0); // Oct 21 2026
const DAY = 24 * 60 * 60 * 1000;
const VALIDITY_DAYS = 30; // explicit via matterValidityDays, as in B1

const SUBJECT: ConsentSubjectRef = {
  type: 'user_role',
  targetUid: 'user-1',
  roleKey: 'president_national',
  action: 'appoint',
};

const ACT_SUMMARY = 'Appoint user-1 as president_national';

function seedBase(db: FakeDb) {
  db.seed('users', FOUNDER_UID, { displayName: 'The Founder' });
  db.seed('roles', FOUNDER_UID, { role: 'founder_patron' });
  db.seed('governance_settings', 'phase2', {
    consentGateMode: { catb_officer: 'hard' },
    matterValidityDays: { catb_officer: VALIDITY_DAYS },
  });
}

/** Seed a usable (unexpired, unconsumed, consented) decided consent. */
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

class RequestValidationError extends Error {}

/**
 * Route-shaped fixture: validate FIRST, gate SECOND, gated write LAST —
 * the exact ordering the production routes follow, so an invalid
 * request can never reach the gate-internal auto-consent writer.
 */
async function performReservedMatter(
  db: FakeDb,
  input: { subjectRef: ConsentSubjectRef; actSummary?: string },
) {
  const s = input.subjectRef as unknown as Record<string, unknown>;
  if (input.subjectRef.type === 'user_role') {
    if (typeof s.targetUid !== 'string' || s.targetUid.trim() === '') {
      throw new RequestValidationError('targetUid is required');
    }
    if (typeof s.roleKey !== 'string' || s.roleKey.trim() === '') {
      throw new RequestValidationError('roleKey is required');
    }
    if (s.action !== 'appoint' && s.action !== 'remove') {
      throw new RequestValidationError('action must be appoint or remove');
    }
  }
  if (typeof input.actSummary !== 'string' || input.actSummary.trim() === '') {
    throw new RequestValidationError('actSummary is required');
  }

  const pass = await assertConsentFor({
    db: db as never,
    actorUid: FOUNDER_UID,
    matterKey: 'catb_officer',
    subjectRef: input.subjectRef,
    actSummary: input.actSummary,
    now: NOW,
  });

  // The gated act itself: only reachable after the gate passes.
  const targetUid = (s.targetUid as string) ?? 'unknown';
  const roleKey = (s.roleKey as string) ?? 'unknown';
  await db
    .collection('role_assignments')
    .doc(`${targetUid}-${roleKey}`)
    .set({ targetUid, roleKey, action: s.action, byUid: FOUNDER_UID });
  return pass;
}

function decidedConsents(db: FakeDb) {
  return db
    .all('consent_requests')
    .filter((r) => r.data.status === 'consented' || r.data.status === 'conditional');
}

describe('Agent 13 cases: founder auto-consent, real gate + real writer', () => {
  // ---------------------------------------------------------------------
  // Case (1): founder + valid Reserved Matter request
  // ---------------------------------------------------------------------
  it('(1) valid request: exactly one founder-act consent is written and the action proceeds', async () => {
    const db = createFakeDb();
    seedBase(db);

    const pass: any = await performReservedMatter(db, {
      subjectRef: SUBJECT,
      actSummary: ACT_SUMMARY,
    });

    // The gate passed as a founder act...
    expect(pass.mode).toBe('hard');
    expect(pass.outcome).toBe('founder_act');
    expect(typeof pass.consentRequestId).toBe('string');

    // ...exactly one consent record exists, and it is the founder-act one.
    const records = db.all('consent_requests');
    expect(records).toHaveLength(1);
    expect(decidedConsents(db)).toHaveLength(1);
    const stored: any = records[0].data;
    expect(records[0].id).toBe(pass.consentRequestId);
    expect(stored.decidedVia).toBe('founder-act');
    expect(stored.status).toBe('consented');
    expect(stored.decision).toBe('consent_given');
    expect(stored.matterKey).toBe('catb_officer');
    expect(stored.subjectRef).toEqual(SUBJECT);
    expect(stored.decidedByUid).toBe(FOUNDER_UID);
    expect(stored.requestedByUid).toBe(FOUNDER_UID);
    expect(stored.proposedAct).toBe(ACT_SUMMARY);
    expect(stored.consumedAt).toBeNull();

    // Writer artefacts: one history entry, one consent_decided audit
    // carrying the founder-act marker, one gate-pass audit.
    const history = db.all(`consent_requests/${pass.consentRequestId}/history`);
    expect(history).toHaveLength(1);
    expect(history[0].data.event).toBe('consent_given');
    const decidedAudits = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'consent_decided');
    expect(decidedAudits).toHaveLength(1);
    expect((decidedAudits[0].data.details as any)?.decidedVia).toBe('founder-act');

    // ...and the action proceeded (the gated write happened).
    expect(db.read('role_assignments', 'user-1-president_national')).toEqual(
      expect.objectContaining({ targetUid: 'user-1', roleKey: 'president_national', action: 'appoint' }),
    );
  });

  // ---------------------------------------------------------------------
  // Case (2): founder + INVALID request — validation before the gate
  // ---------------------------------------------------------------------
  it.each([
    ['missing targetUid', { ...SUBJECT, targetUid: '' }, ACT_SUMMARY],
    ['missing roleKey', { ...SUBJECT, roleKey: '' }, ACT_SUMMARY],
    ['unsupported action', { ...SUBJECT, action: 'explode' }, ACT_SUMMARY],
    ['missing act summary', { ...SUBJECT }, ''],
    ['blank act summary', { ...SUBJECT }, '   '],
  ])(
    '(2) invalid request (%s): rejected, NO consent record written, action does not proceed',
    async (_label, subjectRef, actSummary) => {
      const db = createFakeDb();
      seedBase(db);

      const err = await performReservedMatter(db, {
        subjectRef: subjectRef as ConsentSubjectRef,
        actSummary: actSummary as string,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(RequestValidationError);
      expect(err).not.toBeInstanceOf(ConsentRequiredError);

      // The core missing assertion: against the REAL writer, the store
      // holds no consent record at all — not a pending one, not a
      // founder-act one — and no consent artefacts were produced.
      expect(db.all('consent_requests')).toHaveLength(0);
      expect(decidedConsents(db)).toHaveLength(0);
      expect(
        db.all('audit_logs').filter(
          (a) => a.data.action === 'consent_decided' || a.data.action === 'consent_gate_pass',
        ),
      ).toHaveLength(0);
      expect(db.read('settings', 'consent_counter')).toBeUndefined();

      // The gated action did not proceed.
      expect(db.all('role_assignments')).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------------
  // Case (3): existing decided consent, SAME matter/target/action
  // ---------------------------------------------------------------------
  it('(3) existing decided consent for the same matter/target/action is reused: exactly one decided consent exists afterward and the action proceeds', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedDecided(db, 'seed-same');

    const pass: any = await performReservedMatter(db, {
      subjectRef: SUBJECT,
      actSummary: ACT_SUMMARY,
    });

    expect(pass.outcome).toBe('founder_act');
    expect(pass.consentRequestId).toBe('seed-same');

    // Exactly one decided consent in total: the seed, unmodified — no
    // founder-act duplicate was minted on top of it.
    expect(db.all('consent_requests')).toHaveLength(1);
    expect(decidedConsents(db)).toHaveLength(1);
    const seed: any = db.read('consent_requests', 'seed-same');
    expect(seed.decidedVia).toBeUndefined();
    expect(seed.requestNumber).toBe('FC-2026-seed-seed-same');
    expect(seed.consumedAt).toBeNull(); // founder reuse never consumes

    // No writer mint artefacts, and the counter was never allocated.
    expect(
      db.all('audit_logs').filter((a) => a.data.action === 'consent_decided'),
    ).toHaveLength(0);
    expect(db.all('consent_requests/seed-same/history')).toHaveLength(0);
    expect(db.read('settings', 'consent_counter')).toBeUndefined();

    // The gate audit cites the reused record as existing_decided...
    const passes = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'consent_gate_pass');
    expect(passes).toHaveLength(1);
    expect((passes[0].data.details as any)?.consentBasis).toBe('existing_decided');
    expect((passes[0].data.details as any)?.consentRequestId).toBe('seed-same');

    // ...and the action still proceeded under the reused consent.
    expect(db.read('role_assignments', 'user-1-president_national')).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // Case (4): existing decided consent for a DIFFERENT target / action
  // ---------------------------------------------------------------------
  it('(4a) existing decided consent for a DIFFERENT target is NOT reused: a new founder-act consent is written for this target', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedDecided(db, 'seed-other-target', {
      subjectRef: { ...SUBJECT, targetUid: 'user-2' },
    });

    const pass: any = await performReservedMatter(db, {
      subjectRef: SUBJECT,
      actSummary: ACT_SUMMARY,
    });

    expect(pass.outcome).toBe('founder_act');
    expect(pass.consentRequestId).not.toBe('seed-other-target');

    // Two records total: the untouched seed for user-2 plus a fresh
    // founder-act record whose subject is THIS target (user-1).
    const records = db.all('consent_requests');
    expect(records).toHaveLength(2);
    expect(decidedConsents(db)).toHaveLength(2);

    const seed: any = db.read('consent_requests', 'seed-other-target');
    expect(seed.decidedVia).toBeUndefined();
    expect(seed.subjectRef.targetUid).toBe('user-2');

    const fresh = records.find((r) => r.id === pass.consentRequestId);
    expect(fresh).toBeDefined();
    expect(fresh?.data.decidedVia).toBe('founder-act');
    expect(fresh?.data.status).toBe('consented');
    expect(fresh?.data.subjectRef).toEqual(SUBJECT);
    expect(fresh?.data.decidedByUid).toBe(FOUNDER_UID);

    // The gate audit cites the fresh record as a founder act, never
    // the other target's consent as existing_decided.
    const passes = db
      .all('audit_logs')
      .filter((a) => a.data.action === 'consent_gate_pass');
    expect(passes).toHaveLength(1);
    expect((passes[0].data.details as any)?.consentBasis).toBe('founder_act');
    expect((passes[0].data.details as any)?.consentRequestId).toBe(pass.consentRequestId);

    // The action proceeded for user-1 only.
    expect(db.read('role_assignments', 'user-1-president_national')).toBeDefined();
    expect(db.read('role_assignments', 'user-2-president_national')).toBeUndefined();
  });

  it('(4b) existing decided consent for the same target but a DIFFERENT action is NOT reused: a new founder-act consent is written', async () => {
    const db = createFakeDb();
    seedBase(db);
    seedDecided(db, 'seed-remove-action', {
      subjectRef: { ...SUBJECT, action: 'remove' },
    });

    const pass: any = await performReservedMatter(db, {
      subjectRef: SUBJECT, // action: 'appoint'
      actSummary: ACT_SUMMARY,
    });

    expect(pass.outcome).toBe('founder_act');
    expect(pass.consentRequestId).not.toBe('seed-remove-action');

    const records = db.all('consent_requests');
    expect(records).toHaveLength(2);
    const fresh = records.find((r) => r.id === pass.consentRequestId);
    expect(fresh?.data.decidedVia).toBe('founder-act');
    expect(fresh?.data.subjectRef).toEqual(SUBJECT);

    const seed: any = db.read('consent_requests', 'seed-remove-action');
    expect(seed.decidedVia).toBeUndefined();
    expect(seed.subjectRef.action).toBe('remove');
  });
});
