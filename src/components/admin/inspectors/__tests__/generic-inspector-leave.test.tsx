/**
 * Leave drawer tests for GenericInspector + LeaveInspector (Worker D).
 *
 * Covers the Worker B fix:
 * - Drawer Approve/Reject for a leave row sends PATCH /api/admin/universal-review
 *   with { collection: "leave_requests", ids: [bareDocId], action, notes }
 *   and NO points field and NO extraFields field.
 * - A 2xx response that lists the doc in failedLeaveRequests or
 *   skippedAlreadyReviewed surfaces an error (alert) instead of silent success.
 * - A clean 2xx response does not alert.
 * - A non-leave row keeps the old payload shape (points + extraFields).
 * - LeaveInspector accepts null fields and Timestamp dates without crashing
 *   or rendering "[object Object]".
 *
 * Firestore, the auth hook, and fetch are mocked. No em dashes are used
 * in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// The repo Jest config uses the classic JSX runtime (jsx: "react"), so
// components that rely on the Next.js automatic runtime (generic-inspector
// has no React import) resolve `React` as a free variable at render time.
// Provide it globally from the test file only; no source change.
(globalThis as any).React = React;

const mockLeaveDoc: { current: any } = { current: null };
const mockSubmissionDoc: { current: any } = { current: null };
const mockFetchResponse: { current: any } = {
  current: { success: true, failedLeaveRequests: [], skippedAlreadyReviewed: [] },
};
const mockFetchCalls: Array<{ url: string; init: any }> = [];

jest.mock('@/firebase/provider', () => ({
  getFirebaseApp: () => ({}),
  getFirestoreService: () => ({}),
}));

jest.mock('firebase/firestore', () => ({
  doc: (_db: any, ...parts: any[]) => ({ path: parts.join('/'), id: parts[parts.length - 1] }),
  getDoc: jest.fn(async (ref: any) => {
    if (ref.path === 'leave_requests/leave-1') {
      return { exists: () => true, data: () => mockLeaveDoc.current };
    }
    if (ref.path === 'submissions/sub-1') {
      return { exists: () => true, data: () => mockSubmissionDoc.current };
    }
    if (ref.path === 'users/member-1') {
      return { exists: () => true, data: () => ({ displayName: 'Member One', role: 'member', points: 0 }) };
    }
    return { exists: () => false, data: () => undefined };
  }),
}));

jest.mock('@/hooks/use-user', () => ({
  useUser: () => ({ user: { uid: 'admin-1', getIdToken: async () => 'token-1' } }),
}));

import GenericInspector from '../generic-inspector';
import LeaveInspector from '../leave-inspector';

const LEAVE_DOC = {
  userId: 'member-1',
  reason: 'Family trip',
  startDate: '2026-10-20',
  endDate: '2026-10-24',
  leaveType: 'annual',
  coveringOfficerId: 'officer-1',
  coveringOfficerName: 'Officer One',
  status: 'pending',
  notes: 'Please approve',
};

function lastFetchBody(): any {
  expect(mockFetchCalls.length).toBeGreaterThan(0);
  return JSON.parse(mockFetchCalls[mockFetchCalls.length - 1].init.body);
}

beforeEach(() => {
  mockLeaveDoc.current = { ...LEAVE_DOC };
  mockSubmissionDoc.current = { userId: 'member-1', title: 'Entry', type: 'resource' };
  mockFetchResponse.current = { success: true, failedLeaveRequests: [], skippedAlreadyReviewed: [] };
  mockFetchCalls.length = 0;
  jest.spyOn(window, 'alert').mockImplementation(() => {});
  global.fetch = jest.fn(async (url: any, init?: any) => {
    mockFetchCalls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => mockFetchResponse.current } as any;
  }) as any;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GenericInspector leave Approve/Reject payload', () => {
  test('leave Approve sends collection leave_requests, bare docId, no points, no extraFields', async () => {
    render(
      <GenericInspector
        globalId="leave_requests/leave-1"
        originalRef="leave_requests/leave-1"
        status="PENDING"
        title="LEAVE REQUEST"
        schema={null}
        renderPayload={(data: any) => <div>Payload reason: {data?.reason}</div>}
      />,
    );
    expect(await screen.findByText('Payload reason: Family trip')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Points to Award/i)).toBeNull();
    expect(screen.queryByText('Points to Award')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockFetchCalls.length).toBe(1));
    const body = lastFetchBody();
    expect(body.collection).toBe('leave_requests');
    expect(body.ids).toEqual(['leave-1']);
    expect(body.action).toBe('approve');
    expect(body).not.toHaveProperty('points');
    expect(body).not.toHaveProperty('extraFields');
    expect(mockFetchCalls[0].init.method).toBe('PATCH');
  });

  test('leave Reject sends action reject with notes and no points or extraFields', async () => {
    render(
      <GenericInspector
        globalId="leave_requests/leave-1"
        originalRef="leave_requests/leave-1"
        status="PENDING"
        title="LEAVE REQUEST"
        schema={null}
        renderPayload={(data: any) => <div>Payload reason: {data?.reason}</div>}
      />,
    );
    expect(await screen.findByText('Payload reason: Family trip')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Required for rejections/), {
      target: { value: 'Not approved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(mockFetchCalls.length).toBe(1));
    const body = lastFetchBody();
    expect(body.collection).toBe('leave_requests');
    expect(body.ids).toEqual(['leave-1']);
    expect(body.action).toBe('reject');
    expect(body.notes).toBe('Not approved');
    expect(body).not.toHaveProperty('points');
    expect(body).not.toHaveProperty('extraFields');
  });

  test('non-leave Approve keeps points and extraFields in the payload', async () => {
    render(
      <GenericInspector
        globalId="sub-1"
        originalRef="submissions/sub-1"
        status="PENDING"
        title="SUBMISSION"
        schema={null}
        renderPayload={() => <div>Submission payload</div>}
      />,
    );
    expect(await screen.findByText('Submission payload')).toBeInTheDocument();
    expect(screen.getByText('Points to Award')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockFetchCalls.length).toBe(1));
    const body = lastFetchBody();
    expect(body.collection).toBe('submissions');
    expect(body.ids).toEqual(['sub-1']);
    expect(body.action).toBe('approve');
    expect(body.points).toBe(10);
    expect(body.extraFields).toEqual({ addToCompetitions: true });
  });
});

describe('GenericInspector leave 2xx skip/fail surfacing', () => {
  test('failedLeaveRequests entry for this doc surfaces its error instead of silent success', async () => {
    mockFetchResponse.current = {
      success: true,
      failedLeaveRequests: [{ id: 'leave-1', error: 'No leave requester resolved; status not changed.' }],
      skippedAlreadyReviewed: [],
    };
    render(
      <GenericInspector
        globalId="leave_requests/leave-1"
        originalRef="leave_requests/leave-1"
        status="PENDING"
        title="LEAVE REQUEST"
        schema={null}
        renderPayload={() => <div>Payload</div>}
      />,
    );
    expect(await screen.findByText('Payload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(String((window.alert as jest.Mock).mock.calls[0][0])).toContain(
      'No leave requester resolved',
    );
  });

  test('skippedAlreadyReviewed entry for this doc surfaces an already-reviewed error', async () => {
    mockFetchResponse.current = {
      success: true,
      failedLeaveRequests: [],
      skippedAlreadyReviewed: ['leave-1'],
    };
    render(
      <GenericInspector
        globalId="leave_requests/leave-1"
        originalRef="leave_requests/leave-1"
        status="PENDING"
        title="LEAVE REQUEST"
        schema={null}
        renderPayload={() => <div>Payload</div>}
      />,
    );
    expect(await screen.findByText('Payload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(String((window.alert as jest.Mock).mock.calls[0][0])).toMatch(/already reviewed/i);
  });

  test('failedLeaveRequests entry for a different doc does not surface an error', async () => {
    mockFetchResponse.current = {
      success: true,
      failedLeaveRequests: [{ id: 'leave-999', error: 'Some other failure' }],
      skippedAlreadyReviewed: [],
    };
    render(
      <GenericInspector
        globalId="leave_requests/leave-1"
        originalRef="leave_requests/leave-1"
        status="PENDING"
        title="LEAVE REQUEST"
        schema={null}
        renderPayload={() => <div>Payload</div>}
      />,
    );
    expect(await screen.findByText('Payload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockFetchCalls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(window.alert).not.toHaveBeenCalled();
  });

  test('clean 2xx response does not alert', async () => {
    render(
      <GenericInspector
        globalId="leave_requests/leave-1"
        originalRef="leave_requests/leave-1"
        status="PENDING"
        title="LEAVE REQUEST"
        schema={null}
        renderPayload={() => <div>Payload</div>}
      />,
    );
    expect(await screen.findByText('Payload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockFetchCalls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(window.alert).not.toHaveBeenCalled();
  });
});

describe('LeaveInspector null and date handling', () => {
  test('renders null fields with fallbacks and YYYY-MM-DD dates verbatim', async () => {
    mockLeaveDoc.current = {
      userId: 'member-1',
      reason: null,
      startDate: '2026-10-20',
      endDate: '2026-10-24',
      leaveType: null,
      coveringOfficerId: null,
      coveringOfficerName: null,
      status: 'pending',
      notes: null,
    };
    render(
      <LeaveInspector globalId="leave_requests/leave-1" originalRef="leave_requests/leave-1" status="PENDING" />,
    );
    expect(await screen.findByText('2026-10-20')).toBeInTheDocument();
    expect(screen.getByText('2026-10-24')).toBeInTheDocument();
    expect(screen.getByText('None assigned')).toBeInTheDocument();
    expect(screen.getByText('Not specified')).toBeInTheDocument();
    expect(screen.getByText('No additional notes')).toBeInTheDocument();
    expect(screen.getByText('General Leave')).toBeInTheDocument();
    expect(screen.queryByText('Points to Award')).toBeNull();
  });

  test('Timestamp-like date objects do not render as [object Object]', async () => {
    mockLeaveDoc.current = {
      ...LEAVE_DOC,
      startDate: { toDate: () => new Date('2026-10-20T12:00:00.000Z') },
      endDate: { toMillis: () => new Date('2026-10-24T12:00:00.000Z').getTime() },
    };
    const { container } = render(
      <LeaveInspector globalId="leave_requests/leave-1" originalRef="leave_requests/leave-1" status="PENDING" />,
    );
    await screen.findByText('Officer One');
    expect(container.textContent).not.toContain('[object Object]');
  });
});
