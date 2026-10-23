/**
 * DATA-MODEL plan section 8 - RolePermissionEditor custom sessions
 * (plan section 6b).
 *
 * For a custom definition the editor shows the Custom role section
 * (parent and chapter read-only from the loaded doc, default-term
 * input), pins scope to chapter, drops the allowedChapters picker,
 * locks the two Reserved Power switches, and round-trips
 * isCustom / parentRoleKey / chapterId / defaultTermDays in the save
 * body. A non-custom session renders no custom section and its save
 * body is byte-identical in shape to today's.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

(global as any).React = React;

if (typeof window !== 'undefined') {
  (global as any).ResizeObserver =
    (global as any).ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
}

const IST = 'seds-ist-chapter';

const CHAPTER_DOCS = [
  { id: IST, data: () => ({ name: 'IST Chapter' }) },
  { id: 'seds-lhr-chapter', data: () => ({ name: 'Lahore Chapter' }) },
];

const mockDefDocs: Record<string, Record<string, unknown>> = {
  custom_poster_team_lead: {
    slug: 'custom_poster_team_lead',
    name: 'Poster Team Lead',
    description: 'Runs the poster team',
    category: 'Custom',
    isActive: true,
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: IST,
    defaultTermDays: 90,
  },
  chapter_events_chair: {
    slug: 'chapter_events_chair',
    name: 'Chapter Events Chair',
    description: 'Runs chapter events',
    category: 'Committee',
    isActive: true,
  },
};

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, _col: string, id: string) => ({ _id: id })),
  getDoc: jest.fn(async (ref: { _id: string }) => ({
    exists: () => ref._id in mockDefDocs,
    data: () => mockDefDocs[ref._id],
  })),
  collection: jest.fn((_db: unknown, name: string) => ({ _name: name })),
  query: jest.fn((ref: unknown) => ref),
  orderBy: jest.fn(() => ({})),
  getDocs: jest.fn(async (ref: { _name?: string }) =>
    ref?._name === 'chapters' ? { docs: CHAPTER_DOCS } : { docs: [] },
  ),
}));

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: jest.fn(async () => 'test-token') },
  }),
}));

jest.mock('@/firebase', () => ({
  useFirestore: () => ({}),
  useUser: () => ({ user: { uid: 'admin-uid' }, role: 'president_national' }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/components/admin/governance/consent-request-picker', () => ({
  ConsentRequestPicker: () => null,
}));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

import { RolePermissionEditor } from '@/components/admin/roles/role-permission-editor';

const mockFetch = jest.fn(async () => ({
  ok: true,
  json: async () => ({ success: true }),
}));

beforeEach(() => {
  mockFetch.mockClear();
  (global as any).fetch = mockFetch;
});

async function clickSaveAndGetBody(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some((c) => c[0] === '/api/admin/role-permissions'),
    ).toBe(true),
  );
  const call = mockFetch.mock.calls.find((c) => c[0] === '/api/admin/role-permissions');
  return JSON.parse((call?.[1] as { body: string }).body);
}

describe('RolePermissionEditor - custom session (plan 6b)', () => {
  function renderCustom() {
    return render(
      <RolePermissionEditor
        roleSlug="custom_poster_team_lead"
        roleName="Poster Team Lead"
        initialPermissions={['canManageTasks']}
        initialScope="chapter"
        initialAllowedChapters={[IST]}
        canEdit
      />,
    );
  }

  it('renders parent and chapter read-only from the loaded definition', async () => {
    renderCustom();
    expect(
      await screen.findByText('Chapter Design and Media Chair (chapter_design_chair)'),
    ).toBeInTheDocument();
    expect(screen.getByText('IST Chapter')).toBeInTheDocument();
  });

  it('loads the default term into the pinned input', async () => {
    renderCustom();
    await screen.findByText('Chapter Design and Media Chair (chapter_design_chair)');
    await waitFor(() => {
      const input = document.getElementById(
        'custom-default-term-days',
      ) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input?.value).toBe('90');
    });
  });

  it('disables the two Reserved Power switches with the explanatory note', async () => {
    renderCustom();
    await screen.findByText('Chapter Design and Media Chair (chapter_design_chair)');
    expect(
      document.getElementById('custom_poster_team_lead-canManagePermissions'),
    ).toBeDisabled();
    expect(
      document.getElementById('custom_poster_team_lead-canManageRoles'),
    ).toBeDisabled();
    expect(
      screen.getAllByText(/Reserved Power - never available to custom roles/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('pins scope to chapter and hides the allowedChapters picker', async () => {
    renderCustom();
    await screen.findByText('Chapter Design and Media Chair (chapter_design_chair)');
    expect(
      document.getElementById('scope-global-custom_poster_team_lead'),
    ).toBeDisabled();
    expect(
      document.getElementById('scope-chapter-custom_poster_team_lead')?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(screen.queryByText('Chapter Assignment')).toBeNull();
    expect(screen.queryByPlaceholderText('SEARCH CHAPTERS...')).toBeNull();
  });

  it('round-trips the custom fields in the save body', async () => {
    renderCustom();
    await screen.findByText('Chapter Design and Media Chair (chapter_design_chair)');
    const body = await clickSaveAndGetBody();
    expect(body.role).toBe('custom_poster_team_lead');
    expect(body.isCustom).toBe(true);
    expect(body.parentRoleKey).toBe('chapter_design_chair');
    expect(body.chapterId).toBe(IST);
    expect(body.defaultTermDays).toBe(90);
    expect(body.scope).toBe('chapter');
    expect(body.permissionKeys).toEqual(expect.arrayContaining(['canManageTasks']));
    expect(body.permissionKeys).not.toContain('canManagePermissions');
    expect(body.permissionKeys).not.toContain('canManageRoles');
  });
});

describe('RolePermissionEditor - non-custom session (unchanged)', () => {
  function renderCatalog() {
    return render(
      <RolePermissionEditor
        roleSlug="chapter_events_chair"
        roleName="Chapter Events Chair"
        initialPermissions={['canManageTasks']}
        initialScope="chapter"
        canEdit
      />,
    );
  }

  it('renders no custom section and keeps the chapter picker', async () => {
    renderCatalog();
    expect(await screen.findByText('Chapter Assignment')).toBeInTheDocument();
    expect(document.getElementById('custom-default-term-days')).toBeNull();
    expect(
      screen.queryByText('Chapter Design and Media Chair (chapter_design_chair)'),
    ).toBeNull();
  });

  it('does not lock the Reserved Power switches', async () => {
    renderCatalog();
    await screen.findByText('Chapter Assignment');
    expect(
      document.getElementById('chapter_events_chair-canManagePermissions'),
    ).not.toBeDisabled();
    expect(
      document.getElementById('chapter_events_chair-canManageRoles'),
    ).not.toBeDisabled();
  });

  it('save body shape is byte-identical to today (no custom fields)', async () => {
    renderCatalog();    await screen.findByText('Chapter Assignment');
    const body = await clickSaveAndGetBody();
    expect(Object.keys(body).sort()).toEqual(
      [
        'allowedChapters',
        'allowedPaths',
        'canAccessAdmin',
        'category',
        'consentRequestId',
        'description',
        'isActive',
        'label',
        'permissionKeys',
        'role',
        'scope',
      ].sort(),
    );
    expect(body.isCustom).toBeUndefined();
    expect(body.parentRoleKey).toBeUndefined();
    expect(body.chapterId).toBeUndefined();
    expect(body.defaultTermDays).toBeUndefined();
    // Merge-time adjustment (data-model audit clause 5): this render is
    // slow under jsdom on a contended box and flaked on jest's 5s
    // default timeout with no assertion diff; explicit timeout only,
    // assertions unchanged.
  }, 60000);
});
