/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET /api/cron/compliance-report.
 *
 * This route had NO tests before this suite. Pins CURRENT behaviour of
 * the unmodified route: fail-closed cron-only auth, the complianceLive
 * flag gate, and the delegation/write set (generate -> deliver ->
 * governance audit). All collaborators mocked; zero live reads.
 *
 * Note the auth error string differs from the sibling compliance cron:
 * here it is 'CRON_SECRET not configured' (no "is"). Pinned as-is.
 */

const state = {
  live: false,
  quarterKey: '2025-Q3',
  generateResult: { revision: 3 } as any,
  deliverResult: { deliveredTo: ['founder@example.invalid'], completedInstanceId: 'inst-1' } as any,
  liveError: null as any,
  auditError: null as any,
  calls: [] as Array<{ fn: string; args: any[] }>,
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
    state.calls.push({ fn: 'isPhase2Live', args: [flag] });
    if (state.liveError) throw state.liveError;
    return flag === 'complianceLive' && state.live;
  },
}));

jest.mock('@/lib/server/compliance/report-aggregator', () => ({
  previousQuarterKey: (now: Date) => {
    state.calls.push({ fn: 'previousQuarterKey', args: [now] });
    return state.quarterKey;
  },
}));

jest.mock('@/lib/server/compliance/report-service', () => ({
  generateQuarterlyReport: async (...args: any[]) => {
    state.calls.push({ fn: 'generateQuarterlyReport', args });
    return state.generateResult;
  },
  deliverQuarterlyReport: async (...args: any[]) => {
    state.calls.push({ fn: 'deliverQuarterlyReport', args });
    return state.deliverResult;
  },
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: async (...args: any[]) => {
    state.calls.push({ fn: 'writeGovernanceAuditOrThrow', args });
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
  state.live = false;
  state.liveError = null;
  state.auditError = null;
  state.calls = [];
  process.env.CRON_SECRET = 'test-secret';
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/cron/compliance-report — migration contract', () => {
  it('fails closed with 500 when CRON_SECRET is unset (exact body)', async () => {
    delete process.env.CRON_SECRET;
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'CRON_SECRET not configured' });
    expect(state.calls).toHaveLength(0);
  });

  it('wrong secret -> 401 { error: "Unauthorized" }, nothing runs', async () => {
    const res: any = await GET(req('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.calls).toHaveLength(0);
  });

  it('no Authorization header at all -> 401', async () => {
    const res: any = await GET(req(undefined));
    expect(res.status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });

  it('flag off -> 200 { ok: true, skipped: "complianceLive off" }, no generate/deliver/audit', async () => {
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'complianceLive off' });
    expect(state.calls.map((c) => c.fn)).toEqual(['isPhase2Live']);
    expect(state.calls[0].args).toEqual(['complianceLive']);
  });

  it('flag on: delegates generate -> deliver with (quarterKey, "cron", Date) and returns the exact summary', async () => {
    state.live = true;
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      quarterKey: '2025-Q3',
      revision: 3,
      deliveredTo: ['founder@example.invalid'],
      completedInstanceId: 'inst-1',
    });
    const gen = state.calls.find((c) => c.fn === 'generateQuarterlyReport');
    const del = state.calls.find((c) => c.fn === 'deliverQuarterlyReport');
    expect(gen?.args[0]).toBe('2025-Q3');
    expect(gen?.args[1]).toBe('cron');
    expect(gen?.args[2]).toBeInstanceOf(Date);
    expect(del?.args[0]).toBe('2025-Q3');
    expect(del?.args[1]).toBe('cron');
    expect(del?.args[2]).toBeInstanceOf(Date);
    // previousQuarterKey receives the same "now" the services receive.
    const key = state.calls.find((c) => c.fn === 'previousQuarterKey');
    expect(key?.args[0]).toBeInstanceOf(Date);
  });

  it('flag on: writes the governance audit record with the exact field set', async () => {
    state.live = true;
    await GET(req('Bearer test-secret'));
    const audit = state.calls.find((c) => c.fn === 'writeGovernanceAuditOrThrow');
    expect(audit?.args).toEqual([
      {
        actorUid: 'cron',
        action: 'compliance.report_generated',
        subjectType: 'compliance_report',
        subjectId: '2025-Q3',
        details: {
          generatedBy: 'cron',
          revision: 3,
          deliveredTo: ['founder@example.invalid'],
          completedInstanceId: 'inst-1',
        },
      },
    ]);
  });

  it('audit write failure is swallowed: still 200 with the same summary (differs from the daily compliance cron)', async () => {
    state.live = true;
    state.auditError = new Error('audit store down');
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      quarterKey: '2025-Q3',
      revision: 3,
      deliveredTo: ['founder@example.invalid'],
      completedInstanceId: 'inst-1',
    });
    expect(body.auditWriteFailed).toBeUndefined();
  });

  // Current behaviour, pinned: unlike /api/cron/compliance, this route
  // does NOT catch a rejection from isPhase2Live — the error propagates
  // out of the handler (in production Next turns it into a 500).
  it('flag check rejection propagates out of the handler (no catch in this route)', async () => {
    state.liveError = new Error('settings store down');
    await expect(GET(req('Bearer test-secret'))).rejects.toThrow('settings store down');
  });
});
