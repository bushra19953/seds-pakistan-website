/**
 * Leave inbox tests for the Universal Inbox page (Worker D).
 *
 * Covers the Worker A fix: the third inbox listener on `leave_requests`
 * where status == "pending" maps each doc to a UniversalSubmission row
 * (type LEAVE_REQUEST, global_id / original_ref `leave_requests/{docId}`,
 * status PENDING, summary text with dates and fallbacks, passthrough
 * fields), the rows join the combined list, and the Leave Requests tab
 * (id LEAVE_REQUEST) shows them.
 *
 * The page is rendered for real. Firestore, the auth hook, the
 * AuthorizationGate, the drawer factory, and the virtualizer are mocked
 * so the onSnapshot callbacks can be driven with fake leave docs.
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

const LEAVE_FULL = {
  userId: 'member-1',
  userDisplayName: 'Member One',
  userPhotoUrl: 'https://example.com/photo.jpg',
  chapterId: 'seds-ist-chapter',
  createdAt: '2026-10-20T00:00:00.000Z',
  startDate: '2026-10-20',
  endDate: '2026-10-24',
  leaveType: 'annual',
  reason: 'Family trip',
  coveringOfficerId: 'officer-1',
};

function renderInboxWithLeaveDocs(leaveDocs: Array<{ id: string; data: any }>): void {
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
  fireSnapshot('leave_requests', leaveDocs);
}

describe('leave_requests inbox mapping', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockSnapshotCallbacks)) delete mockSnapshotCallbacks[key];
  });

  test('maps a full leave doc to a LEAVE_REQUEST row with ref form, PENDING status, and dated summary', async () => {
    renderInboxWithLeaveDocs([{ id: 'leave-1', data: LEAVE_FULL }]);
    expect(await screen.findByText('Leave Request: 2026-10-20 to 2026-10-24')).toBeInTheDocument();
    expect(screen.getByText('Member One')).toBeInTheDocument();
    expect(screen.getAllByText('LEAVE_REQUEST').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
  });

  test('Leave Requests tab shows only leave rows and All shows every row', async () => {
    renderInboxWithLeaveDocs([{ id: 'leave-1', data: LEAVE_FULL }]);
    expect(await screen.findByText('Leave Request: 2026-10-20 to 2026-10-24')).toBeInTheDocument();
    expect(screen.getByText('Competition entry')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Leave Requests' }));
    expect(screen.getByText('Leave Request: 2026-10-20 to 2026-10-24')).toBeInTheDocument();
    expect(screen.queryByText('Competition entry')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All Submissions' }));
    expect(screen.getByText('Competition entry')).toBeInTheDocument();
    expect(screen.getByText('Leave Request: 2026-10-20 to 2026-10-24')).toBeInTheDocument();
  });

  test('summary falls back to leave type when no dates are present', async () => {
    renderInboxWithLeaveDocs([
      { id: 'leave-2', data: { userId: 'member-2', userDisplayName: 'Member Two', createdAt: '2026-10-19T00:00:00.000Z', leaveType: 'sick' } },
    ]);
    expect(await screen.findByText('Leave Request: sick')).toBeInTheDocument();
  });

  test('summary falls back to bare Leave Request when no dates and no type are present', async () => {
    renderInboxWithLeaveDocs([
      { id: 'leave-3', data: { userId: 'member-3', createdAt: '2026-10-18T00:00:00.000Z' } },
    ]);
    expect(await screen.findByText('Leave Request')).toBeInTheDocument();
    expect(screen.getByText('Anonymous User')).toBeInTheDocument();
  });

  test('summary falls back to start date only when only a start date is present', async () => {
    renderInboxWithLeaveDocs([
      { id: 'leave-4', data: { userId: 'member-4', userDisplayName: 'Member Four', createdAt: '2026-10-18T00:00:00.000Z', startDate: '2026-11-01' } },
    ]);
    expect(await screen.findByText('Leave Request: 2026-11-01')).toBeInTheDocument();
  });

  test('clicking a leave row passes global_id, original_ref, and passthrough fields to the drawer', async () => {
    renderInboxWithLeaveDocs([{ id: 'leave-1', data: LEAVE_FULL }]);
    fireEvent.click(await screen.findByText('Leave Request: 2026-10-20 to 2026-10-24'));
    const drawer = await screen.findByTestId('drawer');
    const row = JSON.parse(drawer.textContent || '{}');
    expect(row.type).toBe('LEAVE_REQUEST');
    expect(row.global_id).toBe('leave_requests/leave-1');
    expect(row.original_ref).toBe('leave_requests/leave-1');
    expect(row.status).toBe('PENDING');
    expect(row.summary_text).toBe('Leave Request: 2026-10-20 to 2026-10-24');
    expect(row.user_id).toBe('member-1');
    expect(row.user_display_name).toBe('Member One');
    expect(row.chapter_id).toBe('seds-ist-chapter');
    expect(row.leaveType).toBe('annual');
    expect(row.startDate).toBe('2026-10-20');
    expect(row.endDate).toBe('2026-10-24');
    expect(row.reason).toBe('Family trip');
    expect(row.coveringOfficerId).toBe('officer-1');
  });

  test('legacy snake_case fields map to the same row shape', async () => {
    renderInboxWithLeaveDocs([
      {
        id: 'leave-5',
        data: {
          user_id: 'member-5',
          name: 'Member Five',
          chapter_id: 'seds-ist-chapter',
          created_at: '2026-10-17T00:00:00.000Z',
          start_date: '2026-12-01',
          end_date: '2026-12-03',
          leave_type: 'emergency',
          covering_officer_id: 'officer-9',
        },
      },
    ]);
    expect(await screen.findByText('Leave Request: 2026-12-01 to 2026-12-03')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Leave Request: 2026-12-01 to 2026-12-03'));
    const row = JSON.parse((await screen.findByTestId('drawer')).textContent || '{}');
    expect(row.global_id).toBe('leave_requests/leave-5');
    expect(row.user_id).toBe('member-5');
    expect(row.user_display_name).toBe('Member Five');
    expect(row.leaveType).toBe('emergency');
    expect(row.coveringOfficerId).toBe('officer-9');
  });
});
