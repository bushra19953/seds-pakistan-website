/**
 * @jest-environment node
 *
 * Route tests for /api/consents (spec Section A.9): the service is
 * mocked; these tests pin the HTTP gate behavior - 401s, the Founder
 * decision gate (NOT_FOUNDER for non-Founders incl. a CTO holder), error
 * passthrough, and that the service is never called when a gate fails.
 */
import { NextRequest } from 'next/server';

const FOUNDER = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const mockAuth: { userId: string | null } = { userId: 'officer-1' };
const mockDecider: { value: boolean } = { value: false };

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

jest.mock('@/lib/consents/consent-config', () => ({
  isConsentDecider: jest.fn(async () => mockDecider.value),
  getConsentConfig: jest.fn(async () => ({ filingsEnabled: true, founderRootMode: 'founder_only' })),
}));

jest.mock('@/lib/server/role-holders', () => ({
  resolveUserRoleKey: jest.fn(async () => 'member'),
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
    createDraft: jest.fn(async () => ({ id: 'draft-1', status: 'draft', requestNumber: null })),
    listMyRequests: jest.fn(async () => []),
    getRequest: jest.fn(async () => ({ id: 'req-1', requestedByUid: 'officer-1', status: 'draft' })),
    updateDraft: jest.fn(async () => ({ id: 'req-1', status: 'draft' })),
    submitRequest: jest.fn(async () => ({ id: 'req-1', requestNumber: 'FC-2026-0001', status: 'pending' })),
    decideRequest: jest.fn(async () => ({ id: 'req-1', status: 'consented' })),
    supplyInformation: jest.fn(async () => ({ id: 'req-1', status: 'pending' })),
    executeRequest: jest.fn(async () => ({ id: 'req-1', status: 'executed' })),
    cancelRequest: jest.fn(async () => ({ id: 'req-1', status: 'cancelled' })),
    listInbox: jest.fn(async () => ({ awaitingDecision: [], awaitingInformation: [] })),
    listRegister: jest.fn(async () => []),
    toRegisterCsv: jest.fn(() => 'Request number\n'),
  };
});

import * as service from '@/lib/server/consent-service';
import { POST as createPOST } from '@/app/api/consents/route';
import { POST as submitPOST } from '@/app/api/consents/[id]/submit/route';
import { POST as decidePOST } from '@/app/api/consents/[id]/decide/route';
import { POST as infoPOST } from '@/app/api/consents/[id]/information/route';
import { POST as executePOST } from '@/app/api/consents/[id]/execute/route';
import { POST as cancelPOST } from '@/app/api/consents/[id]/cancel/route';
import { GET as inboxGET } from '@/app/api/consents/inbox/route';

const svc = service as any;
const PARAMS = { params: { id: 'req-1' } };

function req(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.userId = 'officer-1';
  mockDecider.value = false;
});

describe('unauthenticatedRejected', () => {
  it('returns 401 and never calls the service on every route', async () => {
    mockAuth.userId = null;
    expect((await createPOST(req('http://x/api/consents', {}))).status).toBe(401);
    expect((await submitPOST(req('http://x/api/consents/req-1/submit'), PARAMS)).status).toBe(401);
    expect((await decidePOST(req('http://x/api/consents/req-1/decide', { action: 'consent_given' }), PARAMS)).status).toBe(401);
    expect((await infoPOST(req('http://x/api/consents/req-1/information', { response: 'x' }), PARAMS)).status).toBe(401);
    expect((await executePOST(req('http://x/api/consents/req-1/execute', {}), PARAMS)).status).toBe(401);
    expect((await cancelPOST(req('http://x/api/consents/req-1/cancel', {}), PARAMS)).status).toBe(401);
    expect(svc.createDraft).not.toHaveBeenCalled();
    expect(svc.submitRequest).not.toHaveBeenCalled();
    expect(svc.decideRequest).not.toHaveBeenCalled();
  });
});

describe('nonFounderDecideRejected', () => {
  it('a CTO holder and a plain officer both get 403 NOT_FOUNDER; service untouched', async () => {
    for (const uid of ['cto-1', 'officer-1']) {
      mockAuth.userId = uid;
      mockDecider.value = false;
      const res = await decidePOST(
        req('http://x/api/consents/req-1/decide', { action: 'consent_given' }),
        PARAMS,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('NOT_FOUNDER');
    }
    expect(svc.decideRequest).not.toHaveBeenCalled();
  });

  it('the inbox returns no queue data to non-Founders', async () => {
    mockDecider.value = false;
    const res = await inboxGET(req('http://x/api/consents/inbox'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_FOUNDER');
    expect(svc.listInbox).not.toHaveBeenCalled();
  });
});

describe('founderDecideSucceeds', () => {
  it('all five actions delegate to the service', async () => {
    mockAuth.userId = FOUNDER;
    mockDecider.value = true;
    for (const action of [
      'consent_given',
      'consent_refused',
      'conditional_consent',
      'request_further_information',
      'waive',
    ]) {
      const res = await decidePOST(
        req('http://x/api/consents/req-1/decide', { action }),
        PARAMS,
      );
      expect(res.status).toBe(200);
    }
    expect(svc.decideRequest).toHaveBeenCalledTimes(5);
  });
});

describe('service error passthrough', () => {
  it('doubleDecisionRejected: ALREADY_DECIDED surfaces as 409', async () => {
    mockAuth.userId = FOUNDER;
    mockDecider.value = true;
    svc.decideRequest.mockRejectedValueOnce(
      new svc.ConsentServiceError('ALREADY_DECIDED', 409, 'already decided'),
    );
    const res = await decidePOST(
      req('http://x/api/consents/req-1/decide', { action: 'consent_given' }),
      PARAMS,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_DECIDED');
  });

  it('requesterCannotTouchOthersRequests: CONSENT_FORBIDDEN surfaces as 403', async () => {
    svc.submitRequest.mockRejectedValueOnce(
      new svc.ConsentServiceError('CONSENT_FORBIDDEN', 403, 'not yours'),
    );
    expect((await submitPOST(req('http://x/api/consents/req-1/submit'), PARAMS)).status).toBe(403);
    svc.supplyInformation.mockRejectedValueOnce(
      new svc.ConsentServiceError('CONSENT_FORBIDDEN', 403, 'not yours'),
    );
    expect(
      (await infoPOST(req('http://x/api/consents/req-1/information', { response: 'x' }), PARAMS)).status,
    ).toBe(403);
    svc.executeRequest.mockRejectedValueOnce(
      new svc.ConsentServiceError('CONSENT_FORBIDDEN', 403, 'not yours'),
    );
    expect((await executePOST(req('http://x/api/consents/req-1/execute', {}), PARAMS)).status).toBe(403);
    svc.cancelRequest.mockRejectedValueOnce(
      new svc.ConsentServiceError('CONSENT_FORBIDDEN', 403, 'not yours'),
    );
    expect((await cancelPOST(req('http://x/api/consents/req-1/cancel', {}), PARAMS)).status).toBe(403);
  });

  it('filingsFlagOff: CONSENT_FILINGS_DISABLED surfaces as 403 on create', async () => {
    svc.createDraft.mockRejectedValueOnce(
      new svc.ConsentServiceError('CONSENT_FILINGS_DISABLED', 403, 'disabled'),
    );
    const res = await createPOST(req('http://x/api/consents', {}));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CONSENT_FILINGS_DISABLED');
  });

  it('validationReturnsAllFields: the 422 fields object passes through whole', async () => {
    svc.submitRequest.mockRejectedValueOnce(
      new svc.ConsentServiceError('CONSENT_VALIDATION_FAILED', 422, 'invalid', {
        matterKey: 'a',
        proposedAct: 'b',
        materialFacts: 'c',
        proposedActDate: 'd',
      }),
    );
    const res = await submitPOST(req('http://x/api/consents/req-1/submit'), PARAMS);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Object.keys(body.fields).sort()).toEqual(
      ['materialFacts', 'matterKey', 'proposedAct', 'proposedActDate'].sort(),
    );
  });
});
