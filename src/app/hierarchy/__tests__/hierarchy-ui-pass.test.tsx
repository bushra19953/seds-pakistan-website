/**
 * Hierarchy UI pass (MSG33: MSG28 + MSG31, one pass).
 *
 * Live-shaped fixture: the feed payload shape exactly as the route
 * emits it (7 person keys + level + the parents map). Feed order is
 * level ascending, so the level-5 customs sit BEFORE the level-6
 * statutory officer in the delivered order — the list-view case
 * MSG31 corrects. The President's Executive Apprentice is a custom
 * role parented to the section head (parents map: child 4 -> 0,
 * the F1 root), which MSG31 renders as a side staff node, never as
 * a link in the vertical chain above the VP.
 *
 * jsdom performs no layout, so truncation and wrap are pinned via
 * the class contract the layout depends on, the same way the older
 * name-wins tests pin theirs.
 */
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import HierarchyPage from '../page';

function mockFetchOk(payload: unknown) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
}

function uiPerson(
  id: string,
  name: string,
  roleTitle: string,
  level: number,
  isCustomRole = false
) {
  return {
    id,
    name,
    roleTitle,
    photoURL: null,
    profilePath: `/profile/unified/${id}`,
    isCustomRole,
    level,
  };
}

const UI_PAYLOAD = {
  sections: [
    {
      id: 'national',
      name: 'National',
      members: [uiPerson('u-founder', 'The Founder', 'Founder and Patron-in-Chief', 0)],
    },
    {
      id: 'seds-ist-chapter',
      name: 'IST Chapter',
      parents: { '4': 0, '5': 1 },
      members: [
        uiPerson('u-prez', 'The President', 'Chapter President', 3),
        uiPerson('u-vp', 'The VP', 'Chapter Vice President', 4),
        uiPerson('u-sec', 'The Secretary', 'Chapter Secretary', 4),
        uiPerson('u-treas', 'The Treasurer', 'Chapter Treasurer', 4),
        uiPerson('u-staff', 'The Apprentice', "President's Executive Apprentice", 5, true),
        uiPerson('u-dep', 'VP Deputy', 'Chapter VP Deputy - Technical Systems', 5, true),
        uiPerson('u-orphan', 'Orphan Dep', 'Alumni Deputy - Database Archival', 5, true),
        uiPerson('u-officer6', 'Level Six Officer', 'Chapter Logistics Coordinator', 6),
      ],
    },
  ],
};

describe('/hierarchy UI pass (MSG28 + MSG31)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function renderUi() {
    global.fetch = mockFetchOk(UI_PAYLOAD) as any;
    const utils = render(<HierarchyPage />);
    await screen.findByText('The President');
    return utils;
  }

  it('MSG28 chart: role titles render in full, never truncated', async () => {
    await renderUi();

    const chip = screen.getByText('Chapter Vice President');
    expect(chip.className).not.toContain('truncate');
    expect(chip.className).toContain('break-words');
  });

  it('MSG28 list: role titles render in full, never truncated, Custom marker kept', async () => {
    await renderUi();
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));

    const chip = await screen.findByText('Chapter Vice President');
    expect(chip.className).not.toContain('truncate');
    expect(chip.className).toContain('break-words');
    // The Custom marker survives the un-truncation: custom rows
    // still carry it (three customs in this fixture).
    expect(screen.getAllByText('Custom').length).toBeGreaterThanOrEqual(3);
  });

  it('MSG31 list: statutory roles render before custom roles, feed order kept inside each group', async () => {
    await renderUi();
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));

    const officerLink = await screen.findByRole('link', { name: 'Level Six Officer' });
    const staffLink = screen.getByRole('link', { name: 'The Apprentice' });
    // Delivered order puts the level-5 custom before the level-6
    // officer; the list must read statutory first anyway.
    expect(
      Boolean(
        officerLink.compareDocumentPosition(staffLink) &
          Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true);
    // Inside the statutory group the feed order is unchanged.
    const prezLink = screen.getByRole('link', { name: 'The President' });
    expect(
      Boolean(
        prezLink.compareDocumentPosition(officerLink) &
          Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true);
  });

  it('MSG31 chart: a custom parented to the head renders as a side staff node, never in the chain above the VP', async () => {
    await renderUi();

    const staffLink = screen.getByRole('link', { name: 'The Apprentice' });
    const rail = screen.getByTestId('staff-rail-seds-ist-chapter');
    expect(rail.contains(staffLink)).toBe(true);
    // The VP branch holds the VP and his own deputy, not the staff node.
    const vpBranch = screen.getByRole('link', { name: 'The VP' }).closest('li')!;
    expect(vpBranch.contains(staffLink)).toBe(false);
    // The staff node is derived from data, not a name: it is the
    // child whose parents-map entry points at the section root.
    expect(rail.textContent).toContain('Staff');
  });

  it('MSG31 chart: custom cards are subordinate, dashed connector, prominent CUSTOM label', async () => {
    await renderUi();

    const depNode = document.getElementById('hnode-seds-ist-chapter-5')!;
    expect(depNode).not.toBeNull();
    // Smaller, dashed card (officer cards keep the solid border).
    expect(depNode.className).toContain('border-dashed');
    const officerNode = document.getElementById('hnode-seds-ist-chapter-2')!;
    expect(officerNode.className).not.toContain('border-dashed');
    // Muted title pill on the custom card.
    const depChip = within(depNode).getByText('Chapter VP Deputy - Technical Systems');
    expect(depChip.className).toContain('bg-muted');
    // The custom title stacks above its label, so the pill gets
    // the card's full width and wraps at word boundaries instead
    // of splitting words beside the marker; officer titles keep
    // the inline row.
    expect(depChip.parentElement!.className).toContain('flex-col');
    const officerChip = within(officerNode).getByText('Chapter Secretary');
    expect(officerChip.parentElement!.className).not.toContain('flex-col');
    // The CUSTOM label is prominent, not a quiet badge.
    const marker = within(depNode).getByText('Custom');
    expect(marker.className).toContain('font-semibold');
    // The deputy chain hangs on a dashed connector, not a solid one.
    const chainDiv = depNode.closest('li')!.parentElement!.parentElement!;
    const connector = chainDiv.querySelector('span.absolute');
    expect(connector).not.toBeNull();
    expect(connector!.className).toContain('border-dashed');
  });

  it('MSG31 chart: a VP-parented deputy still hangs under the VP (staff rule is head-only)', async () => {
    await renderUi();

    const vpBranch = screen.getByRole('link', { name: 'The VP' }).closest('li')!;
    expect(vpBranch.contains(screen.getByRole('link', { name: 'VP Deputy' }))).toBe(true);
    // The VP-parented deputy is NOT swept into the staff rail.
    const rail = screen.getByTestId('staff-rail-seds-ist-chapter');
    expect(rail.contains(screen.getByRole('link', { name: 'VP Deputy' }))).toBe(false);
  });
});
