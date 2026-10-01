'use client';

import React from 'react';
import { FirebaseProvider } from './provider';
import { UserProvider } from './user-provider';

// This component ensures Firebase is initialized only on the client side.
export function FirebaseClientProvider({ children }: { children: React.ReactNode }) {
  return (
    <FirebaseProvider>
      <UserProvider>
        {children}
      </UserProvider>
    </FirebaseProvider>
  );
}
