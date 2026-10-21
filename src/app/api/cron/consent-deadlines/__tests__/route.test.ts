/**
 * @jest-environment node
 *
 * Tests for /api/cron/consent-deadlines (spec Section A.9): T-7 warning
 * once per clock cycle, deemed-withheld pass-through to the service,
 * further-information requests never stamped, cron auth.
 */
import { NextRequest } from 'next/server';

const FOUNDER = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const mockAuth: { value: any } = { value: { authenticated: false, user: null } };
const mockSend = jest.fn(async () => undefined);
const fakeHolder: { db: any } = { db: null };

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => fakeHolder.db,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => mockAuth.value),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: mockSend },
}));

jest.mock('@/lib/server/consent-service', () => ({
  stampDeemedWithheld: jest.fn(async (db: any, id: string) => {
    // Simulate the real service: flip the doc out of pending on stamp.
    const current = db.read('consent_requests', id);
    if (!current || current.status !== 'pending') {
      return { stamped: false, reason: 'not_pending' };
    }
    db.seed('consent_requests', id, { ...current, status: 'deemed_withheld' });
    return { stamped: true };
  }),
}));

import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';
import { GET, runConsentDeadlines } from '@/app/api/cron/consent-deadlines/route';

const NOW = new Date(2026, 9, 21, 9, 15, 0);
const DAY = 24 * 3600 * 1000;

function seedRequest(db: any, id: string, overrides: Record<string, any> = {}) {
  db.seed('consent_requests', id, {
    status: 'pending',
    requestedByUid: 'officer-1',
    requestNumber: `FC-2026-${id}`,
    matterLabel: 'Appoint or remove a national officer',
    isUrgent: false,
    decisionDeadlineAt: new Date(NOW.getTime() + 20 * DAY),
    deadlineWarningSentAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockImplementation(async () => undefined);
  mockAuth.value = { authenticated: false, user: null };
  process.env.CRON_SECRET = 'test-secret';
});

describe('warning pass', () => {
  it('warnsAtTMinus7Once: one Founder warning and a stamp; the re-run warns no more', async () => {
    const db = createFakeDb();
    seedRequest(db, 'r1', { decisionDeadlineAt: new Date(NOW.getTime() + 3 * DAY) });
    const first = await runConsentDeadlines(db as any, NOW);
    expect(first.warningsSent).toBe(1);
    expect(mockSend).toHaveBeenCalledWith(
      FOUNDER,
      expect.objectContaining({ type: 'consent_deadline_warning' }),
      'P1',
    );
    expect(db.read('consent_requests', 'r1')?.deadlineWarningSentAt).toBeTruthy();
    mockSend.mockClear();
    const second = await runConsentDeadlines(db as any, NOW);
    expect(second.warningsSent).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('noWarnBeforeTMinus7: a deadline 20 days out stays silent', async () => {
    const db = createFakeDb();
    seedRequest(db, 'r1', { decisionDeadlineAt: new Date(NOW.getTime() + 20 * DAY) });
    const summary = await runConsentDeadlines(db as any, NOW);
    expect(summary.warningsSent).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('urgent requests warn at P0', async () => {
    const db = createFakeDb();
    seedRequest(db, 'r1', {
      decisionDeadlineAt: new Date(NOW.getTime() + 2 * DAY),
      isUrgent: true,
    });
    await runConsentDeadlines(db as any, NOW);
    expect(mockSend).toHaveBeenCalledWith(FOUNDER, expect.anything(), 'P0');
  });
});

describe('deadline pass', () => {
  it('deemedWithheldFiresOnce: past-due request is stamped and the requester notified; re-run is a no-op', async () => {
    const db = createFakeDb();
    seedRequest(db, 'r1', { decisionDeadlineAt: new Date(NOW.getTime() - 3600 * 1000) });
    const first = await runConsentDeadlines(db as any, NOW);
    expect(first.deemedWithheld).toBe(1);
    expect(mockSend).toHaveBeenCalledWith(
      'officer-1',
      expect.objectContaining({ type: 'consent_deemed_withheld' }),
      'P1',
    );
    mockSend.mockClear();
    const second = await runConsentDeadlines(db as any, NOW);
    expect(second.checked).toBe(0);
    expect(second.deemedWithheld).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('furtherInfoRequestsNeverStamped: a 90-day-old FIR request is untouched', async () => {
    const db = createFakeDb();
    seedRequest(db, 'r1', {
      status: 'further_information_requested',
      decisionDeadlineAt: new Date(NOW.getTime() - 90 * DAY),
    });
    const summary = await runConsentDeadlines(db as any, NOW);
    expect(summary.checked).toBe(0);
    expect(summary.deemedWithheld).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(db.read('consent_requests', 'r1')?.status).toBe('further_information_requested');
  });

  it('decisionInFlightWins: a stamp refusal counts as skipped and sends nothing', async () => {
    const db = createFakeDb();
    // The mocked stamp flips status before returning, so simulate the
    // race differently: pre-decide the doc but leave it pending-shaped
    // with a stamp that refuses. We emulate by making the doc decided.
    seedRequest(db, 'r1', { decisionDeadlineAt: new Date(NOW.getTime() - 3600 * 1000) });
    const { stampDeemedWithheld } = jest.requireMock('@/lib/server/consent-service');
    stampDeemedWithheld.mockResolvedValueOnce({ stamped: false, reason: 'not_pending' });
    const summary = await runConsentDeadlines(db as any, NOW);
    expect(summary.skippedDecidedInFlight).toBe(1);
    expect(summary.deemedWithheld).toBe(0);
    expect(mockSend).not.toHaveBeenCalledWith(
      'officer-1',
      expect.objectContaining({ type: 'consent_deemed_withheld' }),
      expect.anything(),
    );
  });
});

describe('cronAuth', () => {
  function cronReq(authHeader?: string) {
    return new NextRequest('http://x/api/cron/consent-deadlines', {
      method: 'GET',
      headers: authHeader ? { Authorization: authHeader } : {},
    });
  }

  it('no header and no session -> 401, zero writes', async () => {
    const db = createFakeDb();
    fakeHolder.db = db;
    seedRequest(db, 'r1', { decisionDeadlineAt: new Date(NOW.getTime() + 3 * DAY) });
    const res = await GET(cronReq());
    expect(res.status).toBe(401);
    expect(db.read('consent_requests', 'r1')?.deadlineWarningSentAt).toBeNull();
  });

  it('wrong Bearer -> 401', async () => {
    fakeHolder.db = createFakeDb();
    const res = await GET(cronReq('Bearer wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('correct Bearer runs', async () => {
    fakeHolder.db = createFakeDb();
    const res = await GET(cronReq('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('an authenticated admin session may trigger it manually', async () => {
    fakeHolder.db = createFakeDb();
    mockAuth.value = { authenticated: true, user: { userId: 'admin-1', role: 'superadmin' } };
    const res = await GET(cronReq());
    expect(res.status).toBe(200);
  });
});
