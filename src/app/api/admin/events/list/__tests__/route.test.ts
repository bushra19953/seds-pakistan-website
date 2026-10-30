/**
 * @jest-environment node
 *
 * GET /api/admin/events/list (E5 admin-events seam, CRM page events
 * read; read-bleed train 2, CRM item 2). Pins the partners/list
 * pattern: auth + permission run BEFORE the seam check, the route
 * serves ONLY seam rows (503 when the seam cannot serve — it never
 * reads Firestore itself), and the wire body is the seam array with
 * timestamps serialized by toPublicJson. Zero live reads; every
 * dependency mocked at the seam.
 */
import { NextRequest } from 'next/server';

const mockAuth = { state: { authenticated: true, user: { userId: 'u-admin' } } as any };
const mockPerm = { allowed: true };
const mockSeam = { rows: null as Array<Record<string, unknown>> | null };

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => ({})),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => mockAuth.state),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockPerm.allowed),
}));

jest.mock('@/lib/supa-events/admin-events', () => ({
  listAllEventsFromSupa: jest.fn(async () => mockSeam.rows),
}));

import { GET } from '../route';

beforeEach(() => {
  mockAuth.state = { authenticated: true, user: { userId: 'u-admin' } };
  mockPerm.allowed = true;
  mockSeam.rows = null;
});

describe('GET /api/admin/events/list', () => {
  it('401 when unauthenticated, seam never consulted', async () => {
    mockAuth.state = { authenticated: false, user: null };
    const res = await GET(new NextRequest('http://localhost/api/admin/events/list'));
    expect(res.status).toBe(401);
  });

  it('403 when the caller lacks canManageSponsorsPartners', async () => {
    mockPerm.allowed = false;
    const res = await GET(new NextRequest('http://localhost/api/admin/events/list'));
    expect(res.status).toBe(403);
  });

  it('503 when the seam cannot serve (flag off / adapter down)', async () => {
    mockSeam.rows = null;
    const res = await GET(new NextRequest('http://localhost/api/admin/events/list'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'events supa unavailable' });
  });

  it('200 with the seam rows as a plain array, timestamps ISO on the wire', async () => {
    mockSeam.rows = [
      {
        id: 'ev1',
        title: 'Space Talk',
        createdAt: {
          seconds: 1759000000,
          nanoseconds: 0,
          toDate: () => new Date(1759000000 * 1000),
          toMillis: () => 1759000000 * 1000,
        },
      },
    ];
    const res = await GET(new NextRequest('http://localhost/api/admin/events/list'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { id: 'ev1', title: 'Space Talk', createdAt: new Date(1759000000 * 1000).toISOString() },
    ]);
  });
});
