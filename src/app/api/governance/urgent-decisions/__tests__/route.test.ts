/**
 * @jest-environment node
 *
 * CHARACTERIZATION — FOUND-NOT-FIXED (coordinator adaptation of plan
 * 4.3b; this adaptation overrides the plan's fixed-behaviour cases for
 * this route).
 *
 * POST /api/governance/urgent-decisions resolves the caller's stored
 * role through resolveUserRole(uid) (1-arg, deny-all -> always null),
 * so actorRoleKey reaching the service is always
 * resolveCanonicalRole(null) — never 'president_national'. The
 * service's president-only gate (urgent.ts:140-147) therefore fires
 * for EVERYONE: the real National President cannot submit. The
 * Founder's 403 on this route is BY DESIGN (the record must stay the
 * President's) and is pinned as such.
 *
 * Scope note: this file pins the POST only. The route's GET is
 * consumer F16 of requireGovPermission and IS repaired by Fix 2; its
 * permission-checked behaviour is covered through the representative
 * consumers in src/lib/server/governance/__tests__/route-helpers.test.ts.
 *
 * Mocking follows the governance settings route test style: session,
 * governance-enabled, deps and the urgent service are mocked at their
 * seams, while @/lib/server/permissions (resolveUserRole) and
 * @/lib/roles are REAL — the pin is precisely that the real 1-arg
 * resolver hands the route null. The mocked submitUrgentDecision
 * reproduces the service's president gate verbatim (urgent.ts:140-147)
 * and records what the route passed it.
 */

const mockState: { uid: string } = { uid: 'president-1' };
const mockSubmitCalls: Array<Record<string, unknown>> = [];

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async () => ({ uid: mockState.uid })),
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

beforeEach(() => {
  mockSubmitCalls.length = 0;
  mockState.uid = 'president-1';
});

describe('CHARACTERIZATION (found-not-fixed): urgent-decisions POST role resolution', () => {
  it('the National President cannot submit today: the route hands the service a null-derived role, never president_national', async () => {
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('president_only');
    expect(mockSubmitCalls).toHaveLength(1);
    expect(mockSubmitCalls[0].actorUid).toBe('president-1');
    expect(mockSubmitCalls[0].actorRoleKey).not.toBe('president_national');
    expect(mockSubmitCalls[0].isFounderActor).toBe(false);
  });

  it('the Founder is refused president_only BY DESIGN (this exclusion must survive any future repair)', async () => {
    mockState.uid = FOUNDER_UID;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('president_only');
    expect(mockSubmitCalls).toHaveLength(1);
    expect(mockSubmitCalls[0].isFounderActor).toBe(true);
  });
});
