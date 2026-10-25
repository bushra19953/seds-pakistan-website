/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for the dispatch proxy's failure
 * boundary. The inner firestore handler is replaced by a mock here so
 * its failure modes can be pinned exactly:
 *
 *  - inner handler throws -> 502 { error: 'Webhook handler failed' }
 *    (NOT 500: the proxy distinguishes its own handoff failure from a
 *    handler error response)
 *  - inner handler returns a response -> the proxy returns THAT
 *    response object unchanged (identity, status and body)
 *
 * Session verification and the secret gate run for real against the
 * mocked verifySession module.
 */

const mockInnerResult = { current: null as any };
const mockInnerError = { current: null as any };

jest.mock('../../firestore/route', () => ({
  POST: jest.fn(async () => {
    if (mockInnerError.current) throw mockInnerError.current;
    return mockInnerResult.current;
  }),
}));

jest.mock('@/lib/auth/verifySession', () => ({
  SessionError: class extends Error {},
  verifySession: jest.fn(async () => ({ uid: 'u-1' })),
  toSessionErrorResponse: jest.fn(() => null),
}));

import { POST } from '../route';

function dispatchRequest(body: string): any {
  return {
    url: 'http://localhost/api/webhooks/dispatch',
    headers: new Headers({ Authorization: 'Bearer token' }),
    text: async () => body,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInnerResult.current = null;
  mockInnerError.current = null;
  process.env.FIRESTORE_WEBHOOK_SECRET = 'test-webhook-secret';
});

afterAll(() => {
  delete process.env.FIRESTORE_WEBHOOK_SECRET;
});

describe('POST /api/webhooks/dispatch — proxy failure boundary', () => {
  it('inner handler throwing -> 502 { error: "Webhook handler failed" }', async () => {
    mockInnerError.current = new Error('inner exploded');
    const res: any = await POST(dispatchRequest('{"collection":"users"}'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Webhook handler failed' });
  });

  it('inner handler response is returned UNCHANGED (same object identity)', async () => {
    const innerResponse = {
      status: 207,
      json: async () => ({ weird: true }),
      __inner: true,
    };
    mockInnerResult.current = innerResponse;
    const res: any = await POST(dispatchRequest('{"collection":"users"}'));
    expect(res).toBe(innerResponse);
    expect(res.status).toBe(207);
  });

  it('the proxied request carries the server secret as x-webhook-secret and the verbatim body', async () => {
    const { POST: innerPOST } = require('../../firestore/route');
    let seen: any = null;
    (innerPOST as jest.Mock).mockImplementationOnce(async (req: any) => {
      seen = req;
      return { status: 200, json: async () => ({ success: true }) };
    });
    await POST(dispatchRequest('{"collection":"users","docId":"u-1"}'));
    expect(seen).not.toBeNull();
    expect(seen.headers.get('x-webhook-secret')).toBe('test-webhook-secret');
    expect(seen.headers.get('Content-Type')).toBe('application/json');
    expect(seen.method).toBe('POST');
    expect(await seen.text()).toBe('{"collection":"users","docId":"u-1"}');
  });
});
