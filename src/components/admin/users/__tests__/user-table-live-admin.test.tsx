/**
 * A14 (listeners cluster, Class B): the user table's leave_audit
 * onSnapshot listener converts to bounded polling behind the
 * 'live-admin' surface flag.
 *
 * - Flag OFF: onSnapshot is registered on leave_audit
 *   (orderBy timestamp desc, limit 1); the first snapshot is
 *   ignored and later non-empty snapshots trigger fetchPage — the
 *   pre-conversion behavior, byte for byte.
 * - Flag ON: onSnapshot is never called; the initial page load is
 *   untouched and usePollingRefresh drives the same fetchPage at
 *   the 5-minute floor — not before.
 *
 * fetchPage is observed at its network boundary: every invocation
 * with a cold cache issues GET /api/admin/users. The mock answers
 * 500 so the client search cache stays cold and every fetchPage
 * invocation stays observable; the data path (same function, same
 * URL, same params) is identical in both modes.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import UserTable from '@/components/admin/users/user-table';

// The component relies on Next's automatic JSX runtime and never
// imports React; the jest tsconfig uses the classic runtime, so
// expose React globally for its compiled JSX (existing suites whose
// components import React do not need this).
(globalThis as Record<string, unknown>).React = React;

// --- stable mock identities (fresh objects per render would loop effects)
const mockAdminUser = {
  uid: 'admin-1',
  getIdToken: jest.fn(async () => 'test-token'),
};
const mockUserState = { user: mockAdminUser, role: 'admin', isLoading: false };
const mockToastState = { toast: jest.fn() };
const mockFirestore = {};

const snapshotCallbacks: Array<(snap: unknown) => void> = [];

const firestoreMock = {
  collection: jest.fn((_fs: unknown, name: string) => ({ __collection: name })),
  getDocs: jest.fn(async () => ({ docs: [] as unknown[] })),
  orderBy: jest.fn((field: string, dir: string) => ({ __orderBy: [field, dir] })),
  limit: jest.fn((n: number) => ({ __limit: n })),
  query: jest.fn((...args: unknown[]) => ({ __query: args })),
  startAfter: jest.fn(),
  onSnapshot: jest.fn(
    (_q: unknown, cb: (snap: unknown) => void, _err: (e: unknown) => void) => {
      snapshotCallbacks.push(cb);
      return jest.fn();
    },
  ),
};

jest.mock('@/firebase', () => ({
  useFirestore: () => mockFirestore,
  useUser: () => mockUserState,
}));

jest.mock('firebase/firestore', () => ({
  collection: (...a: unknown[]) => (firestoreMock.collection as any)(...a),
  getDocs: (...a: unknown[]) => (firestoreMock.getDocs as any)(...a),
  orderBy: (...a: unknown[]) => (firestoreMock.orderBy as any)(...a),
  limit: (...a: unknown[]) => (firestoreMock.limit as any)(...a),
  query: (...a: unknown[]) => (firestoreMock.query as any)(...a),
  startAfter: (...a: unknown[]) => (firestoreMock.startAfter as any)(...a),
  onSnapshot: (...a: unknown[]) => (firestoreMock.onSnapshot as any)(...a),
  DocumentSnapshot: class {},
  Firestore: class {},
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => mockToastState,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}));

jest.mock('@/lib/roles', () => ({
  hasSufficientRole: () => true,
  USER_ROLES: {},
}));

jest.mock('@/lib/role-management', () => ({
  assignRole: jest.fn(async () => true),
}));

jest.mock('@/lib/authority-refresh', () => ({
  refreshTokenAfterRoleChange: jest.fn(async () => undefined),
}));

jest.mock('@/components/admin/users/user-table-columns', () => ({
  buildUserColumns: () => [],
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, isLoading: false }),
}));

jest.mock('@/hooks/use-firestore-pagination', () => ({
  useFirestorePagination: () => ({
    next: jest.fn(),
    prev: jest.fn(),
    hasPrev: false,
    stackRef: { current: [] },
  }),
}));

jest.mock('@/lib/unified-roles', () => ({
  getUnifiedRoleOptions: jest.fn(async () => []),
}));

jest.mock('@/components/admin/roles/grant-expiry', () => ({
  isCustomRoleKey: () => false,
}));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

jest.mock('@/lib/client/consent-gate-error', () => ({
  isConsentGateBlocked: () => false,
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function usersCalls(): number {
  return fetchMock.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].startsWith('/api/admin/users'),
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
    ok: false,
    status: 500,
    json: async () => ({ error: 'boom' }),
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

describe('A14 flag OFF (default): leave_audit listener as today', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  });

  it('registers onSnapshot on leave_audit (timestamp desc, limit 1) and refetches via fetchPage after the first snapshot', async () => {
    render(<UserTable />);
    await flush();

    expect(firestoreMock.onSnapshot).toHaveBeenCalled();
    expect(
      firestoreMock.collection.mock.calls.some((c) => c[1] === 'leave_audit'),
    ).toBe(true);
    expect(firestoreMock.orderBy).toHaveBeenCalledWith('timestamp', 'desc');
    expect(firestoreMock.limit).toHaveBeenCalledWith(1);

    const baseline = usersCalls();
    expect(baseline).toBeGreaterThan(0); // initial page load happened

    const cb = snapshotCallbacks[snapshotCallbacks.length - 1];
    // First snapshot is ignored, exactly as before the conversion.
    act(() => { cb({ empty: false, docs: [] }); });
    await flush();
    expect(usersCalls()).toBe(baseline);

    // Later non-empty snapshots trigger the same fetchPage data path.
    act(() => { cb({ empty: false, docs: [] }); });
    await flush();
    expect(usersCalls()).toBe(baseline + 1);
  });

  it('does not poll: advancing 5 minutes without a snapshot does not refetch', async () => {
    render(<UserTable />);
    await flush();
    const baseline = usersCalls();
    await act(async () => { jest.advanceTimersByTime(5 * 60 * 1000); });
    await flush();
    expect(usersCalls()).toBe(baseline);
  });
});

describe('A14 flag ON: bounded polling, no listener', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
  });

  it('never registers onSnapshot; fetchPage fires on mount and again at the 300,000ms tick, not before', async () => {
    render(<UserTable />);
    await flush();

    expect(firestoreMock.onSnapshot).not.toHaveBeenCalled();
    const baseline = usersCalls();
    expect(baseline).toBeGreaterThan(0); // initial page load untouched

    await act(async () => { jest.advanceTimersByTime(299_999); });
    await flush();
    expect(usersCalls()).toBe(baseline);

    await act(async () => { jest.advanceTimersByTime(1); });
    await flush();
    expect(usersCalls()).toBe(baseline + 1);

    await act(async () => { jest.advanceTimersByTime(300_000); });
    await flush();
    expect(usersCalls()).toBe(baseline + 2);
  });
});
