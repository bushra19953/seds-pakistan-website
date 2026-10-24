/**
 * Header duplicate-instance gating (read-burn fix, 2026-10-24 audit R3).
 *
 * The header mounts two NotificationCenter instances, one per
 * breakpoint; CSS hides one without unmounting it. Before the fix both
 * instances subscribed to personal notifications and both re-fetched
 * announcements every 60 seconds. These tests mount the pair the way
 * the header does (exactly one active) and prove only the active
 * instance fetches: on mount, and again on the polling cadence.
 *
 * A signed-in non-officer viewer resolves to 3 audience values
 * (public, all, members), so one announcements fetch round is exactly
 * 3 getDocs calls.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { NotificationCenter } from '@/components/notifications/notification-center';
import { MIN_POLL_INTERVAL_MS } from '@/hooks/use-polling-refresh';

const mockGetDocs = jest.fn((_query: unknown) => Promise.resolve({ docs: [] as any[] }));
const mockUseCollection = jest.fn((_query: unknown) => ({
  data: [] as any[],
  loading: false,
  error: null,
}));
// Stable identities, like the real hooks: the component's fetch effect
// depends on the db object, so a fresh object per render would re-fire
// the effect after every render.
const mockDb = {};
const mockUser = { uid: 'user-1' };

jest.mock('@/firebase', () => ({
  useFirestore: () => mockDb,
  useUser: () => ({ user: mockUser, role: 'member_basic' }),
  useCollection: (query: unknown) => mockUseCollection(query),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({ withConverter: () => ({}) })),
  doc: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  onSnapshot: jest.fn(() => () => {}),
  getDocs: (query: unknown) => mockGetDocs(query),
  Timestamp: {
    fromDate: jest.fn(() => ({})),
    now: jest.fn(() => ({})),
  },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/push-notifications', () => ({
  getNotificationPermission: () => 'denied',
  requestPushPermission: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  updateDoc: jest.fn(() => Promise.resolve()),
}));

const QUERIES_PER_FETCH_ROUND = 3;

beforeEach(() => {
  jest.useFakeTimers();
  mockGetDocs.mockClear();
  mockUseCollection.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('NotificationCenter active gating (header pair)', () => {
  it('only the active instance fetches announcements on mount', async () => {
    render(
      <>
        <NotificationCenter active />
        <NotificationCenter active={false} />
      </>,
    );
    await act(async () => {});

    expect(mockGetDocs).toHaveBeenCalledTimes(QUERIES_PER_FETCH_ROUND);
  });

  it('a lone active instance subscribes with a live personal query', async () => {
    render(<NotificationCenter active />);
    await act(async () => {});

    expect(mockUseCollection).toHaveBeenCalled();
    for (const [q] of mockUseCollection.mock.calls) {
      expect(q).not.toBeNull();
      expect(q).not.toBeUndefined();
    }
  });

  it('only the active instance re-fetches on the polling cadence', async () => {
    render(
      <>
        <NotificationCenter active />
        <NotificationCenter active={false} />
      </>,
    );
    await act(async () => {});
    expect(mockGetDocs).toHaveBeenCalledTimes(QUERIES_PER_FETCH_ROUND);

    await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS); });

    // One more round from the active instance only: 6 total, not 12.
    expect(mockGetDocs).toHaveBeenCalledTimes(2 * QUERIES_PER_FETCH_ROUND);
  });

  it('a lone inactive instance fetches nothing and subscribes to nothing', async () => {
    render(<NotificationCenter active={false} />);
    await act(async () => {});
    await act(async () => { jest.advanceTimersByTime(2 * MIN_POLL_INTERVAL_MS); });

    expect(mockGetDocs).not.toHaveBeenCalled();
    expect(mockUseCollection).toHaveBeenCalled();
    for (const [q] of mockUseCollection.mock.calls) {
      expect(q ?? null).toBeNull();
    }
  });
});
