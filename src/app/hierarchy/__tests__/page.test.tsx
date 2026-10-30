/**
 * Render tests for the public /hierarchy page (founder order
 * 2026-10-30). The feed is mocked at fetch; these pin the page-level
 * contract only:
 *  - a failed feed shows the load-failed state with a retry, and
 *    NEVER the empty-chart copy (truthful degradation);
 *  - retrying after a failure can recover into the real chart;
 *  - a successful feed renders sections in order with names linked
 *    to public profiles;
 *  - a successful but empty feed shows the honest empty state.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import HierarchyPage from '../page';

const PAYLOAD = {
  sections: [
    {
      id: 'national',
      name: 'National',
      members: [
        {
          id: 'u-nat',
          name: 'Nat Prez',
          roleTitle: 'National President',
          photoURL: null,
          profilePath: '/profile/unified/u-nat',
          isCustomRole: false,
        },
      ],
    },
    {
      id: 'seds-ist-chapter',
      name: 'IST Chapter',
      members: [
        {
          id: 'u-deputy',
          name: 'The Deputy',
          roleTitle: 'Chapter VP Deputy - Technical Systems',
          photoURL: null,
          profilePath: '/profile/unified/u-deputy',
          isCustomRole: true,
        },
      ],
    },
  ],
};

function mockFetchOk(payload: unknown) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
}

describe('/hierarchy page', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the load-failed state (not an empty chart) when the feed fails, and recovers on retry', async () => {
    const failing = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to load the hierarchy.' }),
    }));
    global.fetch = failing as any;

    render(<HierarchyPage />);

    expect(
      await screen.findByText(/could not be loaded/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No role-holders are published yet/i)
    ).not.toBeInTheDocument();

    global.fetch = mockFetchOk(PAYLOAD) as any;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Nat Prez')).toBeInTheDocument();
    expect(screen.getByText('IST Chapter')).toBeInTheDocument();
  });

  it('renders sections with profile links on success', async () => {
    global.fetch = mockFetchOk(PAYLOAD) as any;

    render(<HierarchyPage />);

    expect(await screen.findByText('National')).toBeInTheDocument();
    const natLink = screen.getByRole('link', { name: 'Nat Prez' });
    expect(natLink).toHaveAttribute('href', '/profile/unified/u-nat');
    const deputyLink = await screen.findByRole('link', { name: 'The Deputy' });
    expect(deputyLink).toHaveAttribute('href', '/profile/unified/u-deputy');
    expect(
      screen.getByText('Chapter VP Deputy - Technical Systems')
    ).toBeInTheDocument();
  });

  it('shows the honest empty state only for a successful empty feed', async () => {
    global.fetch = mockFetchOk({ sections: [] }) as any;

    render(<HierarchyPage />);

    expect(
      await screen.findByText(/No role-holders are published yet/i)
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument()
    );
  });
});
