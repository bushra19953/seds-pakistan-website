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

/**
 * Scalable redesign (perf program, 2026-10-30). The chart is built
 * for 20+ chapters and 500+ role-holders: these tests pin the
 * mechanisms with a synthetic fixture of the real payload shape —
 * 20 national officers + 20 chapters x 24 holders = 500 people.
 * No feed, route or Firestore is touched: fetch is mocked, exactly
 * as above.
 */

function fixturePerson(
  id: string,
  name: string,
  roleTitle: string,
  isCustomRole = false
) {
  return {
    id,
    name,
    roleTitle,
    photoURL: null,
    profilePath: `/profile/unified/${id}`,
    isCustomRole,
  };
}

const CHAPTER_ROLES = [
  'Chapter President',
  'Chapter Vice President',
  'Chapter Treasurer',
  'Chapter Secretary',
  'Chapter VP Deputy - Technical Systems',
  'Projects Lead',
];

function scalePayload() {
  const national = {
    id: 'national',
    name: 'National',
    members: Array.from({ length: 20 }, (_, i) =>
      fixturePerson(
        `nat-${i}`,
        `National Officer ${i}`,
        i === 0 ? 'National President' : 'National Officer Role'
      )
    ),
  };
  const chapters = Array.from({ length: 20 }, (_, c) => ({
    id: `chapter-${c + 1}`,
    name: `Chapter ${c + 1}`,
    members: Array.from({ length: 24 }, (_, p) =>
      fixturePerson(
        `c${c + 1}-p${p}`,
        `Member C${c + 1} P${p}`,
        CHAPTER_ROLES[p % CHAPTER_ROLES.length],
        CHAPTER_ROLES[p % CHAPTER_ROLES.length].includes('Deputy')
      )
    ),
  }));
  return { sections: [national, ...chapters] };
}

function profileLinks(container: HTMLElement) {
  return container.querySelectorAll('a[href^="/profile/unified/"]');
}

describe('/hierarchy page at scale (500 role-holders, 21 sections)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function renderScale() {
    global.fetch = mockFetchOk(scalePayload()) as any;
    const utils = render(<HierarchyPage />);
    await screen.findByText('500 role-holders across 21 sections');
    return utils;
  }

  it('bounds the initial DOM: only National and the first chapter render rows', async () => {
    const { container } = await renderScale();

    // 20 national + 24 from Chapter 1; the other 19 chapters are
    // collapsed and render no member rows at all.
    expect(profileLinks(container)).toHaveLength(44);
    expect(screen.queryByText('Member C20 P0')).not.toBeInTheDocument();
    expect(document.querySelectorAll('*').length).toBeLessThan(1500);
  });

  it('shows the chapter jump-nav at scale, and a jump opens its section', async () => {
    await renderScale();

    const nav = screen.getByRole('navigation', { name: 'Chapters' });
    expect(nav).toBeInTheDocument();
    expect(screen.queryByText('Member C12 P0')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /Chapter 12/ }));

    expect(await screen.findByText('Member C12 P0')).toBeInTheDocument();
  });

  it('expand all renders every holder; collapse all renders none', async () => {
    const { container } = await renderScale();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(profileLinks(container)).toHaveLength(500);
    expect(document.querySelectorAll('*').length).toBeGreaterThan(3000);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(profileLinks(container)).toHaveLength(0);
    // The section itself is still there — only its rows are gone.
    expect(
      screen.getByRole('button', { name: /Chapter 20/ })
    ).toBeInTheDocument();
  });

  it('search finds a person by name and announces the count', async () => {
    await renderScale();

    fireEvent.change(screen.getByLabelText('Search by name or role'), {
      target: { value: 'Member C7 P3' },
    });

    expect(await screen.findByText('Member C7 P3')).toBeInTheDocument();
    expect(
      screen.getByText('Showing 1 of 500 role-holders')
    ).toBeInTheDocument();
    expect(screen.queryByText('Member C7 P4')).not.toBeInTheDocument();
  });

  it('search by role title force-expands collapsed sections with matches', async () => {
    await renderScale();

    // Chapter 20 starts collapsed; its deputies must still be found.
    fireEvent.change(screen.getByLabelText('Search by name or role'), {
      target: { value: 'Deputy' },
    });

    expect(await screen.findByText('Member C20 P4')).toBeInTheDocument();
    // 4 deputies per chapter (24 members cycling 6 roles) x 20 chapters.
    expect(
      screen.getByText('Showing 80 of 500 role-holders')
    ).toBeInTheDocument();
  });

  it('a search with no matches shows the reset state, never the empty chart', async () => {
    await renderScale();

    fireEvent.change(screen.getByLabelText('Search by name or role'), {
      target: { value: 'zzzz-no-such-person' },
    });

    expect(
      await screen.findByText(/No one matches that search/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No role-holders are published yet/i)
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Clear search and filters' })
    );
    expect(await screen.findByText('Member C1 P0')).toBeInTheDocument();
    expect(
      screen.queryByText(/No one matches that search/i)
    ).not.toBeInTheDocument();
  });

  it('role and chapter selects filter the chart', async () => {
    const { container } = await renderScale();

    fireEvent.change(screen.getByLabelText('Filter by role'), {
      target: { value: 'Chapter President' },
    });
    // 4 presidents per chapter in the fixture (24 members cycling 6
    // roles) x 20 chapters, and every chapter stays represented.
    expect(profileLinks(container)).toHaveLength(80);
    expect(
      screen.getByText('Showing 80 of 500 role-holders')
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by chapter'), {
      target: { value: 'chapter-3' },
    });
    expect(profileLinks(container)).toHaveLength(4);
    expect(screen.getByText('Member C3 P0')).toBeInTheDocument();
  });
});

describe('/hierarchy page collapse behaviour (small chart)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a small chart starts fully open, and a section toggle collapses it', async () => {
    global.fetch = mockFetchOk(PAYLOAD) as any;
    render(<HierarchyPage />);

    const toggle = await screen.findByRole('button', {
      name: /IST Chapter/,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('The Deputy')).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('The Deputy')).not.toBeInTheDocument();
    // The National section is untouched by the chapter's toggle.
    expect(screen.getByText('Nat Prez')).toBeInTheDocument();
  });
});
