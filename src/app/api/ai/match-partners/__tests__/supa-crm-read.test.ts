/**
 * @jest-environment node
 *
 * Cluster F wiring contract for POST /api/ai/match-partners (the
 * sponsor-match panel's server side, census P14): with the 'crm'
 * surface ON, BOTH read modes are served from the Supabase mirror —
 * batch mode by ids and fallback mode as a whole-collection (optionally
 * status-filtered) read — and Firestore is never touched. The
 * pre-existing suite (route.test.ts) pins the flag-OFF Firestore path.
 * Zero live reads; Gemini mocked at the key-manager seam.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';

const mockDb = {
  collection: jest.fn(() => {
    throw new Error('Firestore must not be read when the crm seam serves');
  }),
  getAll: jest.fn(async () => {
    throw new Error('Firestore must not be read when the crm seam serves');
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'admin-1', role: 'superadmin' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => true),
  hasServerPermissionForUser: jest.fn(async () => true),
}));

jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: jest.fn(),
}));

import { executeWithFailover } from '@/lib/ai/key-manager';
import { POST } from '../route';
import {
  __setCrmSupaEnabledForTests,
  __setCrmSupaPortForTests,
  type CrmSupaPort,
} from '@/lib/server/crm-supa';

const mockFailover = executeWithFailover as jest.Mock;

function makeGenAI(capture: { prompt?: string }) {
  return {
    getGenerativeModel: () => ({
      generateContent: async (prompt: string) => {
        capture.prompt = prompt;
        return {
          response: {
            text: () =>
              JSON.stringify({
                matches: [
                  { id: 'sp1', organizationName: 'Seam Partner', score: 9, reason: 'fit', key_factors: ['x'] },
                ],
              }),
          },
        };
      },
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

let capture: { prompt?: string };

beforeEach(() => {
  capture = {};
  jest.clearAllMocks();
  mockFailover.mockImplementation(async (op: (genAI: unknown) => unknown) => op(makeGenAI(capture)));
  const fake = new FakeSupa().seed('fs_sponsors_partners', [
    landingRow('sp1', {
      organizationName: 'Seam Partner',
      status: 'Active',
      strategicContext: 'SEAM-CONTEXT-1',
      sponsorshipTier: 'Gold',
      updatedAt: '2026-03-01T00:00:00.000Z',
    }),
    landingRow('sp2', {
      organizationName: 'Second Seam',
      status: 'Past',
      agreementIntelligence: { key_clauses: ['c'] },
      updatedAt: '2026-02-01T00:00:00.000Z',
    }),
  ]);
  __setCrmSupaEnabledForTests(true);
  __setCrmSupaPortForTests(
    createSupaAdapter(fake as unknown as SupabaseClient) as unknown as CrmSupaPort,
  );
});

afterEach(() => {
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
});

it('batch mode (partnerIds): partners come from the seam, Firestore untouched', async () => {
  const res = await POST(
    postRequest({ eventName: 'Expo', eventNeeds: 'Funding', partnerIds: ['sp1', 'ghost'] }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.matches).toHaveLength(1);
  expect(capture.prompt).toContain('Seam Partner');
  expect(capture.prompt).toContain('SEAM-CONTEXT-1');
  expect(mockDb.collection).not.toHaveBeenCalled();
});

it('whole-collection mode: all seam partners reach the prompt; status filter applies', async () => {
  const res = await POST(postRequest({ eventName: 'Expo', eventNeeds: 'Funding' }));
  expect(res.status).toBe(200);
  expect(capture.prompt).toContain('Seam Partner');
  expect(capture.prompt).toContain('Second Seam');
  expect(mockDb.collection).not.toHaveBeenCalled();

  capture = {};
  const res2 = await POST(
    postRequest({ eventName: 'Expo', eventNeeds: 'Funding', status: 'Active' }),
  );
  expect(res2.status).toBe(200);
  expect(capture.prompt).toContain('Seam Partner');
  expect(capture.prompt).not.toContain('Second Seam');
});
