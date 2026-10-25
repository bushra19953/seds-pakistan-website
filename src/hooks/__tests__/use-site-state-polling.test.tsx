/**
 * X1/X2 (listeners cluster, Class B): the site-state polls no longer
 * run on raw 60-second setIntervals.
 *
 * - useSiteState (X1): initial load immediate; repeats only via the
 *   shared usePollingRefresh — nothing at 60s, next fetch at the
 *   5-minute floor. Payload/state shape (mode mapping, fail-open
 *   fallback) unchanged.
 * - Source-level pin for both X1 and X2 files: no setInterval call
 *   remains, both go through usePollingRefresh.
 * (The X2 banner's behavior is pinned by its own component suite in
 * site-state-banner-polling.test.tsx.)
 */

import * as fs from 'fs';
import * as path from 'path';
import { act, renderHook } from '@testing-library/react';
import { useSiteState } from '@/hooks/use-site-state';
import { MIN_POLL_INTERVAL_MS } from '@/hooks/use-polling-refresh';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

function siteStateCalls(): number {
  return fetchMock.mock.calls.filter((c) => c[0] === '/api/site-state').length;
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useSiteState polling (X1)', () => {
  it('loads immediately on mount, then only at the 5-minute floor (never at 60s)', async () => {
    fetchMock.mockResolvedValue(okJson({ mode: 'live' }));
    const { result } = renderHook(() => useSiteState());
    await act(async () => {});
    expect(siteStateCalls()).toBe(1);
    expect(result.current.mode).toBe('live');
    expect(result.current.isLoading).toBe(false);

    // The old 60-second cadence is gone.
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(siteStateCalls()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS - 60_000 - 1); });
    expect(siteStateCalls()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(1); });
    expect(siteStateCalls()).toBe(2);
  });

  it('keeps the payload shape: known modes pass through, notice is surfaced', async () => {
    fetchMock.mockResolvedValue(
      okJson({ mode: 'maintenance', licencePublicNotice: 'Paused Sunday' }),
    );
    const { result } = renderHook(() => useSiteState());
    await act(async () => {});
    expect(result.current).toEqual({
      mode: 'maintenance',
      licencePublicNotice: 'Paused Sunday',
      isLoading: false,
    });
  });

  it('keeps the fail-open fallback: a failed fetch resolves to live', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useSiteState());
    await act(async () => {});
    expect(result.current).toEqual({ mode: 'live', isLoading: false });
  });
});

describe('X1/X2 source-level pins', () => {
  const files = [
    'src/hooks/use-site-state.ts',
    'src/components/layout/site-state-banner.tsx',
  ];
  for (const rel of files) {
    it(`${rel}: no raw setInterval call, polls via usePollingRefresh`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(src).not.toMatch(/setInterval\s*\(/);
      expect(src).not.toContain('60_000');
      expect(src).toContain('usePollingRefresh');
      expect(src).toContain('MIN_POLL_INTERVAL_MS');
    });
  }

  it('the shared floor the conversions rely on is 300,000ms', () => {
    expect(MIN_POLL_INTERVAL_MS).toBe(300_000);
  });
});
