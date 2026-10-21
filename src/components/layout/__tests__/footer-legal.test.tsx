/**
 * footer-legal.test.tsx - Item 8 (T8.8-T8.10).
 *
 * Renders the real Footer with useSiteSettings mocked, proving the
 * footer reads the legal name + status line from the single source.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import Footer from '@/components/layout/footer';
import { IN_PROCESS_STATUS_LINE, LEGAL_NAME } from '@/lib/legal-status';

jest.mock('@/components/ui/optimized-logo', () => ({
  __esModule: true,
  default: () => null,
}));

const mockUseSiteSettings = jest.fn();
jest.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => mockUseSiteSettings(),
}));

describe('Footer legal identity (Item 8)', () => {
  it('T8.8: settings loading/null: renders LEGAL_NAME and the in-process line, no "Pakistan Chapter", no "Company" heading', () => {
    mockUseSiteSettings.mockReturnValue({ settings: null, loading: true, error: null, refetch: jest.fn() });
    const { container } = render(<Footer />);
    expect(screen.getAllByText(LEGAL_NAME).length).toBeGreaterThan(0);
    expect(container.textContent).toContain('currently in process');
    expect(container.textContent).toContain(IN_PROCESS_STATUS_LINE);
    expect(container.textContent).not.toContain('Pakistan Chapter');
    expect(screen.queryByText('Company')).toBeNull();
    expect(screen.getByText('Organisation')).toBeTruthy();
  });

  it('T8.9: complete registered settings: renders the registration number, no in-process claim', () => {
    mockUseSiteSettings.mockReturnValue({
      settings: {
        registrationStatus: 'registered',
        registrationNumber: 'REG-999',
        registrationDate: '2026-02-01',
        registrarJurisdiction: 'Islamabad Capital Territory',
      },
      loading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { container } = render(<Footer />);
    expect(container.textContent).toContain('REG-999');
    expect(container.textContent).not.toContain('currently in process');
  });

  it('T8.10: footer links to /privacy-policy and /terms-and-conditions', () => {
    mockUseSiteSettings.mockReturnValue({ settings: null, loading: false, error: null, refetch: jest.fn() });
    const { container } = render(<Footer />);
    expect(container.querySelector('a[href="/privacy-policy"]')).not.toBeNull();
    expect(container.querySelector('a[href="/terms-and-conditions"]')).not.toBeNull();
  });
});
