import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { Timestamp } from 'firebase/firestore';
import TimelineSection, {
  groupTimelineEvents,
  TIMELINE_TEASER_LIMIT,
  TIMELINE_MONTH_PAGE_SIZE,
} from '../timeline-section';
import type { TimelineEvent } from '@/types';

// Controllable stand-in for the Firestore-backed collection hook.
const mockCollectionState: { data: TimelineEvent[] | null; loading: boolean } = {
  data: [],
  loading: false,
};

jest.mock('@/firebase/firestore/use-collection', () => ({
  useCollection: () => ({
    data: mockCollectionState.data,
    loading: mockCollectionState.loading,
    error: null,
  }),
}));

jest.mock('@/firebase', () => ({ firestore: {} }));

jest.mock('firebase/firestore', () => ({
  collection: () => ({ withConverter: () => ({}) }),
  query: () => ({}),
  orderBy: () => ({}),
  where: () => ({}),
  limit: () => ({}),
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

beforeEach(() => {
  mockCollectionState.data = [];
  mockCollectionState.loading = false;
});

describe('TimelineSection teaser variant', () => {
  it('never renders more than the teaser limit, keeping the newest entries in chronological order', () => {
    // Wire order for the teaser query is position-descending (newest
    // first); the component reverses it back to chronological order.
    mockCollectionState.data = Array.from({ length: 10 }, (_, i) =>
      makeEvent(i + 1, `2026-01-${String(i + 1).padStart(2, '0')}`)
    ).reverse();

    render(<TimelineSection variant="teaser" />);

    const cards = screen.getAllByTestId('timeline-card');
    expect(cards).toHaveLength(TIMELINE_TEASER_LIMIT);
    // Newest 6 of 10: events 5..10, still oldest-first.
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining('Event 5'),
      expect.stringContaining('Event 6'),
      expect.stringContaining('Event 7'),
      expect.stringContaining('Event 8'),
      expect.stringContaining('Event 9'),
      expect.stringContaining('Event 10'),
    ]);
    expect(screen.queryByText('Event 4')).not.toBeInTheDocument();
    expect(screen.queryByText('Event 1')).not.toBeInTheDocument();
  });

  it('filters unpublished entries before applying the teaser cap', () => {
    // Descending wire order, as the bounded teaser query delivers it;
    // the client-side published filter still applies on arrival.
    mockCollectionState.data = Array.from({ length: 10 }, (_, i) =>
      makeEvent(i + 1, `2026-02-${String(i + 1).padStart(2, '0')}`, {
        isPublished: i + 1 <= 7,
      })
    ).reverse();

    render(<TimelineSection variant="teaser" />);

    // 7 published (events 1..7) -> newest 6 are events 2..7.
    expect(screen.getAllByTestId('timeline-card')).toHaveLength(6);
    expect(screen.getByText('Event 7')).toBeInTheDocument();
    expect(screen.queryByText('Event 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Event 8')).not.toBeInTheDocument();
  });

  it('shows a View the full timeline link to /timeline when more entries exist', () => {
    mockCollectionState.data = Array.from({ length: 9 }, (_, i) =>
      makeEvent(i + 1, `2026-03-${String(i + 1).padStart(2, '0')}`)
    ).reverse();

    render(<TimelineSection variant="teaser" />);

    const cta = screen.getByRole('link', { name: /view the full timeline/i });
    expect(cta).toHaveAttribute('href', '/timeline');
  });
});

describe('TimelineSection full variant', () => {
  const groupedData = () => [
    makeEvent(1, '2025-11-06'),
    makeEvent(2, '2026-08-09'),
    makeEvent(3, '2026-08-10'),
    makeEvent(4, '2026-10-02'),
    makeEvent(5, '2026-10-04'),
    makeEvent(6, '2026-10-25'),
  ];

  it('groups by year and month, expanding only the most recent month by default', () => {
    mockCollectionState.data = groupedData();

    render(<TimelineSection />);

    // Year headings, chronological.
    expect(screen.getAllByTestId('timeline-year').map((el) => el.textContent)).toEqual(['2025', '2026']);

    const novHeader = screen.getByTestId('timeline-month-header-2025-11');
    const augHeader = screen.getByTestId('timeline-month-header-2026-08');
    const octHeader = screen.getByTestId('timeline-month-header-2026-10');
    expect(novHeader.textContent).toContain('November 2025');
    expect(novHeader.textContent).toContain('1 entry');
    expect(augHeader.textContent).toContain('August 2026');
    expect(augHeader.textContent).toContain('2 entries');
    expect(octHeader.textContent).toContain('October 2026');
    expect(octHeader.textContent).toContain('3 entries');

    // Only the most recent month (October 2026) renders cards.
    expect(octHeader).toHaveAttribute('aria-expanded', 'true');
    expect(augHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByTestId('timeline-card')).toHaveLength(3);
    expect(screen.getByText('Event 4')).toBeInTheDocument();
    expect(screen.getByText('Event 6')).toBeInTheDocument();
    expect(screen.queryByText('Event 2')).not.toBeInTheDocument();
    expect(screen.queryByText('Event 1')).not.toBeInTheDocument();
  });

  it('toggles month sections open and closed from their headers', () => {
    mockCollectionState.data = groupedData();

    render(<TimelineSection variant="full" />);

    fireEvent.click(screen.getByTestId('timeline-month-header-2026-08'));
    expect(screen.getByText('Event 2')).toBeInTheDocument();
    expect(screen.getByText('Event 3')).toBeInTheDocument();
    expect(screen.getAllByTestId('timeline-card')).toHaveLength(5);

    fireEvent.click(screen.getByTestId('timeline-month-header-2026-10'));
    expect(screen.queryByText('Event 4')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('timeline-card')).toHaveLength(2);
  });

  it('caps an expanded month at the page size and reveals the rest via Show more', () => {
    mockCollectionState.data = Array.from({ length: 18 }, (_, i) =>
      makeEvent(i + 1, '2026-10-05')
    );

    render(<TimelineSection variant="full" />);

    // October 2026 is the most recent (only) month, so it starts expanded.
    expect(screen.getAllByTestId('timeline-card')).toHaveLength(TIMELINE_MONTH_PAGE_SIZE);
    const showMore = screen.getByTestId('timeline-show-more-2026-10');
    expect(showMore.textContent).toContain('3 more');

    fireEvent.click(showMore);
    expect(screen.getAllByTestId('timeline-card')).toHaveLength(18);
    expect(screen.queryByTestId('timeline-show-more-2026-10')).not.toBeInTheDocument();
    expect(screen.getByText('Event 18')).toBeInTheDocument();
  });
});

describe('groupTimelineEvents', () => {
  it('produces chronological year/month groups preserving input order inside a month', () => {
    const groups = groupTimelineEvents(groupedFixture());

    expect(groups.map((g) => g.year)).toEqual([2025, 2026]);
    expect(groups[0].months.map((m) => m.key)).toEqual(['2025-11']);
    expect(groups[1].months.map((m) => m.key)).toEqual(['2026-08', '2026-10']);
    expect(groups[1].months[1].label).toBe('October 2026');
    expect(groups[1].months[1].events.map((e) => e.title)).toEqual(['Event 4', 'Event 5', 'Event 6']);
  });
});

function groupedFixture() {
  return [
    makeEvent(1, '2025-11-06'),
    makeEvent(2, '2026-08-09'),
    makeEvent(3, '2026-08-10'),
    makeEvent(4, '2026-10-02'),
    makeEvent(5, '2026-10-04'),
    makeEvent(6, '2026-10-25'),
  ];
}
