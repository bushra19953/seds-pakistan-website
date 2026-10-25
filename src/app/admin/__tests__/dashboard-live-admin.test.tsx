/**
 * A3 (listeners cluster, Class B): the admin dashboard's realtime
 * audit widget converts to bounded polling behind 'live-admin'.
 *
 * Survey basis: GET /api/admin/dashboard/init is token-verified
 * (verifyAuthentication + canAccessAdmin server-side) and already
 * returns auditLogs (audit_logs, orderBy timestamp desc, limit 20,
 * {id, action, targetUidOrResource, timestamp} — the same shape the
 * listener maps each doc to); loadDashboard already fetches it.
 *
 * - Flag OFF: onSnapshot registered on audit_logs (timestamp desc,
 *   limit 20); snapshots feed the widget, batch-compressed.
 * - Flag ON: onSnapshot never called; usePollingRefresh refetches
 *   via the init route at the 5-minute floor and the widget shows
 *   the same compressed payload shape.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import AdminDashboardPage from '@/app/admin/page';

// Classic-runtime JSX in the page component (see user-table suite).
(globalThis as Record<string, unknown>).React = React;

const mockAdminUser = {
  uid: 'admin-1',
  getIdToken: jest.fn(async () => 'test-token'),
};
const mockUserState = { user: mockAdminUser, role: 'founder', isLoading: false };

const snapshotCallbacks: Array<(snap: unknown) => void> = [];

const firestoreMock = {
  collection: jest.fn((_fs: unknown, name: string) => ({ __collection: name })),
  query: jest.fn((...args: unknown[]) => ({ __query: args })),
  orderBy: jest.fn((field: string, dir: string) => ({ __orderBy: [field, dir] })),
  limit: jest.fn((n: number) => ({ __limit: n })),
  where: jest.fn((field: string, op: string, v: unknown) => ({ __where: [field, op, v] })),
  onSnapshot: jest.fn(
    (_q: unknown, cb: (snap: unknown) => void, _err: (e: unknown) => void) => {
      snapshotCallbacks.push(cb);
      return jest.fn();
    },
  ),
};

jest.mock('@/firebase', () => ({
  firestore: {},
  useUser: () => mockUserState,
}));

jest.mock('firebase/firestore', () => ({
  collection: (...a: unknown[]) => (firestoreMock.collection as any)(...a),
  query: (...a: unknown[]) => (firestoreMock.query as any)(...a),
  orderBy: (...a: unknown[]) => (firestoreMock.orderBy as any)(...a),
  limit: (...a: unknown[]) => (firestoreMock.limit as any)(...a),
  where: (...a: unknown[]) => (firestoreMock.where as any)(...a),
  onSnapshot: (...a: unknown[]) => (firestoreMock.onSnapshot as any)(...a),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('@/components/admin/chapter-switcher', () => ({
  ChapterSwitcher: () => null,
}));

jest.mock('@/components/admin/live-missions-board', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/config/permission-registry', () => ({
  getRoleScope: () => 'global',
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const DASHBOARD_PAYLOAD = {
  metrics: {
    users: 3,
    projects: 1,
    blogs: 2,
    events: 1,
    announcements: 1,
    applicationsPending: 0,
    applicationsShortlisted: 0,
    applicationsRejected: 0,
  },
  indicators: {
    usersDeparted: 0,
    medianDaysWaiting: 0,
    tasksCompleted: 0,
    tasksOverdueRate: 0,
  },
  auditLogs: [
    {
      id: 'log-1',
      action: 'ROLE_GRANTED',
      targetUidOrResource: 'user-x',
      timestamp: '2026-10-25T16:00:00.000Z',
    },
    {
      id: 'log-2',
      action: 'ROLE_GRANTED',
      targetUidOrResource: 'user-x',
      timestamp: '2026-10-25T15:59:56.000Z',
    },
    {
      id: 'log-3',
      action: 'USER_LOGIN',
      targetUidOrResource: 'user-y',
      timestamp: '2026-10-25T15:00:00.000Z',
    },
  ],
};

function initCalls(): number {
  return fetchMock.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].startsWith('/api/admin/dashboard/init'),
  ).length;
}

async function flush() {
  await act(async () => {});
  await act(async () => {});
}

const PREV_ENV = process.env.NEXT_PUBLIC_SUPA_SURFACES;

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => DASHBOARD_PAYLOAD,
  });
  snapshotCallbacks.length = 0;
  firestoreMock.collection.mockClear();
  firestoreMock.orderBy.mockClear();
  firestoreMock.limit.mockClear();
  firestoreMock.onSnapshot.mockClear();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

afterEach(() => {
  jest.useRealTimers();
  if (PREV_ENV === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  else process.env.NEXT_PUBLIC_SUPA_SURFACES = PREV_ENV;
});

describe('A3 flag OFF (default): audit listener as today', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  });

  it('registers onSnapshot on audit_logs (timestamp desc, limit 20) and renders snapshot logs batch-compressed', async () => {
    render(<AdminDashboardPage />);
    await flush();

    expect(firestoreMock.onSnapshot).toHaveBeenCalled();
    expect(
      firestoreMock.collection.mock.calls.some((c) => c[1] === 'audit_logs'),
    ).toBe(true);
    expect(firestoreMock.orderBy).toHaveBeenCalledWith('timestamp', 'desc');
    expect(firestoreMock.limit).toHaveBeenCalledWith(20);

    const cb = snapshotCallbacks[snapshotCallbacks.length - 1];
    const doc = (id: string, action: string, target: string, iso: string) => ({
      id,
      data: () => ({
        action,
        targetUidOrResource: target,
        timestamp: { toDate: () => new Date(iso) },
      }),
    });
    act(() => {
      cb({
        docs: [
          doc('s-1', 'ROLE_GRANTED', 'user-x', '2026-10-25T16:00:00.000Z'),
          doc('s-2', 'ROLE_GRANTED', 'user-x', '2026-10-25T15:59:57.000Z'),
          doc('s-3', 'USER_LOGIN', 'user-y', '2026-10-25T15:00:00.000Z'),
        ],
      });
    });
    await flush();

    // Same compression the widget has always shown: the pair of
    // identical actions 3s apart collapses into one (x2) row.
    expect(screen.getByText('ROLE_GRANTED (x2)')).toBeTruthy();
    expect(screen.getByText('USER_LOGIN')).toBeTruthy();
  });

  it('does not poll the init route for audit refreshes', async () => {
    render(<AdminDashboardPage />);
    await flush();
    const baseline = initCalls();
    await act(async () => { jest.advanceTimersByTime(5 * 60 * 1000); });
    await flush();
    expect(initCalls()).toBe(baseline);
  });
});

describe('A3 flag ON: bounded polling via the dashboard init route', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
  });

  it('never registers onSnapshot; the poll tick refetches limit-20 payload and renders it compressed', async () => {
    render(<AdminDashboardPage />);
    await flush();

    expect(firestoreMock.onSnapshot).not.toHaveBeenCalled();
    const baseline = initCalls();
    expect(baseline).toBeGreaterThan(0); // initial loadDashboard untouched

    // loadDashboard's initial payload is shown raw (pre-existing
    // behavior); the poll path applies the listener's compression.
    expect(screen.queryByText('ROLE_GRANTED (x2)')).toBeNull();

    await act(async () => { jest.advanceTimersByTime(299_999); });
    await flush();
    expect(initCalls()).toBe(baseline);

    await act(async () => { jest.advanceTimersByTime(1); });
    await flush();
    expect(initCalls()).toBe(baseline + 1);
    expect(screen.getByText('ROLE_GRANTED (x2)')).toBeTruthy();
    expect(screen.getByText('USER_LOGIN')).toBeTruthy();
  });
});
