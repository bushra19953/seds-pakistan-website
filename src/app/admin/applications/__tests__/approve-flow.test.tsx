/**
 * Approve flow tests for /admin/applications.
 *
 * Before this fix the page offered only Shortlist and Reject (direct
 * client writes) and no Approve at all, even though the universal-review
 * API implements approval server-side. These tests pin the wiring:
 * Approve opens a confirmation dialog, Confirm calls
 * PATCH /api/admin/universal-review with {collection: 'applications',
 * ids: [uid], action: 'approve'} and the admin ID token, the page-side
 * mirror (users doc applicationStatus) and audit entry follow a landed
 * approval, a server-side terminal skip is reported as "Already
 * reviewed" instead of success, a server error keeps the dialog open,
 * and terminal applications show no action buttons.
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

  test('confirming approve PATCHes the universal-review API and applies the mirror, audit entry, and stage stamp', async () => {
    mockFetch.mockResolvedValue(
      fetchResponse(true, { success: true, updated: 1, results: [{ id: 'applicant-1', success: true }] })
    );

    await selectPendingAndOpenApproveDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/admin/universal-review');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe('Bearer test-id-token');
    expect(JSON.parse(init.body)).toEqual({
      collection: 'applications',
      ids: ['applicant-1'],
      action: 'approve',
    });

    // The users-doc mirror the applicant portal reads.
    await waitFor(() =>
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        { path: 'users/applicant-1' },
        expect.objectContaining({ applicationStatus: 'approved' })
      )
    );
    // The applicant tracker stage stamp.
    expect(mockUpdateDoc).toHaveBeenCalledWith(
      { path: 'applications/applicant-1' },
      { 'stageHistory.onboardingAt': 'SERVER_TS' }
    );
    // The page audit entry the status-history view depends on.
    expect(mockLogAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      'application_status_updated',
      'admin-1',
      'applicant-1',
      expect.objectContaining({ new_status: 'approved' })
    );
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
