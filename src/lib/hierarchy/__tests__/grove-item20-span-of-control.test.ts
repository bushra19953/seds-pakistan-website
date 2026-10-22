/**
 * Grove Item 20 - span of control on the hierarchy.
 *
 * Tests for the display-only helpers in src/lib/hierarchy/span-of-control.ts
 * and for the exact flag composition the hierarchy canvas applies:
 *
 *   spanOutsideGuideline = isSupervisoryRole(role, uid) && isSpanOutsideGuideline(reportsCount)
 *
 * The dotted-edge rule tested here is the one documented in the module:
 * "Every edge counts once, direct and dotted alike: each edge is one person
 * whose work this manager supervises."
 *
 * Edge fixtures mirror validateEdges in hierarchy-canvas.tsx: the edge's
 * source is the manager, its target is the subordinate, and the relationship
 * type rides on data.relationType ('direct' | 'dotted'). The counter reads
 * only source/target, so a dotted relationship reaches it as an ordinary
 * edge and must count exactly like a direct one.
 */

import {
    countReportsByManager,
    isSpanOutsideGuideline,
    isSupervisoryRole,
    SPAN_GUIDELINE_MIN,
    SPAN_GUIDELINE_MAX,
} from '@/lib/hierarchy/span-of-control';
import { FOUNDER_UID } from '@/config/founder';

type RelationType = 'direct' | 'dotted';

/** One loaded chart edge, shaped the way hierarchy-canvas.tsx builds it. */
const edge = (managerId: string, subordinateId: string, relationType: RelationType = 'direct') => ({
    id: `e-${managerId}-${subordinateId}-${relationType}`,
    source: managerId,
    target: subordinateId,
    data: { relationType },
});

/** A manager with n first-level reports, all of one relationship type. */
const star = (managerId: string, n: number, relationType: RelationType = 'direct') =>
    Array.from({ length: n }, (_, i) => edge(managerId, `${managerId}-report-${i + 1}`, relationType));

/** The flag exactly as hierarchy-canvas.tsx composes it for node data. */
const spanFlagFor = (role: string | null | undefined, reportsCount: number, uid?: string | null): boolean =>
    isSupervisoryRole(role, uid) && isSpanOutsideGuideline(reportsCount);

describe('guideline band constants', () => {
    it('are Grove\'s 6-8', () => {
        expect(SPAN_GUIDELINE_MIN).toBe(6);
        expect(SPAN_GUIDELINE_MAX).toBe(8);
    });
});

describe('countReportsByManager: synthetic relationship sets', () => {
    it('counts 3 direct reports for a manager', () => {
        const counts = countReportsByManager(star('mgr-a', 3));
        expect(counts.get('mgr-a')).toBe(3);
    });

    it('counts 7 direct reports for a manager', () => {
        const counts = countReportsByManager(star('mgr-b', 7));
        expect(counts.get('mgr-b')).toBe(7);
    });

    it('counts 12 direct reports for a manager', () => {
        const counts = countReportsByManager(star('mgr-c', 12));
        expect(counts.get('mgr-c')).toBe(12);
    });

    it('gives a leaf node a count of 0 (it never appears as a source)', () => {
        const counts = countReportsByManager(star('mgr-a', 3));
        // 'mgr-a-report-1' is in the chart only as a target: a leaf.
        expect(counts.has('mgr-a-report-1')).toBe(false);
        expect(counts.get('mgr-a-report-1') || 0).toBe(0);
    });

    it('returns an empty map for an empty relationship set', () => {
        const counts = countReportsByManager([]);
        expect(counts.size).toBe(0);
    });

    it('keeps independent counts for several managers in one set', () => {
        const counts = countReportsByManager([
            ...star('mgr-a', 3),
            ...star('mgr-b', 7),
            ...star('mgr-c', 12),
        ]);
        expect(counts.get('mgr-a')).toBe(3);
        expect(counts.get('mgr-b')).toBe(7);
        expect(counts.get('mgr-c')).toBe(12);
        expect(counts.size).toBe(3);
    });

    it('counts a shared report once for each of its managers', () => {
        const counts = countReportsByManager([
            edge('mgr-a', 'shared-report'),
            edge('mgr-b', 'shared-report', 'dotted'),
        ]);
        expect(counts.get('mgr-a')).toBe(1);
        expect(counts.get('mgr-b')).toBe(1);
    });

    it('counts only first-level reports, not the whole subtree', () => {
        const counts = countReportsByManager([
            ...star('top', 2),
            ...star('top-report-1', 5),
        ]);
        expect(counts.get('top')).toBe(2);
        expect(counts.get('top-report-1')).toBe(5);
    });
});

describe('countReportsByManager: dotted edges (documented rule: counted, like direct)', () => {
    it('counts dotted edges toward the manager\'s span', () => {
        const counts = countReportsByManager(star('mgr-dotted', 4, 'dotted'));
        expect(counts.get('mgr-dotted')).toBe(4);
    });

    it('adds direct and dotted edges together into one span', () => {
        const counts = countReportsByManager([
            ...star('mgr-mixed', 4, 'direct'),
            ...[0, 1, 2].map(i => edge('mgr-mixed', `mgr-mixed-dotted-${i + 1}`, 'dotted')),
        ]);
        expect(counts.get('mgr-mixed')).toBe(7);
    });
});

describe('countReportsByManager: malformed edges are skipped', () => {
    it('skips self-edges and edges with a missing endpoint', () => {
        const counts = countReportsByManager([
            edge('mgr-a', 'mgr-a'),
            { source: '', target: 'someone' },
            { source: 'mgr-a', target: '' },
            ...star('mgr-a', 2),
        ]);
        expect(counts.get('mgr-a')).toBe(2);
        expect(counts.has('')).toBe(false);
    });
});

describe('isSpanOutsideGuideline: the 6-8 band', () => {
    it.each([
        [0, true],
        [5, true],
        [6, false],
        [7, false],
        [8, false],
        [9, true],
        [12, true],
    ])('count %i -> outside=%s', (count, expected) => {
        expect(isSpanOutsideGuideline(count)).toBe(expected);
    });
});

describe('isSupervisoryRole: catalog executive tiers (R2 and above)', () => {
    it.each([
        'founder_patron',          // R5
        'governor_member',         // R4
        'president_national',      // R3
        'national_vice_president', // R3
        'chapter_president',       // R2
        'chapter_events_chair',    // R2
    ])('treats %s as supervisory', (role) => {
        expect(isSupervisoryRole(role)).toBe(true);
    });

    it.each([
        'member',         // R0 general body
        'member_basic',   // R0 general body
        'team_lead',      // R1 unit role
        'faculty_advisor',// R1 advisory role
    ])('treats %s as non-supervisory', (role) => {
        expect(isSupervisoryRole(role)).toBe(false);
    });

    it('resolves legacy tokens through the catalog before judging', () => {
        expect(isSupervisoryRole('president_chapter')).toBe(true); // legacy -> chapter_president (R2)
        expect(isSupervisoryRole('superadmin')).toBe(true);        // legacy -> chief_technology_officer (R3)
    });

    it('treats the stored admin token as supervisory only on the founder\'s own uid', () => {
        expect(isSupervisoryRole('admin', FOUNDER_UID)).toBe(true);
        expect(isSupervisoryRole('admin', 'some-other-uid')).toBe(false);
        expect(isSupervisoryRole('admin')).toBe(false);
    });

    it('never flags missing or unknown roles', () => {
        expect(isSupervisoryRole(null)).toBe(false);
        expect(isSupervisoryRole(undefined)).toBe(false);
        expect(isSupervisoryRole('')).toBe(false);
        expect(isSupervisoryRole('not_a_real_role')).toBe(false);
    });
});

describe('span flag composition (as applied by hierarchy-canvas.tsx)', () => {
    const SUPERVISORY = 'chapter_president';

    it('flags a supervisory role below the band (5 reports)', () => {
        expect(spanFlagFor(SUPERVISORY, 5)).toBe(true);
    });

    it('flags a supervisory role above the band (9 reports)', () => {
        expect(spanFlagFor(SUPERVISORY, 9)).toBe(true);
    });

    it('does not flag a supervisory role inside the band (7 reports)', () => {
        expect(spanFlagFor(SUPERVISORY, 7)).toBe(false);
    });

    it('does not flag a supervisory role at the band edges (6 and 8 reports)', () => {
        expect(spanFlagFor(SUPERVISORY, 6)).toBe(false);
        expect(spanFlagFor(SUPERVISORY, 8)).toBe(false);
    });

    it('flags a supervisory role with no reports at all (0 is below the band)', () => {
        expect(spanFlagFor(SUPERVISORY, 0)).toBe(true);
    });

    it.each([0, 3, 5, 7, 9, 12, 20])(
        'never flags a non-supervisory role, at any count (%i reports)',
        (count) => {
            expect(spanFlagFor('member', count)).toBe(false);
            expect(spanFlagFor('team_lead', count)).toBe(false);
        },
    );

    it('end to end: counts from a synthetic set drive the flag', () => {
        // 5 officers under a chapter president: below the band, flagged.
        const five = countReportsByManager(star('chapter-president-uid', 5));
        expect(spanFlagFor('chapter_president', five.get('chapter-president-uid') || 0)).toBe(true);

        // 7 members under the same president: inside the band, not flagged.
        const seven = countReportsByManager(star('chapter-president-uid', 7));
        expect(spanFlagFor('chapter_president', seven.get('chapter-president-uid') || 0)).toBe(false);

        // 12 members under a team lead: over the band numerically, but a
        // non-supervisory role is never flagged.
        const twelve = countReportsByManager(star('team-lead-uid', 12));
        expect(spanFlagFor('team_lead', twelve.get('team-lead-uid') || 0)).toBe(false);
    });
});
