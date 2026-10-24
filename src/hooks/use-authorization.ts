'use client';

import { useMemo } from 'react';
import { useUserContext } from '@/firebase/user-provider';
import { hasPermissionForAnyRole } from '@/config/permissions';
import { type PermissionKey } from '@/config/permissions.config';
import { useFirestore } from '@/firebase';

export type UseAuthorizationResult = {
  isAuthorized: boolean;
  isLoading: boolean;
  role: string | null;
};

export function useAuthorization(permission?: PermissionKey | string): UseAuthorizationResult {
  const { role, customRoles, allowedPaths, isLoading } = useUserContext();

  const isAuthorized = useMemo(() => {
    if (!role) return false;
    if (role === 'superadmin' || role === 'founder_patron' || allowedPaths.includes('all')) return true;

    if (!permission) return true;

    // Holder-level union over the primary role plus every held custom
    // role, each slug evaluated on its own through the dynamic
    // hasPermission (which respects Firestore overrides). A custom
    // role's grant is never attributed to the primary role: a holder
    // WITHOUT the custom role gets exactly the pre-union answer.
    return hasPermissionForAnyRole([role, ...(customRoles ?? [])], permission);
  }, [role, customRoles, permission, allowedPaths]);

  return { isAuthorized, isLoading, role: role || null };
}

