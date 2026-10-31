/**
 * WaitlistForm tests (PLAN-gd Section 12, file C25):
 * spec tests W1 and W2, form half.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WaitlistForm } from '@/components/store/waitlist-form';

const mockServerWrite = jest.fn(async () => ({ status: 201, body: { ok: true, id: 'w1' } }));
jest.mock('@/lib/client/server-write', () => ({
  serverWrite: (...args: any[]) => mockServerWrite(...(args as [])),
}));
jest.mock('@/firebase', () => ({
  useUser: () => ({ user: null }),
  useFirestore: () => null,
}));

describe('WaitlistForm (GD)', () => {
  beforeEach(() => {
    mockServerWrite.mockClear();
  });

  it('W1: submits contactName, contactPhone, productId and source product_page_oos, then shows the confirmation', async () => {
    render(
      <WaitlistForm source="product_page_oos" productId="p1" initialRequestedText="Servo Motor" />,
    );
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Test Buyer' } });
    fireEvent.change(screen.getByLabelText('WhatsApp number'), {
      target: { value: '+92 300 1234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByText('Request noted')).toBeTruthy());
    expect(mockServerWrite).toHaveBeenCalledWith(
      '/api/store/waitlist',
      'POST',
      expect.objectContaining({
        contactName: 'Test Buyer',
        contactPhone: '+92 300 1234567',
        productId: 'p1',
        requestedText: 'Servo Motor',
        source: 'product_page_oos',
      }),
    );
    expect(screen.getByText(/We will contact you on WhatsApp/)).toBeTruthy();
  });

  it('blocks submit with an inline error when the phone number is empty', async () => {
    render(<WaitlistForm source="product_page_oos" productId="p1" initialRequestedText="Servo Motor" />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Test Buyer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(screen.getByText('Please enter your WhatsApp number.')).toBeTruthy(),
    );
    expect(mockServerWrite).not.toHaveBeenCalled();
  });

  it('W2: submits the prefilled search text as requestedText with searchQuery and source store_search_empty', async () => {
    render(
      <WaitlistForm
        source="store_search_empty"
        initialRequestedText="flux capacitor"
        searchQuery="flux"
      />,
    );
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Test Buyer' } });
    fireEvent.change(screen.getByLabelText('WhatsApp number'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByText('Request noted')).toBeTruthy());
    expect(mockServerWrite).toHaveBeenCalledWith(
      '/api/store/waitlist',
      'POST',
      expect.objectContaining({
        requestedText: 'flux capacitor',
        searchQuery: 'flux',
        source: 'store_search_empty',
      }),
    );
  });
});
