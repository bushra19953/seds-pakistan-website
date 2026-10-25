/**
 * Contract tests for the blog admin list (B1) under the live-admin
 * surface flag (Supabase migration, listeners Class D).
 *
 * The page drives useCollection with { listen: true } today. Flag OFF
 * must pass exactly that; flag ON must pass { listen: false }, which
 * the hook turns into a one-shot getDocs with no subscription (pinned
 * at hook level in src/lib/__tests__/live-admin-hook-oneshot.test.tsx).
 * The rendered rows are shape-identical between the two paths.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import BlogAdminPage from '../page';

(global as any).React = React;

const mockDb = { __db: 'fake-db' };

const BLOGS = [
  {
    id: 'b1',
    title: 'First Transmission',
    slug: 'first-transmission',
    authorName: 'Ayesha Khan',
    status: 'published',
    createdAt: { toDate: () => new Date('2026-01-01T00:00:00Z') },
    updatedAt: { toDate: () => new Date('2026-01-02T00:00:00Z') },
  },
  {
    id: 'b2',
    title: 'Second Transmission',
    slug: 'second-transmission',
    authorName: 'Bilal Ahmed',
    status: 'draft',
    createdAt: { toDate: () => new Date('2026-01-03T00:00:00Z') },
    updatedAt: { toDate: () => new Date('2026-01-04T00:00:00Z') },
  },
];

const mockState: { optionsSeen: any[] } = { optionsSeen: [] };

jest.mock('@/firebase', () => ({
  useFirestore: () => mockDb,
  useUser: () => ({ user: { uid: 'admin-1', getIdToken: () => Promise.resolve('tok') }, role: 'admin', isLoading: false }),
  useCollection: jest.fn((_query: any, options?: any) => {
    mockState.optionsSeen.push(options);
    return { data: BLOGS, loading: false, error: null };
  }),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: any, name: string) => ({ __coll: name })),
  query: jest.fn((coll: any, ...rest: any[]) => ({ __q: coll?.__coll, rest })),
  orderBy: jest.fn((field: string, dir: string) => ({ __orderBy: [field, dir] })),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, isLoading: false }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/components/admin/AuthorizationGate', () => ({
  __esModule: true,
  default: ({ children }: any) => <>{children}</>,
}));

jest.mock('@/components/layout/footer', () => ({
  __esModule: true,
  default: () => null,
}));

function renderedRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
    (tr.textContent || '').replace(/\s+/g, ' ').trim(),
  );
}

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_SUPA_SURFACES;

beforeEach(() => {
  mockState.optionsSeen = [];
  delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
  else process.env.NEXT_PUBLIC_SUPA_SURFACES = ORIGINAL_ENV;
});

describe('BlogAdminPage live-admin conversion', () => {
  it('flag OFF passes listen true to useCollection', () => {
    render(<BlogAdminPage />);
    expect(mockState.optionsSeen.length).toBeGreaterThan(0);
    expect(mockState.optionsSeen[0]).toEqual({ listen: true });
  });

  it('flag ON passes listen false to useCollection', () => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
    render(<BlogAdminPage />);
    expect(mockState.optionsSeen.length).toBeGreaterThan(0);
    expect(mockState.optionsSeen[0]).toEqual({ listen: false });
  });

  it('renders shape-identical rows on both paths', async () => {
    const off = render(<BlogAdminPage />);
    expect(await screen.findByText('First Transmission')).toBeInTheDocument();
    const offRows = renderedRows(off.container);
    expect(offRows).toHaveLength(2);
    off.unmount();

    mockState.optionsSeen = [];
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'LIVE-ADMIN';
    const on = render(<BlogAdminPage />);
    expect(await screen.findByText('First Transmission')).toBeInTheDocument();
    const onRows = renderedRows(on.container);

    expect(onRows).toEqual(offRows);
    expect(mockState.optionsSeen[0]).toEqual({ listen: false });
  });
});
