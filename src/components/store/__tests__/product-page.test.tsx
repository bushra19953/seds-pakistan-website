/**
 * Product page composition tests (PLAN-gd Section 12, file C24):
 * spec tests C3 and C4, plus the analytics fires.
 * The server helper is mocked here; its real behaviour is covered
 * through the catalogue route tests.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CatalogueProduct } from '@/types/store-catalogue';

const mockTrack = jest.fn(async () => {});
jest.mock('@/lib/client/commerce-analytics', () => ({
  useCommerceAnalytics: () => ({ trackCommerceEvent: mockTrack }),
}));

const mockGetCatalogueProduct = jest.fn();
const mockListAlternatives = jest.fn(async () => [] as CatalogueProduct[]);
jest.mock('@/lib/server/store-catalogue', () => ({
  getCatalogueProduct: (...args: any[]) => mockGetCatalogueProduct(...args),
  listAlternatives: (...args: any[]) => mockListAlternatives(...(args as [])),
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({}),
}));
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
jest.mock('@/firebase', () => ({
  useUser: () => ({ user: null }),
  useFirestore: () => null,
}));
// Coordinator (merge gate): the page renders WaitlistForm, which writes
// through server-write; the real module pulls @/firebase/provider and
// initializes Firebase at import. Mock the seam, as waitlist-form's own
// suite does.
jest.mock('@/lib/client/server-write', () => ({
  serverWrite: jest.fn(async () => ({ status: 201, body: { ok: true, id: 'w1' } })),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, onClick, children, ...rest }: any) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

import ProductPage from '@/app/store/[productId]/page';

function makeProduct(overrides: Partial<CatalogueProduct> = {}): CatalogueProduct {
  return {
    id: 'p1',
    name: 'Servo Motor',
    description: 'A useful servo for builds',
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

async function renderPage(productId = 'p1') {
  const ui = await ProductPage({ params: Promise.resolve({ productId }) });
  return render(ui as React.ReactElement);
}

describe('/store/[productId] page (GD)', () => {
  beforeEach(() => {
    mockTrack.mockClear();
    mockGetCatalogueProduct.mockReset();
    mockListAlternatives.mockReset();
    mockListAlternatives.mockResolvedValue([]);
  });

  it('C3: price and delivery charge render as separate lines with a total line', async () => {
    mockGetCatalogueProduct.mockResolvedValue(makeProduct());
    const { container } = await renderPage();
    expect(container.textContent).toContain('Price: PKR 1,500');
    expect(container.textContent).toContain('Delivery: PKR 200');
    expect(container.textContent).toContain('Total: PKR 1,700');
  });

  it('C3: the alternatives rail is labelled Also available and lists same vendor in stock products', async () => {
    mockGetCatalogueProduct.mockResolvedValue(makeProduct());
    mockListAlternatives.mockResolvedValue([
      makeProduct({ id: 'p2', name: 'Wheel Kit', price: 900 }),
    ]);
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Also available' })).toBeTruthy();
    expect(screen.getByText('Wheel Kit')).toBeTruthy();
  });

  it('C3: no cost or competitor text appears anywhere on the page', async () => {
    mockGetCatalogueProduct.mockResolvedValue(makeProduct());
    const { container } = await renderPage();
    expect(container.textContent).not.toMatch(/costPrice|competitor/i);
  });

  it('C4: an out of stock product shows no Buy button', async () => {
    mockGetCatalogueProduct.mockResolvedValue(makeProduct({ stock: 0, inStock: false }));
    await renderPage();
    expect(screen.queryByRole('link', { name: 'Buy now' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Buy' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'I want this' })).toBeTruthy();
  });

  it('C4: the rail is labelled Available instead and renders above the I want this form', async () => {
    mockGetCatalogueProduct.mockResolvedValue(makeProduct({ stock: 0, inStock: false }));
    mockListAlternatives.mockResolvedValue([
      makeProduct({ id: 'p2', name: 'Wheel Kit', price: 900 }),
    ]);
    await renderPage();
    const railHeading = screen.getByRole('heading', { name: 'Available instead' });
    const formHeading = screen.getByRole('heading', { name: 'I want this' });
    expect(
      railHeading.compareDocumentPosition(formHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('fires product_view once with the productId on mount', async () => {
    mockGetCatalogueProduct.mockResolvedValue(makeProduct());
    await renderPage();
    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith('product_view', 'p1'),
    );
    const viewCalls = mockTrack.mock.calls.filter((c: any[]) => c[0] === 'product_view');
    expect(viewCalls).toHaveLength(1);
  });

  it('clicking Buy fires buy_click with the productId and still navigates to checkout', async () => {
    mockGetCatalogueProduct.mockResolvedValue(makeProduct());
    await renderPage();
    const buy = screen.getByRole('link', { name: 'Buy now' });
    expect(buy.getAttribute('href')).toBe('/checkout?productId=p1&type=product');
    fireEvent.click(buy);
    expect(mockTrack).toHaveBeenCalledWith('buy_click', 'p1');
  });

  it('a missing or house product calls notFound', async () => {
    mockGetCatalogueProduct.mockResolvedValue(null);
    await expect(
      ProductPage({ params: Promise.resolve({ productId: 'nope' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
