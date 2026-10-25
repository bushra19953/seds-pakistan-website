/**
 * Behavior contracts for the public ticket verification page
 * (/verify/ticket/[ticketId]), recorded from the CURRENT Firestore
 * implementation (feat/integration-wave3 @ 4d5a1e16) ahead of the
 * Supabase migration (implementer branch feat/supa-events-3,
 * tickets/verify).
 *
 * The page is a server component; these tests invoke it directly with
 * a mocked admin-db accessor and render the returned element. Zero
 * live reads.
 *
 * Contract inventory:
 *   E-VFY-01  Valid: a doc whose status is 'valid' renders the VALID
 *             treatment ('VALID', 'This ticket is authentic and has
 *             not been revoked.') with the ticket number zero-padded
 *             to 3, attendee, event, venue, and ticket id rows.
 *   E-VFY-02  Revoked: status 'revoked' renders the REVOKED treatment
 *             ('REVOKED', 'This ticket has been revoked and cannot be
 *             used for entry.') WITH the ticket details still shown.
 *   E-VFY-03  Not found: a missing doc renders NOT FOUND with
 *             'Ticket not found. This may be an invalid or
 *             counterfeit ticket.' and NO ticket details. A database
 *             failure renders NOT FOUND with 'Unable to verify ticket
 *             at this time. Please try again.' — the two messages are
 *             the only distinction between the two failure arms.
 *   E-VFY-04  FINDING (current behavior): the status decision is
 *             binary. Any status other than 'valid' (for example
 *             'used' or 'expired') renders as REVOKED, because the
 *             label is `isValid ? 'VALID' : 'REVOKED'` whenever a doc
 *             exists. There is no third state.
 *   E-VFY-05  FINDING (lookup mismatch, current behavior): the page
 *             looks the ticket up ONLY by document id
 *             (eventTickets.doc(ticketId)). The current issuer stores
 *             tickets at doc id "<eventId>_<uid>" with the readable
 *             id in the ticketId FIELD, and the QR codes encode
 *             /verify/ticket/<readableId> — so a genuinely issued
 *             ticket verifies as NOT FOUND through this page. Pinned
 *             as-is: feat/supa-events-3 must either reproduce this
 *             (and own the defect) or fix the lookup as a named
 *             change; the contract flip will show up here.
 *   E-VFY-06  Date rendering on this page reads the Admin-SDK
 *             serialized shape { _seconds }: an eventDate in that
 *             shape renders its calendar date. FINDING: the seam-
 *             normalized shape { seconds, nanoseconds, toDate() }
 *             (what src/lib/supa emits for a Firestore Timestamp)
 *             renders as 'Invalid Date' here, because safeDate checks
 *             only `_seconds` before falling back to new Date(value).
 *             The ticket page (src/app/events/ticket/[ticketId]) does
 *             NOT have this defect: it renders via
 *             formatEventInstantInPkt, which accepts both shapes (see
 *             the seam timestamp contracts). events-3 must normalize
 *             for THIS consumer or fix safeDate as a named change.
 */

import React from 'react';
// Classic JSX runtime note: see the delete-flow suite.
(globalThis as any).React = React;

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
}));

import TicketVerificationPage from '../page';

/** Minimal admin-db stub: only the surface the page uses. */
function stubDb(docs: Record<string, Record<string, any> | undefined>) {
  return {
    collection: (name: string) => {
      if (name !== 'eventTickets') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id: string) => ({
          get: async () => {
            const data = docs[id];
            return { exists: data !== undefined, id, data: () => data };
          },
        }),
      };
    },
  };
}

async function renderVerify(ticketId: string) {
  const element = await TicketVerificationPage({ params: Promise.resolve({ ticketId }) });
  return render(element as React.ReactElement);
}

// 2026-11-01T05:00:00Z is a Sunday.
const EVENT_SECONDS = Math.floor(Date.UTC(2026, 10, 1, 5, 0) / 1000);

const VALID_TICKET = {
  ticketId: 'EVT-GALA20-20261101-0007',
  ticketNumber: 7,
  displayName: 'Target One',
  eventTitle: 'Founders Gala',
  eventDate: { _seconds: EVENT_SECONDS },
  eventVenue: 'IST Auditorium',
  issuedAt: { _seconds: EVENT_SECONDS },
  status: 'valid',
};

beforeEach(() => {
  mockDbHolder.db = stubDb({ 'EVT-GALA20-20261101-0007': VALID_TICKET });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe('E-VFY: rendering decisions from a mocked doc', () => {
  it('E-VFY-01 a valid ticket renders VALID with its padded number and details', async () => {
    await renderVerify('EVT-GALA20-20261101-0007');
    expect(screen.getByRole('heading', { name: 'VALID' })).toBeTruthy();
    expect(screen.getByText('This ticket is authentic and has not been revoked.')).toBeTruthy();
    expect(screen.getByText('#007')).toBeTruthy();
    expect(screen.getByText('Target One')).toBeTruthy();
    expect(screen.getByText('Founders Gala')).toBeTruthy();
    expect(screen.getByText('IST Auditorium')).toBeTruthy();
    expect(screen.getByText('EVT-GALA20-20261101-0007')).toBeTruthy();
  });

  it('E-VFY-02 a revoked ticket renders REVOKED and still shows its details', async () => {
    mockDbHolder.db = stubDb({
      'EVT-GALA20-20261101-0007': { ...VALID_TICKET, status: 'revoked' },
    });
    await renderVerify('EVT-GALA20-20261101-0007');
    expect(screen.getByRole('heading', { name: 'REVOKED' })).toBeTruthy();
    expect(screen.getByText('This ticket has been revoked and cannot be used for entry.')).toBeTruthy();
    expect(screen.getByText('Target One')).toBeTruthy();
    expect(screen.getByText('#007')).toBeTruthy();
  });

  it('E-VFY-03 a missing ticket renders NOT FOUND with the counterfeit message and no details', async () => {
    await renderVerify('EVT-NOPE-0000');
    expect(screen.getByRole('heading', { name: 'NOT FOUND' })).toBeTruthy();
    expect(screen.getByText('Ticket not found. This may be an invalid or counterfeit ticket.')).toBeTruthy();
    expect(screen.queryByText('Target One')).toBeNull();
  });

  it('E-VFY-03 a database failure renders NOT FOUND with the try-again message', async () => {
    mockDbHolder.db = null;
    await renderVerify('EVT-GALA20-20261101-0007');
    expect(screen.getByRole('heading', { name: 'NOT FOUND' })).toBeTruthy();
    expect(screen.getByText('Unable to verify ticket at this time. Please try again.')).toBeTruthy();
  });

  it.each(['used', 'expired', 'checked-in'])(
    "E-VFY-04 FINDING: a ticket with status '%s' renders as REVOKED (the decision is binary)",
    async (status) => {
      mockDbHolder.db = stubDb({
        'EVT-GALA20-20261101-0007': { ...VALID_TICKET, status },
      });
      await renderVerify('EVT-GALA20-20261101-0007');
      expect(screen.getByRole('heading', { name: 'REVOKED' })).toBeTruthy();
    },
  );
});

describe('E-VFY: lookup and timestamp shapes', () => {
  it('E-VFY-05 FINDING: an issued ticket stored at <eventId>_<uid> is NOT FOUND by its readable id', async () => {
    // Exactly what POST /api/v1/tickets/issue stores today: doc id is
    // deterministic, the readable id lives in the ticketId field, and
    // the QR/verificationUrl point at the readable id.
    mockDbHolder.db = stubDb({
      gala2026_target1: { ...VALID_TICKET },
    });
    await renderVerify('EVT-GALA20-20261101-0007');
    expect(screen.getByRole('heading', { name: 'NOT FOUND' })).toBeTruthy();
    expect(screen.getByText('Ticket not found. This may be an invalid or counterfeit ticket.')).toBeTruthy();
  });

  it('E-VFY-06 an eventDate in the { _seconds } shape renders its calendar date', async () => {
    await renderVerify('EVT-GALA20-20261101-0007');
    // safeDate formats with toLocaleDateString('en-PK', ...), whose
    // field order is day-first: 'Sunday, 1 November 2026'. The instant
    // (2026-11-01T05:00:00Z, a Sunday) is what is pinned, in the
    // page's own locale format.
    expect(screen.getByText(/Sunday, 1 November 2026/)).toBeTruthy();
    expect(screen.getByText(/1 November 2026/)).toBeTruthy();
  });

  it("E-VFY-06 FINDING: an eventDate in the seam shape { seconds, nanoseconds, toDate() } renders 'Invalid Date' on this page", async () => {
    const seamDate = {
      seconds: EVENT_SECONDS,
      nanoseconds: 0,
      toDate: () => new Date(EVENT_SECONDS * 1000),
    };
    mockDbHolder.db = stubDb({
      'EVT-GALA20-20261101-0007': { ...VALID_TICKET, eventDate: seamDate },
    });
    await renderVerify('EVT-GALA20-20261101-0007');
    expect(screen.getByRole('heading', { name: 'VALID' })).toBeTruthy();
    expect(screen.getByText('Invalid Date')).toBeTruthy();
  });
});
