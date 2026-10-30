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

async function switchToList() {
  fireEvent.click(screen.getByRole('radio', { name: 'List' }));
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

  it('bounds the initial DOM in the chart view: two trees plus summary cards', async () => {
    const { container } = await renderScale();

    // National tree (20) + Chapter 1 tree (24) render as nodes; the
    // other 19 chapters are summary cards carrying only their root
    // holder's link (19). 500 people, 63 profile links in the DOM.
    expect(profileLinks(container)).toHaveLength(63);
    expect(screen.queryByText('Member C20 P5')).not.toBeInTheDocument();
    expect(document.querySelectorAll('*').length).toBeLessThan(1500);
  });

  it('shows the chapter jump-nav at scale, and a jump opens its section', async () => {
    await renderScale();

    const nav = screen.getByRole('navigation', { name: 'Chapters' });
    expect(nav).toBeInTheDocument();
    // Chapter 12's summary names only its root (P0); P5 is deeper.
    expect(screen.queryByText('Member C12 P5')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /Chapter 12/ }));

    expect(await screen.findByText('Member C12 P5')).toBeInTheDocument();
  });

  it('expand all renders every holder; collapse all leaves only summaries', async () => {
    const { container } = await renderScale();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(profileLinks(container)).toHaveLength(500);
    expect(document.querySelectorAll('*').length).toBeGreaterThan(3000);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    // One root-holder link per section summary: 21 sections.
    expect(profileLinks(container)).toHaveLength(21);
    // The section itself is still there — only its tree is gone.
    expect(
      screen.getByRole('button', { name: /Chapter 20/ })
    ).toBeInTheDocument();
  });

  it('search finds a person by name and announces the count', async () => {
    await renderScale();
    await switchToList();

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
    await switchToList();

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
    await switchToList();

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
    await switchToList();

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
    // Wait for the loaded chart before switching to the list view.
    await screen.findByText('The Deputy');
    await switchToList();

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

/**
 * Visual org chart (founder design correction, 2026-10-30). The
 * default view is the top-down tree. Edges come from the feed's
 * parents map (derived server-side from role-definition
 * parentRoleKey); this fixture pins the rendering rules:
 *  - member 0 roots the tree, catalog officers form the level below;
 *  - a deputy with a mapped parent renders INSIDE that chair's
 *    subtree;
 *  - a deputy with no mapped parent renders in the level band,
 *    inside nobody's subtree.
 */
const TREE_PAYLOAD = {
  sections: [
    {
      id: 'national',
      name: 'National',
      members: [
        fixturePerson('u-founder', 'The Founder', 'Founder and Patron-in-Chief'),
      ],
    },
    {
      id: 'seds-ist-chapter',
      name: 'IST Chapter',
      parents: { '3': 1, '4': 1 },
      members: [
        fixturePerson('u-prez', 'The President', 'Chapter President'),
        fixturePerson('u-vp', 'The VP', 'Chapter Vice President'),
        fixturePerson('u-treas', 'The Treasurer', 'Chapter Treasurer'),
        fixturePerson('u-dep-a', 'Dep A', 'Chapter VP Deputy - Technical Systems', true),
        fixturePerson('u-dep-b', 'Dep B', 'Chapter VP Deputy - Workshop Logistics', true),
        fixturePerson('u-orphan', 'Orphan Dep', 'Alumni Deputy - Database Archival', true),
      ],
    },
  ],
};

describe('/hierarchy page visual org chart', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function renderTree() {
    global.fetch = mockFetchOk(TREE_PAYLOAD) as any;
    const utils = render(<HierarchyPage />);
    await screen.findByText('The President');
    return utils;
  }

  it('opens in the chart view, with the list one toggle away', async () => {
    await renderTree();

    expect(screen.getByRole('radio', { name: 'Chart' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    // The canvas is a labelled group per section.
    expect(
      screen.getByRole('group', { name: 'IST Chapter org chart' })
    ).toBeInTheDocument();
  });

  it('places a mapped deputy inside its chair subtree, and an unmapped deputy in the band', async () => {
    const { container } = await renderTree();

    const vpLink = screen.getByRole('link', { name: 'The VP' });
    const vpBranch = vpLink.closest('li');
    expect(vpBranch).not.toBeNull();
    // Both VP deputies hang under the VP's branch of the tree.
    expect(
      vpBranch!.contains(screen.getByRole('link', { name: 'Dep A' }))
    ).toBe(true);
    expect(
      vpBranch!.contains(screen.getByRole('link', { name: 'Dep B' }))
    ).toBe(true);
    // The president does not leak into the VP's branch.
    expect(
      vpBranch!.contains(screen.getByRole('link', { name: 'The President' }))
    ).toBe(false);

    // The orphan deputy is in the dashed level band, in no subtree.
    const orphanLink = screen.getByRole('link', { name: 'Orphan Dep' });
    expect(vpBranch!.contains(orphanLink)).toBe(false);
    const band = container.querySelector('.border-dashed');
    expect(band).not.toBeNull();
    expect(band!.contains(orphanLink)).toBe(true);
  });

  it('search highlights the matching node in the chart and counts it', async () => {
    await renderTree();

    fireEvent.change(screen.getByLabelText('Search by name or role'), {
      target: { value: 'Dep A' },
    });

    expect(
      await screen.findByText(/1 matching role-holder highlighted/)
    ).toBeInTheDocument();
    const node = document.getElementById('hnode-seds-ist-chapter-3');
    expect(node?.className).toContain('ring-primary');
    // Nothing is hidden in chart search: the president still renders.
    expect(screen.getByText('The President')).toBeInTheDocument();
  });

  it('zoom controls scale the tree canvas', async () => {
    const { container } = await renderTree();

    fireEvent.click(
      screen.getByRole('button', { name: 'Zoom in the IST Chapter chart' })
    );

    expect(await screen.findByText('125%')).toBeInTheDocument();
    expect(
      container.querySelector('[style*="scale(1.25)"]')
    ).not.toBeNull();

    // Every section has its own Reset; click the one zoom enabled.
    const resets = screen.getAllByRole('button', { name: 'Reset' });
    const enabled = resets.find(
      (b) => !(b as HTMLButtonElement).disabled
    );
    fireEvent.click(enabled!);
    // Both trees back at 100%.
    expect(screen.getAllByText('100%')).toHaveLength(2);
  });
});
