/**
 * @jest-environment node
 *
 * Issuance-integrity tests for POST /api/v1/tickets/issue (EV-P12/EV-P13).
 *
 * Defects covered:
 *  - The stored qrCodeDataUrl used to encode ".../verify/ticket/PLACEHOLDER"
 *    because the QR was generated before the real ticket id existed. The QR
 *    payload must decode to this ticket's own verification URL.
 *  - Issuance never checked the registration's paymentStatus: a confirmed
 *    but unpaid registration received a full ticket, and a missing
 *    registration was auto-created as confirmed+verified from ANY order,
 *    even a never-verified one.
 *
 * The 'qrcode' module is mocked with a reversible payload encoding
 * (base64 of the exact text handed to the generator) so the test decodes
 * the stored QR payload byte-for-byte. What is under test is the PAYLOAD
 * the route asks the generator to encode, not the PNG rendering, which is
 * the qrcode library's own behaviour.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
const mockState = { uid: 'holder-1' };

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
const KEY = 'canManageEvents';
const EVENT_ID = 'gala2026';
const UID = 'target-1';
const TICKET_DOC_ID = `${EVENT_ID}_${UID}`;

function req(body: unknown) {
  return new NextRequest('http://localhost/api/v1/tickets/issue', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function decodeQrPayload(qrCodeDataUrl: string): string {
  const base64 = qrCodeDataUrl.split(',')[1];
  return Buffer.from(base64, 'base64').toString('utf8');
}

let db: FakeFirestore;

function seedEvent(paymentDetails: Record<string, unknown> | undefined) {
  db.__seed('events', EVENT_ID, {
    title: 'Founders Gala',
    venue: 'IST Auditorium',
    ticketCount: 0,
    ...(paymentDetails ? { paymentDetails } : {}),
  });
}

function seedRegistration(data: Record<string, unknown>) {
  db.__seed(`events/${EVENT_ID}/registrations`, UID, data);
}

beforeEach(() => {
  db = createFakeFirestore() as never;
  mockHolder.db = db;
  mockState.uid = 'holder-1';

  db.__seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: [KEY] });
  db.__seed('roles', 'holder-1', { role: 'member', additionalRoles: [CUSTOM] });
  db.__seed('users', UID, { displayName: 'Target One', email: 'target@example.com', eventsAttended: [] });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

describe('tickets issue integrity (EV-P12/EV-P13)', () => {
  it('paid + verified registration: issued ticket QR decodes to the real verify URL containing its own ticket id', async () => {
    seedEvent({ isPaid: true, amount: 1500, currency: 'PKR' });
    seedRegistration({
      status: 'confirmed',
      paymentStatus: 'verified',
      displayName: 'Target One',
      email: 'target@example.com',
      paymentMethod: 'bank_transfer',
    });

    const res = await POST(req({ eventId: EVENT_ID, uid: UID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.existing).toBe(false);
    expect(body.ticketId).toMatch(/^EVT-GALA20-\d{8}-0001$/);

    const stored = db.__doc('eventTickets', TICKET_DOC_ID);
    expect(stored).toBeDefined();
    expect(stored!.ticketId).toBe(body.ticketId);
    // Stored verification URL is the canonical verify shape for THIS ticket.
    expect(stored!.verificationUrl).toBe(`https://sedspakistan.live/verify/ticket/${body.ticketId}`);
    // The QR payload decodes to exactly that URL — not the placeholder.
    const payload = decodeQrPayload(stored!.qrCodeDataUrl as string);
    expect(payload).toBe(stored!.verificationUrl);
    expect(payload).toContain(body.ticketId);
    expect(payload).not.toContain('PLACEHOLDER');

    // Registration was stamped with the same readable id.
    const reg = db.__doc(`events/${EVENT_ID}/registrations`, UID);
    expect(reg!.ticketId).toBe(body.ticketId);
  });

  it('paid + unpaid registration: rejected naming the unpaid state, and no ticket is written', async () => {
    seedEvent({ isPaid: true, amount: 1500, currency: 'PKR' });
    seedRegistration({
      status: 'confirmed',
      paymentStatus: 'unpaid',
      displayName: 'Target One',
      email: 'target@example.com',
    });

    const res = await POST(req({ eventId: EVENT_ID, uid: UID }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('paymentStatus: unpaid');
    expect(body.error).toMatch(/unpaid registration/);

    expect(db.__doc('eventTickets', TICKET_DOC_ID)).toBeUndefined();
    const reg = db.__doc(`events/${EVENT_ID}/registrations`, UID);
    expect(reg!.ticketId).toBeUndefined();
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(0);
  });

  it('paid + pending registration: also rejected (payment outstanding is not verified)', async () => {
    seedEvent({ isPaid: true, amount: 1500, currency: 'PKR' });
    seedRegistration({
      status: 'confirmed',
      paymentStatus: 'pending',
      displayName: 'Target One',
      email: 'target@example.com',
    });

    const res = await POST(req({ eventId: EVENT_ID, uid: UID }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('paymentStatus: pending');
    expect(db.__doc('eventTickets', TICKET_DOC_ID)).toBeUndefined();
  });

  it('free event: issues normally even though no payment was ever taken', async () => {
    seedEvent({ isPaid: false });
    // Free registrations carry no verified payment to check; the old
    // standalone flow could also leave paymentStatus unstamped.
    seedRegistration({
      status: 'confirmed',
      displayName: 'Target One',
      email: 'target@example.com',
    });

    const res = await POST(req({ eventId: EVENT_ID, uid: UID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const stored = db.__doc('eventTickets', TICKET_DOC_ID);
    expect(stored).toBeDefined();
    const payload = decodeQrPayload(stored!.qrCodeDataUrl as string);
    expect(payload).toBe(`https://sedspakistan.live/verify/ticket/${body.ticketId}`);
    expect(payload).not.toContain('PLACEHOLDER');
  });

  it('missing registration with only an unverified order: rejected, no ticket and no auto-created verified registration', async () => {
    seedEvent({ isPaid: true, amount: 1500, currency: 'PKR' });
    db.__seed('orders', 'order-1', {
      eventId: EVENT_ID,
      userId: UID,
      paymentStatus: 'pending',
      buyer: { fullName: 'Target One', email: 'target@example.com' },
    });

    const res = await POST(req({ eventId: EVENT_ID, uid: UID }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('paymentStatus: pending');

    expect(db.__doc('eventTickets', TICKET_DOC_ID)).toBeUndefined();
    // The old code fabricated a confirmed+verified registration here.
    expect(db.__doc(`events/${EVENT_ID}/registrations`, UID)).toBeUndefined();
  });

  it('missing registration with a verified order: auto-confirms and issues, QR carries the real id', async () => {
    seedEvent({ isPaid: true, amount: 1500, currency: 'PKR' });
    db.__seed('orders', 'order-2', {
      eventId: EVENT_ID,
      userId: UID,
      paymentStatus: 'verified',
      buyer: { fullName: 'Target One', email: 'target@example.com' },
    });

    const res = await POST(req({ eventId: EVENT_ID, uid: UID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const stored = db.__doc('eventTickets', TICKET_DOC_ID);
    expect(stored).toBeDefined();
    expect(decodeQrPayload(stored!.qrCodeDataUrl as string)).toBe(stored!.verificationUrl);
    expect(stored!.verificationUrl).toContain(body.ticketId);
  });
});
