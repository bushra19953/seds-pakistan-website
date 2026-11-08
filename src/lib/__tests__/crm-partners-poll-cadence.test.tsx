/**
 * useCrmPartnersPoll cadence (perf/admin-realtime read-burn fix).
 *
 * Before the fix the hook ran a private 30-second setInterval with no
 * visibility handling: the full partner list was re-fetched (and the
 * CRM table re-rendered) twice a minute per open tab, hidden tabs
 * included. These tests pin the corrected behavior:
 * - one initial fetch when the surface enables;
 * - repeats ride the shared polling floor (MIN_POLL_INTERVAL_MS),
 *   never the requested 30 seconds;
 * - no fetches while the tab is hidden, exactly one on return;
 * - inert while disabled.
 */

import { act, renderHook } from '@testing-library/react';
import { MIN_POLL_INTERVAL_MS } from '@/hooks/use-polling-refresh';
import { useCrmPartnersPoll } from '@/lib/crm-supa-client';

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: async () => 'test-token' },
  }),
}));

const fetchMock = jest.fn(async () => ({
  ok: true,
  json: async () => ({ partners: [{ id: 'p1', organizationName: 'Acme' }] }),
}));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockClear();
  (global as any).fetch = fetchMock;
  setHidden(false);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useCrmPartnersPoll', () => {
  it('fetches once on enable and then only on the shared 5-minute floor, not every 30s', async () => {
    renderHook(() => useCrmPartnersPoll(true));

    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The old private cadence would have fired 4 more times by now.
    await act(async () => { jest.advanceTimersByTime(2 * 60 * 1000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS - 2 * 60 * 1000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch while the tab is hidden and refreshes once on return', async () => {
    renderHook(() => useCrmPartnersPoll(true));

    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => { setHidden(true); });
    await act(async () => { jest.advanceTimersByTime(3 * MIN_POLL_INTERVAL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => { setHidden(false); });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays inert while disabled', async () => {
    renderHook(() => useCrmPartnersPoll(false));

    await act(async () => { jest.advanceTimersByTime(2 * MIN_POLL_INTERVAL_MS); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
