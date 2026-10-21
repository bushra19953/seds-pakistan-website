'use client';

/**
 * useSiteState (Workstream H). Polls the public GET /api/site-state
 * every 60 seconds for display components (the admin banner). Any
 * failure resolves to 'live': the display layer fails open exactly
 * like the gate itself.
 */

import { useEffect, useState } from 'react';

export interface SiteStateView {
  mode: 'live' | 'maintenance' | 'disabled' | 'revoked';
  licencePublicNotice?: string;
  isLoading: boolean;
}

const FALLBACK: SiteStateView = { mode: 'live', isLoading: false };
const POLL_MS = 60_000;

export function useSiteState(): SiteStateView {
  const [state, setState] = useState<SiteStateView>({
    mode: 'live',
    isLoading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/site-state', { cache: 'no-store' });
        if (!res.ok) throw new Error('state unavailable');
        const body = (await res.json()) as {
          mode?: unknown;
          licencePublicNotice?: unknown;
        };
        if (cancelled) return;
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
        if (!cancelled) setState(FALLBACK);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return state;
}

export default useSiteState;
