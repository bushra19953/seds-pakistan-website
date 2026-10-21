/**
 * Compliance cron route tests (spec G.5): fail-closed CRON_SECRET auth
 * (unset secret = 500, wrong secret = 401) and the complianceLive flag
 * gate (off = skipped summary, zero engine runs).
 */

const mockState = { live: false, cronRuns: 0 };

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
  isPhase2Live: async (flag: string) => flag === 'complianceLive' && mockState.live,
}));

jest.mock('@/lib/server/compliance/cron', () => ({
  runComplianceCron: async () => {
    mockState.cronRuns += 1;
    return { ok: true, passes: {} };
  },
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: async () => 'audit-id',
  GovernanceAuditError: class extends Error {},
}));

import { GET } from '../route';

function req(auth?: string): any {
  return { headers: { get: (name: string) => (name === 'authorization' ? auth ?? null : null) } };
}

const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  mockState.live = false;
  mockState.cronRuns = 0;
  process.env.CRON_SECRET = 'test-secret';
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/cron/compliance', () => {
  it('fails closed with 500 when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(500);
    expect(mockState.cronRuns).toBe(0);
  });

  it('rejects a wrong secret with 401', async () => {
    const res: any = await GET(req('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(mockState.cronRuns).toBe(0);
  });

  it('flag off: skipped summary, engine never runs', async () => {
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'complianceLive off' });
    expect(mockState.cronRuns).toBe(0);
  });

  it('flag on: runs the engine and returns its summary', async () => {
    mockState.live = true;
    const res: any = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(mockState.cronRuns).toBe(1);
    expect((await res.json()).ok).toBe(true);
  });
});
