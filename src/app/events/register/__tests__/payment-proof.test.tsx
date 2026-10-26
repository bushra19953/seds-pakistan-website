/**
 * Payment-proof form tests for /events/register (R-07).
 *
 * Before this fix the register page carried a complete submission
 * handler (handleSubmitPaymentRef) plus paymentRef / whatsappInput /
 * submittingPayment state, but no rendered element referenced any of
 * them: the only onClick in the page was Confirm Seat, so an attendee
 * who paid offline for a paid event could never submit the payment
 * reference the admin panel's Verify Payment action waits on (the
 * panel acts when a registration's paymentStatus is "pending", which
 * is exactly what the handler writes). These tests pin the wiring:
 * the proof form renders for a registered attendee of a paid event
 * whose payment is not yet verified, it does not render for free
 * events or verified payments, and submitting sends the handler's
 * exact fields.
 *
 * WS10 relocation: the handler used to call the wrapper updateDoc on
 * the caller's own registration doc; it now goes through
 * PATCH /api/event-registrations (serverWrite), and the route applies
 * the identical update server-side: { paymentRef, paymentMethod,
 * paymentStatus: 'pending', whatsappE164, updatedAt:
 * serverTimestamp() } on events/{eventId}/registrations/{token uid}.
 * The route's payload is pinned behaviorally by
 * src/app/api/event-registrations/__tests__/route.test.ts.
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// The repo Jest config uses the classic JSX runtime (jsx: "react"), so
// components that rely on the Next.js automatic runtime resolve `React`
// as a free variable at render time. Provide it globally from the test
// file only; no source change.
(globalThis as any).React = React;

const mockToast = jest.fn();
const mockUpdateDoc = jest.fn(async (..._args: any[]) => undefined);
const mockServerWrite = jest.fn(async (..._args: any[]) => ({ status: 200, body: { ok: true } }));

let mockEventData: any = null;
let mockRegistrationData: any = null;

jest.mock('@/firebase', () => ({
  useUser: () => ({
    user: { uid: 'user-1', getIdToken: async () => 'test-token' },
  }),
  useFirestore: () => ({}),
  useDoc: (ref: any) => {
    if (!ref) return { data: null };
    if (ref.path === 'events/evt-1') return { data: mockEventData };
    if (ref.path === 'events/evt-1/registrations/user-1') return { data: mockRegistrationData };
    if (ref.path === 'warningConfig/global') return { data: { enforcementEnabled: true } };
    return { data: null };
  },
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('eventId=evt-1'),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  updateDoc: (...args: any[]) => mockUpdateDoc(...args),
}));

jest.mock('@/lib/client/server-write', () => ({
  serverWrite: (...args: any[]) => mockServerWrite(...args),
}));

jest.mock('firebase/firestore', () => ({
  doc: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }),
  serverTimestamp: () => 'SERVER_TIMESTAMP',
}));

jest.mock('@/components/starry-background', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/layout/footer', () => ({
  __esModule: true,
  default: () => null,
}));

import RegisterPage from '../page';

const PAID_EVENT = {
  title: 'Paid Gala',
  slug: 'paid-gala',
  status: 'published',
  registrationOpen: true,
  capacity: 100,
  attendeeIds: ['user-1'],
  paymentDetails: {
    isPaid: true,
    method: 'JazzCash',
    amount: 1500,
    currency: 'PKR',
    instructions: 'Send the fee to the JazzCash number and keep the transaction ID.',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEventData = null;
  mockRegistrationData = null;
});

it('renders the payment proof form for a registered attendee of a paid event with unpaid payment', () => {
  mockEventData = PAID_EVENT;
  mockRegistrationData = { status: 'pending', paymentStatus: 'unpaid', whatsappE164: '+923001234567' };
  render(<RegisterPage />);
  expect(screen.getByText(/Submit your payment reference/)).toBeTruthy();
  expect(screen.getByLabelText(/Payment reference \/ transaction ID/)).toBeTruthy();
  expect(screen.getByLabelText(/WhatsApp number/)).toBeTruthy();
  expect(screen.getByText(/Send the fee to the JazzCash number/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Submit Payment Reference' })).toBeTruthy();
});

it('renders the proof form again when a submitted reference is pending verification', () => {
  mockEventData = PAID_EVENT;
  mockRegistrationData = { status: 'pending', paymentStatus: 'pending', paymentRef: 'OLD-REF-1', whatsappE164: '+923001234567' };
  render(<RegisterPage />);
  expect(screen.getByText(/awaiting verification/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Submit Payment Reference' })).toBeTruthy();
});

it('does not render the proof form when the payment is already verified', () => {
  mockEventData = PAID_EVENT;
  mockRegistrationData = { status: 'confirmed', paymentStatus: 'verified', whatsappE164: '+923001234567' };
  render(<RegisterPage />);
  expect(screen.queryByText(/Submit your payment reference/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Submit Payment Reference' })).toBeNull();
  expect(screen.getByText('View My Tickets')).toBeTruthy();
});

it('does not render the proof form for a free event registration', () => {
  mockEventData = { ...PAID_EVENT, paymentDetails: { isPaid: false } };
  mockRegistrationData = { status: 'pending', paymentStatus: 'verified', whatsappE164: '+923001234567' };
  render(<RegisterPage />);
  expect(screen.queryByText(/Ticket Required/)).toBeNull();
  expect(screen.queryByText(/Submit your payment reference/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Submit Payment Reference' })).toBeNull();
});

it('submits the reference with the exact fields the handler defines', async () => {
  mockEventData = PAID_EVENT;
  mockRegistrationData = { status: 'pending', paymentStatus: 'unpaid', whatsappE164: '+923001234567' };
  render(<RegisterPage />);
  fireEvent.change(screen.getByLabelText(/Payment reference \/ transaction ID/), {
    target: { value: 'TXN-98765' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit Payment Reference' }));
  await waitFor(() => expect(mockServerWrite).toHaveBeenCalledTimes(1));
  // The page sends the handler's fields to the registrations route;
  // the route adds paymentStatus 'pending' + the updatedAt server
  // timestamp and writes the caller's own registration doc (its doc
  // id is the token uid), reproducing the old updateDoc payload
  // exactly (route.test.ts pins that payload).
  expect(mockServerWrite).toHaveBeenCalledWith(
    '/api/event-registrations',
    'PATCH',
    {
      eventId: 'evt-1',
      paymentRef: 'TXN-98765',
      paymentMethod: 'JazzCash',
      whatsappE164: '+923001234567',
    }
  );
  expect(mockUpdateDoc).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payment submitted' }))
  );
});

it('refuses a too-short reference and writes nothing', async () => {
  mockEventData = PAID_EVENT;
  mockRegistrationData = { status: 'pending', paymentStatus: 'unpaid', whatsappE164: '+923001234567' };
  render(<RegisterPage />);
  fireEvent.change(screen.getByLabelText(/Payment reference \/ transaction ID/), {
    target: { value: 'ab' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit Payment Reference' }));
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payment reference required' }))
  );
  expect(mockServerWrite).not.toHaveBeenCalled();
  expect(mockUpdateDoc).not.toHaveBeenCalled();
});
