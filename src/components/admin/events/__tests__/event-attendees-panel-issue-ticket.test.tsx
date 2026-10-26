/**
 * DEFECT (Issue Ticket inert, live retest 2026-10-26): clicking
 * "Issue Ticket" in the admin Attendees panel produced no navigation,
 * no toast, no visible change. Two panel-side causes are pinned here:
 *   1. The success path's ONLY feedback was console.log plus a
 *      window.open() attempted after an await — popup blockers swallow
 *      that silently, so even a successful issuance looked inert, and
 *      the row kept reading "Issue Ticket" because nothing local
 *      recorded the issued ticketId.
 *   2. The silent early return (`if (!user || !reg.uid) return;`) and
 *      the existing-ticket path also produced zero feedback.
 *
 * The fixed panel records the issued/existing ticketId on the row
 * (button flips to "Re-Issue", the ticket link appears) and renders an
 * inline notice naming the ticket number for both the new and the
 * already-issued outcomes.
 */

import React from 'react';
(globalThis as any).React = React;

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockReg = {
  id: 'target-1',
  uid: 'target-1',
  eventId: 'ev2paid',
  displayName: 'Target One',
  email: 'target@example.com',
  whatsappE164: '+920000000000',
  status: 'confirmed',
  paymentStatus: 'verified',
  paymentMethod: 'bank_transfer',
  paymentRef: 'ref-1',
};

jest.mock('@/firebase', () => ({
  useUser: () => ({
    user: { uid: 'admin-1', getIdToken: async () => 'tok' },
    isLoading: false,
  }),
  useFirestore: () => ({}),
  useCollection: () => ({ data: [mockReg], loading: false }),
}));

jest.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => ({ __args: args }),
  doc: (...args: unknown[]) => ({ __args: args }),
  query: (...args: unknown[]) => ({ __args: args }),
  orderBy: () => ({}),
  serverTimestamp: () => new Date(),
  getDoc: async () => ({ data: () => ({ capacity: 10 }), exists: true }),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  updateDoc: jest.fn(async () => undefined),
}));

jest.mock('@/lib/supa-events/admin-events', () => ({
  adminEventsSupaClientEnabled: () => false,
}));

jest.mock('@/components/ui/responsive-table', () => ({
  __esModule: true,
  default: ({ table }: { table: React.ReactNode }) => <>{table}</>,
}));

import EventAttendeesPanel from '../event-attendees-panel';

const READABLE_ID = 'EVT-EV2PAI-20261026-0001';

beforeEach(() => {
  jest.spyOn(window, 'open').mockImplementation(() => null); // popup blocked, as in the live retest
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  (globalThis as any).fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, ticketId: READABLE_ID, ticketNumber: 1, existing: false }),
  }));
});

afterEach(() => {
  (window.open as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

describe('Attendees panel — Issue Ticket feedback', () => {
  it('a successful issuance is visibly recorded on the row: notice naming the ticket, button flips to Re-Issue', async () => {
    render(<EventAttendeesPanel eventId="ev2paid" />);

    const button = await screen.findByRole('button', { name: /Issue Ticket/ });
    fireEvent.click(button);

    // Visible feedback that does not depend on the popup surviving.
    await waitFor(() => {
      expect(screen.getByText(new RegExp(`Ticket #1 issued.*${READABLE_ID}`))).toBeTruthy();
    });
    expect(await screen.findByRole('button', { name: /Re-Issue/ })).toBeTruthy();
    // The API was called with the panel's documented body shape.
    expect((globalThis as any).fetch).toHaveBeenCalledWith(
      '/api/v1/tickets/issue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ eventId: 'ev2paid', uid: 'target-1', regId: 'target-1' }),
      }),
    );
  });

  it('an already-issued ticket is also surfaced (notice + row state), not silently logged', async () => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, ticketId: READABLE_ID, ticketNumber: 1, existing: true }),
    }));
    render(<EventAttendeesPanel eventId="ev2paid" />);

    fireEvent.click(await screen.findByRole('button', { name: /Issue Ticket/ }));

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`already issued.*${READABLE_ID}`))).toBeTruthy();
    });
    expect(await screen.findByRole('button', { name: /Re-Issue/ })).toBeTruthy();
  });
});
