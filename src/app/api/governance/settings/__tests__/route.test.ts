/**
 * @jest-environment node
 *
 * Tests for POST /api/governance/settings (spec Section 0.1):
 * Founder-only writes, changeReason bookkeeping, enum validation.
 */
import { NextRequest } from 'next/server';

const FOUNDER = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

const state: { founder: boolean; stored: Record<string, unknown> | null; sets: any[] } = {
  founder: true,
  stored: null,
  sets: [],
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () =>
          state.stored === null
            ? { exists: false, data: () => undefined }
            : { exists: true, data: () => state.stored },
        set: async (data: any) => {
          state.sets.push(data);
          state.stored = { ...(state.stored ?? {}), ...data };
        },
      }),
    }),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TS' },
}));

jest.mock('@/lib/server/founder-gate', () => {
  class FounderGateError extends Error {
    constructor() {
      super('Forbidden: Founder only');
      this.name = 'FounderGateError';
    }
  }
  return {
    FounderGateError,
    assertFounder: jest.fn(async () => {
      if (!state.founder) throw new FounderGateError();
      return { uid: FOUNDER };
    }),
  };
});

jest.mock('@/lib/auth/verifySession', () => ({
  toSessionErrorResponse: () => null,
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(async () => 'audit-id'),
}));

import { POST } from '@/app/api/governance/settings/route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/governance/settings', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  state.founder = true;
  state.stored = null;
  state.sets = [];
});

describe('POST /api/governance/settings', () => {
  it('non-founder gets 403 NOT_FOUNDER and zero writes', async () => {
    state.founder = false;
    const res = await POST(req({ flags: { consentLive: true }, changeReason: 'enable consent' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_FOUNDER');
    expect(state.sets).toHaveLength(0);
  });

  it('founder update writes updatedBy, updatedAt and changeReason', async () => {
    const res = await POST(
      req({ flags: { consentLive: true }, changeReason: 'turn consent live now' }),
    );
    expect(res.status).toBe(200);
    expect(state.sets).toHaveLength(1);
    expect(state.sets[0].updatedBy).toBe(FOUNDER);
    expect(state.sets[0].changeReason).toBe('turn consent live now');
    expect(state.sets[0].updatedAt).toBe('SERVER_TS');
    const body = await res.json();
    expect(body.settings.flags.consentLive).toBe(true);
  });

  it('rejects a changeReason shorter than 10 chars', async () => {
    const res = await POST(req({ flags: { consentLive: true }, changeReason: 'short' }));
    expect(res.status).toBe(400);
    expect(state.sets).toHaveLength(0);
  });

  it('rejects invalid enum values and unknown flags', async () => {
    const res = await POST(
      req({ consentGateMode: { chapter_lifecycle: 'bogus' }, changeReason: 'a long enough reason' }),
    );
    expect(res.status).toBe(400);
    const res2 = await POST(
      req({ flags: { nopeLive: true }, changeReason: 'a long enough reason' }),
    );
    expect(res2.status).toBe(400);
    expect(state.sets).toHaveLength(0);
  });
});
