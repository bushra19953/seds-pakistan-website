/**
 * @jest-environment node
 *
 * GET /api/admin/governance/consents/decided - the picker's read.
 * Contract under test (fix/consent-picker-degraded): a DEGRADED
 * lookup (ConsentLookupDegradedError - an arm failed or timed out
 * and nothing matched) answers 503 so the picker renders its
 * load-error state with Retry; only a genuinely successful read may
 * answer 200, with an empty list when no decided consent matches and
 * expired records excluded. A 200 [] must never be producible from
 * failed reads - that was the false "No decided consent for this act
 * yet" the founder hit live on 2026-10-30 while FC-2026-0054 was on
 * file and consented.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { role: 'founder_patron' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => true),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({}),
}));

jest.mock('@/lib/server/governance-settings', () => ({
  getConsentMatterSettings: jest.fn(async () => ({ validityDays: 30 })),
}));

const mockLookup = jest.fn();
jest.mock('@/lib/server/consent-lookup', () => ({
  ...jest.requireActual('@/lib/server/consent-lookup'),
  listDecidedConsentsForAct: (db: unknown, matter: unknown, subject: unknown) =>
    mockLookup(db, matter, subject),
}));

import { NextRequest } from 'next/server';
import { GET } from '../route';
import { ConsentLookupDegradedError } from '@/lib/server/consent-lookup';

function pickerRequest(): NextRequest {
  const subject = encodeURIComponent(
    JSON.stringify({
      type: 'role_definition',
      slug: 'custom_finance_deputy_pipeline_tracking',
      action: 'create',
    }),
  );
  return new NextRequest(
    `http://localhost/api/admin/governance/consents/decided?matter=role_catalog&subjectType=role_definition&subject=${subject}`,
  );
}

const D = (day: number) => new Date(2026, 9, day, 10, 0, 0);

beforeEach(() => {
  mockLookup.mockReset();
});

describe('GET /api/admin/governance/consents/decided', () => {
  it('answers 503 when the lookup is degraded (arm failure, no match)', async () => {
    mockLookup.mockRejectedValue(
      new ConsentLookupDegradedError(['candidates: timed out after 8000ms']),
    );
    const res = await GET(pickerRequest());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Consent lookup degraded' });
  });

  it('answers 200 with an empty list only for a genuinely successful empty read', async () => {
    mockLookup.mockResolvedValue([]);
    const res = await GET(pickerRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ requests: [] });
  });

  it('answers 200 with the matched consent and excludes expired records', async () => {
    mockLookup.mockResolvedValue([
      {
        id: 'fc0054',
        requestNumber: 'FC-2026-0054',
        status: 'consented',
        decision: 'consent_given',
        decidedAt: D(29),
        decidedAtSort: D(29),
        consumedAt: null,
      },
      {
        id: 'expired1',
        requestNumber: 'FC-2026-0001',
        status: 'consented',
        decision: 'consent_given',
        decidedAt: new Date(2026, 0, 1, 10, 0, 0),
        decidedAtSort: new Date(2026, 0, 1, 10, 0, 0),
        consumedAt: null,
      },
    ]);
    const res = await GET(pickerRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].id).toBe('fc0054');
    expect(body.requests[0].requestNumber).toBe('FC-2026-0054');
  });
});
