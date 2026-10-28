/**
 * @jest-environment node
 *
 * Audit item 5 (+20): POST /api/auth/signup is the rate-limited,
 * enumeration-safe account-creation path for the homepage join form.
 * - happy path: Admin createUser + createCustomToken, token returned
 * - auth/email-already-exists returns the SAME generic 400 body as any
 *   other failure (no enumeration oracle through our own endpoint)
 * - input failures (bad email, weak password) are distinguishable
 *   because they describe the caller's input, not an account
 * - per-IP limiter: the 11th creation from one IP inside the window
 *   is a 429 and createUser is not called for it
 * - per-email limiter: the 6th attempt for one email inside the
 *   window is a 429
 *
 * The Admin SDK is mocked; no Firestore data is read.
 */

const mockCreateUser = jest.fn();
const mockCreateCustomToken = jest.fn();

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  admin: {
    auth: () => ({
      createUser: mockCreateUser,
      createCustomToken: mockCreateCustomToken,
    }),
  },
}));

import { POST } from '../route';
import { GENERIC_SIGNUP_ERROR } from '@/lib/signup-errors';

let uidCounter = 0;

function makeRequest(body: unknown, ip: string): any {
  return {
    json: async () => body,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? ip : null,
    },
  };
}

const validBody = (email: string) => ({
  name: 'Test Person',
  email,
  password: 'long-enough',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateUser.mockImplementation(async () => ({ uid: `uid-${++uidCounter}` }));
  mockCreateCustomToken.mockImplementation(async (uid: string) => `token-for-${uid}`);
});

describe('POST /api/auth/signup', () => {
  it('creates the account server-side and returns a custom token', async () => {
    const res: any = await POST(makeRequest(validBody('happy@example.com'), '10.0.0.1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.customToken).toBe('string');
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'happy@example.com', displayName: 'Test Person' }),
    );
    // The password reaches the Admin SDK only, never the response.
    expect(JSON.stringify(body)).not.toContain('long-enough');
  });

  it('maps email-already-exists to the same generic 400 as other failures', async () => {
    mockCreateUser.mockRejectedValueOnce(
      Object.assign(new Error('raw provider text'), { code: 'auth/email-already-exists' }),
    );
    const resDup: any = await POST(makeRequest(validBody('dup@example.com'), '10.0.0.2'));
    expect(resDup.status).toBe(400);
    const dupBody = await resDup.json();
    expect(dupBody.error).toBe(GENERIC_SIGNUP_ERROR);
    expect(JSON.stringify(dupBody).toLowerCase()).not.toContain('already');

    mockCreateUser.mockRejectedValueOnce(
      Object.assign(new Error('raw provider text'), { code: 'auth/internal-error' }),
    );
    const resOther: any = await POST(makeRequest(validBody('other@example.com'), '10.0.0.3'));
    expect(resOther.status).toBe(400);
    expect((await resOther.json()).error).toBe(dupBody.error);
  });

  it('keeps input-only failures distinct: invalid email and weak password', async () => {
    const badEmail: any = await POST(
      makeRequest({ name: 'Test Person', email: 'not-an-email', password: 'long-enough' }, '10.0.0.4'),
    );
    expect(badEmail.status).toBe(400);
    expect((await badEmail.json()).code).toBe('auth/invalid-email');

    const weak: any = await POST(
      makeRequest({ name: 'Test Person', email: 'weak@example.com', password: '123' }, '10.0.0.5'),
    );
    expect(weak.status).toBe(400);
    expect((await weak.json()).code).toBe('auth/weak-password');
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('rate-limits per IP: 10 creations pass, the 11th is 429 with no createUser call', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 10; i++) {
      const res: any = await POST(makeRequest(validBody(`ip-user-${i}@example.com`), ip));
      expect(res.status).toBe(200);
    }
    const callsBefore = mockCreateUser.mock.calls.length;
    const blocked: any = await POST(makeRequest(validBody('ip-user-11@example.com'), ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(mockCreateUser.mock.calls.length).toBe(callsBefore);
  });

  it('rate-limits per email: the 6th attempt for one email is 429', async () => {
    const email = 'repeat@example.com';
    for (let i = 0; i < 5; i++) {
      const res: any = await POST(makeRequest(validBody(email), `10.8.0.${i + 1}`));
      expect(res.status).toBe(200);
    }
    const blocked: any = await POST(makeRequest(validBody(email), '10.8.0.99'));
    expect(blocked.status).toBe(429);
  });
});
