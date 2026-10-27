/**
 * Delete flow tests for /admin/projects.
 *
 * Before this fix the trash button called handleDeleteProject, whose
 * first statement gated on the native window.confirm(). Automated
 * browsers auto-dismiss native dialogs, so confirm() returned false
 * and the handler returned silently: no dialog, no write, no toast,
 * no network call. The button appeared completely dead in the
 * Oct 27, 2026 founder-admin pass even though the downstream delete
 * (POST /api/admin/projects op 'delete', Firestore delete, Supabase
 * mirror delete, list refresh) was fully built. These tests pin the
 * in-app confirmation flow that replaced it, mirroring the earlier
 * announcements cure: the trash button only sets deleteTarget,
 * Cancel performs no write at all, and Delete runs confirmDeleteProject
 * with the target project's id and refreshes the list. The page
 * performs no client Firestore delete.
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

// The repo Jest config uses the classic JSX runtime (jsx: "react"), so
// components that rely on the Next.js automatic runtime resolve `React`
// as a free variable at render time. Provide it globally from the test
// file only; no source change.
(globalThis as any).React = React;

const mockToast = jest.fn();
const mockServerWrite = jest.fn(async (..._args: any[]) => ({ status: 200, body: { ok: true } }));

const PROJECT = {
  id: 'proj-1',
  title: 'SEDS Prestige Engine CH07',
  slug: 'seds-prestige-engine-ch07',
  description: 'Project workspace for the SEDS Prestige Engine Chapter 07 mission workflow series.',
  status: 'active',
  team: [],
  teamLeaderId: 'leader-1',
  createdBy: 'admin-1',
  createdAt: { seconds: 1760000000 },
};

// The list fetch reads through getDocs. The first call returns the
// project; later calls (the post-delete refresh) return an empty list,
// which also lets the confirm test observe the row disappearing.
let fetchCount = 0;
const snapshotWith = (docs: any[]) => ({
  forEach: (cb: (doc: any) => void) => docs.forEach(cb),
});
const mockGetDocs = jest.fn(async (..._args: any[]) => {
  fetchCount += 1;
  if (fetchCount === 1) {
    return snapshotWith([{ id: PROJECT.id, data: () => ({ ...PROJECT }) }]);
  }
  return snapshotWith([]);
});

// The signed-in user must be a stable object identity: the page's
// list effect depends on `user`, so a mock that mints a fresh object
// per render would retrigger the fetch on every render and the table
// would churn between the skeleton and the rows.
const MOCK_USER = { uid: 'admin-1' };

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: MOCK_USER, isLoading: false }),
  useCollection: () => ({ data: [], loading: false }),
}));

jest.mock('@/firebase/provider', () => ({
  getFirebaseApp: () => ({}),
  useFirestore: () => ({}),
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  collection: (_db: any, name: string) => ({ name }),
  query: (ref: any) => ref,
  getDocs: (...args: any[]) => mockGetDocs(...args),
  doc: () => ({}),
  Timestamp: { fromDate: (d: Date) => d },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, isLoading: false, role: 'founder_patron' }),
}));

jest.mock('@/lib/client/server-write', () => ({
  serverWrite: (...args: any[]) => mockServerWrite(...args),
}));

jest.mock('@/lib/projects-supa', () => ({
  fetchAdminProjectRowsViaRoute: jest.fn(async () => []),
  getCurrentUserIdToken: jest.fn(async () => 'token'),
  projectsSupaClientEnabled: () => false,
  restoreProjectTimestamps: (data: any) => data,
}));

jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/admin/multi-select-user-combobox', () => ({
  __esModule: true,
  default: () => <div data-testid="multi-select-user-combobox" />,
}));

jest.mock('@/components/admin/user-selection-combobox', () => ({
  __esModule: true,
  default: () => <div data-testid="user-selection-combobox" />,
}));

jest.mock('@/components/admin/image-uploader', () => ({
  __esModule: true,
  default: () => <div data-testid="image-uploader" />,
}));

import AdminProjectsPage from '../page';

// The list load and dialog mount cross several async hops; on a
// loaded box they exceed the default 5s per-test budget, so the
// suite gets a wider one (the finder budgets below stay at 10s).
jest.setTimeout(30000);

let confirmSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  fetchCount = 0;
  confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

// The row's Actions cell holds a Tasks link (rendered as a link, not a
// button), an edit button, and the trash button, in that order. The
// trash button is the last button in the row. Finder timeouts are
// generous because the list load and the Radix dialog mount both go
// through async hops that the default 1s findBy budget does not
// reliably cover.
const FIND = { timeout: 10000 };

async function clickTrashForProject() {
  const titleCell = await screen.findByText(PROJECT.title, {}, FIND);
  const row = titleCell.closest('tr');
  if (!row) throw new Error('project row not found');
  const buttons = within(row as HTMLElement).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]);
}

it('opens an in-app confirmation dialog naming the project when the trash button is clicked', async () => {
  render(<AdminProjectsPage />);
  await clickTrashForProject();
  expect(await screen.findByText('Delete Project', {}, FIND)).toBeTruthy();
  // The title now appears twice in the document (table row plus the
  // dialog description), so the naming assertion is scoped to the
  // dialog itself.
  const dialog = await screen.findByRole('dialog', {}, FIND);
  expect(within(dialog).getByText(new RegExp(PROJECT.title))).toBeTruthy();
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(mockServerWrite).not.toHaveBeenCalled();
});

it('performs no write when the delete dialog is cancelled', async () => {
  render(<AdminProjectsPage />);
  await clickTrashForProject();
  const cancelButton = await screen.findByRole('button', { name: 'Cancel' }, FIND);
  fireEvent.click(cancelButton);
  await waitFor(() => expect(screen.queryByText('Delete Project')).toBeNull(), FIND);
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(mockServerWrite).not.toHaveBeenCalled();
  expect(fetchCount).toBe(1);
});

it('deletes through the server route and refreshes the list on confirm', async () => {
  render(<AdminProjectsPage />);
  await clickTrashForProject();
  const deleteButton = await screen.findByRole('button', { name: 'Delete' }, FIND);
  fireEvent.click(deleteButton);
  await waitFor(() => expect(mockServerWrite).toHaveBeenCalledTimes(1), FIND);
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(mockServerWrite).toHaveBeenCalledWith(
    '/api/admin/projects',
    'POST',
    expect.objectContaining({
      op: 'delete',
      id: 'proj-1',
      mirrorOp: 'delete',
      audit: expect.objectContaining({
        action: 'project_deleted',
        target: 'proj-1',
        payload: { projectId: 'proj-1' },
      }),
    })
  );
  await waitFor(
    () =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Project Deleted' })
      ),
    FIND
  );
  // The refresh re-reads the list; the second getDocs returns empty,
  // so the deleted row leaves the table.
  await waitFor(() => expect(screen.queryByText(PROJECT.title)).toBeNull(), FIND);
  expect(fetchCount).toBeGreaterThan(1);
});
