/**
 * @jest-environment node
 *
 * DEFECT (Issue Ticket inert, live retest 2026-10-26): on a confirmed,
 * payment-verified registration, POST /api/v1/tickets/issue produced no
 * ticket. Root cause pinned here: with the 'tickets' Supabase surface ON,
 * the seam's non-transactional reads treated an adapter MISS as
 * authoritative. Issuance itself is Firestore-primary (its transaction
 * NEVER writes Supabase), and the checkout/order writer mirrors the
 * registration to Firestore ONLY — so a registration (or a whole event
 * created through the Firestore admin form) can exist in Firestore while
 * its fs_* row is absent. The route then read "Event not found" /
 * "Registration not found" for data that was right there in Firestore
 * and issued nothing.
 *
 * These tests reproduce the live chain exactly as the Attendees panel
 * drives it (body { eventId, uid, regId }), with the adapter answering
 * empty/null for everything, and Firestore holding the confirmed +
 * verified registration. They also pin the profile half of the
 * deliverable: after a successful issuance, the member's
 * users/{uid}.eventsAttended entry (what the profile Tickets tab reads)
 * is mirrored to the fs_users row the profile seam serves, because the
 * Firestore arrayUnion alone is invisible to that read path.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
const mockState = { uid: 'holder-1' };

const adapter = {
  getDoc: jest.fn(),
  listDocs: jest.fn(),
  countDocs: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
};

jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => surface === 'tickets',
  getSupaClient: () => ({ fake: 'client' }),
  getSupaAdapter: () => adapter,
}));

const adminStub = {
  auth: () => ({
    verifyIdToken: async () => ({ uid: mockState.uid }),
  }),
  firestore: {
    Timestamp: {
      now: () => new Date(),
      fromDate: (d: Date) => d,
    },
    FieldValue: {
      serverTimestamp: () => new Date(),
      arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
    },
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: adminStub,
  ...adminStub,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockHolder.db,
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

jest.mock('qrcode', () => {
  const encode = async (text: string) =>
    `data:image/png;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
  const api = { toDataURL: encode, toBuffer: async (text: string) => Buffer.from(text, 'utf8') };
  return { __esModule: true, default: api, ...api };
});

import { POST } from '@/app/api/v1/tickets/issue/route';

const CUSTOM = 'custom_verify_design_aide';
const EVENT_ID = 'ev2paid';
const UID = 'target-1';
const TICKET_DOC_ID = `${EVENT_ID}_${UID}`;

function req(body: unknown) {
  return new NextRequest('http://localhost/api/v1/tickets/issue', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let db: FakeFirestore;

beforeEach(() => {
  db = createFakeFirestore() as never;
  mockHolder.db = db;
  mockState.uid = 'holder-1';
  jest.clearAllMocks();

  // Adapter (fs_* landing tables) knows NOTHING about this event,
  // registration or ticket — the Firestore-primary writers never landed
  // there. The member's fs_users row exists (dump-era) with no tickets.
  adapter.listDocs.mockResolvedValue([]);
  adapter.getDoc.mockImplementation(async (path: string, id: string) => {
    if (path === 'users' && id === UID) return { id: UID, displayName: 'Target One', eventsAttended: [] };
    return null;
  });
  adapter.updateDoc.mockImplementation(async (_path: string, id: string, updates: Record<string, unknown>) => ({ id, ...updates }));

  db.__seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: ['canManageEvents'] });
  db.__seed('roles', 'holder-1', { role: 'member', additionalRoles: [CUSTOM] });
  db.__seed('users', UID, { displayName: 'Target One', email: 'target@example.com', eventsAttended: [] });
  db.__seed('events', EVENT_ID, {
    title: 'EV2 PAID TEST',
    venue: 'IST Auditorium',
    ticketCount: 0,
    paymentDetails: { isPaid: true, amount: 500, currency: 'PKR' },
  });
  // Exactly the panel's view: confirmed seat, verified payment.
  db.__seed(`events/${EVENT_ID}/registrations`, UID, {
    uid: UID,
    eventId: EVENT_ID,
    status: 'confirmed',
    paymentStatus: 'verified',
    displayName: 'Target One',
    email: 'target@example.com',
    paymentMethod: 'bank_transfer',
  });

  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

describe('issue ticket with the tickets Supa surface ON and fs_* rows missing', () => {
  it('issues a real ticket for the confirmed + verified Firestore registration (panel request shape, regId included)', async () => {
    const res = await POST(req({ eventId: EVENT_ID, uid: UID, regId: UID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.existing).toBe(false);
    expect(body.ticketId).toMatch(/^EVT-EV2PAI-\d{8}-0001$/);

    const stored = db.__doc('eventTickets', TICKET_DOC_ID);
    expect(stored).toBeDefined();
    expect(stored!.ticketId).toBe(body.ticketId);
    expect(stored!.status).toBe('valid');

    const reg = db.__doc(`events/${EVENT_ID}/registrations`, UID);
    expect(reg!.ticketId).toBe(body.ticketId);

    // Profile Tickets tab source: users/{uid}.eventsAttended.
    const user = db.__doc('users', UID);
    expect(user!.eventsAttended as any[]).toHaveLength(1);
    expect((user!.eventsAttended as any[])[0].ticketId).toBe(body.ticketId);
  });

  it('mirrors the new eventsAttended entry onto the fs_users row the profile seam serves', async () => {
    const res = await POST(req({ eventId: EVENT_ID, uid: UID, regId: UID }));
    expect(res.status).toBe(200);
    const body = await res.json();

    const userMirrorCalls = adapter.updateDoc.mock.calls.filter((c) => c[0] === 'users' && c[1] === UID);
    expect(userMirrorCalls).toHaveLength(1);
    const mirrored = userMirrorCalls[0][2] as { eventsAttended: any[] };
    expect(mirrored.eventsAttended).toHaveLength(1);
    expect(mirrored.eventsAttended[0].eventId).toBe(EVENT_ID);
    expect(mirrored.eventsAttended[0].ticketId).toBe(body.ticketId);
  });

  it('re-issue after a Firestore-only first issuance returns the same readable ticket id (existing arm)', async () => {
    const first = await (await POST(req({ eventId: EVENT_ID, uid: UID, regId: UID }))).json();
    const secondRes = await POST(req({ eventId: EVENT_ID, uid: UID, regId: UID }));
    expect(secondRes.status).toBe(200);
    const second = await secondRes.json();
    expect(second.existing).toBe(true);
    // The panel opens /events/ticket/<ticketId> from this value: it must
    // be the readable id, not the deterministic doc id.
    expect(second.ticketId).toBe(first.ticketId);
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(1);
  });
});
