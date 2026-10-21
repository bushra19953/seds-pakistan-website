/**
 * @jest-environment node
 *
 * Tests for POST /api/ai/generate-pitch
 * (src/app/api/ai/generate-pitch/route.ts).
 *
 * Covers Item 1 (Phase 0): Pattern A auth gate
 * (verifyAuthentication + canManageSponsorsPartners) runs before any
 * Gemini call, validation and the pitch response shape are unchanged,
 * and the caller apiKey is passed through to executeWithFailover.
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
}));

jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: jest.fn(),
}));

import { executeWithFailover } from '@/lib/ai/key-manager';
import { POST } from '../route';
import { NextRequest } from 'next/server';

const mockFailover = executeWithFailover as jest.Mock;

function makeGenAI() {
  return {
    getGenerativeModel: (_opts: any) => ({
      generateContent: async (_prompt: string) => ({
        response: {
          text: () =>
            JSON.stringify({
              subject: 'Partner with us on Rocketry Day',
              body: 'Hello Partner,<br>Let us build this together.',
              strategy_note: 'Golden Bridge applied with three options.',
            }),
        },
      }),
    }),
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/ai/generate-pitch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    partner: {
      organizationName: 'Partner One',
      primaryContact: { name: 'Pat', role: 'Director' },
      website: 'https://partner-one.example.test',
      interactionHistory: [],
      intelligence: {},
      strategicContext: 'Focus on STEM outreach',
    },
    eventName: 'National Rocketry Championship',
    eventNeeds: 'Prize money',
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

describe('POST /api/ai/generate-pitch', () => {
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

  it('returns 400 for an authorized caller when partner or eventName is missing', async () => {
    const res = await POST(postRequest({ eventName: 'Only Name' }));

    expect(res.status).toBe(400);
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('returns 200 with subject, body and strategy_note for an authorized caller with the permission', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe('Partner with us on Rocketry Day');
    expect(body.body).toContain('Let us build this together');
    expect(body.strategy_note).toContain('Golden Bridge');
  });

  it('passes the caller apiKey through to executeWithFailover unchanged', async () => {
    const res = await POST(postRequest(validBody({ apiKey: 'caller-key-123' })));

    expect(res.status).toBe(200);
    expect(mockFailover).toHaveBeenCalledWith(expect.any(Function), 'caller-key-123');
  });
});
