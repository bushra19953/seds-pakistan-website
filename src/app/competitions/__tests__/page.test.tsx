/**
 * Tests for the public competitions page (src/app/competitions/page.tsx).
 *
 * Covers the query-stability fix: `competitionsCollection(db)` must be
 * wrapped in `useMemoFirebase` so the collection reference keeps a stable
 * identity across renders. A new reference every render would retrigger the
 * query memo, defeat the useCollection memoization, and cause an infinite
 * refetch loop (loading stuck forever).
 *
 * Also covers the useCollection error path: when the query fails the page
 * must show an error message instead of hanging on the loading row.
 *
 * Mocks: firebase/firestore (query/where/orderBy), @/firebase
 * (useFirestore/useCollection), and @/lib/competitions
 * (competitionsCollection returns a fresh object per call, matching real
 * firestore `collection()` behavior). The real useMemoFirebase is used so
 * the memoization behavior is genuinely exercised.
 *
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { useCollection } from '@/firebase';
import { competitionsCollection } from '@/lib/competitions';
import { query } from 'firebase/firestore';
import PublicCompetitionsPage from '../page';

// Every collection reference created by the (mocked) competitionsCollection
// call, recorded in order. Real firestore collection() returns a new object
// on every call, so the mock does the same.
const queryCols: any[] = [];

jest.mock('firebase/firestore', () => ({
  query: jest.fn((col: any) => {
    queryCols.push(col);
    return { __queryOf: col };
  }),
  where: (...args: any[]) => ({ __where: args }),
  orderBy: (...args: any[]) => ({ __orderBy: args }),
}));

jest.mock('@/firebase', () => {
  // The real useFirestore returns a stable Firestore instance from context,
  // so the mock keeps a single object per test file run.
  const stableDb = { __db: 'fake-db' };
  return {
    useFirestore: () => stableDb,
    useCollection: jest.fn(),
  };
});

jest.mock('@/lib/competitions', () => {
  let n = 0;
  return {
    competitionsCollection: jest.fn(() => ({ __collection: `competitions-${++n}` })),
  };
});

// Shell components are stubbed: the page mounts the site chrome
// (StarryBackground, Footer) around the listing, and neither is under
// test here. StarryBackground also cannot render under this repo's
// classic JSX jest transform (it does not import the React default).
jest.mock('@/components/starry-background', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/layout/footer', () => ({
  __esModule: true,
  default: () => null,
}));

const useCollectionMock = useCollection as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  queryCols.length = 0;
  useCollectionMock.mockReturnValue({ data: [], loading: false, error: null });
});

describe('PublicCompetitionsPage query stability', () => {
  it('calls competitionsCollection once and reuses the same ref on re-render', () => {
    const { rerender } = render(<PublicCompetitionsPage />);
    rerender(<PublicCompetitionsPage />);

    // competitionsCollection(db) is memoized: exactly one call despite two renders.
    expect(competitionsCollection).toHaveBeenCalledTimes(1);
    // The query factory ran once with the memoized ref, not once per render.
    expect(query).toHaveBeenCalledTimes(1);
    expect(queryCols).toHaveLength(1);
    expect(queryCols[0]).toBe((competitionsCollection as jest.Mock).mock.results[0].value);
  });

  it('passes the isPublic filter to the query', () => {
    render(<PublicCompetitionsPage />);

    expect(query).toHaveBeenCalledTimes(1);
    const whereArg = (query as unknown as jest.Mock).mock.calls[0][1];
    expect(whereArg).toEqual({ __where: ['isPublic', '==', true] });
  });
});

describe('PublicCompetitionsPage states', () => {
  it('shows the loading row while the query is loading', () => {
    useCollectionMock.mockReturnValue({ data: null, loading: true, error: null });
    render(<PublicCompetitionsPage />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows an error message when the query fails instead of hanging', () => {
    useCollectionMock.mockReturnValue({
      data: null,
      loading: false,
      error: new Error('permission denied'),
    });
    render(<PublicCompetitionsPage />);

    expect(
      screen.getByText('Could not load competitions. Please try again later.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('prefers the error message over the empty list message', () => {
    useCollectionMock.mockReturnValue({
      data: [],
      loading: false,
      error: new Error('boom'),
    });
    render(<PublicCompetitionsPage />);

    expect(
      screen.getByText('Could not load competitions. Please try again later.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No public competitions.')).not.toBeInTheDocument();
  });

  it('renders competition rows when data loads', () => {
    useCollectionMock.mockReturnValue({
      data: [
        {
          id: 'c1',
          title: 'Rocketry Cup',
          description: 'Build and fly',
          featuredImage: '',
          startDate: '2026-11-01',
          endDate: '2026-11-03',
          isPublic: true,
        },
      ],
      loading: false,
      error: null,
    });
    render(<PublicCompetitionsPage />);

    expect(screen.getByText('Rocketry Cup')).toBeInTheDocument();
    expect(screen.getByText('2026-11-01')).toBeInTheDocument();
    expect(screen.getByText('2026-11-03')).toBeInTheDocument();
  });

  it('shows the empty state when there are no public competitions', () => {
    render(<PublicCompetitionsPage />);

    expect(screen.getByText('No public competitions.')).toBeInTheDocument();
  });
});
