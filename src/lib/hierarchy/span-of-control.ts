/**
 * Span of control (Grove, High Output Management, Principle 16): a manager
 * whose work is largely supervisory should have six to eight subordinates.
 * Fewer invites meddling or on-the-job retirement; more makes monitoring
 * impossible.
 *
 * Display-only helpers for the hierarchy canvas. Everything here is computed
 * client-side from the relationship set the page has already loaded; nothing
 * in this module writes data or restructures anything. The 6-8 band is
 * Grove's guideline, not a fault line: a smaller span can be deliberate (a
 * president with five officer reports is correct, not deficient), so the UI
 * labels it as a guideline wherever it is shown.
 */

import { rankOf, rankValue, resolveRoleForUid } from '@/lib/role-catalog';
import { isFounderUid } from '@/config/founder';

export const SPAN_GUIDELINE_MIN = 6;
export const SPAN_GUIDELINE_MAX = 8;

/**
 * Supervisory roles are the catalog's executive tiers: chapter executives
 * (rank R2) and everything above them (national executives R3, governors
 * R4, founder R5). This is the same grouping the platform already uses in
 * src/lib/roles.ts (isChapterExecutive / isNationalExecutive). Advisory and
 * unit roles (R1) and the general body (R0) are never flagged against the
 * band. The raw stored token is resolved through the canonical catalog, so
 * legacy tokens (president_chapter, superadmin, ...) and the founder's
 * stored 'admin' token resolve exactly as they do everywhere else.
 */
export function isSupervisoryRole(
    role: string | null | undefined,
    uid?: string | null,
): boolean {
    const result = resolveRoleForUid(role ?? null, uid ?? null, isFounderUid);
    if (result.kind !== 'catalog' && result.kind !== 'legacy') return false;
    return rankValue(rankOf(result.key)) >= 2;
}

/** True when a direct-report count falls outside Grove's 6-8 guideline band. */
export function isSpanOutsideGuideline(reportsCount: number): boolean {
    return reportsCount < SPAN_GUIDELINE_MIN || reportsCount > SPAN_GUIDELINE_MAX;
}

/**
 * Count first-level reports per manager from a loaded relationship set.
 * Every edge counts once, direct and dotted alike: each edge is one person
 * whose work this manager supervises (dotted-line managers hold real
 * task-validation rights in this platform).
 */
export function countReportsByManager(
    edges: ReadonlyArray<{ source: string; target: string }>,
): Map<string, number> {
    const counts = new Map<string, number>();
    edges.forEach((e) => {
        if (!e.source || !e.target || e.source === e.target) return;
        counts.set(e.source, (counts.get(e.source) || 0) + 1);
    });
    return counts;
}
