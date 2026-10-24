/**
 * @jest-environment node
 *
 * FIXED (adoption wave, pack 28 / GOV-01): POST
 * /api/governance/urgent-decisions now derives the caller's role with
 * the 2-arg resolveUserRole(getDb(), uid) — the PRIMARY role only
 * (additionalRoles does NOT count). A primary president_national
 * holder reaches the service with actorRoleKey 'president_national'
 * and submits (201). The service's president-only gate is untouched
 * and the Founder exclusion stays ABSOLUTE: a founder actor is 403
 * president_only even with a president_national primary role.
 *
 * Scope note: this file pins the POST only. The route's GET is
 * consumer F16 of requireGovPermission; its permission-checked
 * behaviour is covered through the representative consumers in
 * src/lib/server/governance/__tests__/route-helpers.test.ts.
 *
 * Mocking: session, governance-enabled, route deps and the urgent
 * service are mocked at their seams, while @/lib/server/permissions
 * (resolveUserRole) and @/lib/roles are REAL and read an in-memory
 * FakeFirestore — the fix is precisely that the real 2-arg resolver
 * now hands the route the stored primary role. The mocked
 * submitUrgentDecision reproduces the service's president gate
 * verbatim (urgent.ts:140-147) and records what the route passed it.
 */

const mockState: { uid: string } = { uid: 'president-1' };
const mockSubmitCalls: Array<Record<string, unknown>> = [];
const mockDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async () => ({ uid: mockState.uid })),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  admin: {},
}));

jest.mock('@/lib/server/governance/settings', () => ({
  requireGovernanceEnabled: jest.fn(async () => undefined),
}));

jest.mock('@/lib/server/governance/firestore-stores', () => ({
  getGovernanceRouteDeps: jest.fn(() => ({
    urgentStore: { nextId: () => 'urgent-1' },
    classes: {},
    decisions: {},
    bodies: {},
  })),
}));

jest.mock('@/lib/server/governance/urgent', () => {
  const { GovernanceServiceError } = jest.requireActual('@/lib/server/governance/shared');
  return {
    noopUrgentNotifier: jest.fn(),
    submitUrgentDecision: jest.fn(async (_deps: unknown, input: Record<string, unknown>) => {
      mockSubmitCalls.push(input);
      // The service gate, verbatim (src/lib/server/governance/urgent.ts:140-147):
      if (input.isFounderActor || input.actorRoleKey !== 'president_national') {
        throw new GovernanceServiceError(
          'president_only',
          403,
          'Urgent decisions may only be submitted by the National President; the Founder may not submit acting as President',
        );
      }
      return { record: { id: 'urgent-1' }, registerDecisionId: 'decision-1' };
    }),
  };
});

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/governance/urgent-decisions/route';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { FOUNDER_UID } from '@/lib/roles';

function req() {
  return new NextRequest('http://localhost/api/governance/urgent-decisions', {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify({
      title: 'Act now',
      description: 'Delay would harm the chapter',
      decisionClassId: 'class-1',
      harmStatement: 'The venue deadline passes tonight',
    }),
  });
}

function seedRole(uid: string, record: Record<string, unknown>) {
  const db = mockDbHolder.db as FakeDb;
  db.seed('roles', uid, record);
}

beforeEach(() => {
  mockSubmitCalls.length = 0;
  mockState.uid = 'president-1';
  mockDbHolder.db = createFakeDb();
});

describe('FIXED: urgent-decisions POST resolves the PRIMARY role (2-arg)', () => {
  it('a primary president_national holder can submit: 201 with actorRoleKey president_national', async () => {
    seedRole('president-1', { role: 'president_national' });
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect((await res.json()).success).toBe(true);
    expect(mockSubmitCalls).toHaveLength(1);
    expect(mockSubmitCalls[0].actorUid).toBe('president-1');
    expect(mockSubmitCalls[0].actorRoleKey).toBe('president_national');
    expect(mockSubmitCalls[0].isFounderActor).toBe(false);
  });

  it('a legacy-token president (stored "president") resolves to president_national and can submit: 201', async () => {
    seedRole('president-1', { role: 'president' });
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(mockSubmitCalls).toHaveLength(1);
    expect(mockSubmitCalls[0].actorRoleKey).toBe('president_national');
  });

  it('president_national held ONLY via additionalRoles does NOT count: 403 president_only', async () => {
    seedRole('president-1', { role: 'member', additionalRoles: ['president_national'] });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('president_only');
    expect(mockSubmitCalls).toHaveLength(1);
    expect(mockSubmitCalls[0].actorRoleKey).not.toBe('president_national');
    expect(mockSubmitCalls[0].isFounderActor).toBe(false);
  });

  it('an ordinary member cannot submit: 403 president_only', async () => {
    seedRole('president-1', { role: 'member' });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('president_only');
  });

  it('the Founder is refused president_only BY DESIGN, even with a president_national primary role (exclusion is absolute)', async () => {
    mockState.uid = FOUNDER_UID;
    seedRole(FOUNDER_UID, { role: 'president_national' });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('president_only');
    expect(mockSubmitCalls).toHaveLength(1);
    expect(mockSubmitCalls[0].isFounderActor).toBe(true);
  });
});
