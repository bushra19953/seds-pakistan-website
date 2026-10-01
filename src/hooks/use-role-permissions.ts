"use client";

import { useState, useEffect } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { useFirestore } from '@/firebase';
import { useUser } from '@/firebase/auth/use-user';

/**
 * A role_permissions document in Firestore looks like:
 * {
 *   role: "chair_marketing",
 *   label: "Marketing Chair",           // human-readable name
 *   allowedPaths: ["/admin/blog", "/admin/announcements", "/admin/gallery"],
 *   canAccessAdmin: true,               // can they see the admin panel at all?
 *   createdAt: Timestamp,
 *   updatedAt: Timestamp,
 * }
 *
 * Doc ID = role slug (e.g., "chair_marketing")
 */

export interface RolePermissionDoc {
  role: string;
  label: string;
  allowedPaths: string[];
  canAccessAdmin: boolean;
  createdAt?: any;
  updatedAt?: any;
}

/**
 * Hook that loads the current user's role permissions from Firestore.
 * Falls back to the hardcoded config if no Firestore doc exists (backward compat).
 */
export function useRolePermissions() {
  const { role, allowedPaths, isLoading } = useUser();

  /**
   * Check if the current user can access a specific sidebar path.
   */
  const canAccess = (path: string): boolean => {
    if (!role) return false;
    if (role === 'superadmin' || allowedPaths.includes('*') || allowedPaths.includes('all')) return true;
    
    // Check exact match or prefix match
    return allowedPaths.some(allowed =>
      path === allowed || path.startsWith(allowed + '/')
    );
  };

  return {
    permissions: role ? { role, allowedPaths, label: role } : null,
    loading: isLoading,
    usingFallback: allowedPaths.length === 0 && role !== 'superadmin',
    canAccess,
    canAccessAdmin: allowedPaths.length > 0 || role === 'superadmin',
  };
}
