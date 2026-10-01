'use client';

import { useUserContext } from '../user-provider';

export function useUser() {
  return useUserContext();
}
