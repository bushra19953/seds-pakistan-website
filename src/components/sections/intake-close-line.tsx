'use client';

/**
 * One-line intake close/open copy (Workstream E, spec 6.2).
 *
 * Renders the resolved window's line via the shared formatters in
 * src/lib/intake-windows/format.ts, so no surface ever hard-codes a
 * date:
 * - open      -> formatIntakeCloseLine(window.closesAt)
 * - scheduled -> formatIntakeScheduledLine(window.opensAt)
 * - closed / cancelled / none -> formatIntakeClosedLine(window?.closesAt)
 * - loading   -> renders nothing (null): no date line before the first
 *   successful fetch (fail-safe, spec 6.3).
 */

import { useIntakeWindow } from '@/hooks/use-intake-window';
import {
  formatIntakeClosedLine,
  formatIntakeCloseLine,
  formatIntakeScheduledLine,
} from '@/lib/intake-windows/format';
import type { IntakeWindowKind } from '@/types/intake-window';

export interface IntakeCloseLineProps {
  kind?: IntakeWindowKind;
  className?: string;
}

export function IntakeCloseLine({
  kind = 'induction',
  className,
}: IntakeCloseLineProps) {
  const { window, state } = useIntakeWindow(kind);

  if (state === 'loading') return null;

  let line: string;
  if (state === 'open' && window) {
    line = formatIntakeCloseLine(window.closesAt);
  } else if (state === 'scheduled' && window) {
    line = formatIntakeScheduledLine(window.opensAt);
  } else {
    line = formatIntakeClosedLine(window?.closesAt);
  }

  return <span className={className}>{line}</span>;
}

export default IntakeCloseLine;
