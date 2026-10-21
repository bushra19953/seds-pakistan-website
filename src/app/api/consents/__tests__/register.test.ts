/**
 * @jest-environment node
 *
 * Route tests for GET /api/consents/register (spec Sections A.7/A.9):
 * Founder and National General Secretary access, officer denial, filter
 * passthrough, and the CSV export shape.
 */
import { NextRequest } from 'next/server';

const FOUNDER = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const mockAuth: { userId: string | null } = { userId: FOUNDER };
const mockRole: { value: string | null } = { value: null };

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({}),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () =>
    mockAuth.userId
      ? { authenticated: true, user: { userId: mockAuth.userId } }
      : { authenticated: false, user: null },
  ),
}));

jest.mock('@/lib/server/role-holders', () => ({
  resolveUserRoleKey: jest.fn(async () => mockRole.value),
  resolveRoleHolders: jest.fn(async () => []),
}));

jest.mock('@/lib/server/consent-service', () => {
  class ConsentServiceError extends Error {
    code: string;
    status: number;
    fields?: Record<string, string>;
    constructor(code: string, status: number, message: string, fields?: Record<string, string>) {
      super(message);
      this.code = code;
      this.status = status;
      this.fields = fields;
    }
  }
  return {
    ConsentServiceError,
    listRegister: jest.fn(async () => [
      { id: 'r1', requestNumber: 'FC-2026-0001', status: 'consented' },
    ]),
    toRegisterCsv: jest.fn(
      () => 'Request number,Date of request,Requesting person\nFC-2026-0001,2026-10-01,Officer One\n',
    ),
  };
});

import * as service from '@/lib/server/consent-service';
import { GET as registerGET } from '@/app/api/consents/register/route';

const svc = service as any;

function getReq(url: string) {
  return new NextRequest(url, { method: 'GET' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.userId = FOUNDER;
  mockRole.value = null;
});

describe('GET /api/consents/register access', () => {
  it('the Founder can read the register', async () => {
    const res = await registerGET(getReq('http://x/api/consents/register'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.register).toHaveLength(1);
  });

  it('the National General Secretary can read the register', async () => {
    mockAuth.userId = 'ngs-1';
    mockRole.value = 'national_general_secretary';
    const res = await registerGET(getReq('http://x/api/consents/register'));
    expect(res.status).toBe(200);
  });

  it('an ordinary officer is denied and the service is not called', async () => {
    mockAuth.userId = 'officer-9';
    mockRole.value = 'chapter_president';
    const res = await registerGET(getReq('http://x/api/consents/register'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CONSENT_FORBIDDEN');
    expect(svc.listRegister).not.toHaveBeenCalled();
  });

  it('unauthenticated callers get 401', async () => {
    mockAuth.userId = null;
    const res = await registerGET(getReq('http://x/api/consents/register'));
    expect(res.status).toBe(401);
  });
});

describe('register filters and CSV', () => {
  it('passes status, matter, q and limit through to the service', async () => {
    await registerGET(
      getReq('http://x/api/consents/register?status=consented&matterKey=related_party_contract&q=Doe&limit=25'),
    );
    expect(svc.listRegister).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        status: 'consented',
        matterKey: 'related_party_contract',
        q: 'Doe',
        limit: 25,
      }),
    );
  });

  it('?format=csv returns text/csv with the header row and attachment disposition', async () => {
    const res = await registerGET(getReq('http://x/api/consents/register?format=csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('register-of-consents.csv');
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('Request number');
  });
});
