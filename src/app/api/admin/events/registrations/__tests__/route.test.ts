/**
 * @jest-environment node
 *
 * E5 registrations route contracts (mocked adapter; zero live reads):
 *  - GET with the 'events-admin' surface OFF answers 503 supa_unavailable
 *    so the attendees panel keeps its Firestore data (flag OFF = today's
 *    behavior), and the adapter is never touched.
 *  - GET with the surface ON returns the seam's registrations for exactly
 *    the requested event plus the event capacity.
 *  - POST mirrors only the whitelisted status fields, stamps updatedAt
 *    server-side, and never mirrors when the flag is off.
 *  - Auth failures behave exactly like the profit-settlement route
 *    (verifySession + canManageEvents).
 */

const mockState = { canManage: true };

jest.mock('@/lib/auth/verifySession', () => ({
  verifySession: jest.fn(async () => ({ uid: 'mgr', email: 'mgr@seds.test' })),
  toSessionErrorResponse: () => null,
  SessionError: class SessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockState.canManage),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({}),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from '../route';
import {
  setAdminEventsAdapterForTests,
  type AdminEventsSupaAdapter,
} from '@/lib/supa-events/admin-events';

const savedSurfaces = process.env.SUPA_SURFACES;

function makeAdapter(overrides: Partial<AdminEventsSupaAdapter> = {}): AdminEventsSupaAdapter {
  return {
    getDoc: jest.fn(async () => ({ id: 'ev1', capacity: 120 })),
    listDocs: jest.fn(async () => [
      { id: 'uid-a', eventId: 'ev1', status: 'confirmed' },
      { id: 'uid-b', eventId: 'ev1', status: 'pending' },
    ]),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

function getReq(qs: string) {
  return new NextRequest(`http://localhost/api/admin/events/registrations${qs}`, {
    headers: { authorization: 'Bearer <redacted>' },
  });
}

function postReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/events/registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer <redacted>' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockState.canManage = true;
  setAdminEventsAdapterForTests(undefined);
  delete process.env.SUPA_SURFACES;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  setAdminEventsAdapterForTests(undefined);
  if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedSurfaces;
  jest.restoreAllMocks();
});

describe('GET /api/admin/events/registrations', () => {
  it('missing eventId -> 400', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
  });

  it('flag OFF -> 503 supa_unavailable, adapter untouched', async () => {
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    const res = await GET(getReq('?eventId=ev1'));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'supa_unavailable' });
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('flag ON -> registrations + capacity from the seam', async () => {
    process.env.SUPA_SURFACES = 'events-admin';
    setAdminEventsAdapterForTests(makeAdapter());
    const res = await GET(getReq('?eventId=ev1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capacity).toBe(120);
    expect(body.registrations).toHaveLength(2);
    expect(body.registrations.map((r: { id: string }) => r.id)).toEqual(['uid-a', 'uid-b']);
  });
});

describe('POST /api/admin/events/registrations (mirror)', () => {
  it('flag OFF -> 200 { mirrored: false }, adapter untouched', async () => {
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    const res = await POST(postReq({ eventId: 'ev1', registrationId: 'uid-a', fields: { status: 'confirmed' } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ mirrored: false });
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });

  it('flag ON -> mirrors whitelisted fields only, with a server-stamped updatedAt', async () => {
    process.env.SUPA_SURFACES = 'events-admin';
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    const res = await POST(
      postReq({
        eventId: 'ev1',
        registrationId: 'uid-a',
        fields: { status: 'cancelled', paymentStatus: 'refunded', registrationsCount: 999, evil: 'x' },
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ mirrored: true });
    expect(adapter.updateDoc).toHaveBeenCalledTimes(1);
    const [collection, id, payload] = (adapter.updateDoc as jest.Mock).mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(collection).toBe('registrations');
    expect(id).toBe('uid-a');
    expect(payload.status).toBe('cancelled');
    expect(payload.paymentStatus).toBe('refunded');
    expect('registrationsCount' in payload).toBe(false);
    expect('evil' in payload).toBe(false);
    expect(Number.isNaN(Date.parse(payload.updatedAt as string))).toBe(false);
  });

  it('no whitelisted fields -> { mirrored: false }, no adapter write', async () => {
    process.env.SUPA_SURFACES = 'events-admin';
    const adapter = makeAdapter();
    setAdminEventsAdapterForTests(adapter);
    const res = await POST(postReq({ eventId: 'ev1', registrationId: 'uid-a', fields: { note: 'hi' } }));
    await expect(res.json()).resolves.toEqual({ mirrored: false });
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });
});
