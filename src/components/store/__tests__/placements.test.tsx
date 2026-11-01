/**
 * Placement tests (PLAN-gd Section 12, file C27): spec test C5.
 * Header, homepage Store section, projects strip, community card,
 * and footer links.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { CatalogueProduct } from '@/types/store-catalogue';

const mockFetchCatalogue = jest.fn();
jest.mock('@/lib/store/catalogue-client', () => ({
  fetchCatalogue: (...args: any[]) => mockFetchCatalogue(...args),
}));
jest.mock('@/lib/client/commerce-analytics', () => ({
  useCommerceAnalytics: () => ({ trackCommerceEvent: jest.fn(async () => {}) }),
}));
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ prefetch: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/firebase/auth/use-user', () => ({
  useUser: () => ({ user: null, role: null, isLoading: false }),
}));
jest.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ settings: null, loading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: false }),
}));
jest.mock('@/components/notifications/notification-center', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/ui/optimized-logo', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/theme-toggle-button', () => ({
  ThemeToggleButton: () => null,
}));

import Header from '@/components/layout/header';
import Footer from '@/components/layout/footer';
import { StoreSection } from '@/components/sections/store-section';
import { StoreStrip } from '@/components/store/store-strip';
import CommunityPage from '@/app/community/page';

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

describe('Store placements (GD)', () => {
  beforeEach(() => {
    mockFetchCatalogue.mockReset();
    mockFetchCatalogue.mockResolvedValue([]);
  });

  it('C5: the main navigation contains a Store link to /store', () => {
    const { container } = render(<Header />);
    const links = container.querySelectorAll('a[href="/store"]');
    expect(links.length).toBeGreaterThan(0);
    expect([...links].some((a) => a.textContent?.includes('Store'))).toBe(true);
  });

  it('C5: the home Store section renders catalogue products that link to their product pages', async () => {
    mockFetchCatalogue.mockResolvedValue([makeProduct()]);
    render(<StoreSection />);
    await waitFor(() => expect(screen.getByText('Servo Motor')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Servo Motor' }).getAttribute('href')).toBe(
      '/store/p1',
    );
    expect(screen.getByRole('link', { name: 'Visit the store' }).getAttribute('href')).toBe(
      '/store',
    );
  });

  it('C5: the home Store section renders nothing when the catalogue is empty', async () => {
    mockFetchCatalogue.mockResolvedValue([]);
    const { container } = render(<StoreSection />);
    await waitFor(() => expect(mockFetchCatalogue).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('C5: the projects strip renders products that link to their product pages and nothing when the catalogue is empty', async () => {
    mockFetchCatalogue.mockResolvedValue([makeProduct()]);
    const first = render(<StoreStrip />);
    await waitFor(() => expect(screen.getByText('Servo Motor')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Servo Motor' }).getAttribute('href')).toBe(
      '/store/p1',
    );
    expect(screen.getByRole('link', { name: 'Open the store' }).getAttribute('href')).toBe(
      '/store',
    );
    first.unmount();

    mockFetchCatalogue.mockResolvedValue([]);
    const second = render(<StoreStrip />);
    await waitFor(() => expect(second.container.textContent).toBe(''));
  });

  it('C5: the community page contains a Store card linking to /store', () => {
    render(<CommunityPage />);
    expect(screen.getByRole('link', { name: 'Visit the store' }).getAttribute('href')).toBe(
      '/store',
    );
  });

  it('C5: the footer links to /store and to /store/returns', () => {
    const { container } = render(<Footer />);
    expect(container.querySelector('a[href="/store"]')).not.toBeNull();
    expect(container.querySelector('a[href="/store/returns"]')).not.toBeNull();
  });
});
