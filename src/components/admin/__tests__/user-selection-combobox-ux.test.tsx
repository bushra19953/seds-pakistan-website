/**
 * UX fix program F2 (audit P8 filter trap) — UserSelectionCombobox.
 *
 * On the base tree the role-trap test fails: when a step's role text
 * matched nobody, the picker showed an unexplained empty list. The
 * fixed component names the problem inline and points at the way out.
 * The row-click test pins the onClick fallback added beside cmdk's
 * onSelect (audit P3).
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockUser = { getIdToken: async () => 'test-token' };

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: mockUser }),
  useFirestore: () => null,
}));

import UserSelectionCombobox from '@/components/admin/user-selection-combobox';

const PICKER_ROWS = [
  { uid: 'px-ahmed-1', displayName: 'Ahmed Khan', email: 'ahmed.one@sedsmail.example', chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: [], isOnVacation: false },
  { uid: 'px-zara', displayName: 'Zara Sheikh', email: 'zara@sedsmail.example', chapterId: 'seds-ist-chapter', role: 'president_chapter', additionalRoles: [], isOnVacation: false },
];

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
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ users: PICKER_ROWS }),
  })) as any;
});

afterEach(() => cleanup());

describe('UserSelectionCombobox UX (F2)', () => {
  it('warns inline when the preferred role is held by nobody', async () => {
    render(
      <UserSelectionCombobox
        onSelect={jest.fn()}
        preferredRole="poster_team_lead"
        preferredRoleLabel="Poster Team Lead"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Select a user/ }));
    expect(await screen.findByText(/No one in this list holds the role/)).toBeInTheDocument();
  });

  it('does not warn when someone holds the preferred role', async () => {
    render(<UserSelectionCombobox onSelect={jest.fn()} preferredRole="member" />);
    fireEvent.click(screen.getByRole('button', { name: /Select a user/ }));
    expect(await screen.findByText('Ahmed Khan')).toBeInTheDocument();
    expect(screen.queryByText(/No one in this list holds the role/)).not.toBeInTheDocument();
  });

  it('a mouse click on a row selects the user', async () => {
    const onSelect = jest.fn();
    render(<UserSelectionCombobox onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Select a user/ }));
    const row = await screen.findByText('Zara Sheikh');
    fireEvent.click(row);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('px-zara'));
  });
});
