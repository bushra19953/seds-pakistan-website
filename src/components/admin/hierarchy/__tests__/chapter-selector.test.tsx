/**
 * Tests for ChapterSelector (src/components/admin/hierarchy/chapter-selector.tsx).
 *
 * Covers the Issue 1 fix from the hierarchy design plan:
 * - Selection keys on the chapter ID (the cmdk value), never on the display
 *   label, so a click can never die silently in a label find-back.
 * - Two chapters sharing one display name select their own IDs.
 * - Search still filters by chapter name.
 * - The chapters query is subscribed with { listen: true } so a transient
 *   permission-denied cannot leave the list empty for the whole session.
 *
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ChapterSelector } from '../chapter-selector';

// Mutable holder for the mocked chapters result and every options object the
// component passes to useCollection, in call order.
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
  { id: 'twin-a', name: 'Twin Chapter' },
  { id: 'twin-b', name: 'Twin Chapter' },
];

beforeAll(() => {
  // Shims Radix Popover and cmdk expect from a real browser.
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
});

async function openSelector(onChange: jest.Mock) {
  render(<ChapterSelector value="" onChange={onChange} />);
  fireEvent.click(screen.getByRole('combobox'));
  // The synthetic All Chapters entry is present from first render.
  return screen.findByText('All Chapters (Entire Organization)');
}

describe('ChapterSelector', () => {
  it('subscribes to the chapters collection with listen true', async () => {
    const onChange = jest.fn();
    render(<ChapterSelector value="" onChange={onChange} />);

    expect(mockChaptersState.optionsSeen.length).toBeGreaterThan(0);
    expect(mockChaptersState.optionsSeen[0]).toEqual({ listen: true });
  });

  it('calls onChange with the chapter ID, not the label, when an item is selected', async () => {
    const onChange = jest.fn();
    await openSelector(onChange);

    fireEvent.click(await screen.findByText('IST Chapter'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('ist-001');
    expect(onChange).not.toHaveBeenCalledWith('IST Chapter');
  });

  it('selects the correct ID when two chapters share the same name', async () => {
    const onChange = jest.fn();
    await openSelector(onChange);

    const twins = await screen.findAllByText('Twin Chapter');
    expect(twins).toHaveLength(2);
    fireEvent.click(twins[1]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('twin-b');
  });

  it('filters chapters by name when typing in the search field', async () => {
    const onChange = jest.fn();
    await openSelector(onChange);

    const input = screen.getByPlaceholderText('Search chapter...');
    fireEvent.change(input, { target: { value: 'lahore' } });

    await screen.findByText('Lahore Chapter');
    await waitFor(() => {
      expect(screen.queryByText('IST Chapter')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Lahore Chapter'));
    expect(onChange).toHaveBeenCalledWith('lhr-002');
  });
});
