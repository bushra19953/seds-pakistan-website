/**
 * X3 (listeners cluster, Class B, F6): useIntakeWindow's refetch of
 * GET /api/public/intake-window no longer runs on a raw 60-second
 * setInterval. The floor exception was denied:
 *
 * - The initial load is immediate; repeats are driven only by the
 *   shared usePollingRefresh at an effective interval >= 300,000ms
 *   (nothing at 60s, next fetch at the 5-minute floor, hidden-tab
 *   pause, one refresh on re-show).
 * - The only raw setInterval left in the hook is the 1-second local
 *   tick, which drives NO refetch: it re-derives the live state
 *   locally, so a scheduled window flips to open (and an open window
 *   to closed) on time, to the second, with no extra fetch.
 * - The returned state shape ({ window, state, loading, error }) is
 *   unchanged for the same API payloads, including the fail-safe
 *   closed-on-error shape and the cancelled passthrough.
 */

import * as fs from 'fs';
import * as path from 'path';
import { act, renderHook } from '@testing-library/react';
import { useIntakeWindow } from '@/hooks/use-intake-window';
import { MIN_POLL_INTERVAL_MS } from '@/hooks/use-polling-refresh';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

function intakeCalls(): number {
  return fetchMock.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].startsWith('/api/public/intake-window'),
  ).length;
}

/** A valid public payload whose window is open at `nowMs`. */
function openPayload(nowMs: number) {
  return {
    windowId: 'win-1',
    label: 'Induction 2026',
    kind: 'induction',
    opensAt: new Date(nowMs - 60_000).toISOString(),
    closesAt: new Date(nowMs + 60 * 60_000).toISOString(),
    state: 'open',
    isDefault: false,
    serverNow: new Date(nowMs).toISOString(),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useIntakeWindow refetch polling (X3)', () => {
  it('loads immediately on mount, then only at the 5-minute floor (never at 60s)', async () => {
    fetchMock.mockResolvedValue(okJson(openPayload(Date.now())));
    const { result } = renderHook(() => useIntakeWindow());
    await act(async () => {});
    expect(intakeCalls()).toBe(1);
    expect(result.current.state).toBe('open');

    // The old 60-second refetch cadence is gone.
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(intakeCalls()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS - 60_000 - 1); });
    expect(intakeCalls()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(1); });
    expect(intakeCalls()).toBe(2);
  });

  it('pauses the refetch while hidden and refreshes once on re-show', async () => {
    fetchMock.mockResolvedValue(okJson(openPayload(Date.now())));
    renderHook(() => useIntakeWindow());
    await act(async () => {});
    expect(intakeCalls()).toBe(1);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS * 2); });
    expect(intakeCalls()).toBe(1);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(intakeCalls()).toBe(2);
  });

  it('the 1s local tick flips scheduled -> open at opensAt with no refetch', async () => {
    const now = Date.now();
    fetchMock.mockResolvedValue(
      okJson({
        windowId: 'win-2',
        label: null,
        kind: 'induction',
        opensAt: new Date(now + 2_000).toISOString(),
        closesAt: new Date(now + 60 * 60_000).toISOString(),
        state: 'scheduled',
        isDefault: false,
        serverNow: new Date(now).toISOString(),
      }),
    );
    const { result } = renderHook(() => useIntakeWindow());
    await act(async () => {});
    expect(result.current.state).toBe('scheduled');
    expect(intakeCalls()).toBe(1);

    // Two local ticks, zero refetches: the flip is clock-derived.
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(result.current.state).toBe('open');
    expect(intakeCalls()).toBe(1);
  });

  it('the 1s local tick flips open -> closed at closesAt with no refetch', async () => {
    const now = Date.now();
    fetchMock.mockResolvedValue(
      okJson({
        windowId: 'win-3',
        label: null,
        kind: 'induction',
        opensAt: new Date(now - 60_000).toISOString(),
        closesAt: new Date(now + 3_000).toISOString(),
        state: 'open',
        isDefault: false,
        serverNow: new Date(now).toISOString(),
      }),
    );
    const { result } = renderHook(() => useIntakeWindow());
    await act(async () => {});
    expect(result.current.state).toBe('open');

    await act(async () => { jest.advanceTimersByTime(3_000); });
    expect(result.current.state).toBe('closed');
    expect(intakeCalls()).toBe(1);
  });
});

describe('useIntakeWindow returned state shape (unchanged by X3)', () => {
  it('returns { window, state, loading, error } for an open payload', async () => {
    const now = Date.now();
    const payload = openPayload(now);
    fetchMock.mockResolvedValue(okJson(payload));
    const { result } = renderHook(() => useIntakeWindow());
    await act(async () => {});
    expect(result.current).toEqual({
      window: {
        windowId: 'win-1',
        label: 'Induction 2026',
        kind: 'induction',
        opensAt: payload.opensAt,
        closesAt: payload.closesAt,
        state: 'open',
        isDefault: false,
        serverNow: payload.serverNow,
      },
      state: 'open',
      loading: false,
      error: false,
    });
  });

  it('passes a cancelled window state through (not clock-derived)', async () => {
    const now = Date.now();
    const payload = { ...openPayload(now), state: 'cancelled' };
    fetchMock.mockResolvedValue(okJson(payload));
    const { result } = renderHook(() => useIntakeWindow());
    await act(async () => {});
    expect(result.current.state).toBe('cancelled');
    expect(result.current.error).toBe(false);
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(result.current.state).toBe('cancelled');
  });

  it('fails safe to closed with error true on a failed fetch', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useIntakeWindow());
    await act(async () => {});
    expect(result.current).toEqual({
      window: null,
      state: 'closed',
      loading: false,
      error: true,
    });
  });
});

describe('X3 source-level pins', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/hooks/use-intake-window.ts'),
    'utf8',
  );

  it('refetch goes through usePollingRefresh at the floor constant', () => {
    expect(src).toContain('usePollingRefresh');
    expect(src).toContain('MIN_POLL_INTERVAL_MS');
    expect(MIN_POLL_INTERVAL_MS).toBe(300_000);
    expect(MIN_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(300_000);
  });

  it('no raw setInterval drives the refetch: no 60_000 anywhere, and the only setInterval left is the 1s local tick', () => {
    expect(src).not.toContain('60_000');
    const intervals = src.match(/setInterval\s*\(/g) ?? [];
    expect(intervals).toHaveLength(1);
    // The single remaining setInterval call is the 1-second local
    // tick (setTick), never the fetch.
    const tickAt = src.indexOf('setInterval(');
    const tickCall = src.slice(tickAt, tickAt + 80);
    expect(tickCall).toContain('setTick');
    expect(tickCall).toContain('1000');
    expect(tickCall).not.toContain('fetchWindow');
  });

  it('does not edit the shared hook to get its cadence', () => {
    const shared = fs.readFileSync(
      path.join(process.cwd(), 'src/hooks/use-polling-refresh.ts'),
      'utf8',
    );
    expect(shared).toContain('MIN_POLL_INTERVAL_MS = 5 * 60 * 1000');
  });
});
