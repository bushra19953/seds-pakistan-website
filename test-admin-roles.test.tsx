// Simple test to verify the admin roles page structure
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AdminRolesPage from './src/app/admin/roles/page';

// Mock Firebase and other dependencies
jest.mock('./src/firebase', () => ({
  useUser: () => ({
    user: { uid: 'test-user', email: 'test@example.com', displayName: 'Test User' },
    loading: false,
    role: 'superadmin'
  }),
  useCollection: (path: string) => {
    if (path.includes('users')) {
      return {
        data: [
          { uid: 'user1', email: 'user1@example.com', displayName: 'User One' },
          { uid: 'user2', email: 'user2@example.com', displayName: 'User Two' }
        ],
        loading: false,
        error: null
      };
    }
    if (path.includes('roles')) {
      return {
        data: [
          { id: 'user1', role: 'member' },
          { id: 'user2', role: 'admin' }
        ],
        loading: false,
        error: null
      };
    }
    return { data: [], loading: false, error: null };
  }
}));

// Mock other dependencies
jest.mock('./src/lib/use-memo-firebase', () => ({
  useMemoFirebase: (fn: any) => fn()
}));

jest.mock('./src/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn()
  })
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn()
  })
}));

describe('AdminRolesPage', () => {
  test('renders without crashing', () => {
    render(<AdminRolesPage />);
    expect(screen.getByText('Role Management')).toBeInTheDocument();
  });

  test('displays users when data is available', () => {
    render(<AdminRolesPage />);
    expect(screen.getByText('User One')).toBeInTheDocument();
    expect(screen.getByText('User Two')).toBeInTheDocument();
  });

  test('shows role assignment dropdown', () => {
    render(<AdminRolesPage />);
    const assignDropdowns = screen.getAllByText('Assign role');
    expect(assignDropdowns.length).toBeGreaterThan(0);
  });
});