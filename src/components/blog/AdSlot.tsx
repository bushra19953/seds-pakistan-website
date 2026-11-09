'use client';

/**
 * AdSlot — the only advertising surface on the blog.
 *
 * Founder ruling (2026-11-09): ads are allowed in blogs. The society has
 * no AdSense account yet, so this component is built dark: unless BOTH
 * NEXT_PUBLIC_ADS_ENABLED=1 and the publisher id plus this placement's
 * ad-unit id are present in the environment, it renders absolutely
 * nothing — no placeholder box, no reserved height, no layout shift.
 * When the account exists, setting the env vars below is the only step
 * needed; no code change.
 *
 * Required env (set in the deployment environment, never in code):
 *   NEXT_PUBLIC_ADS_ENABLED=1
 *   NEXT_PUBLIC_ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX   (publisher id)
 *   NEXT_PUBLIC_ADSENSE_SLOT_LIST=NNNNNNNNNN             (blog list feed)
 *   NEXT_PUBLIC_ADSENSE_SLOT_POST_INTRO=NNNNNNNNNN       (post, after intro)
 *   NEXT_PUBLIC_ADSENSE_SLOT_POST_MID=NNNNNNNNNN         (post, mid-article)
 *   NEXT_PUBLIC_ADSENSE_SLOT_POST_END=NNNNNNNNNN         (post, end)
 */

import React, { useEffect } from 'react';
import Script from 'next/script';

export type AdSlotPlacement = 'list' | 'post-intro' | 'post-mid' | 'post-end';

interface AdConfig {
  client: string;
  slotId: string;
}

// Each env var is referenced literally so Next.js can inline the public
// values at build time.
function adConfigFor(placement: AdSlotPlacement): AdConfig | null {
  if (process.env.NEXT_PUBLIC_ADS_ENABLED !== '1') return null;
  const client = process.env.NEXT_PUBLIC_ADSENSE_CLIENT;
  if (!client) return null;
  const slotId =
    placement === 'list'
      ? process.env.NEXT_PUBLIC_ADSENSE_SLOT_LIST
      : placement === 'post-intro'
        ? process.env.NEXT_PUBLIC_ADSENSE_SLOT_POST_INTRO
        : placement === 'post-mid'
          ? process.env.NEXT_PUBLIC_ADSENSE_SLOT_POST_MID
          : process.env.NEXT_PUBLIC_ADSENSE_SLOT_POST_END;
  if (!slotId) return null;
  return { client, slotId };
}

declare global {
  interface Window {
    adsbygoogle?: Array<Record<string, unknown>>;
  }
}

export default function AdSlot({
  placement,
  className = '',
}: {
  placement: AdSlotPlacement;
  className?: string;
}) {
  const config = adConfigFor(placement);

  useEffect(() => {
    if (!config) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // Ad blockers and network failures must never break the article.
    }
  }, [config]);

  if (!config) return null;

  return (
    <div className={className} data-ad-placement={placement}>
      <Script
        src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${config.client}`}
        strategy="afterInteractive"
        crossOrigin="anonymous"
      />
      <ins
        className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-client={config.client}
        data-ad-slot={config.slotId}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
