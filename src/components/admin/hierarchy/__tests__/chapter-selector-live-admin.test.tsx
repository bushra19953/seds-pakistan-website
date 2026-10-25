/**
 * Contract tests for ChapterSelector (B9) under the live-admin surface
 * flag (Supabase migration, listeners Class D).
 *
 * Flag OFF: the chapters query is passed { listen: true }, exactly as
 * the pre-existing chapter-selector suite pins. Flag ON: it is passed
 * { listen: false } (one-shot, no subscription at hook level), and the
 * chapter list handed to render is shape-identical.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ChapterSelector } from '../chapter-selector';

const mockChaptersState: { data: any[] | null; optionsSeen: any[] } = {
  data: [],
  optionsSeen: [],
};

jest.mock('@/firebase/firestore/use-collection', () => ({
  useCollection: jest.fn((_query: any, options?: any) => {
    mockChaptersState.optionsSeen.push(options);
    return { data: mockChaptersState.data, loading: false, error: null };
  }),
}));

jest.mock('@/firebase', () => {
  const stableDb = { __db: 'fake-db' };
  return {
    useFirestore: () => stableDb,
  };
});

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({ __collection: true })),
  query: jest.fn(() => ({ __query: true })),
  where: jest.fn((...args: any[]) => ({ __where: args })),
}));

const CHAPTER_DOCS = [
  { id: 'ist-001', name: 'IST Chapter' },
  { id: 'lhr-002', name: 'Lahore Chapter' },
];

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_SUPA_SURFACES;

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  Element.prototype.scrollIntoView = jest.fn();
  (Element.prototype as any).hasPointerCapture = jest.fn(() => false);
  (Element.prototype as any).setPointerCapture = jest.fn();
  (Element.prototype as any).releasePointerCapture = jest.fn();
});

beforeEach(() => {
  mockChaptersState.data = CHAPTER_DOCS;
  mockChaptersState.optionsSeen = [];
  delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  else process.env.NEXT_PUBLIC_SUPA_SURFACES = ORIGINAL_ENV;
});

async function openAndListLabels() {
  const view = render(<ChapterSelector value="" onChange={jest.fn()} />);
  fireEvent.click(screen.getByRole('combobox'));
  await screen.findByText('All Chapters (Entire Organization)');
  const labels = ['All Chapters (Entire Organization)', 'IST Chapter', 'Lahore Chapter'].filter(
    (label) => screen.queryByText(label) !== null,
  );
  view.unmount();
  return labels;
}

describe('ChapterSelector live-admin conversion', () => {
  it('flag OFF passes listen true to useCollection', () => {
    render(<ChapterSelector value="" onChange={jest.fn()} />);
    expect(mockChaptersState.optionsSeen.length).toBeGreaterThan(0);
    expect(mockChaptersState.optionsSeen[0]).toEqual({ listen: true });
  });

  it('flag ON passes listen false to useCollection', () => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
    render(<ChapterSelector value="" onChange={jest.fn()} />);
    expect(mockChaptersState.optionsSeen.length).toBeGreaterThan(0);
    expect(mockChaptersState.optionsSeen[0]).toEqual({ listen: false });
  });

  it('renders the same chapter list on both paths', async () => {
    const offLabels = await openAndListLabels();
    expect(offLabels).toEqual([
      'All Chapters (Entire Organization)',
      'IST Chapter',
      'Lahore Chapter',
    ]);

    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
    const onLabels = await openAndListLabels();
    expect(onLabels).toEqual(offLabels);
  });
});
