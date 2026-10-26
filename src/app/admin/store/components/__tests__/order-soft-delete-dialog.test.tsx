/**
 * DEFECT 4(c) regression test: the order REQUEST SOFT DELETE dialog.
 *
 * Proven live fact (2026-10-26 retest, reproduced 3 times): typing a
 * reason into the dialog's Reason textarea and clicking
 * "Request Soft Delete" answered "Reason required".
 *
 * Mechanism on base: the dialog renders a Textarea bound to the
 * `deleteReason` state and its action button calls
 * `handleDeleteOrder(order.id, deleteReason)`, but the handler is
 * declared as `handleDeleteOrder(orderId: string)` — it drops the
 * passed reason and instead reads `window.prompt(...)`. The prompt is
 * a different input from the one the admin just filled; when it comes
 * back empty/cancelled, validation rejects with "Reason required".
 *
 * Contract pinned here: the request uses the exact reason typed into
 * the dialog textarea, window.prompt is never consulted, and an empty
 * dialog reason is the only "Reason required" case.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

(globalThis as any).React = React;

const mockToast = jest.fn();
const mockFetch = jest.fn();

const ORDER_ID = 'esIQi92Ffj7iugx0YIvM';
const orderData = {
  items: [],
  total: 500,
  currency: 'PKR',
  status: 'pending_verification',
  paymentStatus: 'pending',
  createdAt: { toDate: () => new Date('2026-10-26T00:00:00.000Z') },
  updatedAt: { toDate: () => new Date('2026-10-26T00:00:00.000Z') },
};
const orderDoc = { id: ORDER_ID, data: () => ({ ...orderData }) };

jest.mock('@/firebase', () => ({
  useUser: () => ({
    user: { uid: 'admin-1', getIdToken: async () => 'test-token' },
  }),
  firestore: {},
}));

jest.mock('firebase/firestore', () => ({
  collection: (_db: any, name: string) => ({ __collection: name }),
  query: (ref: any, ..._rest: any[]) => ref,
  orderBy: (..._args: any[]) => ({}),
  limit: (..._args: any[]) => ({}),
  startAfter: (..._args: any[]) => ({}),
  where: (..._args: any[]) => ({}),
  doc: (..._args: any[]) => ({}),
  Timestamp: class {},
  getDocs: async (q: any) => {
    if (q && q.__collection === 'orders') return { docs: [orderDoc] };
    return { docs: [] };
  },
  onSnapshot: (_q: any, cb: any) => {
    cb({ docs: [orderDoc] });
    return () => {};
  },
  serverTimestamp: () => ({}),
  arrayUnion: (v: unknown) => v,
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  setDoc: jest.fn(async () => undefined),
}));

jest.mock('@/lib/audit-logging', () => ({
  logAuditEntry: jest.fn(async () => undefined),
}));

jest.mock('@/lib/finance/order-canonical', () => ({
  normalizeOrder: () => ({ totalPkr: null, declaredAmountPkr: null }),
}));

import { OrderManagement } from '../order-management';

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ approvals: [] }),
  }));
  (globalThis as any).fetch = mockFetch;
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function openSoftDeleteDialog() {
  render(<OrderManagement />);
  const deleteButton = await screen.findByRole('button', { name: /Delete Order/ });
  fireEvent.click(deleteButton);
  return screen.findByPlaceholderText('Why is this order being deleted?');
}

it('sends the reason typed into the dialog textarea to the approvals flow, without window.prompt', async () => {
  const promptSpy = jest.spyOn(window, 'prompt').mockReturnValue(null);
  const textarea = await openSoftDeleteDialog();
  fireEvent.change(textarea, { target: { value: 'Duplicate test order' } });

  fireEvent.click(screen.getByRole('button', { name: 'Request Soft Delete' }));

  await waitFor(() => {
    const post = mockFetch.mock.calls.find(
      ([url, init]: any[]) => url === '/api/admin/finance/approvals' && init?.method === 'POST'
    );
    expect(post).toBeTruthy();
    const body = JSON.parse(post[1].body);
    expect(body.targetType).toBe('order_soft_delete');
    expect(body.targetId).toBe(ORDER_ID);
    expect(body.reason).toBe('Duplicate test order');
  });
  expect(promptSpy).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Reason required' })
  );
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Soft delete requested' })
    )
  );
});

it('still rejects with "Reason required" when the dialog reason is empty', async () => {
  const promptSpy = jest.spyOn(window, 'prompt').mockReturnValue(null);
  await openSoftDeleteDialog();

  fireEvent.click(screen.getByRole('button', { name: 'Request Soft Delete' }));

  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Reason required' })
    )
  );
  expect(promptSpy).not.toHaveBeenCalled();
  const post = mockFetch.mock.calls.find(
    ([url, init]: any[]) => url === '/api/admin/finance/approvals' && init?.method === 'POST'
  );
  expect(post).toBeFalsy();
});
