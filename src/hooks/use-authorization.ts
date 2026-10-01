'use client';

import { useMemo } from 'react';
import { useUserContext } from '@/firebase/user-provider';
import { hasPermission } from '@/config/permissions';
import { type PermissionKey } from '@/config/permissions.config';
import { useFirestore } from '@/firebase';

export type UseAuthorizationResult = {
  isAuthorized: boolean;
  isLoading: boolean;
  role: string | null;
};

export function useAuthorization(permission?: PermissionKey | string): UseAuthorizationResult {
  const { role, allowedPaths, isLoading } = useUserContext();

  const isAuthorized = useMemo(() => {
    if (!role) return false;
    if (role === 'superadmin' || allowedPaths.includes('all')) return true;

    if (!permission) return true;

    // Use the dynamic hasPermission which respects Firestore overrides
    return hasPermission(role as any, permission);
  }, [role, permission, allowedPaths]);

  return { isAuthorized, isLoading, role: role || null };
}

