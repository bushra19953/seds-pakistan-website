/**
 * RoleClustersOverview (hierarchy audit Issues 5, 6, 7):
 * - Issue 5: person names render in full (no truncate on the name span),
 *   stacked above the masked email line instead of sharing one flex row
 *   with the shrink-0 role pill.
 * - Issue 6: a user doc with a missing/blank displayName renders the
 *   "Vacant" treatment (italic muted), never the literal "Unknown" and
 *   never an email in the name slot.
 * - Issue 7: when onFocusPerson is provided, clicking a person row calls
 *   it with that person's uid; vacant rows stay non-clickable.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: jest.fn(async () => 'test-token') },
  }),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
}));

jest.mock('@/firebase', () => ({
  useFirestore: () => ({}),
}));

jest.mock('@/firebase/firestore/use-collection', () => ({
  useCollection: () => ({ data: [] }),
}));

// Test double only: the real MaskedContact (masking, unmask audit flow) is
// out of scope for this suite.
jest.mock('@/components/privacy/masked-contact', () => ({
  __esModule: true,
  MaskedContact: ({ value }: { value: string }) => <span>{value}</span>,
  default: ({ value }: { value: string }) => <span>{value}</span>,
}));

// The registry hook's data source (contracts.md Section 4.2 client
// adapter): serves the one shared fixture definition.
jest.mock('@/lib/role-definitions', () => {
  const { POSTER_DEF } = require('./custom-role-fixture');
  return {
    getCustomRoleDefinitions: jest.fn(async () => [POSTER_DEF]),
  };
});

import RoleClustersOverview from '@/components/admin/hierarchy/role-clusters-overview';
import { getCustomRoleDefinitions } from '@/lib/role-definitions';
import { __setCustomRoleDefinitionsForTests } from '@/lib/custom-role-sync';
import {
  POSTER_DEF,
  CUSTOM_USER,
  CATALOG_USER,
  UNKNOWN_USER,
  CUSTOM_ROLE_NAME,
  CUSTOM_ROLE_SLUG,
} from './custom-role-fixture';

// The component uses the classic JSX runtime, so React must be in global
// scope at render time (same pattern as the root gallery-section suite).
(global as any).React = React;

const LONG_NAME =
  'Muhammad Zubair Mongol With An Exceptionally Long Full Name';

const USERS = [
  {
    id: 'u-long',
    displayName: LONG_NAME,
    email: 'zubair@example.com',
    role: 'president_national',
    chapterId: null,
  },
  {
    id: 'u-vacant',
    displayName: '   ',
    email: null,
    role: 'national_vp_operations',
    chapterId: null,
  },
];

function mockFetchUsers() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ users: USERS }),
  }) as jest.Mock;
}

describe('RoleClustersOverview', () => {
  beforeEach(() => {
    mockFetchUsers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders long names in full without the truncate class (Issue 5)', async () => {
    render(<RoleClustersOverview />);
    const nameEl = await screen.findByText(LONG_NAME);
    expect(nameEl).toBeInTheDocument();
    expect(nameEl.className).not.toMatch(/\btruncate\b/);
    expect(nameEl.className).toMatch(/\bbreak-words\b/);
  });

  it('renders a missing display name as Vacant, never Unknown (Issue 6)', async () => {
    render(<RoleClustersOverview />);
    const vacantEl = await screen.findByText('Vacant');
    expect(vacantEl).toBeInTheDocument();
    expect(vacantEl.className).toMatch(/\bitalic\b/);
    expect(vacantEl.className).toMatch(/\btext-muted-foreground\b/);
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('calls onFocusPerson with the uid when a person row is clicked (Issue 7)', async () => {
    const onFocusPerson = jest.fn();
    render(<RoleClustersOverview onFocusPerson={onFocusPerson} />);
    const nameEl = await screen.findByText(LONG_NAME);
    const row = nameEl.closest('li');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('role', 'button');
    fireEvent.click(row as HTMLElement);
    expect(onFocusPerson).toHaveBeenCalledTimes(1);
    expect(onFocusPerson).toHaveBeenCalledWith('u-long');
  });

  it('keeps vacant rows non-clickable (Issue 7)', async () => {
    const onFocusPerson = jest.fn();
    render(<RoleClustersOverview onFocusPerson={onFocusPerson} />);
    const vacantEl = await screen.findByText('Vacant');
    const row = vacantEl.closest('li');
    expect(row).not.toBeNull();
    expect(row).not.toHaveAttribute('role', 'button');
    fireEvent.click(row as HTMLElement);
    expect(onFocusPerson).not.toHaveBeenCalled();
  });

  it('rows are plain list items when onFocusPerson is not provided', async () => {
    render(<RoleClustersOverview />);
    const nameEl = await screen.findByText(LONG_NAME);
    const row = nameEl.closest('li');
    expect(row).not.toBeNull();
    expect(row).not.toHaveAttribute('role', 'button');
    expect(row).not.toHaveAttribute('tabindex');
  });
});

describe('RoleClustersOverview custom roles (Custom Roles consumers, Surface 4)', () => {
  beforeEach(() => {
    // Re-arm the adapter mock (the outer suite's restoreAllMocks can
    // strip factory implementations) and seed the sync cache, so both
    // registry read paths the implementation may use see the fixture.
    (getCustomRoleDefinitions as jest.Mock).mockImplementation(async () => [POSTER_DEF]);
    __setCustomRoleDefinitionsForTests([POSTER_DEF]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ users: [CUSTOM_USER, CATALOG_USER, UNKNOWN_USER] }),
    }) as jest.Mock;
  });

  afterEach(() => {
    __setCustomRoleDefinitionsForTests(null);
  });

  async function rowFor(displayName: string) {
    const nameEl = await screen.findByText(displayName);
    const row = nameEl.closest('li');
    expect(row).not.toBeNull();
    return row as HTMLElement;
  }

  it('a custom-primary user renders the definition title and the Custom marker, never Basic Member or the raw slug', async () => {
    render(<RoleClustersOverview />);
    const row = await rowFor('Custom Person');
    expect(within(row).getByText(CUSTOM_ROLE_NAME)).toBeInTheDocument();
    expect(within(row).getByText('Custom')).toBeInTheDocument();
    expect(within(row).queryByText('Basic Member')).toBeNull();
    expect(row.textContent).not.toContain(CUSTOM_ROLE_SLUG);
  });

  it('a catalog user renders exactly as before, with no marker', async () => {
    render(<RoleClustersOverview />);
    const row = await rowFor('Prez Person');
    expect(within(row).getByText('National President')).toBeInTheDocument();
    expect(within(row).queryByText('Custom')).toBeNull();
  });

  it('an unknown non-custom token keeps today\u2019s floored rendering (SEC-10 lock)', async () => {
    render(<RoleClustersOverview />);
    const row = await rowFor('Unknown Person');
    expect(within(row).getByText('Basic Member')).toBeInTheDocument();
    expect(within(row).queryByText(CUSTOM_ROLE_NAME)).toBeNull();
    expect(within(row).queryByText('Custom')).toBeNull();
  });
});
