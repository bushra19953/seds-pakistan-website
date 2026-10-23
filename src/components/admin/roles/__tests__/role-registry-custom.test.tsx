/**
 * DATA-MODEL plan section 8 - Role Registry custom-row rendering
 * (plan section 5).
 *
 * A definition that passes the four-part test (custom_ slug +
 * isCustom + catalog parent + chapterId) renders with the shared
 * Custom marker, its parent catalog title and its chapter name. A
 * junk definition renders exactly as today, with NO custom marker
 * (invariant 10). The chapter filter hides other chapters' custom
 * rows while system rows (global reference entries) remain.
 */

import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

(global as any).React = React;

// jsdom shims for Radix Select / ScrollArea internals.
if (typeof window !== 'undefined') {
  const proto = window.HTMLElement.prototype as any;
  proto.setPointerCapture = proto.setPointerCapture || (() => undefined);
  proto.releasePointerCapture = proto.releasePointerCapture || (() => undefined);
  proto.hasPointerCapture = proto.hasPointerCapture || (() => false);
  proto.scrollIntoView = proto.scrollIntoView || (() => undefined);
  (global as any).ResizeObserver =
    (global as any).ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
}

let mockRoleDefinitions: Array<Record<string, unknown>> = [];

const CHAPTER_DOCS = [
  { id: 'seds-ist-chapter', data: () => ({ name: 'IST Chapter' }) },
  { id: 'seds-lhr-chapter', data: () => ({ name: 'Lahore Chapter' }) },
];

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, name: string) => ({ _name: name })),
  query: jest.fn((ref: unknown) => ref),
  orderBy: jest.fn(() => ({})),
  getDocs: jest.fn(async (ref: { _name?: string }) =>
    ref?._name === 'chapters' ? { docs: CHAPTER_DOCS } : { docs: [] },
  ),
}));

jest.mock('@/firebase', () => ({
  useFirestore: () => ({}),
  useUser: () => ({
    user: { uid: 'admin-uid', getIdToken: async () => 'test-token' },
  }),
  useCollection: () => ({ data: mockRoleDefinitions, loading: false }),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, role: 'president_national' }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/lib/use-memo-firebase', () => ({
  useMemoFirebase: (fn: () => unknown) => fn(),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  setDoc: jest.fn(async () => undefined),
}));

jest.mock('@/components/admin/roles/role-permission-editor', () => ({
  RolePermissionEditor: () => null,
  RolePermissionEditorDrawer: () => null,
}));

jest.mock('@/components/admin/governance/consent-request-picker', () => ({
  ConsentRequestPicker: () => null,
}));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

import RoleRegistry from '@/components/admin/roles/role-registry';

const IST = 'seds-ist-chapter';
const LHR = 'seds-lhr-chapter';

const CUSTOM_IST = {
  id: 'custom_poster_team_lead',
  slug: 'custom_poster_team_lead',
  name: 'Poster Team Lead',
  category: 'Custom',
  scope: 'chapter',
  permissions: ['canManageTasks'],
  isCustom: true,
  parentRoleKey: 'chapter_design_chair',
  chapterId: IST,
  isActive: true,
};

const CUSTOM_LHR = {
  id: 'custom_event_helper',
  slug: 'custom_event_helper',
  name: 'Event Helper',
  category: 'Custom',
  scope: 'chapter',
  permissions: [],
  isCustom: true,
  parentRoleKey: 'chapter_events_chair',
  chapterId: LHR,
  isActive: true,
};

const JUNK = {
  id: 'super-admin',
  slug: 'super-admin',
  name: 'Super Admin',
  category: 'System',
  scope: 'global',
  permissions: [],
};

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  if (!row) throw new Error(`no table row found for ${name}`);
  return row as HTMLElement;
}

beforeEach(() => {
  mockRoleDefinitions = [CUSTOM_IST, CUSTOM_LHR, JUNK];
});

describe('RoleRegistry custom rows (plan section 5)', () => {
  it('renders the Custom badge, parent title and chapter name for a valid custom definition', async () => {
    render(<RoleRegistry />);
    await screen.findByText('Poster Team Lead');
    const row = rowFor('Poster Team Lead');

    // The row carries the definition's own category text ("Custom")
    // plus the shared CustomRoleBadge: the marker is what takes the
    // count from one to two.
    expect(within(row).getAllByText('Custom').length).toBeGreaterThanOrEqual(2);
    expect(
      within(row).getByText('Under: Chapter Design and Media Chair'),
    ).toBeInTheDocument();
    expect(within(row).getByText('IST Chapter')).toBeInTheDocument();
  });

  it('renders a junk definition WITHOUT the custom badge or sub-line', async () => {
    render(<RoleRegistry />);
    await screen.findByText('Super Admin');
    const row = rowFor('Super Admin');
    expect(within(row).queryByText('Custom')).toBeNull();
    expect(within(row).queryByText(/^Under:/)).toBeNull();
  });

  it('chapter filter hides another chapter\'s custom rows and keeps system rows', async () => {
    const user = userEvent.setup();
    render(<RoleRegistry />);
    await screen.findByText('Poster Team Lead');
    expect(screen.getByText('Event Helper')).toBeInTheDocument();

    const trigger = screen.getByRole('combobox');
    await user.click(trigger);
    const option = await screen.findByRole('option', { name: 'IST Chapter' });
    await user.click(option);

    await waitFor(() => expect(screen.queryByText('Event Helper')).toBeNull());
    expect(screen.getByText('Poster Team Lead')).toBeInTheDocument();
    // System rows are global reference entries, never chapter property.
    expect(screen.getByText('Full Member')).toBeInTheDocument();
  });
});
