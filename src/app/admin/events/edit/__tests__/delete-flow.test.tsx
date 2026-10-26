/**
 * Delete flow tests for /admin/events/edit.
 *
 * Before this fix the Delete Event button gated on the native
 * window.confirm(). Automated browsers auto-dismiss native dialogs, so
 * confirm() returned false and the handler returned silently: no dialog,
 * no write, no toast, no navigation — the button appeared completely dead
 * in the Oct 24, 2026 lifecycle pass and the event had to be archived as
 * a fallback. These tests pin the in-app confirmation flow that replaced
 * it: Delete Event opens an AlertDialog naming the event, Confirm runs
 * the soft-delete write (deleted: true, status: 'archived') and
 * navigates to the events list with the success toast, Cancel performs
 * no write at all, and the control stays behind the page permission
 * check.
 *
 * WS10 relocation: the soft-delete used to be a wrapper updateDoc on
 * events/{id}; it now goes through POST /api/admin/events/write
 * (serverWrite) with the same fields, and the route stamps deletedAt
 * server-side (timestampFields protocol, pinned behaviorally by the
 * write route's route-ws10 suite). The page performs no client
 * Firestore write.
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// The repo Jest config uses the classic JSX runtime (jsx: "react"), so
// components that rely on the Next.js automatic runtime resolve `React`
// as a free variable at render time. Provide it globally from the test
// file only; no source change.
(globalThis as any).React = React;

const mockPush = jest.fn();
const mockToast = jest.fn();
const mockUpdateDoc = jest.fn(async (..._args: any[]) => undefined);
const mockServerWrite = jest.fn(async (..._args: any[]) => ({ status: 200, body: { ok: true } }));
const mockHasSufficientRole = jest.fn((_role: any, _required: any) => true);

const EVENT = {
  id: 'evt-1',
  title: 'EVENTS GUIDE LIFECYCLE TEST 2026-10-24',
  authorUid: 'admin-1',
  status: 'draft',
};

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: { uid: 'admin-1' }, role: 'founder_patron', isLoading: false }),
  useDoc: () => ({ data: EVENT, loading: false }),
  useFirestore: () => ({}),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams('id=evt-1'),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/lib/roles', () => ({
  hasSufficientRole: (role: any, required: any) => mockHasSufficientRole(role, required),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  updateDoc: (...args: any[]) => mockUpdateDoc(...args),
}));

jest.mock('@/lib/client/server-write', () => ({
  serverWrite: (...args: any[]) => mockServerWrite(...args),
}));

jest.mock('firebase/firestore', () => ({
  doc: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }),
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  Timestamp: { fromDate: (d: Date) => d },
}));

jest.mock('@/app/actions/store', () => ({
  syncEventToProduct: jest.fn(async () => ({ success: true })),
}));

jest.mock('@/components/admin/events/event-form', () => ({
  __esModule: true,
  default: () => <div data-testid="event-form" />,
}));

jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/layout/footer', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/starry-background', () => ({
  __esModule: true,
  default: () => null,
}));

import EditEventPage from '../page';

beforeEach(() => {
  jest.clearAllMocks();
  mockHasSufficientRole.mockReturnValue(true);
});

it('opens an in-app confirmation dialog naming the event when Delete Event is clicked', async () => {
  render(<EditEventPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Event' }));
  expect(await screen.findByText('Delete event?')).toBeTruthy();
  expect(screen.getByText(/EVENTS GUIDE LIFECYCLE TEST 2026-10-24/)).toBeTruthy();
  expect(screen.getByText(/permanent and cannot be undone/)).toBeTruthy();
  expect(mockServerWrite).not.toHaveBeenCalled();
  expect(mockUpdateDoc).not.toHaveBeenCalled();
});

it('runs the soft-delete write, toasts, and navigates to the list on confirm', async () => {
  render(<EditEventPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Event' }));
  const confirmButton = await screen.findByRole('button', { name: 'Delete' });
  fireEvent.click(confirmButton);
  await waitFor(() => expect(mockServerWrite).toHaveBeenCalledTimes(1));
  // The soft-delete payload is unchanged; it travels to the events
  // write route, which applies it to events/evt-1 and stamps
  // deletedAt server-side (the old client serverTimestamp field).
  expect(mockServerWrite).toHaveBeenCalledWith(
    '/api/admin/events/write',
    'POST',
    expect.objectContaining({
      op: 'update',
      id: 'evt-1',
      data: expect.objectContaining({
        deleted: true,
        status: 'archived',
        showInTicker: false,
        deletedByUid: 'admin-1',
      }),
      timestampFields: ['deletedAt'],
    })
  );
  expect(mockUpdateDoc).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Event Deleted' })
    )
  );
  expect(mockPush).toHaveBeenCalledWith('/admin/events');
});

it('performs no write and no navigation when the dialog is cancelled', async () => {
  render(<EditEventPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Event' }));
  const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
  fireEvent.click(cancelButton);
  await waitFor(() => expect(screen.queryByText('Delete event?')).toBeNull());
  expect(mockServerWrite).not.toHaveBeenCalled();
  expect(mockUpdateDoc).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

it('shows no delete control when the user may not edit the event', () => {
  mockHasSufficientRole.mockReturnValue(false);
  // EVENT.authorUid is admin-1, so flip the signed-in user instead by
  // rendering with a different author on the doc.
  (EVENT as any).authorUid = 'someone-else';
  try {
    render(<EditEventPage />);
    expect(screen.getByText('You do not have permission to edit this event.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete Event' })).toBeNull();
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  } finally {
    (EVENT as any).authorUid = 'admin-1';
  }
});
