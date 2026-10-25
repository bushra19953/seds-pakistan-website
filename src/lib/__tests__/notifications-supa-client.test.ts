/**
 * notifications-supa-client seam tests (Supabase migration,
 * notifications cluster G1).
 *
 * Pins the migration contract for the client read path:
 * - flag OFF by default; ON only when NEXT_PUBLIC_SUPA_SURFACES lists
 *   the `notifications` surface;
 * - route payloads are revived into the exact shape the Firestore
 *   listener produces today ({ ...doc.data(), id } with real
 *   firebase/firestore Timestamp fields), because consumers call
 *   .toDate() on them;
 * - every write goes through the G2 route contract (PATCH/DELETE
 *   /api/notifications), with the tree's Bearer ID-token convention;
 * - route errors throw, so callers fall back to Firestore.
 *
 * No live reads: fetch is injected/mocked throughout.
 */

import { Timestamp } from 'firebase/firestore';
import {
    isSupaSurfaceEnabled,
    notificationsSupaEnabled,
    reviveTimestampValue,
    reviveNotification,
    fetchPersonalNotificationsFromApi,
    markNotificationReadViaApi,
    deleteNotificationViaApi,
} from '@/lib/notifications-supa-client';

describe('flag parsing: NEXT_PUBLIC_SUPA_SURFACES', () => {
    it('is OFF when unset or empty', () => {
        expect(isSupaSurfaceEnabled('notifications', undefined)).toBe(false);
        expect(isSupaSurfaceEnabled('notifications', '')).toBe(false);
        expect(isSupaSurfaceEnabled('notifications', '  ')).toBe(false);
    });

    it('is ON only for a listed surface', () => {
        expect(isSupaSurfaceEnabled('notifications', 'notifications')).toBe(true);
        expect(isSupaSurfaceEnabled('notifications', 'announcements,notifications')).toBe(true);
        expect(isSupaSurfaceEnabled('notifications', 'announcements')).toBe(false);
        expect(isSupaSurfaceEnabled('notifications', 'notificationsx')).toBe(false);
    });

    it('tolerates case and whitespace', () => {
        expect(isSupaSurfaceEnabled('notifications', ' Announcements , NOTIFICATIONS ')).toBe(true);
        expect(isSupaSurfaceEnabled('NOTIFICATIONS', 'notifications')).toBe(true);
    });

    it('notificationsSupaEnabled() reads the env var', () => {
        const prev = process.env.NEXT_PUBLIC_SUPA_SURFACES;
        try {
            delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
            expect(notificationsSupaEnabled()).toBe(false);
            process.env.NEXT_PUBLIC_SUPA_SURFACES = 'notifications';
            expect(notificationsSupaEnabled()).toBe(true);
            process.env.NEXT_PUBLIC_SUPA_SURFACES = 'announcements';
            expect(notificationsSupaEnabled()).toBe(false);
        } finally {
            if (prev === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
            else process.env.NEXT_PUBLIC_SUPA_SURFACES = prev;
        }
    });
});

describe('reviveTimestampValue: every wire shape a Firestore timestamp takes', () => {
    const ms = Date.parse('2026-10-25T05:00:00.000Z');

    it('passes a real Timestamp through untouched', () => {
        const ts = Timestamp.fromMillis(ms);
        expect(reviveTimestampValue(ts)).toBe(ts);
    });

    it('revives an ISO string (the G2 route contract) into a Timestamp with a working .toDate()', () => {
        const out = reviveTimestampValue('2026-10-25T05:00:00.000Z');
        expect(out).toBeInstanceOf(Timestamp);
        expect(out.toDate().getTime()).toBe(ms);
        expect(out.toMillis()).toBe(ms);
    });

    it('revives epoch millis and Dates', () => {
        expect(reviveTimestampValue(ms).toMillis()).toBe(ms);
        expect(reviveTimestampValue(new Date(ms)).toMillis()).toBe(ms);
    });

    it('revives the Timestamp#toJSON shape { seconds, nanoseconds }', () => {
        const out = reviveTimestampValue({ seconds: Math.floor(ms / 1000), nanoseconds: 250000000 });
        expect(out).toBeInstanceOf(Timestamp);
        expect(out.toMillis()).toBe(ms + 250);
    });

    it('revives the Admin SDK / jsonb dump shape { _seconds, _nanoseconds }', () => {
        // This is how timestamps land in the fs_group_notifications `data`
        // jsonb (see supabase-migration/migrate_db.js rowFor: data is
        // doc.data() from the Admin SDK, serialized to JSON).
        const out = reviveTimestampValue({ _seconds: Math.floor(ms / 1000), _nanoseconds: 0 });
        expect(out).toBeInstanceOf(Timestamp);
        expect(out.toMillis()).toBe(ms);
    });

    it('returns unrecognized values unchanged instead of dropping them', () => {
        expect(reviveTimestampValue('not a date')).toBe('not a date');
        expect(reviveTimestampValue(null)).toBeNull();
        expect(reviveTimestampValue(undefined)).toBeUndefined();
        const obj = { hello: 'world' };
        expect(reviveTimestampValue(obj)).toBe(obj);
    });
});

describe('reviveNotification: shape identity with the Firestore listener', () => {
    it('revives known timestamp fields and nothing else', () => {
        const out = reviveNotification({
            id: 'n1',
            title: 'Task assigned',
            body: 'Due 2026-10-25T05:00:00.000Z sharp', // looks like a date, must stay a string
            isRead: false,
            timestamp: '2026-10-25T05:00:00.000Z',
            deadline: { _seconds: 1761454800, _nanoseconds: 0 },
            capacity: 10,
            location: 'BIC Room 131',
        });
        expect(out.id).toBe('n1');
        expect(out.title).toBe('Task assigned');
        expect(out.body).toBe('Due 2026-10-25T05:00:00.000Z sharp');
        expect(out.isRead).toBe(false);
        expect(out.capacity).toBe(10);
        expect(out.location).toBe('BIC Room 131');
        expect(out.timestamp).toBeInstanceOf(Timestamp);
        expect(out.timestamp!.toDate().toISOString()).toBe('2026-10-25T05:00:00.000Z');
        expect(out.deadline).toBeInstanceOf(Timestamp);
        expect(out.deadline!.toMillis()).toBe(1761454800000);
    });

    it('matches the listener shape: one object per doc, doc fields spread, id on top', () => {
        const listenerRow = { title: 'x', isRead: true, timestamp: Timestamp.fromMillis(1000), id: 'abc' };
        const revived = reviveNotification({ id: 'abc', title: 'x', isRead: true, timestamp: '1970-01-01T00:00:01.000Z' });
        expect(Object.keys(revived).sort()).toEqual(Object.keys(listenerRow).sort());
        expect(revived.timestamp!.toMillis()).toBe(listenerRow.timestamp.toMillis());
    });
});

function jsonResponse(body: any, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
    } as Response;
}

describe('route client (G2 contract)', () => {
    it('GETs /api/notifications with credentials and the Bearer ID token, revives rows', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse([
            { id: 'n2', title: 'newest', isRead: false, timestamp: '2026-10-25T05:00:00.000Z' },
            { id: 'n1', title: 'older', isRead: true, timestamp: '2026-10-24T05:00:00.000Z' },
        ])));
        const rows = await fetchPersonalNotificationsFromApi({
            fetchFn: fetchFn as any,
            getIdToken: () => Promise.resolve('tok-123'),
        });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0] as any[];
        expect(url).toBe('/api/notifications');
        expect(init.method).toBe('GET');
        expect(init.credentials).toBe('include');
        expect(init.headers.Authorization).toBe('Bearer tok-123');
        expect(rows.map((r) => r.id)).toEqual(['n2', 'n1']); // route order preserved, newest first
        expect(rows[0].timestamp).toBeInstanceOf(Timestamp);
    });

    it('accepts a { notifications: [...] } envelope', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({
            notifications: [{ id: 'n1', isRead: false, timestamp: '2026-10-25T05:00:00.000Z' }],
        })));
        const rows = await fetchPersonalNotificationsFromApi({ fetchFn: fetchFn as any });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('n1');
    });

    it('drops rows without an id (the listener always has one)', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse([
            { title: 'id-less' },
            { id: 'n1', isRead: false },
        ])));
        const rows = await fetchPersonalNotificationsFromApi({ fetchFn: fetchFn as any });
        expect(rows.map((r) => r.id)).toEqual(['n1']);
    });

    it('throws on a non-OK response so callers fall back to Firestore', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({ error: 'boom' }, 500)));
        await expect(fetchPersonalNotificationsFromApi({ fetchFn: fetchFn as any })).rejects.toThrow('500');
    });

    it('throws on an unrecognized payload shape', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({ somethingElse: true })));
        await expect(fetchPersonalNotificationsFromApi({ fetchFn: fetchFn as any })).rejects.toThrow('unrecognized');
    });

    it('throws when fetch itself rejects (network down)', async () => {
        const fetchFn = jest.fn(() => Promise.reject(new Error('offline')));
        await expect(fetchPersonalNotificationsFromApi({ fetchFn: fetchFn as any })).rejects.toThrow('offline');
    });

    it('PATCHes { id, isRead: true } to /api/notifications for mark-as-read', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({ ok: true })));
        await markNotificationReadViaApi('n7', { fetchFn: fetchFn as any, getIdToken: () => Promise.resolve('t') });
        const [url, init] = fetchFn.mock.calls[0] as any[];
        expect(url).toBe('/api/notifications');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ id: 'n7', isRead: true });
        expect(init.headers.Authorization).toBe('Bearer t');
    });

    it('DELETEs /api/notifications?id=<id>', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({ ok: true })));
        await deleteNotificationViaApi('n 7', { fetchFn: fetchFn as any });
        const [url, init] = fetchFn.mock.calls[0] as any[];
        expect(url).toBe('/api/notifications?id=n%207');
        expect(init.method).toBe('DELETE');
    });

    it('write failures throw (the hook reverts its optimistic update)', async () => {
        const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({}, 403)));
        await expect(markNotificationReadViaApi('n7', { fetchFn: fetchFn as any })).rejects.toThrow('403');
    });
});
