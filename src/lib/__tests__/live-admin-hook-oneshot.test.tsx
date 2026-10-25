/**
 * Hook-level contract for the live-admin one-shot conversions
 * (Supabase migration, listeners Class D).
 *
 * Every B-item in the pack converts by flipping the listen option the
 * page passes to useCollection/useDoc. This suite pins what that flip
 * means at the firebase module boundary:
 * - listen true: onSnapshot subscribes, no one-shot fetch runs.
 * - listen false: no subscription is created, getDocs/getDoc runs
 *   exactly once on mount, and the data handed to the consumer is
 *   shape-identical to the listener path for the same documents.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { useCollection } from '@/firebase/firestore/use-collection';
import { useDoc } from '@/firebase/firestore/use-doc';

const DOCS = [
  { id: 'd1', data: () => ({ title: 'Alpha', rank: 1 }) },
  { id: 'd2', data: () => ({ title: 'Beta', rank: 2 }) },
];
const SNAPSHOT = { docs: DOCS, size: DOCS.length };

const mockState: {
  onSnapshotCallback: ((snap: any) => void) | null;
  unsubscribe: jest.Mock;
} = { onSnapshotCallback: null, unsubscribe: jest.fn() };

const mockOnSnapshot = jest.fn((_target: any, cb: any, _errCb: any) => {
  mockState.onSnapshotCallback = cb;
  return mockState.unsubscribe;
});
const mockGetDocs = jest.fn((_q: any) => Promise.resolve(SNAPSHOT));
const mockGetDoc = jest.fn((_ref: any) =>
  Promise.resolve({
    exists: () => true,
    id: 'contact',
    data: () => ({ title: 'Contact Us', subtitle: 'Reach out' }),
  }),
);

jest.mock('firebase/firestore', () => ({
  onSnapshot: (target: any, cb: any, errCb: any) => mockOnSnapshot(target, cb, errCb),
  getDocs: (q: any) => mockGetDocs(q),
  getDoc: (ref: any) => mockGetDoc(ref),
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  startAfter: jest.fn(() => ({})),
  endBefore: jest.fn(() => ({})),
  limitToLast: jest.fn(() => ({})),
}));

const FAKE_QUERY = { __q: 'fake' } as any;
const FAKE_DOC_REF = { id: 'contact', path: 'pages/contact' } as any;

function CollectionHarness({ listen }: { listen: boolean }) {
  const { data } = useCollection(FAKE_QUERY, { listen });
  return (
    <ul>
      {(data || []).map((d: any) => (
        <li key={d.id}>{`${d.id}:${d.title}:${d.rank}`}</li>
      ))}
    </ul>
  );
}

function DocHarness({ listen }: { listen: boolean }) {
  const { data } = useDoc(FAKE_DOC_REF, { listen });
  return <p>{data ? `${data.id}:${(data as any).title}:${(data as any).subtitle}` : 'none'}</p>;
}

beforeEach(() => {
  mockOnSnapshot.mockClear();
  mockGetDocs.mockClear();
  mockGetDoc.mockClear();
  mockState.onSnapshotCallback = null;
  mockState.unsubscribe.mockClear();
});

describe('useCollection listen flip', () => {
  it('listen true subscribes with onSnapshot and never calls getDocs', async () => {
    render(<CollectionHarness listen />);
    await act(async () => {});
    expect(mockOnSnapshot).toHaveBeenCalledTimes(1);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('listen false creates no subscription and calls getDocs exactly once on mount', async () => {
    render(<CollectionHarness listen={false} />);
    await act(async () => {});
    expect(mockOnSnapshot).not.toHaveBeenCalled();
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('d1:Alpha:1')).toBeInTheDocument();
  });

  it('hands shape-identical data to render on both paths', async () => {
    const off = render(<CollectionHarness listen />);
    await act(async () => {});
    await act(async () => {
      mockState.onSnapshotCallback!(SNAPSHOT);
    });
    const offItems = Array.from(off.container.querySelectorAll('li')).map((li) => li.textContent);
    expect(offItems).toEqual(['d1:Alpha:1', 'd2:Beta:2']);
    off.unmount();

    mockOnSnapshot.mockClear();
    mockGetDocs.mockClear();
    const on = render(<CollectionHarness listen={false} />);
    await act(async () => {});
    const onItems = Array.from(on.container.querySelectorAll('li')).map((li) => li.textContent);
    expect(onItems).toEqual(offItems);
  });
});

describe('useDoc listen flip', () => {
  it('listen true subscribes with onSnapshot and never calls getDoc', async () => {
    render(<DocHarness listen />);
    await act(async () => {});
    expect(mockOnSnapshot).toHaveBeenCalledTimes(1);
    expect(mockGetDoc).not.toHaveBeenCalled();
  });

  it('listen false creates no subscription and calls getDoc exactly once, with the same shape', async () => {
    const off = render(<DocHarness listen />);
    await act(async () => {});
    await act(async () => {
      mockState.onSnapshotCallback!({
        exists: () => true,
        id: 'contact',
        data: () => ({ title: 'Contact Us', subtitle: 'Reach out' }),
      });
    });
    expect(off.container.querySelector('p')?.textContent).toBe('contact:Contact Us:Reach out');
    off.unmount();

    mockOnSnapshot.mockClear();
    const on = render(<DocHarness listen={false} />);
    await act(async () => {});
    expect(mockOnSnapshot).not.toHaveBeenCalled();
    expect(mockGetDoc).toHaveBeenCalledTimes(1);
    expect(on.container.querySelector('p')?.textContent).toBe('contact:Contact Us:Reach out');
  });
});
