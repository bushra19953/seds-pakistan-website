/**
 * Applications inbox tests for the Universal Inbox page.
 *
 * Covers the fix for the dead Applications tab: induction applications
 * live in the `applications` collection (they are never mirrored into
 * `submissions`; the webhook mirror targets `universal_submissions`,
 * which no page reads). The page now listens to `applications` directly
 * for in-pipeline statuses and maps each doc to a UniversalSubmission
 * row (type APPLICATION, global_id / original_ref `applications/{uid}`),
 * so the row opens in the application inspector, which reviews the real
 * doc through the universal-review API.
 *
 * The page is rendered for real. Firestore, the auth hook, the
 * AuthorizationGate, the drawer factory, and the virtualizer are mocked
 * so the onSnapshot callbacks can be driven with fake application docs.
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// The repo Jest config uses the classic JSX runtime (jsx: "react"), so
// components that rely on the Next.js automatic runtime (page.tsx has no
// React import) resolve `React` as a free variable at render time.
// Provide it globally from the test file only; no source change.
(globalThis as any).React = React;

const mockSnapshotCallbacks: Record<string, any> = {};

jest.mock('firebase/firestore', () => ({
  collection: (_db: any, name: string) => ({ __collection: name }),
  query: (...args: any[]) => ({ __query: args[0]?.__collection }),
  orderBy: (...args: any[]) => ({ __orderBy: args }),
  where: (...args: any[]) => ({ __where: args }),
  limit: (n: number) => ({ __limit: n }),
  startAfter: (...args: any[]) => ({ __startAfter: args }),
  getDocs: jest.fn(async () => ({ docs: [] })),
  doc: (...args: any[]) => ({ path: args.slice(1).join('/'), id: args[args.length - 1] }),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => undefined })),
  onSnapshot: (q: any, onNext: any) => {
    mockSnapshotCallbacks[q.__query] = onNext;
    return () => {};
  },
}));

jest.mock('@/firebase/provider', () => ({
  getFirebaseApp: () => ({}),
  getFirestoreService: () => ({}),
}));

jest.mock('@/hooks/use-user', () => ({
  useUser: () => ({ user: { uid: 'admin-1' }, role: 'admin' }),
}));

jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('../drawer-content-factory', () => ({
  __esModule: true,
  default: ({ submission }: any) =>
    submission ? <div data-testid="drawer">{JSON.stringify(submission)}</div> : null,
}));

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: any) => ({
    getTotalSize: () => opts.count * 64,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, size: 64, start: i * 64 })),
  }),
}));

import AdminSubmissionsPage from '../page';

function fireSnapshot(collectionName: string, docs: Array<{ id: string; data: any }>): void {
  const cb = mockSnapshotCallbacks[collectionName];
  expect(cb).toBeDefined();
  act(() => {
    cb({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });
  });
}

const APPLICATION_FULL = {
  uid: 'applicant-1',
  fullName: 'Ayesha Khan',
  email: 'ayesha@example.com',
  university: 'Institute of Space Technology',
  department: 'Aerospace Engineering',
  studyYear: '3',
  status: 'pending',
  chapterId: 'seds-ist-chapter',
  created_at: '2026-10-21T00:00:00.000Z',
  skills: ['CAD'],
  interestAreas: ['Rocketry'],
};

function renderInboxWithApplicationDocs(appDocs: Array<{ id: string; data: any }>): void {
  render(<AdminSubmissionsPage />);
  fireSnapshot('submissions', [
    {
      id: 'sub-1',
      data: {
        type: 'SUBMISSION',
        status: 'PENDING',
        summary_text: 'Competition entry',
        user_display_name: 'Submitter',
        created_at: '2026-10-21T00:00:00.000Z',
      },
    },
  ]);
  fireSnapshot('tasks', []);
  fireSnapshot('leave_requests', []);
  fireSnapshot('applications', appDocs);
}

describe('applications inbox mapping', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockSnapshotCallbacks)) delete mockSnapshotCallbacks[key];
  });

  test('maps a pending application doc to an APPLICATION row with ref form and PENDING status', async () => {
    renderInboxWithApplicationDocs([{ id: 'applicant-1', data: APPLICATION_FULL }]);
    expect(await screen.findByText('Application: Ayesha Khan')).toBeInTheDocument();
    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument();
    expect(screen.getAllByText('APPLICATION').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
  });

  test('Applications tab shows only application rows and All shows every row', async () => {
    renderInboxWithApplicationDocs([{ id: 'applicant-1', data: APPLICATION_FULL }]);
    expect(await screen.findByText('Application: Ayesha Khan')).toBeInTheDocument();
    expect(screen.getByText('Competition entry')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
    expect(screen.getByText('Application: Ayesha Khan')).toBeInTheDocument();
    expect(screen.queryByText('Competition entry')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All Submissions' }));
    expect(screen.getByText('Competition entry')).toBeInTheDocument();
    expect(screen.getByText('Application: Ayesha Khan')).toBeInTheDocument();
  });

  test('clicking an application row passes global_id, original_ref, and passthrough fields to the drawer', async () => {
    renderInboxWithApplicationDocs([{ id: 'applicant-1', data: APPLICATION_FULL }]);
    fireEvent.click(await screen.findByText('Application: Ayesha Khan'));
    const drawer = await screen.findByTestId('drawer');
    const row = JSON.parse(drawer.textContent || '{}');
    expect(row.type).toBe('APPLICATION');
    expect(row.global_id).toBe('applications/applicant-1');
    expect(row.original_ref).toBe('applications/applicant-1');
    expect(row.status).toBe('PENDING');
    expect(row.summary_text).toBe('Application: Ayesha Khan');
    expect(row.user_id).toBe('applicant-1');
    expect(row.user_display_name).toBe('Ayesha Khan');
    expect(row.chapter_id).toBe('seds-ist-chapter');
    expect(row.university).toBe('Institute of Space Technology');
    expect(row.department).toBe('Aerospace Engineering');
    expect(row.skills).toEqual(['CAD']);
    expect(row.interestAreas).toEqual(['Rocketry']);
  });

  test('in-pipeline statuses render as readable badges', async () => {
    renderInboxWithApplicationDocs([
      { id: 'applicant-2', data: { ...APPLICATION_FULL, uid: 'applicant-2', fullName: 'Bilal Ahmed', status: 'under_review' } },
      { id: 'applicant-3', data: { ...APPLICATION_FULL, uid: 'applicant-3', fullName: 'Chand Bibi', status: 'shortlisted' } },
    ]);
    expect(await screen.findByText('Application: Bilal Ahmed')).toBeInTheDocument();
    expect(screen.getByText('Application: Chand Bibi')).toBeInTheDocument();
    expect(screen.getAllByText('UNDER REVIEW').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SHORTLISTED').length).toBeGreaterThan(0);
  });

  test('summary and name fall back to email when fullName is missing', async () => {
    renderInboxWithApplicationDocs([
      {
        id: 'applicant-4',
        data: { uid: 'applicant-4', email: 'no-name@example.com', status: 'pending', created_at: '2026-10-20T00:00:00.000Z' },
      },
    ]);
    expect(await screen.findByText('Application: no-name@example.com')).toBeInTheDocument();
    expect(screen.getByText('no-name@example.com')).toBeInTheDocument();
  });

  test('summary falls back to a generic label when neither name nor email is present', async () => {
    renderInboxWithApplicationDocs([
      { id: 'applicant-5', data: { status: 'pending', created_at: '2026-10-19T00:00:00.000Z' } },
    ]);
    expect(await screen.findByText('Induction Application')).toBeInTheDocument();
    expect(screen.getByText('Anonymous User')).toBeInTheDocument();
  });

  test('rows sort newest first by created_at', async () => {
    renderInboxWithApplicationDocs([
      { id: 'applicant-old', data: { ...APPLICATION_FULL, uid: 'applicant-old', fullName: 'Old Applicant', created_at: '2026-10-18T00:00:00.000Z' } },
      { id: 'applicant-new', data: { ...APPLICATION_FULL, uid: 'applicant-new', fullName: 'New Applicant', created_at: '2026-10-21T00:00:00.000Z' } },
    ]);
    expect(await screen.findByText('Application: New Applicant')).toBeInTheDocument();
    const summaries = screen
      .getAllByText(/^Application: /)
      .map((el) => el.textContent);
    expect(summaries[0]).toBe('Application: New Applicant');
    expect(summaries[1]).toBe('Application: Old Applicant');
  });
});
