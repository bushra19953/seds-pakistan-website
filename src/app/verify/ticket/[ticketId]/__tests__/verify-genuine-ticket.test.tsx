/**
 * DEFECT (H-04, genuine + forged halves): the public verify page looked
 * tickets up ONLY by document id. Issuance stores a ticket under the
 * deterministic doc id "<eventId>_<uid>" with the readable
 * "EVT-..." id in the `ticketId` FIELD, and the QR / verificationUrl
 * point at the readable id — so:
 *   - a GENUINE ticket (requested by its readable id, as printed in
 *     its QR) rendered NOT FOUND, and
 *   - a FORGED request composed from public parts — the deterministic
 *     "<eventId>_<uid>" doc id itself — rendered VALID.
 *
 * The fix resolves a verification request by the readable `ticketId`
 * FIELD (the credential the QR actually carries), with a doc-id fallback
 * only for legacy tickets whose doc id IS their readable id (or which
 * carry no ticketId field at all). These tests drive the real page
 * against the finance FakeFirestore. Zero live reads.
 */

import React from 'react';
(globalThis as any).React = React;

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockHolder.db,
  ensureAdminInitialized: () => true,
}));

jest.mock('firebase-admin', () => {
  const stub = {
    firestore: {
      Timestamp: { now: () => new Date(), fromDate: (d: Date) => d },
      FieldValue: {
        serverTimestamp: () => new Date(),
        arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
      },
    },
  };
  return { __esModule: true, default: stub, ...stub };
});

import TicketVerificationPage from '../page';

const EVENT_ID = 'gala2026';
const UID = 'target-1';
const DOC_ID = `${EVENT_ID}_${UID}`;
const READABLE_ID = 'EVT-GALA20-20261101-0007';
const EVENT_SECONDS = Math.floor(Date.UTC(2026, 10, 1, 5, 0) / 1000);

/** Exactly what POST /api/v1/tickets/issue stores today. */
const ISSUED_TICKET = {
  ticketId: READABLE_ID,
  dbId: DOC_ID,
  ticketNumber: 7,
  uid: UID,
  eventId: EVENT_ID,
  displayName: 'Target One',
  eventTitle: 'Founders Gala',
  eventDate: { _seconds: EVENT_SECONDS },
  eventVenue: 'IST Auditorium',
  issuedAt: { _seconds: EVENT_SECONDS },
  status: 'valid',
};

async function renderVerify(ticketId: string) {
  const element = await TicketVerificationPage({ params: Promise.resolve({ ticketId }) });
  return render(element as React.ReactElement);
}

let db: FakeFirestore;

beforeEach(() => {
  db = createFakeFirestore() as never;
  mockHolder.db = db;
  db.__seed('eventTickets', DOC_ID, { ...ISSUED_TICKET });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('verify: genuine tickets and forged ids (H-04)', () => {
  it('GENUINE: a ticket requested by its readable id (the QR payload) renders VALID with its details', async () => {
    await renderVerify(READABLE_ID);
    expect(screen.getByRole('heading', { name: 'VALID' })).toBeTruthy();
    expect(screen.getByText('This ticket is authentic and has not been revoked.')).toBeTruthy();
    expect(screen.getByText('Target One')).toBeTruthy();
    expect(screen.getByText('#007')).toBeTruthy();
  });

  it('FORGED: the deterministic "<eventId>_<uid>" doc id does NOT verify — it is not the ticket credential', async () => {
    await renderVerify(DOC_ID);
    expect(screen.getByRole('heading', { name: 'NOT FOUND' })).toBeTruthy();
    expect(screen.queryByText('Target One')).toBeNull();
  });

  it('GENUINE REVOKED: a revoked ticket requested by its readable id renders REVOKED', async () => {
    db.__seed('eventTickets', DOC_ID, { ...ISSUED_TICKET, status: 'revoked' });
    await renderVerify(READABLE_ID);
    expect(screen.getByRole('heading', { name: 'REVOKED' })).toBeTruthy();
    expect(screen.getByText('Target One')).toBeTruthy();
  });

  it('LEGACY: a ticket whose doc id IS its readable id (field equals doc id) still verifies', async () => {
    db.__seed('eventTickets', READABLE_ID, { ...ISSUED_TICKET });
    await renderVerify(READABLE_ID);
    expect(screen.getByRole('heading', { name: 'VALID' })).toBeTruthy();
  });

  it('UNKNOWN: an id that matches no ticket field and no legacy doc renders NOT FOUND', async () => {
    await renderVerify('EVT-NOPE-20260101-9999');
    expect(screen.getByRole('heading', { name: 'NOT FOUND' })).toBeTruthy();
    expect(screen.getByText('Ticket not found. This may be an invalid or counterfeit ticket.')).toBeTruthy();
  });
});
