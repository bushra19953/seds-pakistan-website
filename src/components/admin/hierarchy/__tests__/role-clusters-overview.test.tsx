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
import { render, screen, fireEvent } from '@testing-library/react';
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

import RoleClustersOverview from '@/components/admin/hierarchy/role-clusters-overview';

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

describe('RoleClustersOverview grant expiry badge (expiry-ui plan 7.7)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const EXPIRY_ISO = new Date(Date.now() + 90 * DAY).toISOString();
  const EXPIRY_LABEL = (() => {
    const d = new Date(EXPIRY_ISO);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  const EXPIRY_USERS = [
    {
      id: 'u-expiring',
      displayName: 'Expiring Holder',
      email: 'expiring@example.com',
      role: 'custom_poster_team_lead',
      roleExpiresAt: EXPIRY_ISO,
      chapterId: null,
    },
    {
      id: 'u-noexpiry',
      displayName: 'Plain Holder',
      email: 'plain@example.com',
      role: 'member',
      roleExpiresAt: null,
      chapterId: null,
    },
  ];

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ users: EXPIRY_USERS }),
    }) as jest.Mock;
  });

  it('renders the GrantExpiryBadge on the email line for a holder with roleExpiresAt', async () => {
    render(<RoleClustersOverview />);
    const badge = await screen.findByText(`Expires ${EXPIRY_LABEL}`);
    expect(badge).toBeInTheDocument();
    // The badge sits in the row of the holder who carries the expiry.
    const row = badge.closest('li');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Expiring Holder');
  });

  it('renders no badge for a holder whose roleExpiresAt is null', async () => {
    render(<RoleClustersOverview />);
    const nameEl = await screen.findByText('Plain Holder');
    const row = nameEl.closest('li');
    expect(row).not.toBeNull();
    expect(row!.textContent).not.toMatch(/Expires|Expired/);
  });
});
