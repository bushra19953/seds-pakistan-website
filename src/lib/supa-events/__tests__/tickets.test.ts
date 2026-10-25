/**
 * @jest-environment node
 *
 * Unit tests for the E3 tickets seam (src/lib/supa-events/tickets.ts).
 *
 * Covered:
 *  - verify-page read (BY DOC ID — H-04 key) in all three shapes the page
 *    renders: not-found (null), found+valid, found+revoked;
 *  - flag ON serves from the mocked Supabase adapter; flag ON + adapter
 *    error falls back to Firestore; flag ON + no client falls back;
 *    flag OFF never touches the adapter;
 *  - stored-timestamp normalization to the {_seconds} shape the verify
 *    page's safeDate/safeIssuedDate consume (jsonb {_seconds} form, ISO
 *    strings, {seconds} form, Dates, epoch millis);
 *  - the issue route's parallel reads via the adapter (existing-ticket
 *    field query, event doc, registration doc via the 3-segment
 *    subcollection path) and via Firestore when the flag is off;
 *  - BOTH transactions stay on Firestore even when the flag is ON
 *    (NEVER-BULK): the counter transaction and atomic issuance write only
 *    through the Firestore db handle and never call the adapter.
 *
 * No live reads: the adapter and Firestore are both fakes/mocks.
 */

import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockUseSupa = jest.fn();
const mockGetSupaClient = jest.fn();
const mockGetSupaAdapter = jest.fn();

jest.mock('@/lib/supa', () => ({
  useSupa: (...args: unknown[]) => mockUseSupa(...args),
  getSupaClient: () => mockGetSupaClient(),
  getSupaAdapter: () => mockGetSupaAdapter(),
}));

jest.mock('firebase-admin', () => {
  const stub = {
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
  return { __esModule: true, default: stub, ...stub };
});

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
  },
}));

import {
  allocateNextTicketNumber,
  getEventForIssue,
  getExistingTicketForIssue,
  getRegistrationForIssue,
  getTicketByDocIdForVerify,
  issueTicketAtomically,
  normalizeTicketData,
  normalizeTimestampLike,
} from '@/lib/supa-events/tickets';

const EVENT_ID = 'gala2026';
const UID = 'target-1';
const TICKET_DOC_ID = `${EVENT_ID}_${UID}`;
const READABLE_ID = 'EVT-GALA20-20261025-0001';

let db: FakeFirestore;
let adapter: {
  getDoc: jest.Mock;
  listDocs: jest.Mock;
  countDocs: jest.Mock;
  setDoc: jest.Mock;
  updateDoc: jest.Mock;
  deleteDoc: jest.Mock;
};

function flagOff() {
  mockUseSupa.mockReturnValue(false);
  mockGetSupaClient.mockReturnValue(null);
}

function flagOn() {
  mockUseSupa.mockImplementation((surface: string) => surface === 'tickets');
  mockGetSupaClient.mockReturnValue({ fake: 'client' });
  mockGetSupaAdapter.mockReturnValue(adapter);
}

beforeEach(() => {
  db = createFakeFirestore() as never;
  adapter = {
    getDoc: jest.fn(),
    listDocs: jest.fn(),
    countDocs: jest.fn(),
    setDoc: jest.fn(),
    updateDoc: jest.fn(),
    deleteDoc: jest.fn(),
  };
  jest.clearAllMocks();
  flagOff();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

/* ------------------------------------------------------- verify read ---- */

describe('getTicketByDocIdForVerify — flag OFF (Firestore)', () => {
  it('not-found: returns null when no doc exists under that doc id', async () => {
    await expect(getTicketByDocIdForVerify(db as never, READABLE_ID)).resolves.toBeNull();
    expect(mockGetSupaAdapter).not.toHaveBeenCalled();
  });

  it('found + valid: returns the doc data UNTOUCHED (fallback keeps stored shapes, spec 3.4(c))', async () => {
    db.__seed('eventTickets', READABLE_ID, {
      ticketId: READABLE_ID,
      status: 'valid',
      ticketNumber: 7,
      eventDate: { _seconds: 1793000000, _nanoseconds: 0 },
      issuedAt: '2026-10-25T02:00:00.000Z',
    });

    const ticket = await getTicketByDocIdForVerify(db as never, READABLE_ID);
    expect(ticket).not.toBeNull();
    expect(ticket!.status).toBe('valid');
    expect(ticket!.ticketNumber).toBe(7);
    // Passthrough: the _seconds object and the string are exactly as stored;
    // the page's safeDate handles both (._seconds first, else new Date(ts)).
    expect(ticket!.eventDate).toEqual({ _seconds: 1793000000, _nanoseconds: 0 });
    expect(ticket!.issuedAt).toBe('2026-10-25T02:00:00.000Z');
  });

  it('adapter-sourced shapes ARE normalized (jsonb {_seconds} and ISO both land on _seconds)', async () => {
    flagOn();
    adapter.getDoc.mockResolvedValue({
      id: READABLE_ID,
      ticketId: READABLE_ID,
      status: 'valid',
      eventDate: { _seconds: 1793000000, _nanoseconds: 0 },
      issuedAt: '2026-10-25T02:00:00.000Z',
    });

    const ticket = await getTicketByDocIdForVerify(db as never, READABLE_ID);
    expect((ticket!.eventDate as any)._seconds).toBe(1793000000);
    expect((ticket!.issuedAt as any)._seconds).toBe(Math.floor(Date.parse('2026-10-25T02:00:00.000Z') / 1000));
    expect((ticket!.issuedAt as any).seconds).toBe((ticket!.issuedAt as any)._seconds);
  });

  it('found + revoked: returns the doc with status revoked (page renders REVOKED)', async () => {
    db.__seed('eventTickets', READABLE_ID, { ticketId: READABLE_ID, status: 'revoked' });

    const ticket = await getTicketByDocIdForVerify(db as never, READABLE_ID);
    expect(ticket!.status).toBe('revoked');
  });

  it('H-04 key fidelity: a doc stored under the deterministic id is NOT found by the readable id', async () => {
    // Issuance writes eventTickets/{eventId}_{uid} with ticketId=READABLE_ID
    // in the field. The verify page's doc-id lookup must miss it — exactly
    // as Firestore behaves today. Preserved, not repaired.
    db.__seed('eventTickets', TICKET_DOC_ID, { ticketId: READABLE_ID, status: 'valid' });
    await expect(getTicketByDocIdForVerify(db as never, READABLE_ID)).resolves.toBeNull();
    const byDocId = await getTicketByDocIdForVerify(db as never, TICKET_DOC_ID);
    expect(byDocId!.ticketId).toBe(READABLE_ID);
  });
});

describe('getTicketByDocIdForVerify — flag ON (Supabase adapter)', () => {
  beforeEach(() => flagOn());

  it('serves the ticket from fs_eventTickets via getDoc(eventTickets, ticketId)', async () => {
    adapter.getDoc.mockResolvedValue({
      id: READABLE_ID,
      ticketId: READABLE_ID,
      status: 'valid',
      issuedAt: { seconds: 1792900000, nanoseconds: 0 },
    });

    const ticket = await getTicketByDocIdForVerify(db as never, READABLE_ID);
    expect(adapter.getDoc).toHaveBeenCalledWith('eventTickets', READABLE_ID);
    expect(ticket!.status).toBe('valid');
    expect((ticket!.issuedAt as any)._seconds).toBe(1792900000);
    // adapter id is stripped — the page consumes doc data, not the row id
    expect(ticket!.id).toBeUndefined();
  });

  it('adapter miss is a real not-found: returns null WITHOUT falling back to Firestore', async () => {
    adapter.getDoc.mockResolvedValue(null);
    db.__seed('eventTickets', READABLE_ID, { ticketId: READABLE_ID, status: 'valid' });

    await expect(getTicketByDocIdForVerify(db as never, READABLE_ID)).resolves.toBeNull();
  });

  it('adapter error falls back to Firestore', async () => {
    adapter.getDoc.mockRejectedValue(new Error('postgrest down'));
    db.__seed('eventTickets', READABLE_ID, { ticketId: READABLE_ID, status: 'revoked' });

    const ticket = await getTicketByDocIdForVerify(db as never, READABLE_ID);
    expect(ticket!.status).toBe('revoked');
  });

  it('revoked shape from the adapter passes through unchanged', async () => {
    adapter.getDoc.mockResolvedValue({ id: READABLE_ID, ticketId: READABLE_ID, status: 'revoked' });
    const ticket = await getTicketByDocIdForVerify(db as never, READABLE_ID);
    expect(ticket!.status).toBe('revoked');
  });
});

describe('getTicketByDocIdForVerify — flag ON but no Supabase client configured', () => {
  it('falls back to Firestore and never asks for the adapter', async () => {
    mockUseSupa.mockReturnValue(true);
    mockGetSupaClient.mockReturnValue(null);
    db.__seed('eventTickets', READABLE_ID, { ticketId: READABLE_ID, status: 'valid' });

    const ticket = await getTicketByDocIdForVerify(db as never, READABLE_ID);
    expect(ticket!.status).toBe('valid');
    expect(mockGetSupaAdapter).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------- issue reads --- */

describe('issue-route parallel reads', () => {
  it('flag ON: existing ticket via listDocs field query, event via getDoc, registration via subcollection path', async () => {
    flagOn();
    adapter.listDocs.mockResolvedValue([
      { id: TICKET_DOC_ID, ticketId: READABLE_ID, ticketNumber: 3, eventId: EVENT_ID, uid: UID },
    ]);
    adapter.getDoc.mockImplementation(async (path: string, id: string) => {
      if (path === 'events') return { id, title: 'Founders Gala' };
      if (path === `events/${EVENT_ID}/registrations`) return { id, status: 'confirmed' };
      return null;
    });

    const existing = await getExistingTicketForIssue(db as never, EVENT_ID, UID);
    expect(adapter.listDocs).toHaveBeenCalledWith('eventTickets', {
      where: [
        ['eventId', '==', EVENT_ID],
        ['uid', '==', UID],
      ],
      limit: 1,
    });
    expect(existing.empty).toBe(false);
    expect(existing.docs[0].id).toBe(TICKET_DOC_ID);
    expect(existing.docs[0].data().ticketNumber).toBe(3);

    const eventSnap = await getEventForIssue(db as never, EVENT_ID);
    expect(eventSnap.exists).toBe(true);
    expect(eventSnap.data()!.title).toBe('Founders Gala');

    const regSnap = await getRegistrationForIssue(db as never, EVENT_ID, UID);
    expect(adapter.getDoc).toHaveBeenCalledWith(`events/${EVENT_ID}/registrations`, UID);
    expect(regSnap.exists).toBe(true);
    expect(regSnap.data()!.status).toBe('confirmed');
  });

  it('flag ON: adapter misses map to empty / not-exists shapes', async () => {
    flagOn();
    adapter.listDocs.mockResolvedValue([]);
    adapter.getDoc.mockResolvedValue(null);

    expect((await getExistingTicketForIssue(db as never, EVENT_ID, UID)).empty).toBe(true);
    expect((await getEventForIssue(db as never, EVENT_ID)).exists).toBe(false);
    expect((await getRegistrationForIssue(db as never, EVENT_ID, UID)).exists).toBe(false);
  });

  it('flag OFF: all three reads come from Firestore', async () => {
    db.__seed('eventTickets', TICKET_DOC_ID, { ticketId: READABLE_ID, ticketNumber: 5, eventId: EVENT_ID, uid: UID });
    db.__seed('events', EVENT_ID, { title: 'Founders Gala' });
    db.__seed(`events/${EVENT_ID}/registrations`, UID, { status: 'confirmed' });

    const existing = await getExistingTicketForIssue(db as never, EVENT_ID, UID);
    expect(existing.empty).toBe(false);
    expect(existing.docs[0].data().ticketNumber).toBe(5);
    expect((await getEventForIssue(db as never, EVENT_ID)).data()!.title).toBe('Founders Gala');
    expect((await getRegistrationForIssue(db as never, EVENT_ID, UID)).data()!.status).toBe('confirmed');
    expect(mockGetSupaAdapter).not.toHaveBeenCalled();
  });

  it('flag ON + adapter error on the existing-ticket query falls back to Firestore', async () => {
    flagOn();
    adapter.listDocs.mockRejectedValue(new Error('boom'));
    db.__seed('eventTickets', TICKET_DOC_ID, { ticketId: READABLE_ID, ticketNumber: 9, eventId: EVENT_ID, uid: UID });

    const existing = await getExistingTicketForIssue(db as never, EVENT_ID, UID);
    expect(existing.docs[0].data().ticketNumber).toBe(9);
  });
});

/* -------------------------------------------------- timestamp shaping --- */

describe('normalizeTimestampLike / normalizeTicketData', () => {
  it('passes {_seconds,_nanoseconds} through with seconds aliases added', () => {
    expect(normalizeTimestampLike({ _seconds: 100, _nanoseconds: 5 })).toEqual({
      _seconds: 100, _nanoseconds: 5, seconds: 100, nanoseconds: 5,
    });
  });

  it('converts {seconds,nanoseconds} jsonb form', () => {
    expect(normalizeTimestampLike({ seconds: 100, nanoseconds: 5 })).toEqual({
      _seconds: 100, _nanoseconds: 5, seconds: 100, nanoseconds: 5,
    });
  });

  it('converts ISO strings and Dates and epoch millis to the same shape', () => {
    const iso = '2026-10-25T02:00:00.500Z';
    const expected = Math.floor(Date.parse(iso) / 1000);
    expect((normalizeTimestampLike(iso) as any)._seconds).toBe(expected);
    expect((normalizeTimestampLike(new Date(iso)) as any)._nanoseconds).toBe(500_000_000);
    expect((normalizeTimestampLike(Date.parse(iso)) as any)._seconds).toBe(expected);
  });

  it('converts Timestamp-like objects via toDate()', () => {
    const ts = { toDate: () => new Date('2026-01-01T00:00:00.000Z'), _seconds: 1 };
    // toDate wins over a stale _seconds field
    expect((normalizeTimestampLike(ts) as any)._seconds).toBe(Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000));
  });

  it('leaves non-timestamps untouched', () => {
    expect(normalizeTimestampLike(null)).toBeNull();
    expect(normalizeTimestampLike(undefined)).toBeUndefined();
    expect(normalizeTimestampLike('not a date')).toBe('not a date');
    expect(normalizeTimestampLike({ venue: 'IST' })).toEqual({ venue: 'IST' });
  });

  it('normalizeTicketData only touches the known timestamp fields', () => {
    const out = normalizeTicketData({
      ticketId: READABLE_ID,
      eventDate: '2026-11-01T00:00:00.000Z',
      issuedAt: { _seconds: 42, _nanoseconds: 0 },
      displayName: 'Target One',
    });
    expect((out.eventDate as any)._seconds).toBe(Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000));
    expect((out.issuedAt as any).seconds).toBe(42);
    expect(out.displayName).toBe('Target One');
  });
});

/* ------------------------------------------- transactions stay Firestore */

describe('transactions — Firestore under BOTH flag states (NEVER-BULK)', () => {
  it('allocateNextTicketNumber increments events/{id}.ticketCount via Firestore even with the flag ON', async () => {
    flagOn();
    db.__seed('events', EVENT_ID, { title: 'Gala', ticketCount: 41 });

    await expect(allocateNextTicketNumber(db as never, EVENT_ID)).resolves.toBe(42);
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(42);
    expect(adapter.getDoc).not.toHaveBeenCalled();
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.updateDoc).not.toHaveBeenCalled();
  });

  it('issueTicketAtomically writes ticket + counter + registration stamp in Firestore even with the flag ON', async () => {
    flagOn();
    db.__seed('events', EVENT_ID, { title: 'Founders Gala', venue: 'IST Auditorium', ticketCount: 0 });
    db.__seed(`events/${EVENT_ID}/registrations`, UID, { status: 'confirmed', paymentStatus: 'verified' });
    db.__seed('users', UID, { displayName: 'Target One', email: 'target@example.com', eventsAttended: [] });

    const result = await issueTicketAtomically(db as never, {
      eventId: EVENT_ID,
      uid: UID,
      registrationDocId: UID,
      siteUrl: 'https://sedspakistan.live',
      finalRegData: { displayName: 'Target One', email: 'target@example.com', paymentMethod: 'bank_transfer' },
      userData: { displayName: 'Target One', email: 'target@example.com', eventsAttended: [] },
      eventData: { title: 'Founders Gala', venue: 'IST Auditorium' },
      generateQrDataUrl: async (text: string) => `qr:${text}`,
    });

    expect(result.existing).toBe(false);
    expect(result.ticketNumber).toBe(1);
    expect(result.ticketId).toMatch(/^EVT-GALA20-\d{8}-0001$/);

    const stored = db.__doc('eventTickets', TICKET_DOC_ID);
    expect(stored).toBeDefined();
    // H-04 shape: doc id is deterministic; readable id is the ticketId FIELD.
    expect(stored!.ticketId).toBe(result.ticketId);
    expect(stored!.dbId).toBe(TICKET_DOC_ID);
    expect(stored!.qrCodeDataUrl).toBe(`qr:https://sedspakistan.live/verify/ticket/${result.ticketId}`);
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(1);
    expect(db.__doc(`events/${EVENT_ID}/registrations`, UID)!.ticketId).toBe(result.ticketId);

    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(adapter.updateDoc).not.toHaveBeenCalled();
    expect(adapter.deleteDoc).not.toHaveBeenCalled();
  });

  it('issueTicketAtomically is idempotent: an existing deterministic doc short-circuits', async () => {
    db.__seed('events', EVENT_ID, { title: 'Founders Gala', ticketCount: 3 });
    db.__seed('eventTickets', TICKET_DOC_ID, { ticketId: READABLE_ID, ticketNumber: 3 });
    db.__seed(`events/${EVENT_ID}/registrations`, UID, { status: 'confirmed' });
    db.__seed('users', UID, { eventsAttended: [] });

    const result = await issueTicketAtomically(db as never, {
      eventId: EVENT_ID,
      uid: UID,
      registrationDocId: UID,
      siteUrl: 'https://sedspakistan.live',
      finalRegData: {},
      userData: { eventsAttended: [] },
      eventData: { title: 'Founders Gala' },
      generateQrDataUrl: async () => 'qr',
    });

    expect(result).toEqual({ ticketId: READABLE_ID, ticketNumber: 3, existing: true });
    expect(db.__doc('events', EVENT_ID)!.ticketCount).toBe(3);
  });
});
