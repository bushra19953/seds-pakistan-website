/** @jest-environment node */
/**
 * Founder shelter (Part B2): GET /api/public/governance-documents
 * stale-serving. The payload is public, sanitised, and slow-changing:
 * a successful response is remembered; when the records read then
 * throws code 8 (RESOURCE_EXHAUSTED, the 2026-10-30 quota death) the
 * route serves the last-good body with X-Served-Stale instead of the
 * bare framework 500 it used to produce (the read was unguarded).
 * With no last-good on hand the failure is a loud JSON 500.
 */

const mockState = {
  getError: null as unknown,
  records: [] as Array<Record<string, any>>,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => ({
    collection: (name: string) => ({
      doc: (_id: string) => ({
        get: async () => ({ exists: false, data: () => undefined }),
      }),
      get: async () => {
        if (name === 'governance_records') {
          if (mockState.getError) throw mockState.getError;
          return {
            docs: mockState.records.map((r) => ({ id: r.recordId, data: () => r })),
          };
        }
        return { docs: [] };
      },
    }),
  })),
}));

import { GET } from '../route';
import { resetPublicStaleCache } from '@/lib/server/public-stale-cache';

function quotaError(): Error {
  const err = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.') as Error & { code?: number };
  err.code = 8;
  return err;
}

const RECORD = {
  recordId: 'govfam-cs--v001',
  familyId: 'govfam-cs',
  series: 'constitution_suite',
  layer: 0,
  title: 'Constitution',
  parties: ['SEDS Pakistan'],
  recordDate: '2026-01-15',
  version: 1,
  status: 'approved',
  adoptionStatus: 'adopted_executed',
  effectiveStatus: 'in_force',
  accessLevel: 'public',
  redactionStatus: 'redacted',
  driveFileId: null,
};

beforeEach(() => {
  resetPublicStaleCache();
  mockState.getError = null;
  mockState.records = [{ ...RECORD }];
  process.env.GOVERNANCE_PUBLICATION_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.GOVERNANCE_PUBLICATION_ENABLED;
});

describe('public governance documents stale-serving', () => {
  it('serves the last-good body (200, X-Served-Stale) when the read throws code 8', async () => {
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('stale-while-revalidate=3600');
    const okBody = await ok.json();
    expect(okBody.layers['0']).toHaveLength(1);
    // Sanitised projection only: no drive id crosses even the stale path.
    expect(JSON.stringify(okBody)).not.toContain('drive');

    mockState.getError = quotaError();
    const stale = await GET();
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-served-stale')).toBe('last-good');
    expect(await stale.json()).toEqual(okBody);
  });

  it('with no last-good, a code-8 failure is a loud JSON 500', async () => {
    mockState.getError = quotaError();
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.layers).toBeUndefined();
  });
});
