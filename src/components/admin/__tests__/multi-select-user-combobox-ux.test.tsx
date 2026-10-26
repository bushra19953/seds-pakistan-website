/**
 * UX fix program F2 (audit P3/P8/P11) — MultiSelectUserCombobox.
 *
 * On the base tree every test here fails:
 * - rows were rendered through @tanstack/react-virtual, which paints
 *   nothing until layout is measured (in jsdom: no rows at all), and
 *   the loading state stayed on forever when usersOverride was given;
 * - the trigger's aria-label/text was hard-coded "Select assignees"
 *   for every field, including co-assignees;
 * - the search input had no label, only a placeholder.
 *
 * Flake discipline mirrors picker-email-role-search: mocked firebase,
 * cleanup between tests so Radix portals cannot bleed across tests.
 * Deliberately NO layout mocks (clientHeight/offsetHeight): rows must
 * render without them now that the virtualizer is gone.
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: { getIdToken: async () => 'test-token' } }),
  useFirestore: () => null,
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  doc: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({ docs: [] })),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => ({}) })),
}));

import MultiSelectUserCombobox from '@/components/admin/multi-select-user-combobox';

const users = Array.from({ length: 6 }).map((_, i) => ({
  id: `u${i + 1}`,
  uid: `u${i + 1}`,
  displayName: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
  chapterId: 'ist',
  role: 'member',
}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => cleanup());

describe('MultiSelectUserCombobox UX (F2)', () => {
  it('renders rows on first open without layout measurement', () => {
    render(<MultiSelectUserCombobox value={[]} onChange={jest.fn()} usersOverride={users} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('User 1')).toBeInTheDocument();
    expect(screen.getByText('User 6')).toBeInTheDocument();
  });

  it('a mouse click on a row selects that user', () => {
    const onChange = jest.fn();
    render(<MultiSelectUserCombobox value={[]} onChange={onChange} usersOverride={users} />);
    fireEvent.click(screen.getByRole('combobox'));
    const row = screen.getByText('User 2').closest('[cmdk-item]');
    expect(row).not.toBeNull();
    fireEvent.click(row as Element);
    const calls = onChange.mock.calls.map((c) => c[0]);
    expect(calls.some((ids: string[]) => ids.includes('u2'))).toBe(true);
  });

  it('the trigger takes its label from the label prop', () => {
    render(
      <MultiSelectUserCombobox value={[]} onChange={jest.fn()} usersOverride={users} label="Select co-assignees" />
    );
    expect(screen.getByRole('combobox', { name: 'Select co-assignees' })).toBeInTheDocument();
    expect(screen.getByText('Select co-assignees')).toBeInTheDocument();
  });

  it('the search input has a real label', () => {
    render(<MultiSelectUserCombobox value={[]} onChange={jest.fn()} usersOverride={users} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByLabelText('Search people')).toBeInTheDocument();
  });
});
