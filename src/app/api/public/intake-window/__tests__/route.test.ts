/**
 * @jest-environment node
 *
 * Suite E2: GET /api/public/intake-window (Workstream E, spec 5.3).
 * - empty collection + kind=induction -> transition shim from the
 *   deprecated constant (X-Intake-Source: shim)
 * - seeded windows -> data source, public shape only
 * - docs exist but none resolve -> fail-safe closed, no_window_resolved
 * - invalid kind -> 400; db unavailable -> 200 fail-safe closed
 */

import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';
import { FakeDb } from '@/lib/intake-windows/__tests__/fake-firestore';

const mockGetDb = jest.fn();

jest.mock('@/lib/server/firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin/firestore');
  return {
    getDb: () => mockGetDb(),
    admin: { firestore: { Timestamp: actual.Timestamp, FieldValue: actual.FieldValue } },
  };
});

import { GET } from '../route';

const NOW_MS = Date.parse('2026-10-21T10:00:00.000Z');
let db: FakeDb;
let nowSpy: jest.SpyInstance;

function req(url: string) {
  return new NextRequest(url);
}

function seedWindow(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  db.seed('intake_windows', id, {
    windowId: id,
    label: 'Fall Induction',
    kind: 'induction',
    opensAt: Timestamp.fromMillis(Date.parse('2026-10-01T00:00:00.000Z')),
    closesAt: Timestamp.fromMillis(Date.parse('2026-10-25T00:00:00.000Z')),
    timezone: 'Asia/Karachi',
    isDefault: false,
    storedStatus: null,
    source: 'manual',
    templateId: null,
    notes: 'admin-only secret note',
    createdBy: 'admin-uid-1',
    createdAt: Timestamp.fromMillis(Date.parse('2026-09-01T00:00:00.000Z')),
    updatedAt: Timestamp.fromMillis(Date.parse('2026-09-01T00:00:00.000Z')),
    ...overrides,
  });
}

beforeEach(() => {
  db = new FakeDb();
  mockGetDb.mockReset();
  mockGetDb.mockReturnValue(db);
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe('GET /api/public/intake-window', () => {
  it('serves the transition shim while the collection is empty', async () => {
    const res = await GET(req('http://localhost/api/public/intake-window'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-intake-source')).toBe('shim');
    expect(res.headers.get('cache-control')).toContain('s-maxage=30');
    const body = await res.json();
    expect(body.windowId).toBe('induction-legacy-shim');
    expect(body.kind).toBe('induction');
    expect(body.closesAt).toBe('2026-10-22T18:59:59.000Z');
    expect(body.state).toBe('open');
    expect(body.serverNow).toBe('2026-10-21T10:00:00.000Z');
  });

  it('serves resolved window data with only public fields', async () => {
    seedWindow('induction-2026-10-fall-induction');
    const res = await GET(
      req('http://localhost/api/public/intake-window?kind=induction'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-intake-source')).toBe('data');
    const body = await res.json();
    expect(body.windowId).toBe('induction-2026-10-fall-induction');
    expect(body.state).toBe('open');
    expect(body.opensAt).toBe('2026-10-01T00:00:00.000Z');
    expect(body.closesAt).toBe('2026-10-25T00:00:00.000Z');
    // Admin-only fields never leak into the public projection.
    expect(body).not.toHaveProperty('notes');
    expect(body).not.toHaveProperty('createdBy');
    expect(body).not.toHaveProperty('cancelReason');
  });

  it('fails safe closed when docs exist but none resolve for the kind', async () => {
    seedWindow('drive-2027-08-annual', { kind: 'drive' });
    const res = await GET(
      req('http://localhost/api/public/intake-window?kind=induction'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('closed');
    expect(body.error).toBe('no_window_resolved');
    expect(body.windowId).toBeNull();
  });

  it('fails safe closed when the resolved window is malformed', async () => {
    seedWindow('induction-bad', {
      opensAt: Timestamp.fromMillis(Date.parse('2026-10-25T00:00:00.000Z')),
      closesAt: Timestamp.fromMillis(Date.parse('2026-10-01T00:00:00.000Z')),
    });
    const res = await GET(req('http://localhost/api/public/intake-window'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.state).toBe('closed');
    expect(body.error).toBe('window_malformed');
  });

  it('rejects an invalid kind with 400', async () => {
    const res = await GET(
      req('http://localhost/api/public/intake-window?kind=bogus'),
    );
    expect(res.status).toBe(400);
  });

  it('fails safe closed when the database is unavailable', async () => {
    mockGetDb.mockReturnValue(null);
    const res = await GET(req('http://localhost/api/public/intake-window'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('closed');
    expect(body.error).toBe('no_window_resolved');
  });
});
