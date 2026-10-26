/**
 * @jest-environment node
 *
 * Route-level mirror wiring for POST /api/governance/settings: the
 * mirror fires only after the primary write AND the Firestore audit
 * entry succeed; a mirror failure leaves the response unchanged, while
 * an audit failure still fails the request (oracle asymmetry).
 */
import { NextRequest } from 'next/server';

const FOUNDER = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

const state: { stored: Record<string, unknown> | null; sets: any[]; auditThrows: boolean } = {
  stored: null,
  sets: [],
  auditThrows: false,
};
const mockMirror = jest.fn(async () => true);
// W4 primacy double, OFF-faithful: with SUPA_PRIMARY unset the real
// setGovernanceDocPrimaryFirst returns false with no side effects, and
// the route runs its original Firestore-first flow (write, audit,
// mirror). The primacy-ON arm is pinned by
// settings-notifications-primacy-w4.
const mockPrimaryFirst = jest.fn(async () => false);
const mockAudit = jest.fn(async () => {
  if (state.auditThrows) throw new Error('audit write failed');
  return 'audit-id';
});

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
    assertFounder: jest.fn(async () => ({ uid: FOUNDER })),
  };
});

jest.mock('@/lib/auth/verifySession', () => ({
  toSessionErrorResponse: () => null,
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: (...args: any[]) => (mockAudit as any)(...args),
}));

jest.mock('@/lib/server/settings-mirror', () => ({
  mirrorGovernanceDoc: (...args: any[]) => (mockMirror as any)(...args),
  setGovernanceDocPrimaryFirst: (...args: any[]) => (mockPrimaryFirst as any)(...args),
}));

import { POST } from '@/app/api/governance/settings/route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/governance/settings', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_BODY = { flags: { consentLive: true }, changeReason: 'turn consent live now' };

beforeEach(() => {
  state.stored = null;
  state.sets = [];
  state.auditThrows = false;
  mockMirror.mockReset();
  mockMirror.mockResolvedValue(true);
  mockPrimaryFirst.mockReset();
  mockPrimaryFirst.mockResolvedValue(false);
  mockAudit.mockClear();
});

describe('POST mirror wiring', () => {
  it('mirrors after primary write + audit, with ISO updatedAt (primary used serverTimestamp)', async () => {
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(200);
    expect(state.sets[0].updatedAt).toBe('SERVER_TS'); // primary unchanged
    // The route consults the primacy helper first (OFF double:
    // returns false), with the same payload it later mirrors.
    expect(mockPrimaryFirst).toHaveBeenCalledTimes(1);
    expect(mockPrimaryFirst).toHaveBeenCalledWith('phase2', expect.objectContaining({
      flags: { consentLive: true },
      updatedBy: FOUNDER,
      changeReason: 'turn consent live now',
    }));
    expect(mockMirror).toHaveBeenCalledTimes(1);
    const [id, payload] = mockMirror.mock.calls[0] as any[];
    expect(id).toBe('phase2');
    expect(payload.flags).toEqual({ consentLive: true });
    expect(payload.updatedBy).toBe(FOUNDER);
    expect(payload.changeReason).toBe('turn consent live now');
    expect(typeof payload.updatedAt).toBe('string');
    expect(payload.updatedAt).not.toBe('SERVER_TS');
    expect(Number.isNaN(Date.parse(payload.updatedAt))).toBe(false);
  });

  it('a throwing mirror leaves the response unchanged', async () => {
    mockMirror.mockRejectedValue(new Error('supa down'));
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.flags.consentLive).toBe(true);
  });

  it('an audit failure still fails the request and nothing mirrors', async () => {
    state.auditThrows = true;
    await expect(POST(req(VALID_BODY))).rejects.toThrow('audit write failed');
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('does not mirror when validation fails', async () => {
    const res = await POST(req({ flags: { consentLive: true }, changeReason: 'short' }));
    expect(res.status).toBe(400);
    expect(mockPrimaryFirst).not.toHaveBeenCalled();
    expect(mockMirror).not.toHaveBeenCalled();
  });
});
