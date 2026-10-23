/**
 * @jest-environment node
 *
 * Tests for POST /api/v1/chapters/invoice
 * (src/app/api/v1/chapters/invoice/route.ts).
 *
 * Covers Phase 0 Item 2:
 * (a) unauthenticated POST rejected 401 (missing and invalid token), with
 *     ZERO chapter_applications adds, ZERO audit_logs adds, ZERO Storage
 *     saves;
 * (b) ownership gate: a valid token whose uid differs from
 *     body.applicantId is 403 without canManageChapterApplications, and
 *     proceeds with it;
 * (c) fail closed on payee configuration: placeholder or unset
 *     SEDS_NTN / SEDS_IBAN / SEDS_BANK_NAME returns 503 with code
 *     'INVOICE_NOT_CONFIGURED' and zero writes of every kind;
 * (d) valid configuration issues the invoice: HTTP 200, total 50000,
 *     currency 'PKR', exactly one chapter_applications add with status
 *     'invoice_issued', exactly one audit_logs add with actorUid taken
 *     from the verified token, exactly one Storage save;
 * (e) pre-existing guards still fire after auth: blacklist 403,
 *     duplicate active application 409, body validation 400.
 *
 * The real invoice-config module is used: the route reads env per request
 * via getAgpConfig(), so each case sets process.env directly.
 */

const state = {
  authMode: 'valid' as 'valid' | 'missing' | 'invalid',
  decodedUid: 'user-a',
  permissionGranted: false,
  userData: { isBlacklisted: false } as Record<string, unknown>,
  configData: { enforcementEnabled: true } as Record<string, unknown>,
  duplicateExists: false,
  chapterAdds: [] as any[],
  auditAdds: [] as any[],
  storageSaves: [] as Array<{ path: string }>,
};

function makeDuplicateQuery() {
  const q: any = {
    where: () => q,
    limit: () => q,
    get: async () => ({ empty: !state.duplicateExists }),
  };
  return q;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'chapter_applications') {
      return {
        where: () => makeDuplicateQuery(),
        add: async (data: any) => {
          state.chapterAdds.push(data);
          return { id: 'app-test-1' };
        },
      };
    }
    if (name === 'audit_logs') {
      return {
        add: async (data: any) => {
          state.auditAdds.push(data);
          return { id: 'audit-test-1' };
        },
      };
    }
    if (name === 'users') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: true, data: () => state.userData }),
        }),
      };
    }
    if (name === 'warningConfig') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: true, data: () => state.configData }),
        }),
      };
    }
    return {
      doc: (_id: string) => ({
        get: async () => ({ exists: false, data: () => ({}) }),
      }),
      add: async () => ({ id: 'unused' }),
    };
  },
};

const mockStorage = {
  bucket: (_name: string) => ({
    file: (path: string) => ({
      save: async () => {
        state.storageSaves.push({ path });
      },
      getSignedUrl: async () => ['https://storage.example.test/invoice.pdf'],
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
  getAdminStorage: jest.fn(() => mockStorage),
}));

jest.mock('@/lib/auth/verifySession', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextResponse } = require('next/server');
  class SessionError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'SessionError';
      this.statusCode = statusCode;
    }
  }
  return {
    SessionError,
    verifySession: jest.fn(async () => {
      if (state.authMode === 'missing') {
        throw new SessionError('Unauthorized: missing Bearer token', 401);
      }
      if (state.authMode === 'invalid') {
        throw new SessionError('Unauthorized: invalid or expired token', 401);
      }
      return { uid: state.decodedUid };
    }),
    toSessionErrorResponse: (err: unknown) =>
      err instanceof SessionError
        ? NextResponse.json({ error: err.message }, { status: err.statusCode })
        : null,
  };
});

jest.mock('@/lib/server/permissions', () => ({
  // Parity conversion (Family F, F16): holder-scoped gate keyed by callerUid.
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, _key: string) => state.permissionGranted
  ),
}));

import { POST } from '@/app/api/v1/chapters/invoice/route';
import { NextRequest } from 'next/server';

const VALID_ENV = {
  SEDS_NTN: '1234567-8',
  SEDS_BANK_NAME: 'Fixture Bank Limited',
  SEDS_IBAN: 'PK36FIXT0000001123456702',
};

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/v1/chapters/invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    applicantId: 'user-a',
    applicantName: 'Applicant A',
    applicantEmail: 'a@example.com',
    institutional: {
      universityName: 'Fixture University',
      campusCity: 'Islamabad',
      deanOrFocalName: 'Fixture Dean',
      deanOrFocalEmail: 'dean@example.com',
      postalAddress: 'Fixture Address, Islamabad',
    },
    officers: [
      { role: 'president', name: 'Officer One', email: 'one@example.com' },
      { role: 'vice_president', name: 'Officer Two', email: 'two@example.com' },
      { role: 'secretary', name: 'Officer Three', email: 'three@example.com' },
      { role: 'treasurer', name: 'Officer Four', email: 'four@example.com' },
      { role: 'communications', name: 'Officer Five', email: 'five@example.com' },
    ],
    beachhead: { hasExistingSpaceSociety: false },
    ...overrides,
  };
}

function expectZeroWrites() {
  expect(state.chapterAdds).toHaveLength(0);
  expect(state.auditAdds).toHaveLength(0);
  expect(state.storageSaves).toHaveLength(0);
}

const ENV_KEYS = ['SEDS_NTN', 'SEDS_BANK_NAME', 'SEDS_IBAN', 'SEDS_PAYEE_NAME'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  state.authMode = 'valid';
  state.decodedUid = 'user-a';
  state.permissionGranted = false;
  state.userData = { isBlacklisted: false };
  state.configData = { enforcementEnabled: true };
  state.duplicateExists = false;
  state.chapterAdds = [];
  state.auditAdds = [];
  state.storageSaves = [];
  setEnv({ ...VALID_ENV, SEDS_PAYEE_NAME: undefined });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.clearAllMocks();
});

afterEach(() => {
  setEnv(savedEnv);
  (console.error as jest.Mock).mockRestore?.();
});

describe('POST /api/v1/chapters/invoice - authentication', () => {
  it('rejects a POST with no Authorization header: 401 and zero writes', async () => {
    state.authMode = 'missing';

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expectZeroWrites();
  });

  it('rejects a POST with an invalid token: 401 and zero writes', async () => {
    state.authMode = 'invalid';

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expectZeroWrites();
  });
});

describe('POST /api/v1/chapters/invoice - ownership gate', () => {
  it('rejects applicantId mismatch without canManageChapterApplications: 403 and zero writes', async () => {
    state.decodedUid = 'user-a';
    state.permissionGranted = false;

    const res = await POST(postRequest(validBody({ applicantId: 'user-b' })));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe(
      'Forbidden: you can only generate an invoice for your own chapter application'
    );
    expectZeroWrites();
  });

  it('allows applicantId mismatch WITH canManageChapterApplications and audits the token uid', async () => {
    state.decodedUid = 'admin-1';
    state.permissionGranted = true;

    const res = await POST(postRequest(validBody({ applicantId: 'user-b' })));

    expect(res.status).toBe(200);
    expect(state.chapterAdds).toHaveLength(1);
    expect(state.chapterAdds[0].applicantId).toBe('user-b');
    expect(state.auditAdds).toHaveLength(1);
    expect(state.auditAdds[0].actorUid).toBe('admin-1');
  });
});

describe('POST /api/v1/chapters/invoice - fail-closed configuration', () => {
  it('rejects the placeholder NTN: 503 INVOICE_NOT_CONFIGURED and zero writes', async () => {
    setEnv({ SEDS_NTN: '0000000-0' });

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('INVOICE_NOT_CONFIGURED');
    expect(body.error).toBe(
      'Invoice issuance is not configured: verified payee bank details are not set.'
    );
    // The response must not leak the configured values.
    expect(JSON.stringify(body)).not.toContain('0000000-0');
    expectZeroWrites();
  });

  it('rejects unset NTN: 503 INVOICE_NOT_CONFIGURED and zero writes', async () => {
    setEnv({ SEDS_NTN: undefined });

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('INVOICE_NOT_CONFIGURED');
    expectZeroWrites();
  });

  it('rejects unset IBAN: 503 INVOICE_NOT_CONFIGURED and zero writes', async () => {
    setEnv({ SEDS_IBAN: undefined });

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('INVOICE_NOT_CONFIGURED');
    expectZeroWrites();
  });

  it('rejects the placeholder IBAN: 503 INVOICE_NOT_CONFIGURED and zero writes', async () => {
    setEnv({ SEDS_IBAN: 'PK00 0000 0000 0000 0000 0000' });

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('INVOICE_NOT_CONFIGURED');
    expectZeroWrites();
  });

  it('rejects the placeholder IBAN in space-stripped form: 503 and zero writes', async () => {
    setEnv({ SEDS_IBAN: 'PK0000000000000000000000' });

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('INVOICE_NOT_CONFIGURED');
    expectZeroWrites();
  });

  it('rejects the placeholder bank name: 503 INVOICE_NOT_CONFIGURED and zero writes', async () => {
    setEnv({ SEDS_BANK_NAME: 'Bank name (configure SEDS_BANK_NAME)' });

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('INVOICE_NOT_CONFIGURED');
    expectZeroWrites();
  });
});

describe('POST /api/v1/chapters/invoice - success path and existing guards', () => {
  it('issues the invoice with valid config: 200, one application, one audit, one Storage save', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.total).toBe(50000);
    expect(body.currency).toBe('PKR');
    expect(body.invoiceNumber).toBeTruthy();

    expect(state.chapterAdds).toHaveLength(1);
    expect(state.chapterAdds[0].status).toBe('invoice_issued');
    expect(state.chapterAdds[0].invoiceNumber).toBe(body.invoiceNumber);
    expect(state.chapterAdds[0].invoiceUrl).toBe(body.invoiceUrl);

    expect(state.auditAdds).toHaveLength(1);
    expect(state.auditAdds[0].action).toBe('CHAPTER_INVOICE_ISSUED');
    expect(state.auditAdds[0].actorUid).toBe('user-a');

    expect(state.storageSaves).toHaveLength(1);
    expect(state.storageSaves[0].path).toBe(`invoices/chapter/${body.invoiceNumber}.pdf`);
  });

  it('still returns 403 for a blacklisted self-applicant after auth', async () => {
    state.userData = { isBlacklisted: true };

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      'Action Blocked: Your account is currently blacklisted.'
    );
    expectZeroWrites();
  });

  it('still returns 409 for a duplicate active application after auth', async () => {
    state.duplicateExists = true;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(409);
    expectZeroWrites();
  });

  it('still returns 400 for an invalid body (4 officers) after auth', async () => {
    const body = validBody();
    body.officers = body.officers.slice(0, 4);

    const res = await POST(postRequest(body));

    expect(res.status).toBe(400);
    expectZeroWrites();
  });
});
