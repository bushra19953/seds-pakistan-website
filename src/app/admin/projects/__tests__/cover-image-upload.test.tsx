/**
 * Cover image upload for /admin/projects (MSG29).
 *
 * Reproduce-first: before this fix the project Edit/Create dialog had
 * NO upload control at all. ImageUploader was imported in page.tsx
 * but never rendered, and Media URLs was free text only, so an admin
 * could not upload a cover image through the form. The save path
 * already derives imageUrl from media[0], so wiring the existing
 * Drive-backed ImageUploader to media[0] needs no model change.
 *
 * Proof pinned here, through the real save path (POST
 * /api/admin/projects op 'set'):
 *   1. the Edit dialog offers a cover image upload control,
 *   2. uploading through it shows the new image in the dialog and
 *      saves it as the cover (media[0] and imageUrl) while every
 *      other field stays identical,
 *   3. a project with no media at all gains exactly [newUrl].
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

// Same classic-JSX-runtime note as delete-flow.test.tsx: provide
// React globally from the test file only; no source change.
(globalThis as any).React = React;

const mockToast = jest.fn();
const mockServerWrite = jest.fn(async (..._args: any[]) => ({ status: 200, body: { ok: true } }));

const NEW_COVER_URL = 'https://drive.example/cover-new.jpg';

const PROJECT_WITH_MEDIA = {
  id: 'proj-1',
  title: 'SEDS Prestige Engine CH07',
  slug: 'seds-prestige-engine-ch07',
  description: 'Project workspace for the SEDS Prestige Engine Chapter 07 mission workflow series.',
  status: 'active',
  team: ['member-1'],
  teamLeaderId: 'member-1',
  createdBy: 'admin-1',
  createdAt: { seconds: 1760000000 },
  media: ['https://old.example/old-cover.jpg', 'https://old.example/second.jpg'],
  video_url: 'https://www.youtube.com/watch?v=oldvideo',
  github_repo: 'https://github.com/org/repo',
  docs_url: 'https://docs.example.com/project',
  showOnHomepage: true,
  tags: ['technical', 'custom-tag'],
};

const PROJECT_NO_MEDIA = {
  ...PROJECT_WITH_MEDIA,
  id: 'proj-2',
  title: 'No Media Project',
  slug: 'no-media-project',
  media: undefined,
};

// The list fixture is per-test so the no-media branch gets its own row.
let currentList: any[] = [PROJECT_WITH_MEDIA];
const snapshotWith = (docs: any[]) => ({
  forEach: (cb: (doc: any) => void) => docs.forEach(cb),
});
const mockGetDocs = jest.fn(async (..._args: any[]) =>
  snapshotWith(currentList.map((p) => ({ id: p.id, data: () => ({ ...p }) }))),
);

// Stable user identity: the list effect depends on `user`, so a fresh
// object per render would retrigger the fetch on every render.
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

// The real ImageUploader drives uploadToDrive (network + Firebase
// auth); the unit under test here is the dialog wiring, so the stub
// stands at exactly the onUploadComplete boundary the real control
// calls with the Drive download URL after a successful upload.
jest.mock('@/components/admin/image-uploader', () => ({
  __esModule: true,
  default: ({ onUploadComplete }: any) => (
    <button data-testid="cover-upload-simulate" onClick={() => onUploadComplete(NEW_COVER_URL)}>
      Simulate cover upload
    </button>
  ),
}));

import AdminProjectsPage from '../page';

jest.setTimeout(30000);

beforeEach(() => {
  jest.clearAllMocks();
  currentList = [PROJECT_WITH_MEDIA];
});

const FIND = { timeout: 10000 };

async function openEditDialogFor(title: string) {
  render(<AdminProjectsPage />);
  const titleCell = await screen.findByText(title, {}, FIND);
  const row = titleCell.closest('tr');
  if (!row) throw new Error('project row not found');
  // Row buttons: edit first, trash second (Tasks is a link, not a button).
  const buttons = within(row as HTMLElement).getAllByRole('button');
  fireEvent.click(buttons[0]);
  await screen.findByRole('dialog', {}, FIND);
}

async function saveDialog() {
  const saveButton = await screen.findByRole('button', { name: 'Save changes' }, FIND);
  fireEvent.click(saveButton);
  await waitFor(() => expect(mockServerWrite).toHaveBeenCalledTimes(1), FIND);
  return mockServerWrite.mock.calls[0][2];
}

it('offers a cover image upload control in the Edit dialog', async () => {
  await openEditDialogFor(PROJECT_WITH_MEDIA.title);
  expect(await screen.findByText('Cover image', {}, FIND)).toBeTruthy();
  expect(await screen.findByTestId('cover-upload-simulate', {}, FIND)).toBeTruthy();
});

it('uploading a cover shows the new image and saves only the cover change', async () => {
  await openEditDialogFor(PROJECT_WITH_MEDIA.title);
  fireEvent.click(await screen.findByTestId('cover-upload-simulate', {}, FIND));

  // The project shows the image before any save: the dialog preview
  // carries the new Drive URL, and the Media URLs text reflects it
  // as the first entry.
  const preview = await screen.findByAltText('Current cover', {}, FIND);
  expect(preview.getAttribute('src')).toBe(NEW_COVER_URL);
  const mediaInput = screen.getByLabelText(/Media URLs/) as HTMLInputElement;
  expect(mediaInput.value.startsWith(NEW_COVER_URL)).toBe(true);

  const payload = await saveDialog();
  expect(payload.op).toBe('set');
  expect(payload.id).toBe('proj-1');
  // The cover changes; the rest of the media list is preserved.
  expect(payload.data.media).toEqual([NEW_COVER_URL, 'https://old.example/second.jpg']);
  expect(payload.data.imageUrl).toBe(NEW_COVER_URL);
  // Every other field is byte-identical to the fixture. Tags go
  // through the pre-existing ensure-type normalization, which keeps
  // the same set here (technical was already the type tag).
  expect(payload.data.title).toBe(PROJECT_WITH_MEDIA.title);
  expect(payload.data.slug).toBe(PROJECT_WITH_MEDIA.slug);
  expect(payload.data.description).toBe(PROJECT_WITH_MEDIA.description);
  expect(payload.data.status).toBe('active');
  expect(payload.data.video_url).toBe('https://www.youtube.com/watch?v=oldvideo');
  expect(payload.data.github_repo).toBe('https://github.com/org/repo');
  expect(payload.data.docs_url).toBe('https://docs.example.com/project');
  expect(payload.data.team).toEqual(['member-1']);
  expect(payload.data.teamMemberIds).toEqual(['member-1']);
  expect(payload.data.teamLeaderId).toBe('member-1');
  expect(payload.data.showOnHomepage).toBe(true);
  expect([...payload.data.tags].sort()).toEqual(['custom-tag', 'technical']);
  expect(payload.data.summary).toBe(PROJECT_WITH_MEDIA.description);
});

it('a project with no media gains exactly the uploaded cover', async () => {
  currentList = [PROJECT_NO_MEDIA];
  await openEditDialogFor(PROJECT_NO_MEDIA.title);
  fireEvent.click(await screen.findByTestId('cover-upload-simulate', {}, FIND));
  const preview = await screen.findByAltText('Current cover', {}, FIND);
  expect(preview.getAttribute('src')).toBe(NEW_COVER_URL);
  const payload = await saveDialog();
  expect(payload.data.media).toEqual([NEW_COVER_URL]);
  expect(payload.data.imageUrl).toBe(NEW_COVER_URL);
});
