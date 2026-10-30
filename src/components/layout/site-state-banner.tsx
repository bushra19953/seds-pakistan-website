'use client';

/**
 * Admin site-state banner (Workstream H, spec 5.3). Mounted in the
 * admin layout; renders nothing while the site is live and no notice
 * is running.
 *
 * Mode strips come from the public state hook. The notice-running
 * strip needs the admin projection, which is Founder-only: the banner
 * tries the licence route and stays silent on 403 (non-founder admins
 * simply do not see licence internals).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@/firebase/auth/use-user';
import { useSiteState } from '@/hooks/use-site-state';
import {
  MIN_POLL_INTERVAL_MS,
  usePollingRefresh,
} from '@/hooks/use-polling-refresh';

export function SiteStateBanner() {
  const { mode } = useSiteState();
  const { user } = useUser();
  const [notice, setNotice] = useState<{
    running: boolean;
    effectiveAt: string | null;
  } | null>(null);

  // Generation counter replacing the old effect-local `cancelled`
  // flag: a load whose generation has moved on (user changed, banner
  // unmounted) drops its result instead of writing stale state.
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    if (!user) return;
    const generation = loadGenerationRef.current;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/platform-licence', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const body = await res.json();
      if (loadGenerationRef.current !== generation) return;
      if (body?.effective?.noticeRunning) {
        setNotice({
          running: true,
          effectiveAt: body.effective.noticeEffectiveAt ?? null,
        });
      } else {
        setNotice({ running: false, effectiveAt: null });
      }
    } catch {
      // Founder-only route or network error: stay silent.
    }
  }, [user]);

  // Initial load on mount / user change; repeat refreshes go through
  // the shared polling hook (Supabase migration, listeners cluster,
  // Class B): the old raw 60-second setInterval is gone, the effective
  // interval is the shared 5-minute floor and polling pauses while
  // the tab is hidden.
  useEffect(() => {
    loadGenerationRef.current += 1;
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]);

  usePollingRefresh(
    () => {
      void load();
    },
    MIN_POLL_INTERVAL_MS,
    !!user,
  );

  if (mode === 'revoked') {
    return (
      <div role="alert" className="bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">
        Platform licence revoked: the public site is unavailable. Founder action
        required in Site Settings.
      </div>
    );
  }
  if (mode === 'maintenance' || mode === 'disabled') {
    return (
      <div role="alert" className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-black">
        Site is paused: visitors currently see the paused page. Turn it back on
        in Site Settings when ready.
      </div>
    );
  }
  if (notice?.running) {
    return (
      <div role="alert" className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-black">
        A licence revocation notice is running and takes effect
        {notice.effectiveAt
          ? ` on ${new Date(notice.effectiveAt).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })} PKT`
          : ' soon'}
        . Withdraw it in Site Settings before then if it was served in error.
      </div>
    );
  }
  return null;
}

export default SiteStateBanner;
