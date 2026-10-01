"use client";

import React from 'react';
import { useAuthorization } from '@/hooks/use-authorization';
import type { PermissionKey } from '@/config/permissions.config';

type Props = {
  permission: PermissionKey;
  children: React.ReactNode;
  fallback?: React.ReactNode;
};

export default function AuthorizationGate({ permission, children, fallback }: Props) {
  const { isAuthorized, isLoading } = useAuthorization(permission);

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground">Loading authorization…</div>
    );
  }

  if (!isAuthorized) {
    return (
      fallback || (
        <div className="p-6">
          <div className="rounded-md border p-4">
            <h2 className="text-lg font-semibold">Permission Denied</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              You do not have access to this admin page.
            </p>
          </div>
        </div>
      )
    );
  }

  return <>{children}</>;
}

