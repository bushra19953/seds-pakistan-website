/**
 * ProductCard tests (PLAN-gd Section 12, file C22): supports C1, C3.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ProductCard } from '@/components/store/product-card';
import type { CatalogueProduct } from '@/types/store-catalogue';

jest.mock('@/lib/client/commerce-analytics', () => ({
  useCommerceAnalytics: () => ({ trackCommerceEvent: jest.fn(async () => {}) }),
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
    imageUrl: 'https://example.com/servo.png',
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

describe('ProductCard (GD)', () => {
  it('renders image, name, seller business name, PKR price, In stock badge and delivery promise', () => {
    render(<ProductCard product={makeProduct()} />);
    expect(screen.getByAltText('Servo Motor')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Servo Motor' }).getAttribute('href')).toBe('/store/p1');
    expect(screen.getByText('Sold by Test Seller')).toBeTruthy();
    expect(screen.getByText('PKR 1,500')).toBeTruthy();
    expect(screen.getByText('In stock')).toBeTruthy();
    expect(screen.getByText('Delivery in 3 days')).toBeTruthy();
  });

  it('an out of stock card shows Out of stock and an I want this link to the product page, and no Buy link', () => {
    render(<ProductCard product={makeProduct({ stock: 0, inStock: false })} />);
    expect(screen.getByText('Out of stock')).toBeTruthy();
    const wantLink = screen.getByRole('link', { name: 'I want this' });
    expect(wantLink.getAttribute('href')).toBe('/store/p1');
    expect(screen.queryByRole('link', { name: 'Buy' })).toBeNull();
  });

  it('an in stock card Buy link points to /checkout with the productId and type=product params', () => {
    render(<ProductCard product={makeProduct()} />);
    const buyLink = screen.getByRole('link', { name: 'Buy' });
    expect(buyLink.getAttribute('href')).toBe('/checkout?productId=p1&type=product');
  });
});
