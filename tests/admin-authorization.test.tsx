import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AdminAnalyticsPage from '@/app/admin/analytics/page';
import AdminProjectsPage from '@/app/admin/projects/page';
import * as hooks from '@/hooks/use-authorization';
import * as firebaseHooks from '@/firebase';

// Mock the authorization hook to simulate unauthorized state
jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: jest.fn(),
}));

// Mock Next.js navigation
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/admin/analytics',
  useSearchParams: () => ({
    get: jest.fn(),
  }),
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  getDocs: jest.fn(() => Promise.resolve({ docs: [], forEach: jest.fn() })),
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(() => Promise.resolve({ exists: () => false })),
  getCountFromServer: jest.fn(() => Promise.resolve({ data: () => ({ count: 0 }) })),
  serverTimestamp: jest.fn(() => ({})),
  writeBatch: jest.fn(() => ({
    set: jest.fn(),
    commit: jest.fn(() => Promise.resolve()),
  })),
}));

jest.mock('@/firebase', () => ({
  useUser: jest.fn(),
  useFirestore: jest.fn(() => ({})),
  useCollection: jest.fn(() => ({ data: [], loading: false })),
  useDoc: jest.fn(() => ({ data: null, loading: false })),
  getFirebaseApp: jest.fn(() => ({})),
}));

jest.mock('@/firebase/provider', () => ({
  useFirestore: jest.fn(() => ({})),
  getFirebaseApp: jest.fn(() => ({})),
  useFirebase: jest.fn(() => ({})),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
}));

// Mock Recharts to prevent errors during testing
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div>{children}</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  Bar: () => null,
  Line: () => null,
}));

// Mock UI components that might interfere with simple rendering
jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children }: any) => <button>{children}</button>,
}));

describe('Admin Pages Authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    (firebaseHooks.useUser as jest.Mock).mockReturnValue({
      user: { uid: '123' },
      role: 'guest',
      isLoading: false,
    });
    
    // Explicitly simulate unauthorized hook state
    (hooks.useAuthorization as jest.Mock).mockReturnValue({
      isAuthorized: false,
      isLoading: false,
    });
  });

  test('Analytics page renders Permission Denied when unauthorized', () => {
    render(<AdminAnalyticsPage />);
    expect(screen.getByText(/Permission Denied/i)).toBeInTheDocument();
  });

  test('Projects page renders Permission Denied when unauthorized', () => {
    render(<AdminProjectsPage />);
    expect(screen.getByText(/Permission Denied/i)).toBeInTheDocument();
  });
});
