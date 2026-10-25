/**
 * @jest-environment node
 *
 * H-11 sibling contracts for GET /api/debug/firebase.
 * The route previously answered unauthenticated and disclosed raw
 * environment values (project ids). It must now gate on the Founder UID
 * and report presence only.
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
import { GET } from '@/app/api/debug/firebase/route';
import { FOUNDER_UID } from '@/lib/roles';

const SECRET = 'TEST_CREDENTIAL_VALUE_DO_NOT_LEAK';

function req(uid?: string) {
  return new NextRequest('http://localhost/api/debug/firebase', {
    headers: uid ? { authorization: `Bearer ${uid}` } : {},
  });
}

beforeAll(() => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = SECRET;
  process.env.FIREBASE_PROJECT_ID = 'test-project-id';
});
afterAll(() => {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.FIREBASE_PROJECT_ID;
});

describe('GET /api/debug/firebase (H-11 sibling)', () => {
  it('rejects anonymous callers with 401', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('rejects authenticated non-founders with 403', async () => {
    const res = await GET(req('some-other-uid'));
    expect(res.status).toBe(403);
  });

  it('serves the founder with presence only, no raw env values', async () => {
    const res = await GET(req(FOUNDER_UID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.environment.googleApplicationCredentials).toBe('present');
    expect(body.environment.firebaseProjectId).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('test-project-id');
  });
});
