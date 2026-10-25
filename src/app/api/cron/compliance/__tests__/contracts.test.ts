/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET /api/cron/compliance —
 * companion to the existing route.test.ts in this folder (which pins
 * the fail-closed auth and the flag gate). This file pins what that
 * suite does not: the audit write SET, the audit-failure response
 * variant, the flag-check failure fallback, and the delegation
 * argument (a Date) handed to runComplianceCron.
 *
 * All collaborators mocked; zero live reads.
 */

const state = {
  live: true,
  liveError: null as any,
  auditError: null as any,
  summary: {
    ok: true,
    passes: {
      filings: { ok: true, counts: { filed: 2, late: 0 }, debugExtra: 'must-be-stripped' },
      register: { ok: false, counts: { stale: 1 } },
    },
    engineExtra: 'kept-in-response',
  } as any,
  cronCalls: [] as any[],
  auditCalls: [] as any[],
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    private payload: any;
    constructor(payload: any, init?: { status?: number }) {
      this.payload = payload;
      this.status = init?.status ?? 200;
    }
    static json(payload: any, init?: { status?: number }) {
      return new MockNextResponse(payload, init);
    }
    async json() {
      return this.payload;
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('@/lib/server/governance-settings', () => ({
  isPhase2Live: async (flag: string) => {
    if (state.liveError) throw state.liveError;
    return flag === 'complianceLive' && state.live;
  },
}));

jest.mock('@/lib/server/compliance/cron', () => ({
  runComplianceCron: async (...args: any[]) => {
    state.cronCalls.push(args);
    return state.summary;
  },
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: async (...args: any[]) => {
    state.auditCalls.push(args);
    if (state.auditError) throw state.auditError;
    return 'audit-id';
  },
}));

import { GET } from '../route';

function req(auth?: string): any {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === 'authorization' ? auth ?? null : null),
    },
  };
}

const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  state.live = true;
  state.liveError = null;
  state.auditError = null;
  state.cronCalls = [];
  state.auditCalls = [];
  process.env.CRON_SECRET = 'test-secret';
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/cron/compliance — write-set contract', () => {
  it('delegates to runComplianceCron with a single Date argument', async () => {
    await GET(req('Bearer test-secret'));
    expect(state.cronCalls).toHaveLength(1);
    expect(state.cronCalls[0]).toHaveLength(1);
    expect(state.cronCalls[0][0]).toBeInstanceOf(Date);
  });

  it('returns the engine summary verbatim on success', async () => {
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(state.summary);
  });

  it('writes ONE governance audit record: actor system:compliance-cron, action compliance.cron_run, passes reduced to { ok, counts }', async () => {
    await GET(req('Bearer test-secret'));
    expect(state.auditCalls).toEqual([
      [
        {
          actorUid: 'system:compliance-cron',
          action: 'compliance.cron_run',
          subjectType: 'compliance_cron',
          subjectId: 'daily',
          details: {
            ok: true,
            passes: {
              filings: { ok: true, counts: { filed: 2, late: 0 } },
              register: { ok: false, counts: { stale: 1 } },
            },
          },
        },
      ],
    ]);
  });

  it('audit write failure -> 200 with { ...summary, auditWriteFailed: true }', async () => {
    state.auditError = new Error('audit store down');
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...state.summary, auditWriteFailed: true });
  });

  it('flag-check rejection is caught and treated as flag OFF (skipped, zero engine runs)', async () => {
    state.liveError = new Error('settings store down');
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'complianceLive off' });
    expect(state.cronCalls).toHaveLength(0);
    expect(state.auditCalls).toHaveLength(0);
  });

  it('unset secret -> 500 with the exact "is not configured" wording (differs from compliance-report)', async () => {
    delete process.env.CRON_SECRET;
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'CRON_SECRET is not configured' });
  });
});
