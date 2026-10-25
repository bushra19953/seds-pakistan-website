/**
 * X2 (listeners cluster, Class B): SiteStateBanner's licence poll no
 * longer runs on a raw 60-second setInterval. The initial load still
 * happens on mount; repeats go through the shared usePollingRefresh
 * (5-minute floor). The banner stays silent unless a notice is
 * running (or the site mode demands a strip, via useSiteState).
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { SiteStateBanner } from '@/components/layout/site-state-banner';
import { MIN_POLL_INTERVAL_MS } from '@/hooks/use-polling-refresh';

// Stable identities, like the real providers: a fresh object per
// render would retrigger the banner's [user]-keyed load effect.
const mockUser = {
  uid: 'founder-1',
  getIdToken: jest.fn(async () => 'test-token'),
};
const mockUserState = { user: mockUser };
const mockSiteState = { mode: 'live' as const, isLoading: false };

jest.mock('@/firebase', () => ({
  useUser: () => mockUserState,
}));

jest.mock('@/hooks/use-site-state', () => ({
  useSiteState: () => mockSiteState,
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function licenceCalls(): number {
  return fetchMock.mock.calls.filter(
    (c) => c[0] === '/api/admin/platform-licence',
  ).length;
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      effective: { noticeRunning: true, noticeEffectiveAt: null },
    }),
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SiteStateBanner licence polling (X2)', () => {
  it('loads on mount, renders the running notice, and does not re-poll at 60s', async () => {
    render(<SiteStateBanner />);
    await act(async () => {});
    expect(licenceCalls()).toBe(1);
    expect(
      screen.getByText(/licence revocation notice is running/),
    ).toBeTruthy();

    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(licenceCalls()).toBe(1);
  });

  it('re-polls at the shared 5-minute floor', async () => {
    render(<SiteStateBanner />);
    await act(async () => {});
    expect(licenceCalls()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS - 1); });
    expect(licenceCalls()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(1); });
    expect(licenceCalls()).toBe(2);
  });

  it('stays silent when no notice is running', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        effective: { noticeRunning: false, noticeEffectiveAt: null },
      }),
    });
    const { container } = render(<SiteStateBanner />);
    await act(async () => {});
    expect(licenceCalls()).toBe(1);
    expect(container.firstChild).toBeNull();
  });
});
