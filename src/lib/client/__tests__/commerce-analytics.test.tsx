/**
 * GC fire helper: useCommerceAnalytics.
 *
 * Gate rules under coordinator ruling R-13: signed-in only plus the
 * global visit-tracking flag. The helper does NOT gate on
 * NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS; that flag governs the
 * legacy AnalyticsEventTracker only. serverWrite is mocked; no
 * network call leaves the suite.
 */
import { act, renderHook } from '@testing-library/react';

jest.mock('@/firebase', () => ({
  useUser: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  usePathname: jest.fn(),
}));
jest.mock('@/lib/client/server-write', () => ({
  serverWrite: jest.fn(),
}));

import { useUser } from '@/firebase';
import { usePathname } from 'next/navigation';
import { serverWrite } from '@/lib/client/server-write';
import {
  useCommerceAnalytics,
  type CommerceEventType,
} from '@/lib/client/commerce-analytics';

const mockUseUser = useUser as jest.Mock;
const mockUsePathname = usePathname as jest.Mock;
const mockServerWrite = serverWrite as jest.Mock;

const COMMERCE_TYPES: CommerceEventType[] = [
  'product_view',
  'buy_click',
  'checkout_start',
  'order_created',
];

const originalDetailed = process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS;
const originalVisit = process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING;

function restoreEnv() {
  if (originalDetailed === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS;
  } else {
    process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS = originalDetailed;
  }
  if (originalVisit === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING;
  } else {
    process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING = originalVisit;
  }
}

beforeEach(() => {
  restoreEnv();
  delete process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS;
  delete process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING;
  mockUseUser.mockReset();
  mockUseUser.mockReturnValue({ user: { uid: 'user-1' } });
  mockUsePathname.mockReset();
  mockUsePathname.mockReturnValue('/store/p1');
  mockServerWrite.mockReset();
  mockServerWrite.mockResolvedValue({ status: 200, body: { ok: true } });
});

afterEach(() => {
  restoreEnv();
});

describe('useCommerceAnalytics (GC fire helper)', () => {
  it.each(COMMERCE_TYPES)(
    'fires %s with productId and the current path through serverWrite when signed in',
    async (type) => {
      const { result } = renderHook(() => useCommerceAnalytics());
      await act(async () => {
        await result.current.trackCommerceEvent(type, 'p1');
      });
      expect(mockServerWrite).toHaveBeenCalledTimes(1);
      expect(mockServerWrite).toHaveBeenCalledWith(
        '/api/analytics/track',
        'POST',
        {
          kind: 'analyticsEvent',
          event: { type, path: '/store/p1', productId: 'p1' },
        },
      );
    },
  );

  it('fires when NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS is not true (R-13: that flag gates the legacy tracker only)', async () => {
    for (const value of [undefined, 'false'] as const) {
      mockServerWrite.mockClear();
      if (value === undefined) {
        delete process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS;
      } else {
        process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS = value;
      }
      const { result, unmount } = renderHook(() => useCommerceAnalytics());
      await act(async () => {
        await result.current.trackCommerceEvent('product_view', 'p1');
      });
      expect(mockServerWrite).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('sends no userId and no timestamp; the server derives both', async () => {
    const { result } = renderHook(() => useCommerceAnalytics());
    await act(async () => {
      await result.current.trackCommerceEvent('buy_click', 'p1');
    });
    const body = mockServerWrite.mock.calls[0][2];
    expect(body.event).not.toHaveProperty('userId');
    expect(body.event).not.toHaveProperty('timestamp');
    expect(Object.keys(body.event).sort()).toEqual([
      'path',
      'productId',
      'type',
    ]);
  });

  it('uses the explicit path argument over usePathname when one is given', async () => {
    const { result } = renderHook(() => useCommerceAnalytics());
    await act(async () => {
      await result.current.trackCommerceEvent(
        'product_view',
        'p2',
        '/store/p2',
      );
    });
    expect(mockServerWrite).toHaveBeenCalledWith(
      '/api/analytics/track',
      'POST',
      {
        kind: 'analyticsEvent',
        event: { type: 'product_view', path: '/store/p2', productId: 'p2' },
      },
    );
  });

  it('is a silent no-op when signed out', async () => {
    mockUseUser.mockReturnValue({ user: null });
    const { result } = renderHook(() => useCommerceAnalytics());
    await act(async () => {
      await expect(
        result.current.trackCommerceEvent('product_view', 'p1'),
      ).resolves.toBeUndefined();
    });
    expect(mockServerWrite).not.toHaveBeenCalled();
  });

  it('is a silent no-op when NEXT_PUBLIC_ENABLE_VISIT_TRACKING is false', async () => {
    process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING = 'false';
    const { result } = renderHook(() => useCommerceAnalytics());
    await act(async () => {
      await result.current.trackCommerceEvent('product_view', 'p1');
    });
    expect(mockServerWrite).not.toHaveBeenCalled();
  });

  it('is a silent no-op for an empty or whitespace productId', async () => {
    const { result } = renderHook(() => useCommerceAnalytics());
    await act(async () => {
      await result.current.trackCommerceEvent('product_view', '');
      await result.current.trackCommerceEvent('product_view', '   ');
    });
    expect(mockServerWrite).not.toHaveBeenCalled();
  });

  it('resolves and never rejects when serverWrite rejects', async () => {
    mockServerWrite.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useCommerceAnalytics());
    await act(async () => {
      await expect(
        result.current.trackCommerceEvent('order_created', 'p1'),
      ).resolves.toBeUndefined();
    });
    expect(mockServerWrite).toHaveBeenCalledTimes(1);
  });
});
