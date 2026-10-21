/**
 * Suite E5 case 21: useIntakeWindow (Workstream E, spec 6.3).
 * - resolves state from the public route payload
 * - applies server clock skew so a fast device clock cannot close a
 *   window early
 * - fails closed on fetch error
 * - flips open -> closed on the local 1s tick at closesAt, no refetch
 */

import { act, renderHook } from '@testing-library/react';
import { useIntakeWindow } from '@/hooks/use-intake-window';

const REAL_NOW = Date.parse('2026-10-21T10:00:00.000Z');
const fetchMock = jest.fn();

function payload(overrides: Record<string, unknown> = {}) {
  return {
    windowId: 'induction-2026-10-fall',
    label: 'Fall Induction',
    kind: 'induction',
    opensAt: '2026-10-01T00:00:00.000Z',
    closesAt: '2026-10-25T00:00:00.000Z',
    state: 'open',
    isDefault: false,
    serverNow: new Date(REAL_NOW).toISOString(),
    ...overrides,
  };
}

function okResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(REAL_NOW);
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useIntakeWindow', () => {
  it('starts loading, then resolves open from the payload', async () => {
    fetchMock.mockImplementation(() => okResponse(payload()));
    const { result } = renderHook(() => useIntakeWindow('induction'));
    expect(result.current.state).toBe('loading');
    await act(async () => {});
    expect(result.current.state).toBe('open');
    expect(result.current.error).toBe(false);
    expect(result.current.window?.windowId).toBe('induction-2026-10-fall');
  });

  it('applies server skew: a device clock 10 minutes fast does not close early', async () => {
    // Device clock runs 10 minutes ahead of the server.
    jest.setSystemTime(REAL_NOW + 10 * 60 * 1000);
    fetchMock.mockImplementation(() =>
      okResponse(
        payload({
          // Server-side truth: the window closes 5 minutes from REAL_NOW.
          closesAt: new Date(REAL_NOW + 5 * 60 * 1000).toISOString(),
          serverNow: new Date(REAL_NOW).toISOString(),
        }),
      ),
    );
    const { result } = renderHook(() => useIntakeWindow('induction'));
    await act(async () => {});
    // Uncorrected device time (REAL_NOW + 10m) is past closesAt and
    // would read closed; the skew-corrected clock reads open.
    expect(result.current.state).toBe('open');
  });

  it('fails closed when the fetch rejects', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    const { result } = renderHook(() => useIntakeWindow('induction'));
    await act(async () => {});
    expect(result.current.state).toBe('closed');
    expect(result.current.error).toBe(true);
  });

  it('fails closed on a fail-safe payload (null window)', async () => {
    fetchMock.mockImplementation(() =>
      okResponse({
        windowId: null,
        label: null,
        kind: 'induction',
        opensAt: null,
        closesAt: null,
        state: 'closed',
        isDefault: false,
        serverNow: new Date(REAL_NOW).toISOString(),
        error: 'no_window_resolved',
      }),
    );
    const { result } = renderHook(() => useIntakeWindow('induction'));
    await act(async () => {});
    expect(result.current.state).toBe('closed');
    expect(result.current.error).toBe(true);
  });

  it('flips open to closed on the local tick at closesAt without refetching', async () => {
    fetchMock.mockImplementation(() =>
      okResponse(
        payload({
          closesAt: new Date(REAL_NOW + 2000).toISOString(),
          serverNow: new Date(REAL_NOW).toISOString(),
        }),
      ),
    );
    const { result } = renderHook(() => useIntakeWindow('induction'));
    await act(async () => {});
    expect(result.current.state).toBe('open');
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(result.current.state).toBe('closed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
