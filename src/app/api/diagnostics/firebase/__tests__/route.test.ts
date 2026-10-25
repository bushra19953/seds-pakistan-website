/**
 * @jest-environment node
 *
 * H-11 regression contracts for GET /api/diagnostics/firebase.
 * The route previously answered unauthenticated and returned the raw
 * GOOGLE_APPLICATION_CREDENTIALS env value. It must now:
 *  - reject anonymous callers (401),
 *  - reject authenticated non-founders (403),
 *  - serve the founder, with presence booleans only — the credential
 *    value must not appear anywhere in the response body.
 * The real founder gate runs; only the session and diagnostics seams
 * are mocked.
 */

jest.mock('@/lib/auth/verifySession', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextResponse } = require('next/server');
  class SessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    SessionError,
    verifySession: jest.fn(
      async (req: { headers: { get(name: string): string | null } }) => {
        const header = req.headers.get('authorization');
        if (!header?.startsWith('Bearer ')) {
          throw new SessionError('Unauthorized: missing Bearer token', 401);
        }
        return { uid: header.slice('Bearer '.length) };
      },
    ),
    toSessionErrorResponse: (err: unknown) =>
      err instanceof SessionError
        ? NextResponse.json(
            { error: (err as Error).message },
            { status: (err as SessionError).statusCode },
          )
        : null,
  };
});

jest.mock('@/lib/server/firebase-admin', () => ({
  getAdminDiagnostics: () => ({ initialized: true, projectIdPresent: true }),
  getLastAdminError: () => null,
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/diagnostics/firebase/route';
import { FOUNDER_UID } from '@/lib/roles';

const SECRET = 'TEST_CREDENTIAL_VALUE_DO_NOT_LEAK';

function req(uid?: string) {
  return new NextRequest('http://localhost/api/diagnostics/firebase', {
    headers: uid ? { authorization: `Bearer ${uid}` } : {},
  });
}

beforeAll(() => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = SECRET;
});
afterAll(() => {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

describe('GET /api/diagnostics/firebase (H-11)', () => {
  it('rejects anonymous callers with 401', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('rejects authenticated non-founders with 403', async () => {
    const res = await GET(req('some-other-uid'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });

  it('serves the founder with presence booleans only', async () => {
    const res = await GET(req(FOUNDER_UID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.environment.GOOGLE_APPLICATION_CREDENTIALS).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
