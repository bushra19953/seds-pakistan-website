/**
 * Tests for the member self-cancel of a pending leave request.
 *
 * The defect: POST /api/leave has supported { action: 'cancel', id }
 * (owner-only, pending-only) since the API shipped, but no member UI
 * ever called it. These tests pin the UI contract for the two member
 * surfaces that list a member's own requests:
 * - LeaveApplyForm (src/components/profile/leave-apply-form.tsx), the
 *   "Your leave requests" list on /profile/leave.
 * - VacationToggle (src/components/profile/vacation-toggle.tsx), the
 *   "My Leave Requests" list on the profile leave card.
 *
 * Contract pinned here:
 * - The Cancel action appears only on the member's own PENDING
 *   requests. (The list endpoints only ever return the caller's own
 *   requests, and the server re-checks ownership and status anyway:
 *   403 for another member's request, 409 for a non-pending one.)
 * - Cancelling requires an explicit confirmation step. Opening the
 *   confirmation sends nothing; dismissing it sends nothing.
 * - Confirming posts { action: 'cancel', id } to /api/leave with the
 *   member's ID token. On success the request renders as cancelled
 *   and the Cancel action is gone.
 * - A failed cancel shows the API error verbatim and the request
 *   stays pending.
 *
 * Server-side companion facts, pinned by the route suite in
 * src/app/api/leave/__tests__/leave-route.test.ts (not re-tested
 * here): a cancelled request does not block a fresh application,
 * because the overlap check only blocks on pending/approved.
 *
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { LeaveApplyForm } from '@/components/profile/leave-apply-form';
import VacationToggle from '@/components/profile/vacation-toggle';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const mockUserContext = {
  current: {
    user: { uid: 'member-uid', getIdToken: async () => 'test-token' },
    isLoading: false,
  } as any,
};

const mockDocState = {
  current: { data: null as any, loading: false, error: null as any },
};

const mockApi = {
  requests: [] as any[],
  cancelResponder: null as null | ((id: string) => { ok: boolean; status: number; body: any }),
  calls: [] as Array<{ url: string; init: any }>,
};

function dateString(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pendingRequest(): any {
  return {
    id: 'leave-pending',
    leaveType: 'annual',
    startDate: dateString(7),
    endDate: dateString(9),
    reason: 'Family event',
    status: 'pending',
    coveringOfficerId: 'officer-uid',
    coveringOfficerName: 'Cover Officer',
  };
}

function requestWithStatus(status: string): any {
  return {
    ...pendingRequest(),
    id: `leave-${status}`,
    reason: `Reason for ${status}`,
    status,
  };
}

function cancelCalls(): Array<{ url: string; init: any }> {
  return mockApi.calls.filter((call) => {
    if (!String(call.url).endsWith('/api/leave')) return false;
    if (call.init?.method !== 'POST') return false;
    try {
      return JSON.parse(call.init.body)?.action === 'cancel';
    } catch {
      return false;
    }
  });
}

jest.mock('@/firebase/user-provider', () => ({
  useUserContext: () => mockUserContext.current,
}));

jest.mock('@/firebase', () => ({
  useDoc: () => mockDocState.current,
  useFirestore: () => ({}),
}));

jest.mock('firebase/firestore', () => ({
  doc: (...args: any[]) => ({ path: args.join('/') }),
  getDoc: async () => ({ exists: () => false, data: () => ({}) }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/admin/user-selection-combobox', () => ({
  UserSelectionCombobox: () => <div data-testid="covering-officer-picker" />,
}));

jest.mock('@/components/dashboard/post-vacation-summary', () => ({
  PostVacationSummaryModal: () => null,
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <h2>{children}</h2>,
  CardDescription: ({ children }: any) => <p>{children}</p>,
  CardContent: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ asChild, variant, size, children, ...props }: any) =>
    asChild ? <>{children}</> : <button {...props}>{children}</button>,
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));

jest.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => <div />,
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => <textarea {...props} />,
}));

beforeEach(() => {
  mockUserContext.current = {
    user: { uid: 'member-uid', getIdToken: async () => 'test-token' },
    isLoading: false,
  };
  mockDocState.current = {
    data: { isOnVacation: false, vacationMode: false, coveringOfficerId: null },
    loading: false,
    error: null,
  };
  mockApi.requests = [];
  mockApi.cancelResponder = null;
  mockApi.calls = [];
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const urlText = String(url);
    mockApi.calls.push({ url: urlText, init });
    if (urlText.endsWith('/api/leave') && (!init?.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ requests: mockApi.requests }) };
    }
    if (urlText.endsWith('/api/leave') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.action === 'cancel') {
        const result = mockApi.cancelResponder
          ? mockApi.cancelResponder(body.id)
          : {
              ok: true,
              status: 200,
              body: { success: true, id: body.id, status: 'cancelled', message: 'Leave request cancelled.' },
            };
        return { ok: result.ok, status: result.status, json: async () => result.body };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ success: true, request: { id: 'leave-new', status: 'pending' } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as any;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// LeaveApplyForm: "Your leave requests" list on /profile/leave
// ---------------------------------------------------------------------------

describe('LeaveApplyForm cancel flow', () => {
  test('shows a Cancel request button only on pending requests', async () => {
    mockApi.requests = [
      pendingRequest(),
      requestWithStatus('approved'),
      requestWithStatus('rejected'),
      requestWithStatus('cancelled'),
      requestWithStatus('completed'),
    ];
    render(<LeaveApplyForm />);

    await screen.findByText('Family event');
    expect(screen.getAllByRole('button', { name: 'Cancel request' })).toHaveLength(1);

    // A request that is already cancelled renders its true status and
    // carries no stale cancel action.
    const cancelledItem = screen.getByText('Reason for cancelled').closest('li') as HTMLElement;
    expect(within(cancelledItem).getByText('cancelled')).toBeInTheDocument();
    expect(within(cancelledItem).queryByRole('button')).toBeNull();
  });

  test('requires confirmation: opening or dismissing the confirm step sends nothing', async () => {
    mockApi.requests = [pendingRequest()];
    render(<LeaveApplyForm />);

    await screen.findByText('Family event');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));

    expect(await screen.findByText(/Cancel this leave request\?/)).toBeInTheDocument();
    expect(cancelCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Keep request' }));
    expect(screen.queryByText(/Cancel this leave request\?/)).toBeNull();
    expect(cancelCalls()).toHaveLength(0);
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  test('confirming posts the cancel action and flips the request to cancelled', async () => {
    mockApi.requests = [pendingRequest()];
    render(<LeaveApplyForm />);

    await screen.findByText('Family event');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, cancel request' }));

    await waitFor(() => {
      expect(screen.getByText('cancelled')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();

    const calls = cancelCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body)).toEqual({ action: 'cancel', id: 'leave-pending' });
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');
  });

  test('a failed cancel shows the API error verbatim and keeps the request pending', async () => {
    mockApi.requests = [pendingRequest()];
    mockApi.cancelResponder = () => ({
      ok: false,
      status: 409,
      body: { error: 'Only a pending leave request can be cancelled' },
    });
    render(<LeaveApplyForm />);

    await screen.findByText('Family event');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, cancel request' }));

    expect(await screen.findByText('Only a pending leave request can be cancelled')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.queryByText('cancelled')).toBeNull();

    // The member can still back out of the confirm step.
    fireEvent.click(screen.getByRole('button', { name: 'Keep request' }));
    expect(screen.queryByText(/Cancel this leave request\?/)).toBeNull();
  });

  test('after cancelling, a fresh application for the same dates submits normally', async () => {
    mockApi.requests = [pendingRequest()];
    render(<LeaveApplyForm />);

    await screen.findByText('Family event');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, cancel request' }));
    await screen.findByText('cancelled');

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: dateString(7) } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: dateString(9) } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Trying again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit leave request' }));

    expect(await screen.findByText(/Leave request submitted\. Status: pending\./)).toBeInTheDocument();
    const createCalls = mockApi.calls.filter((call) => {
      if (!String(call.url).endsWith('/api/leave') || call.init?.method !== 'POST') return false;
      try {
        return JSON.parse(call.init.body)?.action === undefined;
      } catch {
        return false;
      }
    });
    expect(createCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VacationToggle: "My Leave Requests" list on the profile leave card
// ---------------------------------------------------------------------------

describe('VacationToggle cancel flow', () => {
  test('shows a Cancel request button only on pending requests', async () => {
    mockApi.requests = [pendingRequest(), requestWithStatus('approved')];
    render(<VacationToggle />);

    expect(await screen.findByText('My Leave Requests')).toBeInTheDocument();
    await screen.findByText('Family event');
    expect(screen.getAllByRole('button', { name: 'Cancel request' })).toHaveLength(1);
  });

  test('confirming on the profile card cancels and updates the status to Cancelled', async () => {
    mockApi.requests = [pendingRequest()];
    render(<VacationToggle />);

    await screen.findByText('Family event');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(cancelCalls()).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Yes, cancel request' }));

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();

    const calls = cancelCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body)).toEqual({ action: 'cancel', id: 'leave-pending' });
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');
  });

  test('dismissing the confirmation on the profile card sends no cancel request', async () => {
    mockApi.requests = [pendingRequest()];
    render(<VacationToggle />);

    await screen.findByText('Family event');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep request' }));

    expect(screen.queryByText(/Cancel this leave request\?/)).toBeNull();
    expect(cancelCalls()).toHaveLength(0);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  test('a failed cancel on the profile card shows the API error and keeps the request Pending', async () => {
    mockApi.requests = [pendingRequest()];
    mockApi.cancelResponder = () => ({
      ok: false,
      status: 403,
      body: { error: 'Forbidden: you can only cancel your own leave requests' },
    });
    render(<VacationToggle />);

    await screen.findByText('Family event');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, cancel request' }));

    expect(
      await screen.findByText('Forbidden: you can only cancel your own leave requests'),
    ).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });
});
