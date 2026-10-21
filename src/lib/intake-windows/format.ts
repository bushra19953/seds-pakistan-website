/**
 * Copy lines for migrated intake surfaces (Workstream E, spec 6.2).
 *
 * Thin wrappers over formatCutoffLinePKT so the wording lives in one
 * place and every surface renders dates in Asia/Karachi regardless of
 * the viewer's device timezone.
 */

import { formatCutoffLinePKT } from '@/lib/date-utils';
import type { PublicIntakeWindow } from '@/types/intake-window';

/** Open state: "Applications close {PKT line}." */
export function formatIntakeCloseLine(closesAt: unknown): string {
  return `Applications close ${formatCutoffLinePKT(closesAt)}.`;
}

/**
 * Closed state. With a known closesAt (the most recently closed window,
 * resolution step 4): "Applications closed on {PKT line}." Without one,
 * the neutral fail-safe line invents no date: "Applications are now
 * closed."
 */
export function formatIntakeClosedLine(closesAt?: unknown): string {
  if (closesAt === null || closesAt === undefined) {
    return 'Applications are now closed.';
  }
  return `Applications closed on ${formatCutoffLinePKT(closesAt)}.`;
}

/** Scheduled state: "Applications open {PKT line}." */
export function formatIntakeScheduledLine(opensAt: unknown): string {
  return `Applications open ${formatCutoffLinePKT(opensAt)}.`;
}

/**
 * The one-line copy for a resolved public window, by state:
 * open -> close line, scheduled -> open line, anything else (closed,
 * cancelled, none, null window) -> closed line built from closesAt when
 * the window carries one.
 */
export function formatIntakeStateLine(
  window: PublicIntakeWindow | null | undefined,
): string {
  if (!window) return formatIntakeClosedLine();
  if (window.state === 'open') return formatIntakeCloseLine(window.closesAt);
  if (window.state === 'scheduled') {
    return formatIntakeScheduledLine(window.opensAt);
  }
  return formatIntakeClosedLine(window.closesAt);
}
