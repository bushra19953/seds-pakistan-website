/**
 * T8: Vendors + Waitlist tab component tests (GG plan Section 8).
 * Proofs: summary rendering, draft disabled at zero payable, W1 tab UI
 * arm, sweep button contract (R-15 URL).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

(globalThis as any).React = React;

const mockFetch = jest.fn();

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: { uid: 'uid-founder', getIdToken: async () => 'founder-token' } }),
  firestore: {},
}));
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { VendorManagement, GROUP_BUY_SWEEP_URL } from '../vendors-management';
import { WaitlistManagement } from '../waitlist-management';

const SUMMARY = {
  ok: true,
  vendorId: 'VEND-A',
  ordersCount: 3,
  payablePkr: 2700,
  payableCount: 2,
  accruedPkr: 450,
  payouts: [
    {
      id: 'PAY1',
      periodStart: '2026-10-19',
      periodEnd: '2026-10-25',
      entryIds: ['ORD-3'],
      grossPkr: 3000,
      commissionPkr: 300,
      netPkr: 2700,
      status: 'transferred',
      displayStatus: 'transferred',
      transferredAt: '2026-10-27T10:00:00.000Z',
    },
  ],
};

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data };
}

describe('Vendors tab', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as never;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/store/vendors') {
        return jsonResponse({
          ok: true,
          vendors: [
            { id: 'VEND-A', userId: 'uid-vendor-a', businessName: 'Alpha Parts', city: 'Karachi', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 },
          ],
          count: 1,
        });
      }
      if (url === '/api/store/vendors/VEND-A/summary') return jsonResponse(SUMMARY);
      return jsonResponse({ ok: true });
    });
  });

  it('Vendors tab renders the payable sum and payout history from the summary endpoint', async () => {
    render(<VendorManagement />);
    await waitFor(() => expect(screen.getByText('Alpha Parts')).toBeInTheDocument());
    fireEvent.click(screen.getByText('View panel'));
    await waitFor(() => expect(screen.getByText(/Payable now: PKR 2,700 \(2 orders\)/)).toBeInTheDocument());
    expect(screen.getByText(/Accrued \(not yet payable\): PKR 450/)).toBeInTheDocument();
    expect(screen.getByText('2026-10-19 to 2026-10-25')).toBeInTheDocument();
  });

  it('Create weekly payout draft is disabled when payableCount is zero', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/store/vendors') {
        return jsonResponse({
          ok: true,
          vendors: [
            { id: 'VEND-A', userId: 'uid-vendor-a', businessName: 'Alpha Parts', city: 'Karachi', status: 'active', agreementStatus: 'signed', commissionRate: 0.1 },
          ],
          count: 1,
        });
      }
      if (url === '/api/store/vendors/VEND-A/summary') return jsonResponse({ ...SUMMARY, payablePkr: 0, payableCount: 0, payouts: [] });
      return jsonResponse({ ok: true });
    });
    render(<VendorManagement />);
    await waitFor(() => expect(screen.getByText('Alpha Parts')).toBeInTheDocument());
    fireEvent.click(screen.getByText('View panel'));
    await waitFor(() => expect(screen.getByText('No payable orders right now.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create weekly payout draft' })).toBeDisabled();
  });

  it('Sweep expired teams button posts to the sweep endpoint constant and toasts the counts', async () => {
    expect(GROUP_BUY_SWEEP_URL).toBe('/api/store/group-buys/sweep-expired');
    render(<VendorManagement />);
    await waitFor(() => expect(screen.getByText('Alpha Parts')).toBeInTheDocument());
    mockFetch.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (url === GROUP_BUY_SWEEP_URL && options?.method === 'POST') {
        return jsonResponse({ ok: true, expiredTeamIds: ['GB1', 'GB2'], refundApprovalIds: ['APR9'] });
      }
      return jsonResponse({ ok: true, vendors: [], count: 0 });
    });
    fireEvent.click(screen.getByText('Sweep expired teams'));
    await waitFor(() => {
      const sweepCall = mockFetch.mock.calls.find((c: unknown[]) => c[0] === GROUP_BUY_SWEEP_URL);
      expect(sweepCall).toBeTruthy();
      expect((sweepCall[1] as { method?: string }).method).toBe('POST');
    });
  });
});

describe('Waitlist tab', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as never;
  });

  it('Waitlist tab renders an entry with its source and marks it notified (W1)', async () => {
    mockFetch.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (url.startsWith('/api/store/waitlist?') && (options?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          ok: true,
          entries: [
            {
              id: 'W1',
              productId: 'P1',
              requestedText: 'Widget',
              searchQuery: null,
              contactName: 'Buyer One',
              contactPhone: '0300-1',
              source: 'product_page_oos',
              status: 'open',
              createdAt: '2026-10-30T10:00:00.000Z',
            },
          ],
          count: 1,
          hasMore: false,
          nextCursor: null,
        });
      }
      if (url === '/api/store/waitlist/W1' && options?.method === 'PATCH') {
        return jsonResponse({
          ok: true,
          entry: {
            id: 'W1',
            productId: 'P1',
            requestedText: 'Widget',
            searchQuery: null,
            contactName: 'Buyer One',
            contactPhone: '0300-1',
            source: 'product_page_oos',
            status: 'notified',
            createdAt: '2026-10-30T10:00:00.000Z',
          },
        });
      }
      return jsonResponse({ ok: true });
    });
    render(<WaitlistManagement />);
    await waitFor(() => expect(screen.getByText('Widget')).toBeInTheDocument());
    expect(screen.getByText(/Product page \(out of stock\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mark notified'));
    await waitFor(() => expect(screen.getByText('notified')).toBeInTheDocument());
    const patchCall = mockFetch.mock.calls.find((c: unknown[]) => c[0] === '/api/store/waitlist/W1');
    expect(patchCall).toBeTruthy();
    expect(JSON.parse((patchCall[1] as { body: string }).body)).toEqual({ status: 'notified' });
  });
});
