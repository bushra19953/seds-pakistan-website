/**
 * Picker email + role search (Zubair requirement, 2026-10-26; audit
 * TS-P30): the task-flow people pickers showed only a name, so two
 * people sharing a name were indistinguishable and email search found
 * nobody.
 *
 * Both comboboxes are fed by GET /api/users/picker (fetch mocked with
 * the post-fix privileged payload: rows carry email + role). On the
 * unmodified components these tests fail: both comboboxes hard-code
 * email: "" when mapping the payload (so email search and email
 * display are dead) and neither search matches role.
 *
 * Flake discipline mirrors user-selection-combobox-custom-roles: one
 * stable mock user object, unique fixture values, and cleanup between
 * tests so Radix portals cannot bleed across tests.
 */

import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockUser = { getIdToken: async () => 'test-token' };

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: mockUser }),
  useFirestore: () => null,
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  doc: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({ docs: [] })),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => ({}) })),
}));

import MultiSelectUserCombobox from '@/components/admin/multi-select-user-combobox';
import UserSelectionCombobox from '@/components/admin/user-selection-combobox';

// Two "Ahmed Khan"s on purpose: telling them apart is the requirement.
const PICKER_ROWS = [
  { uid: 'px-ahmed-1', displayName: 'Ahmed Khan', email: 'ahmed.one@sedsmail.example', photoURL: null, chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: [], isOnVacation: false },
  { uid: 'px-ahmed-2', displayName: 'Ahmed Khan', email: 'ahmed.two@sedsmail.example', photoURL: null, chapterId: 'seds-ist-chapter', role: 'chapter_events_chair', additionalRoles: [], isOnVacation: false },
  { uid: 'px-bilal', displayName: 'Bilal Ahmed', email: 'bilal@sedsmail.example', photoURL: null, chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: ['custom_poster_team_lead'], isOnVacation: false },
  { uid: 'px-zara', displayName: 'Zara Sheikh', email: 'zara@sedsmail.example', photoURL: null, chapterId: 'seds-ist-chapter', role: 'president_chapter', additionalRoles: [], isOnVacation: false },
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
  // jsdom has no layout; the multi-select's virtualized list needs a
  // viewport or it renders no rows at all.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 600; } });
});

beforeEach(() => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ users: PICKER_ROWS }),
  })) as any;
});

afterEach(async () => {
  cleanup();
  await act(async () => {});
});

function searchInput(): HTMLInputElement {
  const el = document.querySelector('[cmdk-input]');
  expect(el).not.toBeNull();
  return el as HTMLInputElement;
}

function itemRoot(el: HTMLElement): HTMLElement {
  return (el.closest('[cmdk-item]') as HTMLElement) || (el.parentElement as HTMLElement);
}

async function openMultiSelect(onChange: jest.Mock) {
  render(<MultiSelectUserCombobox value={[]} onChange={onChange} />);
  fireEvent.click(screen.getByRole('combobox'));
  // Canary: the second Ahmed's email proves fetch + mapping settled.
  return screen.findByText(/ahmed\.two@sedsmail\.example/, {}, { timeout: 3000 });
}

async function openUserSelection(onSelect: jest.Mock) {
  const { container } = render(<UserSelectionCombobox onSelect={onSelect} />);
  const trigger = container.querySelector('button');
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger as HTMLButtonElement);
  return screen.findByText(/ahmed\.two@sedsmail\.example/, {}, { timeout: 3000 });
}

describe('MultiSelectUserCombobox (assignee / co-assignee picker)', () => {
  it('MS-1: rows show name + email + role, so same-name people are distinguishable', async () => {
    await openMultiSelect(jest.fn());
    expect(screen.getByText(/ahmed\.one@sedsmail\.example/)).toBeInTheDocument();
    expect(screen.getByText(/ahmed\.two@sedsmail\.example/)).toBeInTheDocument();
    expect(screen.getAllByText('Ahmed Khan').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Chapter Events Chair/)).toBeInTheDocument();
    expect(screen.getByText(/Chapter President/)).toBeInTheDocument();
  });

  it('MS-2: typing an email finds exactly that person and selection stores their uid', async () => {
    const onChange = jest.fn();
    await openMultiSelect(onChange);
    fireEvent.change(searchInput(), { target: { value: 'ahmed.two@' } });
    await screen.findByRole('button', { name: /Select all filtered \(1\)/ }, { timeout: 3000 });
    expect(screen.queryByText(/ahmed\.one@sedsmail\.example/)).toBeNull();
    const row = itemRoot(screen.getByText(/ahmed\.two@sedsmail\.example/));
    fireEvent.click(within(row).getByRole('checkbox'));
    await waitFor(() => {
      const calls = onChange.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1][0]).toEqual(['px-ahmed-2']);
    });
  });

  it('MS-3: typing a role finds its holders (primary role)', async () => {
    await openMultiSelect(jest.fn());
    fireEvent.change(searchInput(), { target: { value: 'president' } });
    await screen.findByRole('button', { name: /Select all filtered \(1\)/ }, { timeout: 3000 });
    expect(screen.getByText(/zara@sedsmail\.example/)).toBeInTheDocument();
    expect(screen.queryByText(/ahmed\.one@sedsmail\.example/)).toBeNull();
  });

  it('MS-4: typing a role finds holders via additionalRoles too', async () => {
    await openMultiSelect(jest.fn());
    fireEvent.change(searchInput(), { target: { value: 'poster' } });
    await screen.findByRole('button', { name: /Select all filtered \(1\)/ }, { timeout: 3000 });
    expect(screen.getByText(/bilal@sedsmail\.example/)).toBeInTheDocument();
  });

  it('MS-5: name search still works and the payload is still uids', async () => {
    const onChange = jest.fn();
    await openMultiSelect(onChange);
    fireEvent.change(searchInput(), { target: { value: 'Zara' } });
    await screen.findByRole('button', { name: /Select all filtered \(1\)/ }, { timeout: 3000 });
    const row = itemRoot(screen.getByText(/zara@sedsmail\.example/));
    fireEvent.click(within(row).getByRole('checkbox'));
    await waitFor(() => {
      const calls = onChange.mock.calls;
      expect(calls[calls.length - 1][0]).toEqual(['px-zara']);
    });
  });
});

describe('UserSelectionCombobox (reviewer / step primary picker)', () => {
  it('US-1: rows show name + email + role for every candidate', async () => {
    await openUserSelection(jest.fn());
    expect(screen.getByText(/ahmed\.one@sedsmail\.example/)).toBeInTheDocument();
    expect(screen.getByText(/ahmed\.two@sedsmail\.example/)).toBeInTheDocument();
    expect(screen.getByText(/Chapter Events Chair/)).toBeInTheDocument();
    expect(screen.getByText(/Chapter President/)).toBeInTheDocument();
  });

  it('US-2: typing an email finds exactly that person and selecting returns their uid', async () => {
    const onSelect = jest.fn();
    await openUserSelection(onSelect);
    fireEvent.change(searchInput(), { target: { value: 'ahmed.one@' } });
    const emailEl = await screen.findByText(/ahmed\.one@sedsmail\.example/, {}, { timeout: 3000 });
    expect(screen.queryByText(/ahmed\.two@sedsmail\.example/)).toBeNull();
    fireEvent.click(itemRoot(emailEl));
    expect(onSelect).toHaveBeenCalledWith('px-ahmed-1');
  });

  it('US-3: typing a role finds its holder and selecting returns their uid', async () => {
    const onSelect = jest.fn();
    await openUserSelection(onSelect);
    fireEvent.change(searchInput(), { target: { value: 'president' } });
    const emailEl = await screen.findByText(/zara@sedsmail\.example/, {}, { timeout: 3000 });
    expect(screen.queryByText(/bilal@sedsmail\.example/)).toBeNull();
    fireEvent.click(itemRoot(emailEl));
    expect(onSelect).toHaveBeenCalledWith('px-zara');
  });
});
