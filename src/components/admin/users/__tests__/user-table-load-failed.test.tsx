/**
 * Directory zero-records fix, client half (REQ 1 + REQ 2):
 *
 * REQ 1 (truthfulness): when fetchPage fails, the table used to show
 * only a transient toast and then settle into the exact rendering of
 * an empty directory ("No Users Match Criteria", "Showing 0
 * records"). The component must carry a distinct LOAD-FAILED state:
 * an errorMessage + onRetry handed to the table surface, with a
 * timeout-specific message when the route answers 504.
 *
 * REQ 2 (cache discipline): searchMapRef used to cache EVERY
 * first-page response - including users: [] from a transient
 * score-0/empty 200 - under its search key for the whole tab session
 * with no TTL, and Clear Filters snapped back to the poisoned entry.
 * Empty results must never be cached, entries must expire, and an
 * error must invalidate the key.
 *
 * The VirtualizedUserTable is observed through a props probe (the
 * same network-boundary style as user-table-live-admin.test.tsx):
 * the load-failed contract between UserTable and its table surface
 * is exactly { errorMessage, onRetry, rows }.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import UserTable from '@/components/admin/users/user-table';

(globalThis as Record<string, unknown>).React = React;

const mockAdminUser = {
  uid: 'admin-1',
  getIdToken: jest.fn(async () => 'test-token'),
};
const mockUserState = { user: mockAdminUser, role: 'admin', isLoading: false };
const mockToastState = { toast: jest.fn() };
const mockFirestore = {};

// Latest props handed to the (dynamic) VirtualizedUserTable.
let tableProps: any = null;

const firestoreMock = {
  collection: jest.fn((_fs: unknown, name: string) => ({ __collection: name })),
  getDocs: jest.fn(async () => ({ docs: [] as unknown[] })),
  orderBy: jest.fn((field: string, dir: string) => ({ __orderBy: [field, dir] })),
  limit: jest.fn((n: number) => ({ __limit: n })),
  query: jest.fn((...args: unknown[]) => ({ __query: args })),
  startAfter: jest.fn(),
  onSnapshot: jest.fn((_q: unknown, _cb: unknown, _err: unknown) => jest.fn()),
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

// Probe: record the props of whichever dynamic component receives a
// `rows` prop (the VirtualizedUserTable); RolePowerMatrix gets none.
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: any) => {
    if (props && 'rows' in props) tableProps = props;
    return null;
  },
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

jest.mock('@/lib/chapters-client', () => ({
  getChaptersCached: jest.fn(async () => []),
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function okJson(body: any) {
  return { ok: true, status: 200, json: async () => body };
}
function errJson(status: number, body: any) {
  return { ok: false, status, json: async () => body };
}
function usersCalls(fragment?: string): number {
  return fetchMock.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].startsWith('/api/admin/users') && (!fragment || c[0].includes(fragment)),
  ).length;
}

async function flush() {
  await act(async () => {});
  await act(async () => {});
}

const ONE_USER = { users: [{ uid: 'u-1', displayName: 'Person One', email: 'one@example.com', whatsapp: '', role: 'member_basic', chapterId: null, isBanned: false }], nextCursor: '', pageSize: 20 };

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  tableProps = null;
  mockAdminUser.getIdToken.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('REQ 1: LOAD-FAILED state', () => {
  it('a 500 from the route hands the table an errorMessage and an onRetry, not a settled empty state', async () => {
    fetchMock.mockResolvedValue(errJson(500, { error: 'Internal server error' }));
    render(<UserTable />);
    await flush();

    expect(usersCalls()).toBeGreaterThan(0);
    expect(tableProps).toBeTruthy();
    expect(typeof tableProps.errorMessage).toBe('string');
    expect(tableProps.errorMessage.length).toBeGreaterThan(0);
    expect(typeof tableProps.onRetry).toBe('function');
    expect(tableProps.rows).toEqual([]);
  });

  it('a 504 is distinguishable: the message says the request timed out', async () => {
    fetchMock.mockResolvedValue(errJson(504, { error: 'Gateway timeout' }));
    render(<UserTable />);
    await flush();

    expect(tableProps.errorMessage).toMatch(/timed out|timeout/i);
  });

  it('Retry clears the error and refetches over the network', async () => {
    fetchMock.mockResolvedValueOnce(errJson(500, { error: 'Internal server error' }));
    render(<UserTable />);
    await flush();
    expect(tableProps.errorMessage).toBeTruthy();
    const before = usersCalls();

    fetchMock.mockResolvedValue(okJson(ONE_USER));
    await act(async () => { tableProps.onRetry(); });
    await flush();

    expect(usersCalls()).toBe(before + 1);
    expect(tableProps.errorMessage).toBeFalsy();
    expect(tableProps.rows).toHaveLength(1);
    expect(tableProps.rows[0].uid).toBe('u-1');
  });
});

describe('REQ 2: client cache discipline', () => {
  it('an empty first-page result is never cached: asking for the same search again hits the network', async () => {
    // Base load: one user (cached, non-empty - legitimate). Mount can
    // race a second fetch before the first caches (pre-existing), so
    // counts are asserted on the search fragment / relatively.
    fetchMock.mockResolvedValue(okJson(ONE_USER));
    render(<UserTable />);
    await flush();
    expect(tableProps.rows).toHaveLength(1);

    // Search that (transiently) returns empty.
    fetchMock.mockResolvedValue(okJson({ users: [], nextCursor: '', pageSize: 200 }));
    await act(async () => { tableProps.onSearch('ghost@example.com'); });
    await act(async () => { jest.advanceTimersByTime(600); });
    await flush();
    expect(usersCalls('ghost')).toBe(1);
    expect(tableProps.rows).toEqual([]);

    // Clear, then run the SAME search again: a poisoned cache would
    // answer locally; the fixed cache must go to the network.
    await act(async () => { tableProps.handleClear(); });
    await flush();
    await act(async () => { tableProps.onSearch('ghost@example.com'); });
    await act(async () => { jest.advanceTimersByTime(600); });
    await flush();
    expect(usersCalls('ghost')).toBe(2);
  });

  it('cached entries expire: after the TTL the same key is refetched, not served from the map', async () => {
    fetchMock.mockResolvedValue(okJson(ONE_USER));
    render(<UserTable />);
    await flush();
    const afterMount = usersCalls();
    expect(afterMount).toBeGreaterThan(0);

    // Wander to a search and back within the same tab session, but
    // after the cache TTL has passed: the base key must refetch.
    await act(async () => { jest.advanceTimersByTime(31_000); });
    await act(async () => { tableProps.onSearch('someone@example.com'); });
    await act(async () => { jest.advanceTimersByTime(600); });
    await flush();
    const afterSearch = usersCalls();
    expect(afterSearch).toBeGreaterThan(afterMount);
    await act(async () => { tableProps.onSearch(''); });
    await flush();
    expect(usersCalls()).toBe(afterSearch + 1);
  });

  it('Clear Filters bypasses the cache and forces a network refetch of the base list', async () => {
    fetchMock.mockResolvedValue(okJson(ONE_USER));
    render(<UserTable />);
    await flush();
    const afterMount = usersCalls();
    expect(afterMount).toBeGreaterThan(0);

    await act(async () => { tableProps.handleClear(); });
    await flush();
    expect(usersCalls()).toBe(afterMount + 1);
  });
});
