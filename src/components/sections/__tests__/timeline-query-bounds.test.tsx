/**
 * Read-bleed bounds for TimelineSection (F1).
 *
 * Pins the Firestore query shape per variant and the display
 * equivalence of the bounded teaser query:
 *
 * - T1 teaser query: where(isPublished == true) + orderBy(position desc)
 *   + limit(TIMELINE_TEASER_LIMIT) — the 38-read whole-collection fetch
 *   becomes exactly the displayed set.
 * - T2 full query: orderBy(position asc) + limit(TIMELINE_FULL_LIMIT),
 *   no published where (the full page keeps its client-side filter).
 * - T3 the default variant (no prop, as mounted by /timeline) is full.
 * - T4 timelineQuerySpec returns exactly those shapes.
 * - T5 buildTimelineQuery composes the spec into query constraints.
 * - T6 teaser display equivalence: descending wire data (the newest 6
 *   published) renders the same cards in the same order as the old
 *   filter-published-then-slice(-6) over the ascending full set.
 * - T7 unpublished newest entries do not displace older published ones.
 * - T8 full variant does not reorder: ascending groups render in input
 *   order.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { Timestamp } from 'firebase/firestore';
import TimelineSection, {
  buildTimelineQuery,
  timelineQuerySpec,
  TIMELINE_FULL_LIMIT,
  TIMELINE_TEASER_LIMIT,
} from '../timeline-section';
import type { TimelineEvent } from '@/types';

// Controllable stand-in for the Firestore-backed collection hook; also
// records the query object the component hands it.
const mockCollectionState: { data: TimelineEvent[] | null; loading: boolean } = {
  data: [],
  loading: false,
};
const mockSeenQueries: unknown[] = [];

jest.mock('@/firebase/firestore/use-collection', () => ({
  useCollection: (q: unknown) => {
    mockSeenQueries.push(q);
    return {
      data: mockCollectionState.data,
      loading: mockCollectionState.loading,
      error: null,
    };
  },
}));

jest.mock('@/firebase', () => ({ firestore: {} }));

// Constraint factories return tagged shapes so the composed query can
// be asserted exactly.
jest.mock('firebase/firestore', () => ({
  collection: () => ({ withConverter: () => ({ collection: 'timeline' }) }),
  query: (_ref: unknown, ...constraints: unknown[]) => ({ constraints }),
  orderBy: (field: string, direction: string) => ({ kind: 'orderBy', field, direction }),
  where: (field: string, op: string, value: unknown) => ({ kind: 'where', field, op, value }),
  limit: (count: number) => ({ kind: 'limit', count }),
}));

function makeEvent(n: number, isoDate: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `event-${n}`,
    title: `Event ${n}`,
    description: `Description ${n}`,
    icon: 'Rocket',
    date: { toDate: () => new Date(isoDate) } as unknown as Timestamp,
    isPublished: true,
    position: n * 10,
    ...overrides,
  };
}

/** Events 1..count ascending (oldest first), dates in January 2026. */
function ascendingSet(count: number, overrides: (n: number) => Partial<TimelineEvent> = () => ({})) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return makeEvent(n, `2026-01-${String(n).padStart(2, '0')}`, overrides(n));
  });
}

/**
 * What the bounded teaser query returns for a full set: published only,
 * newest first, capped at the teaser limit.
 */
function teaserWireData(fullAscending: TimelineEvent[]) {
  return fullAscending
    .filter((e) => e.isPublished !== false)
    .slice(-TIMELINE_TEASER_LIMIT)
    .reverse();
}

/** The pre-fix display algorithm: filter published, take the tail. */
function legacyTeaserTitles(fullAscending: TimelineEvent[]) {
  return fullAscending
    .filter((e) => e.isPublished !== false)
    .slice(-TIMELINE_TEASER_LIMIT)
    .map((e) => e.title);
}

function lastQuery() {
  return mockSeenQueries[mockSeenQueries.length - 1] as { constraints: unknown[] };
}

beforeEach(() => {
  mockCollectionState.data = [];
  mockCollectionState.loading = false;
  mockSeenQueries.length = 0;
});

describe('timeline read bounds', () => {
  it('T1: teaser mounts with published + position desc + limit 6', () => {
    render(<TimelineSection variant="teaser" />);
    expect(lastQuery().constraints).toEqual([
      { kind: 'where', field: 'isPublished', op: '==', value: true },
      { kind: 'orderBy', field: 'position', direction: 'desc' },
      { kind: 'limit', count: TIMELINE_TEASER_LIMIT },
    ]);
    expect(TIMELINE_TEASER_LIMIT).toBe(6);
  });

  it('T2: full mounts with position asc + limit 200 and no published where', () => {
    render(<TimelineSection variant="full" />);
    expect(lastQuery().constraints).toEqual([
      { kind: 'orderBy', field: 'position', direction: 'asc' },
      { kind: 'limit', count: TIMELINE_FULL_LIMIT },
    ]);
    expect(TIMELINE_FULL_LIMIT).toBe(200);
  });

  it('T3: default variant is the full query shape', () => {
    render(<TimelineSection />);
    expect(lastQuery().constraints).toEqual([
      { kind: 'orderBy', field: 'position', direction: 'asc' },
      { kind: 'limit', count: 200 },
    ]);
  });

  it('T4: timelineQuerySpec pins both specs', () => {
    expect(timelineQuerySpec('teaser')).toEqual({
      publishedOnly: true,
      positionDirection: 'desc',
      limitCount: 6,
    });
    expect(timelineQuerySpec('full')).toEqual({
      publishedOnly: false,
      positionDirection: 'asc',
      limitCount: 200,
    });
  });

  it('T5: buildTimelineQuery composes the spec into constraints', () => {
    const ref = { collection: 'timeline' } as never;
    expect(buildTimelineQuery(ref, 'teaser')).toEqual({
      constraints: [
        { kind: 'where', field: 'isPublished', op: '==', value: true },
        { kind: 'orderBy', field: 'position', direction: 'desc' },
        { kind: 'limit', count: 6 },
      ],
    });
    expect(buildTimelineQuery(ref, 'full')).toEqual({
      constraints: [
        { kind: 'orderBy', field: 'position', direction: 'asc' },
        { kind: 'limit', count: 200 },
      ],
    });
  });

  it('T6: teaser renders the legacy filter-then-slice set, in the same order', () => {
    const full = ascendingSet(10);
    mockCollectionState.data = teaserWireData(full);

    render(<TimelineSection variant="teaser" />);

    const cards = screen.getAllByTestId('timeline-card');
    expect(cards).toHaveLength(TIMELINE_TEASER_LIMIT);
    expect(cards.map((c) => c.textContent)).toEqual(
      legacyTeaserTitles(full).map((title) => expect.stringContaining(title)),
    );
  });

  it('T7: unpublished newest entries do not displace older published ones', () => {
    // Events 8..10 are drafts; the published set is 1..7, so the teaser
    // must show 2..7 — exactly what the legacy algorithm produced.
    const full = ascendingSet(10, (n) => ({ isPublished: n <= 7 }));
    mockCollectionState.data = teaserWireData(full);

    render(<TimelineSection variant="teaser" />);

    const cards = screen.getAllByTestId('timeline-card');
    expect(cards.map((c) => c.textContent)).toEqual(
      legacyTeaserTitles(full).map((title) => expect.stringContaining(title)),
    );
    expect(screen.queryByText('Event 8')).not.toBeInTheDocument();
    expect(screen.queryByText('Event 1')).not.toBeInTheDocument();
  });

  it('T8: full variant keeps ascending input order inside a month', () => {
    mockCollectionState.data = [
      makeEvent(4, '2026-10-02'),
      makeEvent(5, '2026-10-04'),
      makeEvent(6, '2026-10-25'),
    ];

    render(<TimelineSection variant="full" />);

    const cards = screen.getAllByTestId('timeline-card');
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining('Event 4'),
      expect.stringContaining('Event 5'),
      expect.stringContaining('Event 6'),
    ]);
  });
});
