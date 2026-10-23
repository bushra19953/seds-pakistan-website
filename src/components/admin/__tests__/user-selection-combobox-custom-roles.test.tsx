/**
 * UserSelectionCombobox custom-role matching (Custom Roles Fix Program,
 * consumers item, Surface 2; contracts.md Sections 2.1 and 4.3).
 *
 * The assignee filter must match a custom role held in additionalRoles
 * (the only grant slot for custom roles, contracts K2), keep matching a
 * primary-role holder by slug equality as today, exclude non-holders,
 * keep the showAll escape hatch, never let the additional match bypass
 * a filterFn eligibility gate, and render the filter strip with the
 * resolved preferredRoleLabel instead of leaking the raw custom slug.
 *
 * Users arrive from GET /api/users/picker (mocked fetch below); the
 * picker payload shape incl. additionalRoles is locked by
 * src/app/api/users/picker/__tests__/route.test.ts.
 *
 * Flake discipline: every test uses display names unique to that test,
 * and the popover trigger is clicked through the render container (the
 * trigger lives in the component tree; only the rows portal to body).
 * Radix portals from a previous test can therefore never satisfy this
 * test's queries.
 */

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: { getIdToken: async () => 'test-token' } }),
}));

import UserSelectionCombobox from '@/components/admin/user-selection-combobox';

const CUSTOM_SLUG = 'custom_poster_team_lead';
const DEFINITION_NAME = 'Poster Squad Lead';

function usersFor(tag: string) {
  return [
    { uid: `u-primary-${tag}`, displayName: `Primary Holder ${tag}`, role: CUSTOM_SLUG, additionalRoles: [], chapterId: 'seds-ist-chapter' },
    { uid: `u-additional-${tag}`, displayName: `Additional Holder ${tag}`, role: 'member', additionalRoles: [CUSTOM_SLUG], chapterId: 'seds-ist-chapter' },
    { uid: `u-plain-${tag}`, displayName: `Plain Member ${tag}`, role: 'member', additionalRoles: [], chapterId: 'seds-ist-chapter' },
  ];
}

beforeAll(() => {
  // Shims Radix Popover and cmdk expect from a real browser (same set as
  // the chapter-selector suite).
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

afterEach(async () => {
  cleanup();
  await act(async () => {});
});

async function openCombobox(tag: string, props: Record<string, any> = {}) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ users: usersFor(tag) }),
  })) as any;
  const { container } = render(
    <UserSelectionCombobox
      onSelect={jest.fn()}
      preferredRole={CUSTOM_SLUG}
      {...props}
    />
  );
  const trigger = container.querySelector('button');
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger as HTMLButtonElement);
  // The primary holder is the canary that the fetch + filter completed.
  return screen.findByText(`Primary Holder ${tag}`, {}, { timeout: 3000 });
}

describe('UserSelectionCombobox custom role filter (Surface 2)', () => {
  it('matches a custom role held as the primary role', async () => {
    await openCombobox('T1');
    expect(screen.getByText('Primary Holder T1')).toBeInTheDocument();
  });

  it('matches a custom role held in additionalRoles', async () => {
    await openCombobox('T2');
    // findByText (not getByText): on failure it waits out the timeout, so
    // the component fully settles before this test ends and cannot bleed
    // pending effects into the next test.
    expect(await screen.findByText('Additional Holder T2', {}, { timeout: 1500 })).toBeInTheDocument();
  });

  it('excludes users who do not hold the role anywhere', async () => {
    await openCombobox('T3');
    expect(screen.queryByText('Plain Member T3')).toBeNull();
  });

  it('showAll still reveals everyone', async () => {
    await openCombobox('T4');
    fireEvent.click(screen.getByRole('button', { name: /show all users/i }));
    expect(await screen.findByText('Plain Member T4')).toBeInTheDocument();
    expect(await screen.findByText('Additional Holder T4')).toBeInTheDocument();
  });

  it('a filterFn gate cannot be bypassed by the additionalRoles match', async () => {
    await openCombobox('T5', {
      filterFn: (u: any) => !String(u.uid).startsWith('u-additional'),
    });
    expect(screen.getByText('Primary Holder T5')).toBeInTheDocument();
    expect(screen.queryByText('Additional Holder T5')).toBeNull();
    expect(screen.queryByText('Plain Member T5')).toBeNull();
  });

  it('the filter strip shows preferredRoleLabel and never the raw slug', async () => {
    await openCombobox('T6', { preferredRoleLabel: DEFINITION_NAME });
    expect(screen.getByText(new RegExp(`Filtering by role: ${DEFINITION_NAME}`))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(CUSTOM_SLUG))).toBeNull();
  });
});
