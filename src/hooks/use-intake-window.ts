'use client';

/**
 * Client hook for the resolved intake window (Workstream E, spec 5.3/6.3).
 *
 * Fetches GET /api/public/intake-window for a kind and ticks locally
 * every 1s so an open window flips to closed at its closesAt (and a
 * scheduled window flips to open at its opensAt) without waiting for
 * a refetch.
 *
 * Supabase migration (listeners cluster, Class B, F6 item X3): the
 * repeat refetch no longer runs on a raw 60-second setInterval. It
 * goes through the shared usePollingRefresh hook, so the effective
 * interval is the 5-minute floor (MIN_POLL_INTERVAL_MS) and polling
 * pauses while the tab is hidden. The floor exception was denied:
 * the open/close flips are carried by the 1s local tick below, and
 * the refetch only carries window redefinition (create / cancel /
 * reschedule), which tolerates minutes-scale propagation.
 *
 * Clock skew: the public route returns serverNow. At fetch time the hook
 * computes skewMs = serverNow - clientNow and applies it to every local
 * tick, so a wrong device clock cannot open or close the gate early.
 *
 * Fail-safe (spec 6.3): before the first successful fetch the state is
 * 'loading' and surfaces render non-open. A fetch failure, a non-200
 * response, a null window, or a malformed payload (missing or
 * unparseable opensAt/closesAt) yields state 'closed' with error true.
 * A silently open gate is worse than a loudly closed one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MIN_POLL_INTERVAL_MS,
  usePollingRefresh,
} from '@/hooks/use-polling-refresh';
import type {
  DerivedWindowState,
  IntakeWindowKind,
  PublicIntakeWindow,
} from '@/types/intake-window';

export type IntakeWindowHookState =
  | 'loading'
  | DerivedWindowState;

export interface UseIntakeWindowResult {
  window: PublicIntakeWindow | null;
  state: IntakeWindowHookState;
  loading: boolean;
  error: boolean;
}

const KNOWN_STATES: ReadonlyArray<string> = [
  'scheduled',
  'open',
  'closed',
  'cancelled',
  'none',
];

function parseMs(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Validate a public-route payload. Returns the window on success, or
 * null when the payload is a fail-safe / malformed shape (null window,
 * missing or unparseable opensAt/closesAt).
 */
function parsePayload(
  payload: unknown,
): { window: PublicIntakeWindow; serverNowMs: number } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.windowId !== 'string' || !p.windowId) return null;
  const opensMs = parseMs(p.opensAt);
  const closesMs = parseMs(p.closesAt);
  if (!Number.isFinite(opensMs) || !Number.isFinite(closesMs)) return null;
  const serverNowMs = parseMs(p.serverNow);
  const state =
    typeof p.state === 'string' && KNOWN_STATES.includes(p.state)
      ? (p.state as DerivedWindowState)
      : closesMs <= (Number.isFinite(serverNowMs) ? serverNowMs : opensMs)
        ? 'closed'
        : 'open';
  return {
    window: {
      windowId: p.windowId,
      label: typeof p.label === 'string' ? p.label : null,
      kind: (typeof p.kind === 'string'
        ? p.kind
        : 'induction') as IntakeWindowKind,
      opensAt: new Date(opensMs).toISOString(),
      closesAt: new Date(closesMs).toISOString(),
      state,
      isDefault: p.isDefault === true,
      serverNow:
        typeof p.serverNow === 'string'
          ? p.serverNow
          : new Date().toISOString(),
    },
    serverNowMs,
  };
}

/** Derive the live state of a fetched window at a corrected instant. */
function deriveLiveState(
  window: PublicIntakeWindow,
  correctedNowMs: number,
): DerivedWindowState {
  // Terminal / resolution-level states are not clock-derived.
  if (window.state === 'cancelled' || window.state === 'none') {
    return window.state;
  }
  const opensMs = parseMs(window.opensAt);
  const closesMs = parseMs(window.closesAt);
  if (!Number.isFinite(opensMs) || !Number.isFinite(closesMs)) return 'closed';
  if (correctedNowMs < opensMs) return 'scheduled';
  if (correctedNowMs < closesMs) return 'open';
  return 'closed';
}

export function useIntakeWindow(
  kind: IntakeWindowKind = 'induction',
): UseIntakeWindowResult {
  const [window, setWindow] = useState<PublicIntakeWindow | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [skewMs, setSkewMs] = useState(0);
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);

  const fetchWindow = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/public/intake-window?kind=${encodeURIComponent(kind)}`,
      );
      if (!res || !res.ok) {
        throw new Error(`intake-window fetch failed: ${res?.status}`);
      }
      const payload: unknown = await res.json();
      const parsed = parsePayload(payload);
      if (!parsed) {
        // Fail-safe payload (null window / no_window_resolved /
        // window_malformed) or a malformed body: fail closed.
        throw new Error('intake-window payload malformed or empty');
      }
      if (!mountedRef.current) return;
      const clientNow = Date.now();
      setSkewMs(
        Number.isFinite(parsed.serverNowMs)
          ? parsed.serverNowMs - clientNow
          : 0,
      );
      setWindow(parsed.window);
      setPhase('ready');
    } catch {
      if (!mountedRef.current) return;
      setPhase('error');
    }
  }, [kind]);

  // Initial load is this hook's job; the shared polling hook only
  // drives the repeat refetches.
  useEffect(() => {
    mountedRef.current = true;
    setPhase('loading');
    setWindow(null);
    void fetchWindow();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchWindow]);

  usePollingRefresh(() => {
    void fetchWindow();
  }, MIN_POLL_INTERVAL_MS);

  // Local 1s tick: flips open -> closed at closesAt (and scheduled ->
  // open at opensAt) against the skew-corrected clock, with no refetch.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  let state: IntakeWindowHookState;
  if (phase === 'loading') {
    state = 'loading';
  } else if (phase === 'error' || !window) {
    state = 'closed';
  } else {
    state = deriveLiveState(window, Date.now() + skewMs);
  }

  return {
    window: phase === 'error' ? window : window,
    state,
    loading: phase === 'loading',
    error: phase === 'error',
  };
}

export default useIntakeWindow;
