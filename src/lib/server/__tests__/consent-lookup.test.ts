/**
 * @jest-environment node
 *
 * Tests for checkConsentGate (spec Section 0.6): fail-closed in hard
 * mode, pass-with-record in record mode.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

import { FOUNDER_UID } from '@/lib/roles';
import { createFakeDb, type FakeDb } from './fake-firestore';
import { checkConsentGate } from '@/lib/server/consent-lookup';
import { createDraft, decideRequest, submitRequest } from '@/lib/server/consent-service';

const OFFICER = 'officer-1';
const FILING = {
  matterKey: 'appoint_remove_national_officer', // hard_block by default
  proposedAct: 'Appoint Jane Doe as National Treasurer',
  proposedActDate: '2026-12-01',
  amountPkr: null,
  materialFacts: 'The Treasurer seat has been vacant since September.',
  isUrgent: false,
};
const T0 = new Date(2026, 9, 1, 10, 0, 0);

function seed(db: FakeDb) {
  db.seed('users', OFFICER, { displayName: 'Officer One', role: 'member' });
  db.seed('roles', OFFICER, { role: 'national_treasurer' });
}

describe('checkConsentGate', () => {
  it('hard mode blocks when no decided consent exists', async () => {
    const db = createFakeDb();
    seed(db);
    const result = await checkConsentGate(db as any, {
      matterKey: 'appoint_remove_national_officer',
    });
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe('hard');
    expect(result.consent).toBeNull();
    expect(result.reason).toBe('NO_DECIDED_CONSENT');
  });

  it('hard mode allows with a decided consent and returns it', async () => {
    const db = createFakeDb();
    seed(db);
    const draft: any = await createDraft(db as any, OFFICER, FILING);
    await submitRequest(db as any, draft.id, OFFICER, T0);
    await decideRequest(db as any, draft.id, FOUNDER_UID, { action: 'consent_given' }, T0);
    const result = await checkConsentGate(db as any, {
      matterKey: 'appoint_remove_national_officer',
    });
    expect(result.allowed).toBe(true);
    expect((result.consent as any)?.id).toBe(draft.id);
  });

  it('record mode passes without a consent and reports the absence', async () => {
    const db = createFakeDb();
    seed(db);
    const result = await checkConsentGate(db as any, {
      matterKey: 'change_registered_office', // record_only by default
    });
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('record');
    expect(result.consent).toBeNull();
    expect(result.reason).toBe('NO_DECIDED_CONSENT');
  });

  it('an explicit mode overrides the seed default', async () => {
    const db = createFakeDb();
    seed(db);
    const result = await checkConsentGate(db as any, {
      matterKey: 'change_registered_office',
      mode: 'hard',
    });
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe('hard');
  });

  it('a failed lookup fails closed in hard mode', async () => {
    const brokenDb: any = {
      collection: () => {
        throw new Error('firestore down');
      },
    };
    const result = await checkConsentGate(brokenDb, {
      matterKey: 'appoint_remove_national_officer',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('CONSENT_LOOKUP_FAILED');
  });

  it('an unknown matter key fails closed', async () => {
    const db = createFakeDb();
    seed(db);
    const result = await checkConsentGate(db as any, { matterKey: 'not_a_matter' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('UNKNOWN_MATTER');
  });
});
