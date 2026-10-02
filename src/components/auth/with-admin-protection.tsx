'use client';

import { useUser } from '@/firebase/auth/use-user';
import { hasSufficientRole, UserRole } from '@/lib/roles';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

interface WithAdminProtectionProps {
  requiredRole?: UserRole;
  redirectTo?: string;
}

export function withAdminProtection<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  options: WithAdminProtectionProps = {}
) {
  const { requiredRole = 'admin', redirectTo = '/auth/login' } = options;

  return function ProtectedComponent(props: P) {
    const { user, role, isLoading, error } = useUser();
    const router = useRouter();

    useEffect(() => {
      // Don't redirect while loading
      if (isLoading) return;

      // If not authenticated, redirect to login
      if (!user) {
        console.log('Admin protection: No user, redirecting to login');
        router.replace(redirectTo);
        return;
      }

      // If we have a role and it doesn't meet requirements, redirect
      if (role && !hasSufficientRole(role, requiredRole as UserRole)) {
        console.log(`Admin protection: User role '${role}' insufficient for required role '${requiredRole}', redirecting to login`);
        router.replace(redirectTo);
        return;
      }

      // If there's an error and we don't have a valid role, redirect
      if (error && !role) {
        console.log('Admin protection: Error fetching role, redirecting to login');
        router.replace(redirectTo);
        return;
      }

      // If role is null (not just loading), it might be a guest role
      if (role === null && !isLoading) {
        console.log('Admin protection: No role found, treating as guest and redirecting');
        router.replace(redirectTo);
        return;
      }

    }, [user, role, isLoading, error, router, requiredRole, redirectTo]);

    // Show loading state while determining access
    if (isLoading) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Loading...</p>
          </div>
        </div>
      );
    }

    // Don't render the component if user doesn't have access
    if (!user || !role || !hasSufficientRole(role, requiredRole as UserRole)) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Access Denied</h2>
            <p className="text-gray-600">You don&apos;t have permission to access this page.</p>
            <button 
              onClick={() => router.replace(redirectTo)}
              className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Go to Login
            </button>
          </div>
        </div>
      );
    }

    // User has access, render the wrapped component
    return <WrappedComponent {...props} />;
  };
}

// Custom hook version for simpler use cases
export function useAdminProtection(requiredRole: UserRole = 'member') {
  const { user, role, isLoading, error } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      router.push('/auth/login');
      return;
    }

    if (role && !hasSufficientRole(role, requiredRole)) {
      router.push('/auth/login');
      return;
    }

    if (error && !role) {
      router.push('/auth/login');
      return;
    }

    if (role === null && !isLoading) {
      router.push('/auth/login');
      return;
    }
  }, [user, role, isLoading, error, router, requiredRole]);

  return {
    hasAccess: user && role && hasSufficientRole(role, requiredRole),
    isLoading,
    userRole: role,
    user
  };
}
