'use client';

import React from 'react';

/**
 * LegalIdentityBlock (Item 8) - the single rendering path for the legal
 * name + Status Line A. Footer, terms, privacy, and donate all mount
 * this component so there is exactly one place that renders the claim.
 *
 * While settings are loading (or missing) it renders the IN-PROCESS
 * default: it never renders nothing and never renders a registered
 * claim speculatively.
 */

import { useSiteSettings } from '@/hooks/use-site-settings';
import {
  getLegalIdentityBlock,
  IN_PROCESS_STATUS_LINE,
  LEGAL_NAME,
} from '@/lib/legal-status';

export default function LegalIdentityBlock({
  className = '',
}: {
  className?: string;
}) {
  const { settings } = useSiteSettings();

  const block = settings
    ? getLegalIdentityBlock(settings)
    : {
        legalName: LEGAL_NAME,
        shortName: 'SEDS Pakistan',
        statusLine: IN_PROCESS_STATUS_LINE,
        shortStatusLine: '',
      };

  return (
    <div className={`text-xs text-muted-foreground ${className}`}>
      <p className="font-medium text-foreground/80">{block.legalName}</p>
      <p className="mt-1 leading-relaxed">{block.statusLine}</p>
    </div>
  );
}
