/**
 * @jest-environment node
 *
 * Tests for POST /api/ai/analyze-reply
 * (src/app/api/ai/analyze-reply/route.ts).
 *
 * Covers Item 1 (Phase 0): Pattern A auth gate
 * (verifyAuthentication + canManageSponsorsPartners) runs before any
 * Gemini call, validation and the analysis response shape are
 * unchanged.
 */

const state = {
  authResult: {
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin' },
  } as any,
  permissionGranted: true,
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => state.permissionGranted),
  hasServerPermissionForUser: jest.fn(async () => state.permissionGranted),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => ({})),
}));

jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: jest.fn(),
}));

import { executeWithFailover } from '@/lib/ai/key-manager';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { POST } from '../route';

const mockForUser = hasServerPermissionForUser as jest.Mock;
import { NextRequest } from 'next/server';

const mockFailover = executeWithFailover as jest.Mock;

function makeGenAI() {
  return {
    getGenerativeModel: (_opts: any) => ({
      generateContent: async (_prompt: string) => ({
        response: {
          text: () =>
            JSON.stringify({
              diagnosis: 'They are stonewalling on price.',
              strategy_applied: 'Reframe Stone Walls as Aspirations',
              suggested_response: 'Thanks for the reply. What if we phased this?',
              coaching_tip: 'Do not answer their demand immediately.',
            }),
        },
      }),
    }),
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/ai/analyze-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    replyText: 'We cannot fund this at that price.',
    partnerName: 'Partner One',
    history: [],
    strategicContext: 'Focus on STEM outreach',
    apiKey: '',
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

describe('POST /api/ai/analyze-reply', () => {
  it('returns 401 when unauthenticated and never calls Gemini', async () => {
    state.authResult = { authenticated: false, error: 'Unauthorized' };

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 403 when authenticated without canManageSponsorsPartners and never calls Gemini', async () => {
    state.permissionGranted = false;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(403);
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 400 for an authorized caller when replyText is missing', async () => {
    const res = await POST(postRequest({ partnerName: 'Partner One' }));

    expect(res.status).toBe(400);
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('holder parity: primary member with the key only via a custom grant is allowed, checked holder-scoped by userId', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'holder-1', role: 'member' },
    };
    state.permissionGranted = true;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    expect(mockForUser).toHaveBeenCalledWith(
      expect.anything(),
      'holder-1',
      'canManageSponsorsPartners'
    );
  });

  it('holder parity: holder whose custom grant no longer supplies the key keeps the original 403', async () => {
    state.authResult = {
      authenticated: true,
      user: { userId: 'holder-1', role: 'member' },
    };
    state.permissionGranted = false;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 200 with diagnosis, strategy_applied, suggested_response and coaching_tip for an authorized caller with the permission', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diagnosis).toBe('They are stonewalling on price.');
    expect(body.strategy_applied).toBe('Reframe Stone Walls as Aspirations');
    expect(body.suggested_response).toContain('What if we phased this?');
    expect(body.coaching_tip).toContain('Do not answer their demand immediately.');
  });
});
