/**
 * @jest-environment node
 *
 * Tests for POST /api/ai/match-partners
 * (src/app/api/ai/match-partners/route.ts).
 *
 * Covers Item 1 (Phase 0): Pattern A auth gate
 * (verifyAuthentication + canManageSponsorsPartners) runs before any
 * Firestore read or Gemini call, and the response is redacted to the
 * allowlist { id, organizationName, score, reason, key_factors } with
 * no partnerData, contact details, agreement intelligence, or
 * strategic context.
 */

const state = {
  authResult: {
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin' },
  } as any,
  permissionGranted: true,
};

const partnerFixtures: Record<string, any> = {
  p1: {
    organizationName: 'Partner One',
    agreementIntelligence: {
      key_clauses: ['SENTINEL-CLAUSE'],
      deliverables_promised: ['Logo placement'],
      support_offered: ['Funding'],
      risk_factors: ['None'],
    },
    primaryContact: {
      name: 'Sentinel Person',
      email: 'sentinel-contact@example.test',
      phone: '+00-000-SENTINEL',
      role: 'Director',
    },
    website: 'https://partner-one.example.test',
    interactionHistory: [{ note: 'Met last year', author: 'Admin' }],
    sponsorshipTier: 'Gold',
    strategicContext: 'SENTINEL-CONTEXT',
  },
  p2: {
    organizationName: 'Partner Two',
    agreementIntelligence: {
      key_clauses: ['OTHER-CLAUSE'],
      deliverables_promised: [],
      support_offered: [],
      risk_factors: [],
    },
    primaryContact: {
      name: 'Other Person',
      email: 'other@example.test',
      phone: '+00-111-OTHER',
      role: 'Manager',
    },
    website: 'https://partner-two.example.test',
    interactionHistory: [],
    sponsorshipTier: 'Silver',
    strategicContext: 'OTHER-CONTEXT',
  },
};

function fixtureDocs() {
  return Object.entries(partnerFixtures).map(([id, data]) => ({
    id,
    data: () => data,
  }));
}

function makeCollection() {
  return {
    doc: (id: string) => ({ id }),
    where: () => ({
      get: async () => ({ docs: fixtureDocs() }),
    }),
    get: async () => ({ docs: fixtureDocs() }),
  };
}

const mockDb = {
  collection: jest.fn((_name: string) => makeCollection()),
  getAll: jest.fn(async (...refs: Array<{ id: string }>) =>
    refs.map((ref) => ({
      exists: true,
      id: ref.id,
      data: () => partnerFixtures[ref.id],
    }))
  ),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.permissionGranted),
}));

jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: jest.fn(),
}));

import { executeWithFailover } from '@/lib/ai/key-manager';
import { POST, toRedactedMatch } from '../route';
import { NextRequest } from 'next/server';

const mockFailover = executeWithFailover as jest.Mock;

function makeGenAI() {
  return {
    getGenerativeModel: (_opts: any) => ({
      generateContent: async (_prompt: string) => ({
        response: {
          text: () =>
            JSON.stringify({
              matches: [
                {
                  id: 'p1',
                  organizationName: 'Partner One',
                  score: 9,
                  reason: 'Strong alignment with the event.',
                  key_factors: ['Has budget for STEM', 'Contract mentions youth outreach'],
                },
              ],
            }),
        },
      }),
    }),
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/ai/match-partners', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    eventName: 'National Rocketry Championship',
    eventNeeds: 'Media coverage and prize money',
    apiKey: '',
    partnerIds: ['p1', 'p2'],
    ...overrides,
  };
}

beforeEach(() => {
  state.authResult = {
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin' },
  };
  state.permissionGranted = true;
  jest.clearAllMocks();
  mockFailover.mockImplementation(async (op: any) => op(makeGenAI()));
});

describe('POST /api/ai/match-partners', () => {
  it('returns 401 when unauthenticated and never reads Firestore or calls Gemini', async () => {
    state.authResult = { authenticated: false, error: 'Unauthorized' };

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    expect(mockDb.collection).not.toHaveBeenCalled();
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is invalid (verifyAuthentication reports failure)', async () => {
    state.authResult = { authenticated: false, error: 'Token expired' };

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    expect(mockDb.collection).not.toHaveBeenCalled();
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 403 when authenticated without canManageSponsorsPartners and never reads Firestore or calls Gemini', async () => {
    state.permissionGranted = false;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(403);
    expect(mockDb.collection).not.toHaveBeenCalled();
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 400 for an authorized caller when eventName or eventNeeds is missing', async () => {
    const res = await POST(postRequest({ eventName: 'Only Name' }));

    expect(res.status).toBe(400);
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 200 with matches for an authorized caller with the permission', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].score).toBe(9);
    expect(body.matches[0].reason).toBe('Strong alignment with the event.');
  });

  it('redacts partnerData: response contains no contact email, phone, agreement intelligence, or strategic context', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sentinel-contact@example.test');
    expect(serialized).not.toContain('+00-000-SENTINEL');
    expect(serialized).not.toContain('SENTINEL-CLAUSE');
    expect(serialized).not.toContain('SENTINEL-CONTEXT');

    const match = body.matches[0];
    expect(match).not.toHaveProperty('partnerData');
    expect(match).not.toHaveProperty('primaryContact');
    expect(match).not.toHaveProperty('intelligence');
    expect(match).not.toHaveProperty('strategicContext');
    expect(match).not.toHaveProperty('interactionHistory');
  });

  it('redacted match contains exactly the allowlisted keys', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.matches[0]).sort()).toEqual([
      'id',
      'key_factors',
      'organizationName',
      'reason',
      'score',
    ]);
  });

  it('batch mode (partnerIds) and fallback mode (no partnerIds) are both gated', async () => {
    state.authResult = { authenticated: false, error: 'Unauthorized' };

    const batchRes = await POST(postRequest(validBody()));
    expect(batchRes.status).toBe(401);

    const fallbackRes = await POST(
      postRequest({ eventName: 'Event', eventNeeds: 'Needs', apiKey: '' })
    );
    expect(fallbackRes.status).toBe(401);

    expect(mockDb.collection).not.toHaveBeenCalled();
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('toRedactedMatch drops unknown future fields', () => {
    const redacted = toRedactedMatch({
      id: 'p1',
      organizationName: 'Partner One',
      score: 8,
      reason: 'Fit',
      key_factors: ['A'],
      internalNote: 'should not leak',
      partnerData: { primaryContact: { email: 'x@example.test' } },
    });

    expect(redacted).not.toHaveProperty('internalNote');
    expect(redacted).not.toHaveProperty('partnerData');
    expect(Object.keys(redacted).sort()).toEqual([
      'id',
      'key_factors',
      'organizationName',
      'reason',
      'score',
    ]);
  });
});
