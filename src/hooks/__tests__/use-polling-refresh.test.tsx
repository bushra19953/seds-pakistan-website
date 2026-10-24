/**
 * usePollingRefresh: the shared client polling cadence (read-burn fix,
 * 2026-10-24 audit). Proves the three properties every polling surface
 * now relies on:
 * - the 5-minute floor: a caller asking for 30 seconds does not get it;
 * - the hidden-tab pause: no refresh fires while document.hidden, and
 *   becoming visible again fires exactly one immediate refresh;
 * - the enabled gate and unmount cleanup stop all further refreshes.
 */

import { act, renderHook } from '@testing-library/react';
import { MIN_POLL_INTERVAL_MS, usePollingRefresh } from '@/hooks/use-polling-refresh';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  jest.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('usePollingRefresh', () => {
  it('enforces the 5-minute floor when a caller asks for 30 seconds', () => {
    const onRefresh = jest.fn();
    renderHook(() => usePollingRefresh(onRefresh, 30_000));

    act(() => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS - 1); });
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(1); });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('respects an interval longer than the floor', () => {
    const onRefresh = jest.fn();
    renderHook(() => usePollingRefresh(onRefresh, 10 * 60 * 1000));

    act(() => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(5 * 60 * 1000); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden and refreshes once on return', () => {
    const onRefresh = jest.fn();
    renderHook(() => usePollingRefresh(onRefresh, MIN_POLL_INTERVAL_MS));

    act(() => { setHidden(true); });
    act(() => { jest.advanceTimersByTime(3 * MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => { setHidden(false); });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not start polling when mounted in a hidden tab', () => {
    const onRefresh = jest.fn();
    setHidden(true);
    renderHook(() => usePollingRefresh(onRefresh, MIN_POLL_INTERVAL_MS));

    act(() => { jest.advanceTimersByTime(2 * MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => { setHidden(false); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('never fires while disabled, and starts when enabled', () => {
    const onRefresh = jest.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePollingRefresh(onRefresh, MIN_POLL_INTERVAL_MS, enabled),
      { initialProps: { enabled: false } },
    );

    act(() => { jest.advanceTimersByTime(2 * MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).not.toHaveBeenCalled();

    rerender({ enabled: true });
    act(() => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('stops after unmount', () => {
    const onRefresh = jest.fn();
    const { unmount } = renderHook(() => usePollingRefresh(onRefresh, MIN_POLL_INTERVAL_MS));
    unmount();

    act(() => { jest.advanceTimersByTime(2 * MIN_POLL_INTERVAL_MS); });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
