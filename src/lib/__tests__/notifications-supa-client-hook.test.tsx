/**
 * useSupaPersonalNotifications hook tests (Supabase migration,
 * notifications cluster G1).
 *
 * Per-flag-state behavior:
 * - OFF: the hook is inert — no fetch, no polling, no data; the
 *   caller's Firestore path runs exactly as before.
 * - ON + route healthy: data arrives revived from the route, refresh
 *   rides the shared usePollingRefresh cadence (5-minute floor).
 * - ON + route error: `failed` flips true (terminal for the mount)
 *   so the caller re-enables its Firestore query and falls back.
 * - Writes are optimistic and revert when the PATCH fails.
 *
 * Fetch is mocked globally; zero live reads.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { Timestamp } from 'firebase/firestore';
import {
    useSupaPersonalNotifications,
    type UseSupaPersonalNotifications,
} from '@/lib/notifications-supa-client';
import { MIN_POLL_INTERVAL_MS } from '@/hooks/use-polling-refresh';

let latest: UseSupaPersonalNotifications | null = null;

function Probe({ enabled }: { enabled: boolean }) {
    latest = useSupaPersonalNotifications({ enabled, getIdToken: () => Promise.resolve('tok') });
    return null;
}

function jsonResponse(body: any, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
    } as Response;
}

const ROWS = [
    { id: 'n2', title: 'newest', isRead: false, timestamp: '2026-10-25T05:00:00.000Z' },
    { id: 'n1', title: 'older', isRead: true, timestamp: '2026-10-24T05:00:00.000Z' },
];

let fetchMock: jest.Mock;

beforeEach(() => {
    latest = null;
    fetchMock = jest.fn(() => Promise.resolve(jsonResponse(ROWS)));
    (global as any).fetch = fetchMock;
});

afterEach(() => {
    jest.useRealTimers();
});

describe('useSupaPersonalNotifications', () => {
    it('OFF: never fetches, never reports failed, data stays null', async () => {
        jest.useFakeTimers();
        render(<Probe enabled={false} />);
        await act(async () => {});
        await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS * 3); });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(latest!.data).toBeNull();
        expect(latest!.failed).toBe(false);
        expect(latest!.loading).toBe(false);
    });

    it('ON: fetches once on mount and returns revived rows', async () => {
        render(<Probe enabled />);
        await act(async () => {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(latest!.failed).toBe(false);
        expect(latest!.loading).toBe(false);
        expect(latest!.data!.map((n) => n.id)).toEqual(['n2', 'n1']);
        expect(latest!.data![0].timestamp).toBeInstanceOf(Timestamp);
        expect(latest!.data![0].timestamp!.toDate().toISOString()).toBe('2026-10-25T05:00:00.000Z');
    });

    it('ON: refreshes on the shared 5-minute polling cadence, not faster', async () => {
        jest.useFakeTimers();
        render(<Probe enabled />);
        await act(async () => {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS - 1000); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => { jest.advanceTimersByTime(1000); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ON + route error: failed flips true and polling stops', async () => {
        jest.useFakeTimers();
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'x' }, 500)));
        render(<Probe enabled />);
        await act(async () => {});
        expect(latest!.failed).toBe(true);
        expect(latest!.loading).toBe(false);
        const calls = fetchMock.mock.calls.length;
        await act(async () => { jest.advanceTimersByTime(MIN_POLL_INTERVAL_MS * 2); });
        expect(fetchMock.mock.calls.length).toBe(calls);
    });

    it('markRead is optimistic and PATCHes through the route', async () => {
        render(<Probe enabled />);
        await act(async () => {});
        fetchMock.mockClear();
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
        await act(async () => { await latest!.markRead('n2'); });
        expect(latest!.data!.find((n) => n.id === 'n2')!.isRead).toBe(true);
        const [, init] = fetchMock.mock.calls[0] as any[];
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ id: 'n2', isRead: true });
    });

    it('markRead reverts the optimistic update when the PATCH fails', async () => {
        render(<Probe enabled />);
        await act(async () => {});
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({}, 500)));
        await act(async () => { await latest!.markRead('n2'); });
        expect(latest!.data!.find((n) => n.id === 'n2')!.isRead).toBe(false);
    });

    it('markAllRead PATCHes only the unread rows and flips them all', async () => {
        render(<Probe enabled />);
        await act(async () => {});
        fetchMock.mockClear();
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
        await act(async () => { await latest!.markAllRead(); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(latest!.data!.every((n) => n.isRead)).toBe(true);
    });
});
