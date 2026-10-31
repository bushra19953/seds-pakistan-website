'use client';

import { useCallback } from 'react';
import { useUser } from '@/firebase';

export interface VendorApiError {
  status: number;
  code?: string;
  error: string;
}

export function useVendorApi() {
  const { user } = useUser();

  const call = useCallback(
    async (method: 'GET' | 'PATCH', path: string, body?: unknown) => {
      if (!user) throw { status: 401, error: 'Unauthorized' } as VendorApiError;
      const token = await user.getIdToken();
      const res = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw { status: res.status, code: data.code, error: data.error || 'Request failed' } as VendorApiError;
      }
      return data;
    },
    [user],
  );

  const get = useCallback((path: string) => call('GET', path), [call]);
  const patch = useCallback((path: string, body: unknown) => call('PATCH', path, body), [call]);
  return { get, patch, user };
}

export const VENDOR_GATE_MESSAGE =
  'Vendor access is not active for this account. If you think this is a mistake, contact the SEDS Pakistan team on WhatsApp.';
