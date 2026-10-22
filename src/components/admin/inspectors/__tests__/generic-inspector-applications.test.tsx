/**
 * Application drawer tests for GenericInspector.
 *
 * Covers the inbox side of the induction approval fix. Application rows
 * (originalRef applications/{uid}) review through the same
 * universal-review API as /admin/applications, so the drawer must settle
 * identically to that page:
 * - Approve/Reject send { collection: "applications", ids: [uid], action }
 *   with NO points field (admission is not a task completion; the page
 *   sends no points) and NO extraFields.
 * - The Points to Award control is hidden, since it would never be sent.
 * - After a landed decision the inspector writes the users-doc status
 *   mirror (applicationStatus, plus hasApplied false on reject) and the
 *   application_status_updated audit entry, which the API route does not
 *   write but the applicant portal and the applications page depend on.
 * - A terminal skip surfaces an already-reviewed error and writes neither
 *   the mirror nor the audit entry.
 *
 * Firestore, the auth hook, and fetch are mocked. No em dashes are used
 * in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// The repo Jest config uses the classic JSX runtime (jsx: "react"), so
// components that rely on the Next.js automatic runtime resolve `React`
// as a free variable at render time. Provide it globally from the test
// file only; no source change.
(globalThis as any).React = React;

const mockFetchResponse: { current: any } = {
  current: { success: true, skippedAlreadyReviewed: [] },
};
const mockFetchCalls: Array<{ url: string; init: any }> = [];
const mockUpdateDoc = jest.fn(async (..._args: any[]) => undefined);
const mockLogAuditEntry = jest.fn(async (..._args: any[]) => undefined);

const APPLICATION_DOC = {
  uid: 'applicant-1',
  fullName: 'Ayesha Khan',
  email: 'ayesha@example.com',
  university: 'Institute of Space Technology',
  department: 'Aerospace Engineering',
  status: 'pending',
  skills: ['CAD'],
  interestAreas: ['Rocketry'],
};

jest.mock('@/firebase/provider', () => ({
  getFirebaseApp: () => ({}),
  getFirestoreService: () => ({}),
}));

jest.mock('firebase/firestore', () => ({
  doc: (_db: any, ...parts: any[]) => ({ path: parts.join('/'), id: parts[parts.length - 1] }),
  getDoc: jest.fn(async (ref: any) => {
    if (ref.path === 'applications/applicant-1') {
      return { exists: () => true, data: () => ({ ...APPLICATION_DOC }) };
    }
    return { exists: () => false, data: () => undefined };
  }),
  serverTimestamp: () => 'SERVER_TS',
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  updateDoc: (...args: any[]) => mockUpdateDoc(...args),
}));

jest.mock('@/lib/audit-logging', () => ({
  logAuditEntry: (...args: any[]) => mockLogAuditEntry(...args),
}));

jest.mock('@/hooks/use-user', () => ({
  useUser: () => ({ user: { uid: 'admin-1', getIdToken: async () => 'token-1' } }),
}));

import GenericInspector from '../generic-inspector';

function lastFetchBody(): any {
  expect(mockFetchCalls.length).toBeGreaterThan(0);
  return JSON.parse(mockFetchCalls[mockFetchCalls.length - 1].init.body);
}

function renderApplicationInspector() {
  return render(
    <GenericInspector
      globalId="applications/applicant-1"
      originalRef="applications/applicant-1"
      status="PENDING"
      title="APPLICATION"
      schema={null}
      renderPayload={(data: any) => <div>Payload name: {data?.fullName}</div>}
    />,
  );
}

beforeEach(() => {
  mockFetchResponse.current = { success: true, skippedAlreadyReviewed: [] };
  mockFetchCalls.length = 0;
  jest.clearAllMocks();
  jest.spyOn(window, 'alert').mockImplementation(() => {});
  global.fetch = jest.fn(async (url: any, init?: any) => {
    mockFetchCalls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => mockFetchResponse.current } as any;
  }) as any;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GenericInspector application Approve/Reject', () => {
  test('approve sends applications payload with no points and no extraFields, hides the points control, and writes mirror plus audit', async () => {
    renderApplicationInspector();
    expect(await screen.findByText('Payload name: Ayesha Khan')).toBeInTheDocument();
    expect(screen.queryByText('Points to Award')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockFetchCalls.length).toBe(1));
    const body = lastFetchBody();
    expect(body.collection).toBe('applications');
    expect(body.ids).toEqual(['applicant-1']);
    expect(body.action).toBe('approve');
    expect(body).not.toHaveProperty('points');
    expect(body).not.toHaveProperty('extraFields');

    await waitFor(() =>
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        { path: 'users/applicant-1', id: 'applicant-1' },
        expect.objectContaining({ applicationStatus: 'approved' })
      )
    );
    const mirrorArg = mockUpdateDoc.mock.calls[0][1] as any;
    expect(mirrorArg).not.toHaveProperty('hasApplied');
    expect(mockLogAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      'application_status_updated',
      'admin-1',
      'applicant-1',
      expect.objectContaining({ new_status: 'approved' })
    );
    expect(window.alert).not.toHaveBeenCalled();
  });

  test('reject sends action reject and the mirror clears hasApplied', async () => {
    renderApplicationInspector();
    expect(await screen.findByText('Payload name: Ayesha Khan')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Required for rejections/), {
      target: { value: 'Incomplete form' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(mockFetchCalls.length).toBe(1));
    const body = lastFetchBody();
    expect(body.collection).toBe('applications');
    expect(body.action).toBe('reject');
    expect(body.notes).toBe('Incomplete form');
    expect(body).not.toHaveProperty('points');

    await waitFor(() =>
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        { path: 'users/applicant-1', id: 'applicant-1' },
        expect.objectContaining({ applicationStatus: 'rejected', hasApplied: false })
      )
    );
    expect(mockLogAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      'application_status_updated',
      'admin-1',
      'applicant-1',
      expect.objectContaining({ new_status: 'rejected', rejection_reason: 'Incomplete form' })
    );
  });

  test('a terminal skip alerts already reviewed and writes no mirror or audit entry', async () => {
    mockFetchResponse.current = { success: true, skippedAlreadyReviewed: ['applicant-1'] };
    renderApplicationInspector();
    expect(await screen.findByText('Payload name: Ayesha Khan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(String((window.alert as jest.Mock).mock.calls[0][0])).toMatch(/already reviewed/i);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockLogAuditEntry).not.toHaveBeenCalled();
  });
});
