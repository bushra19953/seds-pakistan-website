/**
 * /store page tests (PLAN-gd Section 12, file C23):
 * spec tests C1 and C2, page half.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StorePage from '@/app/store/page';
import type { CatalogueProduct } from '@/types/store-catalogue';

const mockFetchCatalogue = jest.fn();
jest.mock('@/lib/store/catalogue-client', () => ({
  fetchCatalogue: (...args: any[]) => mockFetchCatalogue(...args),
}));
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/lib/client/commerce-analytics', () => ({
  useCommerceAnalytics: () => ({ trackCommerceEvent: jest.fn(async () => {}) }),
}));
jest.mock('@/firebase', () => ({
  useUser: () => ({ user: null }),
  useFirestore: () => null,
}));

function makeProduct(overrides: Partial<CatalogueProduct> = {}): CatalogueProduct {
  return {
    id: 'p1',
    name: 'Servo Motor',
    description: 'A useful servo',
    price: 1500,
    currency: 'PKR',
    stock: 5,
    inStock: true,
    category: 'electronics',
    imageUrl: null,
    vendorId: 'vendor-1',
    businessName: 'Test Seller',
    deliveryChargePkr: 200,
    dispatchWindowWorkingDays: 2,
    deliveryPromiseDays: 3,
    groupBuyEligible: false,
    groupBuyTeamSize: null,
    groupBuyWindowHours: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('/store page (GD)', () => {
  beforeEach(() => {
    mockFetchCatalogue.mockReset();
  });

  it('C1: renders the products the catalogue API returns, with PKR prices, stock state and delivery promise', async () => {
    mockFetchCatalogue.mockResolvedValue([makeProduct()]);
    render(<StorePage />);
    await waitFor(() => expect(screen.getByText('Servo Motor')).toBeTruthy());
    expect(screen.getByText('PKR 1,500')).toBeTruthy();
    expect(screen.getByText('In stock')).toBeTruthy();
    expect(screen.getByText('Delivery in 3 days')).toBeTruthy();
    expect(screen.getByText('1 product')).toBeTruthy();
  });

  it('C2: typing in the search box refetches with q and shows only matches', async () => {
    mockFetchCatalogue
      .mockResolvedValueOnce([makeProduct(), makeProduct({ id: 'p2', name: 'Wheel Kit' })])
      .mockResolvedValue([makeProduct()]);
    render(<StorePage />);
    await waitFor(() => expect(screen.getByText('Wheel Kit')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'servo' } });
    await waitFor(
      () =>
        expect(mockFetchCatalogue).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'servo' }),
          expect.anything(),
        ),
      { timeout: 3000 },
    );
    await waitFor(() => expect(screen.queryByText('Wheel Kit')).toBeNull());
  });

  it('C2: the In stock only toggle refetches with inStock=true', async () => {
    mockFetchCatalogue.mockResolvedValue([makeProduct()]);
    render(<StorePage />);
    await waitFor(() => expect(screen.getByText('Servo Motor')).toBeTruthy());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(mockFetchCatalogue).toHaveBeenCalledWith(
        expect.objectContaining({ inStock: true }),
        expect.anything(),
      ),
    );
  });

  it('C2: a zero result search shows the waitlist form with the search term prefilled', async () => {
    mockFetchCatalogue.mockResolvedValue([]);
    render(<StorePage />);
    await waitFor(() => expect(screen.getByText('The store is not open yet')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'widget' } });
    await waitFor(
      () => expect(screen.getByText('No products match your search')).toBeTruthy(),
      { timeout: 3000 },
    );
    const requested = screen.getByLabelText('What are you looking for?') as HTMLTextAreaElement;
    expect(requested.value).toBe('widget');
  });

  it('C2: zero products and no search show the store empty state with the waitlist form and no search text', async () => {
    mockFetchCatalogue.mockResolvedValue([]);
    render(<StorePage />);
    await waitFor(() => expect(screen.getByText('The store is not open yet')).toBeTruthy());
    expect(screen.getByText(/No products are listed right now/)).toBeTruthy();
    const requested = screen.getByLabelText('What are you looking for?') as HTMLTextAreaElement;
    expect(requested.value).toBe('');
  });

  it('C1: an API failure shows the error state with a retry button and renders no products', async () => {
    mockFetchCatalogue.mockRejectedValue(new Error('boom'));
    render(<StorePage />);
    await waitFor(() =>
      expect(screen.getByText('The store could not load. Please try again.')).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Servo Motor')).toBeNull();
  });
});
