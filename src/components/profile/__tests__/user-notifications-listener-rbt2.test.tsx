/**
 * RBT2 tests for UserNotificationsListener (census 19 item 3):
 * - With the `notifications` client surface ON, the listener takes
 *   its data from the flipped notifications seam (GET
 *   /api/notifications via useSupaPersonalNotifications) and NEVER
 *   builds the live 20-doc Firestore query.
 * - With the surface OFF, the Firestore subscription path is used
 *   exactly as before.
 */

import React from 'react';
import { render } from '@testing-library/react';

const captured = {
  subscriptionQueries: [] as any[],
  supaEnabledArgs: [] as any[],
};

jest.mock('@/firebase', () => ({
  useFirestore: () => ({ __fs: true }),
  useUser: () => ({ user: { uid: 'u-1', getIdToken: async () => 'tok' } }),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((...args: any[]) => ({ __collection: args })),
  query: jest.fn((...args: any[]) => ({ __query: args })),
  orderBy: jest.fn(() => ({ __orderBy: true })),
  limit: jest.fn(() => ({ __limit: true })),
}));

jest.mock('@/hooks/use-safe-firestore-subscription', () => ({
  useSafeFirestoreSubscription: (q: any, opts: any) => {
    captured.subscriptionQueries.push(q);
    return { data: [], opts };
  },
}));

jest.mock('@/hooks/use-enhanced-toast', () => ({
  useEnhancedToast: () => ({ showSuccessToast: jest.fn(), showActionToast: jest.fn() }),
}));

jest.mock('@/lib/notifications-supa-client', () => ({
  notificationsSupaEnabled: jest.fn(() => captured.supaEnabledArgs.length > 0 && captured.supaEnabledArgs[0]),
  useSupaPersonalNotifications: jest.fn(() => ({ data: [], loading: false, failed: false })),
}));

import UserNotificationsListener from '@/components/profile/user-notifications-listener';
import { query } from 'firebase/firestore';

describe('UserNotificationsListener RBT2', () => {
  beforeEach(() => {
    captured.subscriptionQueries = [];
    captured.supaEnabledArgs = [];
    jest.clearAllMocks();
    // clearAllMocks resets mock implementations set at factory time for
    // plain jest.fn()s created inside factories; re-arm the seam flag.
    const seam = jest.requireMock('@/lib/notifications-supa-client');
    seam.notificationsSupaEnabled.mockImplementation(
      () => captured.supaEnabledArgs.length > 0 && captured.supaEnabledArgs[0],
    );
    seam.useSupaPersonalNotifications.mockImplementation(() => ({ data: [], loading: false, failed: false }));
  });

  test('surface ON: Firestore query is never built (subscription receives null)', () => {
    captured.supaEnabledArgs = [true];
    render(<UserNotificationsListener />);
    expect(captured.subscriptionQueries).toEqual([null]);
    expect(query).not.toHaveBeenCalled();
  });

  test('surface OFF: Firestore subscription query is built as before', () => {
    captured.supaEnabledArgs = [false];
    render(<UserNotificationsListener />);
    expect(captured.subscriptionQueries).toHaveLength(1);
    expect(captured.subscriptionQueries[0]).not.toBeNull();
    expect(query).toHaveBeenCalled();
  });
});
