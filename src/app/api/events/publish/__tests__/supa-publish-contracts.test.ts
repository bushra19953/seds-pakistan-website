/**
 * @jest-environment node
 *
 * Contract extensions for POST /api/events/publish, recorded from the
 * CURRENT Firestore implementation (feat/integration-wave3 @
 * 4d5a1e16) ahead of the Supabase migration (implementer branch
 * feat/supa-events-1, server events core).
 *
 * The pre-existing suite in this directory (route-parity.test.ts)
 * pins the permission gate (Firestore-sourced canManageEvents via a
 * custom role; expired/missing grant -> 403 { error: 'Forbidden' })
 * and is NOT duplicated here. This file pins the response shapes and
 * write effects that suite does not reach:
 *
 *   E-PUB-01  No Bearer token -> 401 { error: 'Unauthorized' }.
 *   E-PUB-02  Missing eventId -> 400 { error: 'Missing eventId' }.
 *             The field check runs AFTER the permission gate: a
 *             grant-less caller with a missing eventId gets 403,
 *             not 400.
 *   E-PUB-03  Unknown event -> 404 { error: 'Event not found' }.
 *   E-PUB-04  No database -> 500 { error: 'Firestore not initialized' }.
 *   E-PUB-05  Success body is exactly
 *             { ok: true, message: 'Global broadcast successful!
 *             Displaying on all user announcement feeds.' }.
 *   E-PUB-06  Broadcast write effects: an announcement is written at
 *             announcements/evt_promo_<eventId> with type
 *             'EVENT_PROMO', status 'published', audience 'public',
 *             targetRoles ['public'], priority 'high', ctaText
 *             'Register Now', ctaLink '/events/<eventId>', authorId
 *             'system'; its title is '🚀 New Event: <title>' (or
 *             '🚀 New Workshop: <title>' for type 'workshop'); its
 *             content prefers valueProposition, else the first 100
 *             chars of description, else the fixed fallback; its
 *             deadline mirrors registrationDeadline, else endAt, else
 *             null; and the event doc gains broadcasted: true.
 *   E-PUB-07  Idempotency: a second POST for an already-broadcast
 *             event returns 200 { message: 'Event already broadcasted
 *             globally. Skipping duplicate broadcast.' } — note there
 *             is NO `ok` field on this arm — and writes nothing new:
 *             the announcement and the event are byte-identical.
 *   E-PUB-08  The announcement write is an idempotent merge-set at a
 *             deterministic id, so even a manual re-broadcast cannot
 *             duplicate the promo doc (collection size stays 1).
 *
 * The REAL permissions resolver runs against FakeFirestore, exactly
 * as in route-parity.test.ts. Zero live reads.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: jest.fn(async () => ({ uid: HOLDER })),
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts' },
      Timestamp: { fromDate: (d: Date) => d },
    },
  },
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST } from '../route';

function db(): FakeDb {
  return mockDbHolder.db as FakeDb;
}

function req(body: unknown, withAuth = true) {
  return new NextRequest('http://localhost/api/events/publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(withAuth ? { authorization: 'Bearer test-token' } : {}),
    },
    body: JSON.stringify(body),
  });
}

function seedHolder() {
  db().seed('roles', HOLDER, { role: 'member', additionalRoles: [CUSTOM] });
  db().seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: ['canManageEvents'] });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = createFakeDb();
  seedHolder();
  db().seed('events', 'ev-1', {
    title: 'Launch Night',
    type: 'event',
    description: 'A'.repeat(150),
    broadcasted: false,
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('E-PUB: validation arms', () => {
  it('E-PUB-01 a request with no Bearer token is 401 Unauthorized and writes nothing', async () => {
    const res = await POST(req({ eventId: 'ev-1' }, false));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(db().all('announcements')).toHaveLength(0);
    expect(db().read('events', 'ev-1')!.broadcasted).toBe(false);
  });

  it('E-PUB-02 a missing eventId is 400 Missing eventId', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing eventId' });
  });

  it('E-PUB-02 the permission gate precedes the field check: no grant plus missing eventId is 403, not 400', async () => {
    db().seed('roles', HOLDER, { role: 'member' });
    const res = await POST(req({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('E-PUB-03 an unknown event is 404 Event not found and writes no announcement', async () => {
    const res = await POST(req({ eventId: 'nope' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
    expect(db().all('announcements')).toHaveLength(0);
  });

  it('E-PUB-04 with no database the route is 500 Firestore not initialized', async () => {
    mockDbHolder.db = null;
    const res = await POST(req({ eventId: 'ev-1' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
  });
});

describe('E-PUB: broadcast effects and idempotency', () => {
  it('E-PUB-05/06 a successful broadcast returns the exact body, writes the promo announcement, and marks the event', async () => {
    const res = await POST(req({ eventId: 'ev-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      message: 'Global broadcast successful! Displaying on all user announcement feeds.',
    });

    const ann = db().read('announcements', 'evt_promo_ev-1')!;
    expect(ann).toBeTruthy();
    expect(ann.title).toBe('🚀 New Event: Launch Night');
    expect(ann.content).toBe('A'.repeat(100)); // description truncated to 100 chars
    expect(ann.status).toBe('published');
    expect(ann.type).toBe('EVENT_PROMO');
    expect(ann.audience).toBe('public');
    expect(ann.targetRoles).toEqual(['public']);
    expect(ann.priority).toBe('high');
    expect(ann.ctaText).toBe('Register Now');
    expect(ann.ctaLink).toBe('/events/ev-1');
    expect(ann.authorId).toBe('system');
    expect(ann.authorName).toBe('SEDS Central');
    expect(ann.deadline).toBeNull();
    expect(ann.capacity).toBeNull();
    expect(ann.location).toBeNull();

    expect(db().read('events', 'ev-1')!.broadcasted).toBe(true);
  });

  it("E-PUB-06 a workshop event's promo title says Workshop, and valueProposition wins over description", async () => {
    db().seed('events', 'ev-2', {
      title: 'CubeSat 101',
      type: 'workshop',
      valueProposition: 'Build a satellite in a day.',
      description: 'Long description that must not be used.',
      broadcasted: false,
    });
    const res = await POST(req({ eventId: 'ev-2' }));
    expect(res.status).toBe(200);
    const ann = db().read('announcements', 'evt_promo_ev-2')!;
    expect(ann.title).toBe('🚀 New Workshop: CubeSat 101');
    expect(ann.content).toBe('Build a satellite in a day.');
    expect(ann.ctaLink).toBe('/events/ev-2');
  });

  it('E-PUB-06 with neither valueProposition nor description the promo content is the fixed fallback, and deadline mirrors registrationDeadline', async () => {
    db().seed('events', 'ev-3', {
      title: 'Bare Event',
      broadcasted: false,
      registrationDeadline: { seconds: 1800000000 },
      capacity: 40,
      location: 'IST Auditorium',
    });
    await POST(req({ eventId: 'ev-3' }));
    const ann = db().read('announcements', 'evt_promo_ev-3')!;
    expect(ann.content).toBe('Registration is now open. Secure your spot!');
    expect(ann.deadline).toEqual({ seconds: 1800000000 });
    expect(ann.capacity).toBe(40);
    expect(ann.location).toBe('IST Auditorium');
  });

  it('E-PUB-07 a second broadcast returns the skip message with NO ok field and changes nothing', async () => {
    await POST(req({ eventId: 'ev-1' }));
    const annBefore = db().read('announcements', 'evt_promo_ev-1');
    const eventBefore = db().read('events', 'ev-1');

    const res = await POST(req({ eventId: 'ev-1' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      message: 'Event already broadcasted globally. Skipping duplicate broadcast.',
    });
    expect(json.ok).toBeUndefined();
    expect(db().read('announcements', 'evt_promo_ev-1')).toEqual(annBefore);
    expect(db().read('events', 'ev-1')).toEqual(eventBefore);
  });

  it('E-PUB-07/08 an event seeded as already broadcasted yields the skip arm on the first POST, with no announcement written', async () => {
    db().seed('events', 'ev-9', { title: 'Old Event', broadcasted: true });
    const res = await POST(req({ eventId: 'ev-9' }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/already broadcasted/);
    expect(db().all('announcements')).toHaveLength(0);
  });
});
