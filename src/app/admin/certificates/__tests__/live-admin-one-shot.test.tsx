/**
 * Contract tests for the certificates admin listener (A1) under the
 * live-admin surface flag (Supabase migration, listeners Class D).
 *
 * Flag OFF: the page subscribes with onSnapshot exactly as before.
 * Flag ON: no subscription is created; a one-shot getDocs of the same
 * bare certificates query feeds the identical state mapping, so the
 * rendered rows are shape-identical between the two paths.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import CertificatesAdminPage from '../page';

(global as any).React = React;

const mockDb = { __db: 'fake-db' };

const CERT_DOCS = [
  {
    id: 'c2',
    data: () => ({
      userId: 'u2',
      userName: 'Bilal Ahmed',
      achievement: 'CubeSat Build',
      code: 'CODE-2',
      status: 'issued',
      issueDate: { toMillis: () => 1000, toDate: () => new Date('2026-01-01T00:00:00Z') },
    }),
  },
  {
    id: 'c1',
    data: () => ({
      userId: 'u1',
      userName: 'Ayesha Khan',
      achievement: 'Rocketry Win',
      code: 'CODE-1',
      status: 'issued',
      issueDate: { toMillis: () => 2000, toDate: () => new Date('2026-02-01T00:00:00Z') },
    }),
  },
];

const state: {
  onSnapshotCalls: any[];
  snapshotCallback: ((snap: any) => void) | null;
  getDocsCalls: any[];
  unsubscribe: jest.Mock;
} = {
  onSnapshotCalls: [],
  snapshotCallback: null,
  getDocsCalls: [],
  unsubscribe: jest.fn(),
};

jest.mock('@/firebase', () => ({
  useFirestore: () => mockDb,
  useUser: () => ({ user: { uid: 'admin-1' }, isLoading: false }),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: any, name: string) => ({ __coll: name })),
  query: jest.fn((coll: any, ...rest: any[]) => ({ __q: coll?.__coll, rest })),
  orderBy: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  serverTimestamp: jest.fn(() => ({})),
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
  Timestamp: { fromDate: jest.fn(() => ({})), now: jest.fn(() => ({})) },
  onSnapshot: jest.fn((q: any, cb: any, _errCb: any) => {
    state.onSnapshotCalls.push(q);
    state.snapshotCallback = cb;
    return state.unsubscribe;
  }),
  getDocs: jest.fn((arg: any) => {
    state.getDocsCalls.push(arg);
    if (arg?.__q === 'certificates') return Promise.resolve({ docs: CERT_DOCS });
    return Promise.resolve({ docs: [] });
  }),
}));

jest.mock('@/hooks/use-role', () => ({
  useRole: () => ({ role: 'admin', loading: false }),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, isLoading: false }),
}));

jest.mock('@/hooks/use-enhanced-toast', () => ({
  useEnhancedToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: any) => <>{children}</>,
}));

jest.mock('@/components/admin/user-selection-combobox', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/admin/bulk-user-selector', () => ({
  BulkUserSelector: () => null,
}));

function certGetDocsCalls() {
  return state.getDocsCalls.filter((a) => a?.__q === 'certificates');
}

function renderedRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
    (tr.textContent || '').replace(/\s+/g, ' ').trim(),
  );
}

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_SUPA_SURFACES;

beforeEach(() => {
  state.onSnapshotCalls = [];
  state.snapshotCallback = null;
  state.getDocsCalls = [];
  state.unsubscribe.mockClear();
  delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  (global as any).fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ chapters: [], roles: [] }) }),
  );
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  else process.env.NEXT_PUBLIC_SUPA_SURFACES = ORIGINAL_ENV;
});

describe('CertificatesAdminPage live-admin conversion', () => {
  it('flag OFF subscribes with onSnapshot on the bare certificates query and never one-shot fetches it', async () => {
    render(<CertificatesAdminPage />);
    await act(async () => {});

    expect(state.onSnapshotCalls).toHaveLength(1);
    expect(state.onSnapshotCalls[0]).toEqual(expect.objectContaining({ __q: 'certificates' }));
    expect(certGetDocsCalls()).toHaveLength(0);
  });

  it('flag ON creates no subscription and one-shot fetches the certificates query exactly once', async () => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
    render(<CertificatesAdminPage />);
    await act(async () => {});

    expect(state.onSnapshotCalls).toHaveLength(0);
    expect(certGetDocsCalls()).toHaveLength(1);
    expect(certGetDocsCalls()[0]).toEqual(expect.objectContaining({ __q: 'certificates' }));
    expect(await screen.findByText('Ayesha Khan')).toBeInTheDocument();
  });

  it('hands shape-identical rows to render on both paths', async () => {
    const off = render(<CertificatesAdminPage />);
    await act(async () => {});
    expect(state.snapshotCallback).not.toBeNull();
    await act(async () => {
      state.snapshotCallback!({ docs: CERT_DOCS });
    });
    const offRows = renderedRows(off.container);
    expect(offRows).toHaveLength(2);
    expect(offRows[0]).toContain('Ayesha Khan');
    expect(offRows[0]).toContain('CODE-1');
    off.unmount();

    state.onSnapshotCalls = [];
    state.getDocsCalls = [];
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
    const on = render(<CertificatesAdminPage />);
    await act(async () => {});
    const onRows = renderedRows(on.container);

    expect(onRows).toEqual(offRows);
  });
});
