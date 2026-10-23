/**
 * @jest-environment node
 *
 * Tests for the Founder Consent service (spec Section A.9), run against
 * an in-memory fake Firestore (fake-firestore.ts).
 */

const mockNotificationSend = jest.fn(async () => undefined);

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: mockNotificationSend },
}));

import { FOUNDER_UID } from '@/lib/roles';
import { createFakeDb, type FakeDb } from './fake-firestore';
import {
  ConsentServiceError,
  createDraft,
  createFounderActConsent,
  decideRequest,
  getRequest,
  listRegister,
  stampDeemedWithheld,
  submitRequest,
  supplyInformation,
} from '@/lib/server/consent-service';

const OFFICER = 'officer-1';
const OFFICER2 = 'officer-2';
const CTO = 'cto-1';

const FILING = {
  matterKey: 'appoint_remove_national_officer',
  proposedAct: 'Appoint Jane Doe as National Treasurer',
  proposedActDate: '2026-12-01',
  amountPkr: null,
  materialFacts: 'The Treasurer seat has been vacant since September.',
  isUrgent: false,
};

const T0 = new Date(2026, 9, 1, 10, 0, 0); // Oct 1 2026

function seedUsers(db: FakeDb) {
  db.seed('users', OFFICER, {
    displayName: 'Officer One',
    email: 'officer@example.com',
    chapterId: 'seds-ist-chapter',
    role: 'member',
  });
  db.seed('roles', OFFICER, { role: 'national_treasurer' });
  db.seed('users', OFFICER2, {
    displayName: 'Officer Two',
    email: 'two@example.com',
    role: 'member',
  });
  db.seed('roles', OFFICER2, { role: 'chapter_president' });
  db.seed('users', FOUNDER_UID, { displayName: 'The Founder' });
}

async function filedDraft(db: FakeDb, uid = OFFICER, filing: any = FILING) {
  const draft: any = await createDraft(db as any, uid, filing);
  return draft.id as string;
}

async function submitted(db: FakeDb, uid = OFFICER, filing: any = FILING, now = T0) {
  const id = await filedDraft(db, uid, filing);
  const result = await submitRequest(db as any, id, uid, now);
  return { id, requestNumber: result.requestNumber };
}

beforeEach(() => {
  mockNotificationSend.mockReset();
  mockNotificationSend.mockImplementation(async () => undefined);
});

describe('createDraft identity snapshots', () => {
  it('snapshots name/role/chapter server-side and ignores body identity', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const draft: any = await createDraft(db as any, OFFICER, {
      ...FILING,
      requestedByUid: 'mallory',
      requesterName: 'Mallory',
    });
    expect(draft.requestedByUid).toBe(OFFICER);
    expect(draft.requesterName).toBe('Officer One');
    expect(draft.requesterRoleKey).toBe('national_treasurer');
    expect(draft.requesterChapterId).toBe('seds-ist-chapter');
    expect(draft.status).toBe('draft');
    expect(draft.requestNumber).toBeNull();
  });
});

describe('submitAssignsSequentialNumbers', () => {
  it('assigns FC-<year>-0001 then -0002', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const a = await submitted(db, OFFICER);
    const b = await submitted(db, OFFICER2);
    expect(a.requestNumber).toMatch(/^FC-\d{4}-0001$/);
    expect(b.requestNumber).toMatch(/^FC-\d{4}-0002$/);
    const stored = db.read('consent_requests', a.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.decisionDeadlineAt).toBeInstanceOf(Date);
    expect(
      (stored?.decisionDeadlineAt as Date).getTime() -
        (stored?.submittedAt as Date).getTime(),
    ).toBe(30 * 24 * 3600 * 1000);
  });

  it('concurrent submissions get distinct numbers', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const idA = await filedDraft(db, OFFICER);
    const idB = await filedDraft(db, OFFICER2);
    const [ra, rb] = await Promise.all([
      submitRequest(db as any, idA, OFFICER, T0),
      submitRequest(db as any, idB, OFFICER2, T0),
    ]);
    expect(ra.requestNumber).not.toBe(rb.requestNumber);
    expect([ra.requestNumber, rb.requestNumber].sort()).toEqual([
      expect.stringMatching(/-0001$/),
      expect.stringMatching(/-0002$/),
    ]);
  });

  it('rejects incomplete submissions with all field errors at once', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const draft: any = await createDraft(db as any, OFFICER, {});
    await expect(
      submitRequest(db as any, draft.id, OFFICER, T0),
    ).rejects.toMatchObject({
      code: 'CONSENT_VALIDATION_FAILED',
      status: 422,
      fields: expect.objectContaining({
        matterKey: expect.any(String),
        proposedAct: expect.any(String),
        materialFacts: expect.any(String),
      }),
    });
  });
});

describe('submitIsIdempotent', () => {
  it('a second submit returns the same number and writes one history entry', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id, requestNumber } = await submitted(db);
    const again = await submitRequest(db as any, id, OFFICER, T0);
    expect(again.requestNumber).toBe(requestNumber);
    const history = db.all(`consent_requests/${id}/history`);
    expect(history.filter((h) => h.data.event === 'submitted')).toHaveLength(1);
    const counter = db.read('settings', 'consent_counter') as any;
    const year = Object.keys(counter.counters)[0];
    expect(counter.counters[year]).toBe(1);
  });
});

describe('decideWritesExhibitADecisionBlock', () => {
  it('writes decision, date, decider and signature marker in one write', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db);
    const decidedAt = new Date(2026, 9, 5, 12, 0, 0);
    await decideRequest(db as any, id, FOUNDER_UID, { action: 'consent_given' }, decidedAt);
    const stored: any = db.read('consent_requests', id);
    expect(stored.status).toBe('consented');
    expect(stored.decision).toBe('consent_given');
    expect(stored.decidedByUid).toBe(FOUNDER_UID);
    expect(stored.decisionDate).toEqual(decidedAt);
    expect(stored.founderSignatureMarker).toMatch(
      new RegExp(`^FOUNDER:${FOUNDER_UID}:`),
    );
    expect(stored.founderSignatureMarker).toContain(decidedAt.toISOString());
    const audits = db.all('audit_logs');
    expect(audits.some((a) => a.data.action === 'consent_decided')).toBe(true);
  });

  it('nonFounderDecideRejected: a CTO holder gets NOT_FOUNDER and nothing changes', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db);
    await expect(
      decideRequest(db as any, id, CTO, { action: 'consent_given' }, T0),
    ).rejects.toMatchObject({ code: 'NOT_FOUNDER', status: 403 });
    expect(db.read('consent_requests', id)?.status).toBe('pending');
  });

  it('double decision is rejected with ALREADY_DECIDED', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db);
    await decideRequest(db as any, id, FOUNDER_UID, { action: 'consent_given' }, T0);
    await expect(
      decideRequest(db as any, id, FOUNDER_UID, { action: 'consent_refused', decisionNote: 'no' }, T0),
    ).rejects.toMatchObject({ code: 'ALREADY_DECIDED', status: 409 });
  });

  it('partial consent shapes are enforced', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db);
    await expect(
      decideRequest(db as any, id, FOUNDER_UID, { action: 'conditional_consent' }, T0),
    ).rejects.toMatchObject({ code: 'CONSENT_CONDITIONS_REQUIRED' });
    await expect(
      decideRequest(
        db as any,
        id,
        FOUNDER_UID,
        { action: 'consent_refused', decisionNote: 'No', consentedScope: 'part' },
        T0,
      ),
    ).rejects.toMatchObject({ code: 'CONSENT_CONDITIONS_REQUIRED' });
    const ok = await decideRequest(
      db as any,
      id,
      FOUNDER_UID,
      { action: 'conditional_consent', consentedScope: 'The IST chapter only', refusedScope: 'All other chapters' },
      T0,
    );
    expect((ok as any).status).toBe('conditional');
  });
});

describe('furtherInfoCycleRestartsClock', () => {
  it('reply at day 20 restarts the deadline to reply + 30 days', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db, OFFICER, FILING, T0);
    const original = db.read('consent_requests', id)?.decisionDeadlineAt as Date;
    await decideRequest(
      db as any,
      id,
      FOUNDER_UID,
      { action: 'request_further_information', furtherInformationRequest: 'Attach the budget line.' },
      new Date(2026, 9, 10),
    );
    expect(db.read('consent_requests', id)?.status).toBe('further_information_requested');
    const replyAt = new Date(2026, 9, 21, 10, 0, 0); // day 20
    await supplyInformation(db as any, id, OFFICER, 'Budget line attached: PKR 40,000.', replyAt);
    const stored: any = db.read('consent_requests', id);
    expect(stored.status).toBe('pending');
    expect(stored.informationReceivedAt).toEqual(replyAt);
    expect((stored.decisionDeadlineAt as Date).getTime()).toBe(
      replyAt.getTime() + 30 * 24 * 3600 * 1000,
    );
    expect((stored.decisionDeadlineAt as Date).getTime()).toBeGreaterThan(
      original.getTime(),
    );
    expect(stored.deadlineWarningSentAt).toBeNull();
  });
});

describe('notificationsFirePerTransition', () => {
  it('urgent submit notifies the Founder at P0, normal at P1', async () => {
    const db = createFakeDb();
    seedUsers(db);
    await submitted(db, OFFICER, { ...FILING, isUrgent: true, urgencyReason: 'Time-critical' });
    expect(mockNotificationSend).toHaveBeenCalledWith(
      FOUNDER_UID,
      expect.objectContaining({ type: 'consent_submitted' }),
      'P0',
    );
    mockNotificationSend.mockClear();
    await submitted(db, OFFICER2);
    expect(mockNotificationSend).toHaveBeenCalledWith(
      FOUNDER_UID,
      expect.objectContaining({ type: 'consent_submitted' }),
      'P1',
    );
  });

  it('a notification failure does not roll back the state write', async () => {
    const db = createFakeDb();
    seedUsers(db);
    mockNotificationSend.mockRejectedValue(new Error('notify down'));
    const { id } = await submitted(db);
    expect(db.read('consent_requests', id)?.status).toBe('pending');
    await decideRequest(db as any, id, FOUNDER_UID, { action: 'consent_given' }, T0);
    expect(db.read('consent_requests', id)?.status).toBe('consented');
  });
});

describe('stampDeemedWithheld', () => {
  it('stamps once past the deadline and never twice', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db, OFFICER, FILING, T0);
    const past = new Date(T0.getTime() + 31 * 24 * 3600 * 1000);
    await expect(stampDeemedWithheld(db as any, id, past)).resolves.toEqual({
      stamped: true,
    });
    const stored: any = db.read('consent_requests', id);
    expect(stored.status).toBe('deemed_withheld');
    expect(stored.decidedByUid).toBe('system_cron');
    await expect(stampDeemedWithheld(db as any, id, past)).resolves.toEqual({
      stamped: false,
      reason: 'not_pending',
    });
  });

  it('does not stamp before the deadline', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db, OFFICER, FILING, T0);
    await expect(stampDeemedWithheld(db as any, id, T0)).resolves.toEqual({
      stamped: false,
      reason: 'not_due',
    });
  });

  it('a decision in flight wins over the cron stamp', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const { id } = await submitted(db, OFFICER, FILING, T0);
    await decideRequest(db as any, id, FOUNDER_UID, { action: 'consent_given' }, T0);
    const past = new Date(T0.getTime() + 40 * 24 * 3600 * 1000);
    await expect(stampDeemedWithheld(db as any, id, past)).resolves.toEqual({
      stamped: false,
      reason: 'not_pending',
    });
    expect(db.read('consent_requests', id)?.status).toBe('consented');
  });
});

describe('register hard filter', () => {
  it('never returns pending rows, even when asked', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const a = await submitted(db, OFFICER);
    await submitted(db, OFFICER2);
    await decideRequest(db as any, a.id, FOUNDER_UID, { action: 'consent_given' }, T0);
    await expect(listRegister(db as any, { status: 'pending' })).resolves.toEqual([]);
    const rows = await listRegister(db as any, {});
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).status).toBe('consented');
    await expect(getRequest(db as any, a.id)).resolves.toMatchObject({
      status: 'consented',
    });
  });
});

describe('ConsentServiceError shape', () => {
  it('carries code, status and fields', () => {
    const err = new ConsentServiceError('X', 422, 'msg', { a: 'b' });
    expect(err.code).toBe('X');
    expect(err.status).toBe(422);
    expect(err.fields).toEqual({ a: 'b' });
  });
});

// ---------------------------------------------------------------------------
// Fix 1 Tier 1 (plan 4.2b): createFounderActConsent — the writer behind the
// gate's founder-act pass. It must produce a record indistinguishable in
// shape from a filed+decided consent, plus subjectRef / decidedAt /
// decidedVia:'founder-act' (plan 3.1.4), atomically with its history and
// audit entries, and must dedupe against an existing decided record for
// the same matter + subject.
// ---------------------------------------------------------------------------

describe('createFounderActConsent', () => {
  const SUBJECT = {
    type: 'user_role',
    targetUid: 'user-1',
    roleKey: 'president_national',
    action: 'appoint',
  };
  const NOW = new Date(2026, 9, 21, 12, 0, 0);

  function founderInput(overrides: Record<string, unknown> = {}) {
    return {
      actorUid: FOUNDER_UID,
      matterKey: 'catb_officer',
      subjectRef: { ...SUBJECT },
      proposedAct: 'Appoint user-1 as president_national',
      gateMode: 'hard' as const,
      now: NOW,
      ...overrides,
    };
  }

  it('writes exactly one consent_requests doc with the complete decided field set', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const result = await createFounderActConsent(db as any, founderInput() as any);
    expect(result.reused).toBe(false);
    expect(result.requestNumber).toMatch(/^FC-\d{4}-0001$/);
    const docs = db.all('consent_requests');
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(result.id);
    const stored: any = docs[0].data;
    expect(stored.status).toBe('consented');
    expect(stored.decision).toBe('consent_given');
    expect(stored.decidedVia).toBe('founder-act');
    expect(stored.subjectRef).toEqual(SUBJECT);
    expect(stored.requestedByUid).toBe(FOUNDER_UID);
    expect(stored.decidedByUid).toBe(FOUNDER_UID);
    expect(stored.requesterName).toBe('The Founder');
    expect(stored.matterKey).toBe('catb_officer');
    expect(stored.requestNumber).toBe(result.requestNumber);
    expect(stored.gateModeAtFiling).toBe('hard_block');
    expect(stored.proposedAct).toBe('Appoint user-1 as president_national');
    expect(stored.founderSignatureMarker).toBe(`FOUNDER:${FOUNDER_UID}:${NOW.toISOString()}`);
    expect(stored.submittedAt).toEqual(NOW);
    expect(stored.decisionDate).toEqual(NOW);
    expect(stored.decidedAt).toEqual(NOW);
    expect(stored.decidedAtSort).toEqual(NOW);
    expect(stored.decisionDeadlineAt).toBeInstanceOf(Date);
    expect(stored.consumedAt).toBeNull();
    expect(stored.consumedBy).toBeNull();
    expect(stored.consumedActRef).toBeNull();
    expect(stored.amountPkr).toBeNull();
    expect(stored.attachments).toEqual([]);
    expect(stored.isUrgent).toBe(false);
  });

  it('writes exactly one history entry and exactly one audit entry in the same transaction', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const result = await createFounderActConsent(db as any, founderInput() as any);
    const history = db.all(`consent_requests/${result.id}/history`);
    expect(history).toHaveLength(1);
    expect(history[0].data.event).toBe('consent_given');
    expect(history[0].data.toStatus).toBe('consented');
    const audits = db.all('audit_logs').filter((a) => a.data.action === 'consent_decided');
    expect(audits).toHaveLength(1);
    expect((audits[0].data.details as any)?.decidedVia).toBe('founder-act');
  });

  it('increments the shared counter: a second, different-subject act gets the next number', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const a = await createFounderActConsent(db as any, founderInput() as any);
    const b = await createFounderActConsent(
      db as any,
      founderInput({ subjectRef: { ...SUBJECT, targetUid: 'user-2' } }) as any,
    );
    expect(a.requestNumber).toMatch(/-0001$/);
    expect(b.requestNumber).toMatch(/-0002$/);
    expect(db.all('consent_requests')).toHaveLength(2);
  });

  it('dedupe: a matching decided record returns reused:true and writes NO new doc, history, audit, or counter number', async () => {
    const db = createFakeDb();
    seedUsers(db);
    db.seed('consent_requests', 'seed-1', {
      matterKey: 'catb_officer',
      status: 'consented',
      subjectRef: { ...SUBJECT },
      consumedAt: null,
      requestNumber: 'FC-2026-0042',
      decidedAtSort: NOW,
    });
    const result = await createFounderActConsent(db as any, founderInput() as any);
    expect(result).toEqual({ id: 'seed-1', requestNumber: 'FC-2026-0042', reused: true });
    expect(db.all('consent_requests')).toHaveLength(1);
    expect(db.all('consent_requests/seed-1/history')).toHaveLength(0);
    expect(db.all('audit_logs')).toHaveLength(0);
    expect(db.read('settings', 'consent_counter')).toBeUndefined();
  });

  it('dedupe: a matching but already-consumed record does NOT dedupe (a fresh record is written)', async () => {
    const db = createFakeDb();
    seedUsers(db);
    db.seed('consent_requests', 'seed-used', {
      matterKey: 'catb_officer',
      status: 'consented',
      subjectRef: { ...SUBJECT },
      consumedAt: NOW,
      requestNumber: 'FC-2026-0042',
      decidedAtSort: NOW,
    });
    const result = await createFounderActConsent(db as any, founderInput() as any);
    expect(result.reused).toBe(false);
    expect(db.all('consent_requests')).toHaveLength(2);
  });

  it('role-arm actor: the signature marker names the ACTING uid, not the founder UID constant', async () => {
    const db = createFakeDb();
    seedUsers(db);
    db.seed('users', 'patron-2', { displayName: 'Patron Two', email: 'patron@example.com' });
    db.seed('roles', 'patron-2', { role: 'founder_patron' });
    const result = await createFounderActConsent(
      db as any,
      founderInput({ actorUid: 'patron-2' }) as any,
    );
    const stored: any = db.read('consent_requests', result.id);
    expect(stored.decidedByUid).toBe('patron-2');
    expect(stored.requesterRoleKey).toBe('founder_patron');
    expect(stored.founderSignatureMarker).toBe(`FOUNDER:patron-2:${NOW.toISOString()}`);
  });

  it('record-mode gate stamps gateModeAtFiling as record_only', async () => {
    const db = createFakeDb();
    seedUsers(db);
    const result = await createFounderActConsent(
      db as any,
      founderInput({ gateMode: 'record' }) as any,
    );
    expect(db.read('consent_requests', result.id)?.gateModeAtFiling).toBe('record_only');
  });
});
