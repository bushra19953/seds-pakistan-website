/**
 * Approve flow tests for /admin/applications.
 *
 * Before this fix the page offered only Shortlist and Reject (direct
 * client writes) and no Approve at all, even though the universal-review
 * API implements approval server-side. These tests pin the wiring:
 * Approve opens a confirmation dialog, Confirm calls
 * PATCH /api/admin/universal-review with {collection: 'applications',
 * ids: [uid], action: 'approve'} and the admin ID token, a landed
 * approval is followed by the post-approve sync, a server-side
 * terminal skip is reported as "Already reviewed" instead of success,
 * a server error keeps the dialog open, and terminal applications
 * show no action buttons.
 *
 * WS10 relocation (A3): the post-approve pieces the page used to write
 * itself (users doc applicationStatus mirror, the
 * application_status_updated audit entry, the stageHistory stamp) are
 * owned by POST /api/admin/applications/status op 'post-approve-sync';
 * the page only calls that route after a landed approval and performs
 * no client Firestore write. The route's effects are pinned
 * behaviorally by the status route's route-ws10 suite (stamp =
 * stageHistory.onboardingAt, users mirror = {applicationStatus:
 * 'approved', updatedAt}, audit entry = application_status_updated
 * with new_status 'approved').
 *
 * The page is rendered for real. Firestore, auth, the list and form
 * editor children, the audit logger, and fetch are mocked. No em dashes
 * are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// The repo Jest config uses the classic JSX runtime (jsx: "react"), so
// components that rely on the Next.js automatic runtime resolve `React`
// as a free variable at render time. Provide it globally from the test
// file only; no source change.
(globalThis as any).React = React;

const mockGetIdToken = jest.fn(async () => 'test-id-token');
const mockToast = jest.fn();
const mockUpdateDoc = jest.fn(async (..._args: any[]) => undefined);
const mockLogAuditEntry = jest.fn(async (..._args: any[]) => undefined);
const mockFetch = jest.fn();

const PENDING_APP = {
  uid: 'applicant-1',
  email: 'ayesha@example.com',
  fullName: 'Ayesha Khan',
  university: 'Institute of Space Technology',
  department: 'Aerospace Engineering',
  studyYear: '3',
  status: 'pending',
  created_at: { toDate: () => new Date('2026-10-21T00:00:00.000Z') },
  skills: ['CAD'],
  interestAreas: ['Rocketry'],
};

const APPROVED_APP = { ...PENDING_APP, uid: 'applicant-2', fullName: 'Bilal Ahmed', status: 'approved' };

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: { uid: 'admin-1', getIdToken: mockGetIdToken } }),
}));

jest.mock('@/firebase/provider', () => ({
  getFirebaseApp: () => ({}),
}));

jest.mock('@/firebase/error-handler', () => ({
  handleFirestoreError: (e: any) => e,
  getUserFriendlyErrorMessage: () => 'error',
  FirestoreErrorContext: {},
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ hasPermission: () => true, loading: false }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  doc: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => undefined })),
  getDocs: jest.fn(async () => ({ docs: [] })),
  collection: (_db: any, name: string) => ({ __collection: name }),
  query: (...args: any[]) => ({ __query: args }),
  where: (...args: any[]) => ({ __where: args }),
  serverTimestamp: () => 'SERVER_TS',
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  updateDoc: (...args: any[]) => mockUpdateDoc(...args),
  setDoc: jest.fn(async () => undefined),
}));

jest.mock('@/lib/audit-logging', () => ({
  logAuditEntry: (...args: any[]) => mockLogAuditEntry(...args),
}));

jest.mock('@/components/admin/applications/application-list', () => ({
  __esModule: true,
  default: ({ onSelectApplication }: any) => (
    <div>
      <button onClick={() => onSelectApplication(PENDING_APP)}>Select pending applicant</button>
      <button onClick={() => onSelectApplication(APPROVED_APP)}>Select approved applicant</button>
    </div>
  ),
}));

jest.mock('@/components/admin/applications/induction-form-editor', () => ({
  __esModule: true,
  default: () => null,
}));

import AdminApplicationsPage from '../page';

function fetchResponse(ok: boolean, body: any) {
  return { ok, json: async () => body };
}

async function selectPendingAndOpenApproveDialog() {
  render(<AdminApplicationsPage />);
  fireEvent.click(await screen.findByText('Select pending applicant'));
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Approve Application')).toBeInTheDocument();
}

describe('admin applications approve flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as any).fetch = mockFetch;
  });

  test('confirming approve PATCHes the universal-review API and fires the post-approve sync', async () => {
    mockFetch.mockResolvedValue(
      fetchResponse(true, { success: true, updated: 1, results: [{ id: 'applicant-1', success: true }] })
    );

    await selectPendingAndOpenApproveDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));

    // The page also fetches the induction window (Grove item 11 pace line)
    // on mount; the approve action itself must issue exactly one PATCH.
    const reviewCalls = () =>
      mockFetch.mock.calls.filter(([u]) => u === '/api/admin/universal-review');
    await waitFor(() => expect(reviewCalls()).toHaveLength(1));
    const [url, init] = reviewCalls()[0];
    expect(url).toBe('/api/admin/universal-review');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe('Bearer test-id-token');
    expect(JSON.parse(init.body)).toEqual({
      collection: 'applications',
      ids: ['applicant-1'],
      action: 'approve',
    });

    // The post-approve sync: the route owns the users-doc mirror the
    // applicant portal reads, the stage stamp, and the audit entry
    // (route-ws10 pins those effects); the page fires exactly one
    // sync call for the approved applicant.
    const statusCalls = () =>
      mockFetch.mock.calls.filter(([u]) => u === '/api/admin/applications/status');
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    const [statusUrl, statusInit] = statusCalls()[0];
    expect(statusUrl).toBe('/api/admin/applications/status');
    expect(statusInit.method).toBe('POST');
    expect(JSON.parse(statusInit.body)).toEqual({
      op: 'post-approve-sync',
      applicationId: 'applicant-1',
    });
    // No client Firestore write or client audit entry remains: the
    // page's wrapper updateDoc and logAuditEntry are never called.
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockLogAuditEntry).not.toHaveBeenCalled();
    // Success is reported and the decided application leaves the
    // actionable state in the detail pane.
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Application Approved' })
    );
    expect(
      await screen.findByText('This application has been approved. The decision is final.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('a terminal skip from the API is reported as already reviewed and writes no mirror or audit entry', async () => {
    mockFetch.mockResolvedValue(
      fetchResponse(true, {
        success: true,
        updated: 0,
        skippedAlreadyReviewed: ['applicant-1'],
        results: [{ id: 'applicant-1', success: false, error: 'Already reviewed (terminal state)' }],
      })
    );

    await selectPendingAndOpenApproveDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Already reviewed' }))
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Application Approved' })
    );
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockLogAuditEntry).not.toHaveBeenCalled();
    // A skipped approval fires no post-approve sync either.
    expect(
      mockFetch.mock.calls.filter(([u]) => u === '/api/admin/applications/status')
    ).toHaveLength(0);
  });

  test('a server error keeps the dialog open and writes nothing', async () => {
    mockFetch.mockResolvedValue(fetchResponse(false, { error: 'Approval storage unavailable' }));

    await selectPendingAndOpenApproveDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Error', description: 'Approval storage unavailable' })
      )
    );
    expect(screen.getByRole('button', { name: 'Confirm Approve' })).toBeInTheDocument();
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockLogAuditEntry).not.toHaveBeenCalled();
    expect(
      mockFetch.mock.calls.filter(([u]) => u === '/api/admin/applications/status')
    ).toHaveLength(0);
  });

  test('an already approved application shows no action buttons', async () => {
    render(<AdminApplicationsPage />);
    fireEvent.click(await screen.findByText('Select approved applicant'));
    expect(
      await screen.findByText('This application has been approved. The decision is final.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Shortlist' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });
});
