/**
 * @jest-environment node
 *
 * Audit item 9 follow-on: the public assistant endpoint spends the
 * server Gemini key and previously had no rate limit. POSTs are now
 * limited per client IP via the existing aiRateLimiter
 * (10 requests / minute): the 11th request from one IP is a 429 and
 * the Gemini failover is never invoked for it, while a different IP
 * is unaffected.
 */

jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: jest.fn(),
}));

import { executeWithFailover } from '@/lib/ai/key-manager';
import { POST } from '../route';

const mockFailover = executeWithFailover as jest.Mock;

function makeRequest(ip: string) {
  return {
    json: async () => ({ message: 'What is a CubeSat?' }),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? ip : null,
    },
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-server-key-value-for-jest';
  mockFailover.mockImplementation(async (op: any) =>
    op({
      getGenerativeModel: () => ({
        generateContent: async () => ({ response: { text: () => 'answer' } }),
      }),
    }),
  );
});

describe('POST /api/ai/assistant rate limit', () => {
  test('allows 10 requests per IP per minute, then returns 429 without calling Gemini', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 10; i++) {
      const res: any = await POST(makeRequest(ip));
      expect(res.status).toBe(200);
    }
    const callsBefore = mockFailover.mock.calls.length;
    const blocked: any = await POST(makeRequest(ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(mockFailover.mock.calls.length).toBe(callsBefore);
  });

  test('a different IP has its own budget', async () => {
    const res: any = await POST(makeRequest('203.0.113.99'));
    expect(res.status).toBe(200);
  });
});
