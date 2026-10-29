'use client';

/**
 * useSiteState (Workstream H). Polls the public GET /api/site-state
 * for display components (the admin banner). Any failure resolves to
 * 'live': the display layer fails open exactly like the gate itself.
 *
 * Supabase migration (listeners cluster, Class B): the repeat poll no
 * longer runs on a raw 60-second setInterval. It goes through the
 * shared usePollingRefresh hook, so the effective interval is the
 * 5-minute floor (MIN_POLL_INTERVAL_MS) and polling pauses while the
 * tab is hidden. The initial load still happens immediately on mount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MIN_POLL_INTERVAL_MS,
  usePollingRefresh,
} from '@/hooks/use-polling-refresh';

export interface SiteStateView {
  mode: 'live' | 'maintenance' | 'disabled' | 'revoked';
  licencePublicNotice?: string;
  isLoading: boolean;
}

const FALLBACK: SiteStateView = { mode: 'live', isLoading: false };

export function useSiteState(): SiteStateView {
  const [state, setState] = useState<SiteStateView>({
    mode: 'live',
    isLoading: true,
  });

  // Replaces the old effect-local `cancelled` flag: results landing
  // after unmount are dropped, exactly as before.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      // Default cache mode: lets the route's s-maxage=60 shared-cache
      // header actually serve repeat polls (a forced no-store here
      // would bypass it and re-read on every tab, every poll).
      const res = await fetch('/api/site-state');
      if (!res.ok) throw new Error('state unavailable');
      const body = (await res.json()) as {
        mode?: unknown;
        licencePublicNotice?: unknown;
      };
      if (!mountedRef.current) return;
      const mode =
        body.mode === 'maintenance' ||
        body.mode === 'disabled' ||
        body.mode === 'revoked'
          ? body.mode
          : 'live';
      setState({
        mode,
        licencePublicNotice:
          typeof body.licencePublicNotice === 'string'
            ? body.licencePublicNotice
            : undefined,
        isLoading: false,
      });
    } catch {
      if (mountedRef.current) setState(FALLBACK);
    }
  }, []);

  // Initial load is this hook's job; the shared polling hook only
  // drives the repeat refreshes.
  useEffect(() => {
    void load();
  }, [load]);

  usePollingRefresh(() => {
    void load();
  }, MIN_POLL_INTERVAL_MS);

  return state;
}

export default useSiteState;
