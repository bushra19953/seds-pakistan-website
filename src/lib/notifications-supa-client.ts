'use client';

/**
 * notifications-supa-client — the ONE seam between the notifications
 * client surfaces (NotificationCenter bell, /notifications page) and
 * the Supabase-backed notifications API.
 *
 * Migration contract (Supabase migration, notifications cluster G1):
 *
 * - Client components cannot hold the Supabase service key and cannot
 *   read server-only env, so this seam never talks to Supabase
 *   directly. When the `notifications` surface is ON it reads/writes
 *   through the server route GET/PATCH/DELETE /api/notifications
 *   (built by sibling group G2), which reads the fs_notifications
 *   table (rows migrated from the users/{uid}/notifications
 *   subcollection, parent_path = 'users/{uid}/notifications').
 *
 * - Flag: NEXT_PUBLIC_SUPA_SURFACES is a comma-separated list of
 *   surface names; the notifications surface is ON only when the list
 *   contains `notifications`. No other NEXT_PUBLIC supa flag exists in
 *   the tree today, so this parsing is defined HERE — the merge
 *   planner should treat this as the canonical client-flag mechanism
 *   for client surfaces (server surfaces use the adapter's useSupa()
 *   with server env). Default (unset/empty) = OFF.
 *
 * - OFF, or ANY error from the route: behavior is exactly the
 *   Firestore behavior that predates this seam. The hook reports
 *   `failed: true` on a read error and the caller re-enables its
 *   Firestore query and uses its data/error/loading verbatim.
 *
 * - Shape identity: the route returns plain JSON (ISO-string
 *   timestamps). Firestore consumers call `.toDate()` on timestamp
 *   fields, so this seam revives every known timestamp field back
 *   into a real firebase/firestore `Timestamp` before handing data
 *   to a consumer. See reviveTimestampValue for every accepted wire
 *   shape.
 *
 * AT MERGE TIME this file is the only notifications-client file that
 * needs re-pointing if the G2 route contract moves.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Timestamp } from 'firebase/firestore';
import { usePollingRefresh } from '@/hooks/use-polling-refresh';

// =============================================================================
// FLAG
// =============================================================================

export const NOTIFICATIONS_SUPA_SURFACE = 'notifications';

/**
 * Parse a NEXT_PUBLIC_SUPA_SURFACES value (comma-separated surface
 * names, case-insensitive, whitespace tolerated) and report whether
 * `surface` is enabled. Unset/empty = every surface OFF.
 */
export function isSupaSurfaceEnabled(
    surface: string,
    raw: string | undefined = process.env.NEXT_PUBLIC_SUPA_SURFACES,
): boolean {
    if (!raw) return false;
    const wanted = surface.trim().toLowerCase();
    return raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .includes(wanted);
}

/** Is the notifications client surface routed to Supabase? */
export function notificationsSupaEnabled(): boolean {
    return isSupaSurfaceEnabled(NOTIFICATIONS_SUPA_SURFACE);
}

// =============================================================================
// TYPES + TIMESTAMP REVIVAL
// =============================================================================

/**
 * A personal notification in the exact shape the Firestore listener
 * produces today ({ ...doc.data(), id: doc.id } with Timestamp
 * fields), so consumers cannot tell which backend served it.
 */
export interface SupaPersonalNotification {
    id: string;
    title?: string;
    body?: string;
    link?: string;
    isRead: boolean;
    timestamp?: Timestamp;
    deadline?: Timestamp;
    capacity?: number;
    location?: string;
    [key: string]: any;
}

/**
 * Fields on a notification document that hold Firestore timestamps.
 * JSON transport destroys Timestamp objects, so every one of these is
 * revived on the way in. Fields not in this list pass through
 * untouched (a body string that happens to look like a date must stay
 * a string).
 */
export const NOTIFICATION_TIMESTAMP_FIELDS = [
    'timestamp',
    'deadline',
    'createdAt',
    'updatedAt',
    'created_at',
    'updated_at',
    'readAt',
    'expiresAt',
] as const;

/**
 * Revive one wire value into a Firestore Timestamp.
 *
 * Accepted wire shapes (every one is a real serialization of a
 * Firestore timestamp somewhere in this migration):
 * - a Timestamp already (returned as-is)
 * - an ISO-8601 string (what the G2 route contract returns)
 * - a Date
 * - epoch milliseconds (number)
 * - { seconds, nanoseconds } (Firestore Timestamp#toJSON shape)
 * - { _seconds, _nanoseconds } (Admin SDK / jsonb dump shape — the
 *   fs_notifications `data` jsonb stores timestamps this way)
 *
 * Anything unrecognized is returned unchanged rather than dropped:
 * consumers' date helpers already tolerate strings/numbers, and
 * losing a value would be a worse failure than passing it through.
 */
export function reviveTimestampValue(value: any): any {
    if (value === null || value === undefined) return value;
    if (value instanceof Timestamp) return value;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? value : Timestamp.fromDate(value);
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Timestamp.fromMillis(value) : value;
    }
    if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? value : Timestamp.fromMillis(ms);
    }
    if (typeof value === 'object') {
        const seconds = typeof value.seconds === 'number' ? value.seconds
            : typeof value._seconds === 'number' ? value._seconds
            : undefined;
        const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds
            : typeof value._nanoseconds === 'number' ? value._nanoseconds
            : 0;
        if (seconds !== undefined) return new Timestamp(seconds, nanos);
        if (typeof value.toDate === 'function') return value;
    }
    return value;
}

/** Revive one raw route payload row into the listener shape. */
export function reviveNotification(raw: any): SupaPersonalNotification {
    const out: Record<string, any> = { ...(raw ?? {}) };
    for (const field of NOTIFICATION_TIMESTAMP_FIELDS) {
        if (field in out) out[field] = reviveTimestampValue(out[field]);
    }
    return out as SupaPersonalNotification;
}

// =============================================================================
// ROUTE CLIENT (G2 contract)
// =============================================================================

export interface NotificationsApiDeps {
    /** Injectable for tests; defaults to the global fetch. */
    fetchFn?: typeof fetch;
    /** Firebase ID-token provider (the tree's API auth convention:
     *  `Authorization: Bearer <user.getIdToken()>`). Optional: the
     *  request also carries same-origin credentials so a session
     *  cookie can authenticate it instead. */
    getIdToken?: () => Promise<string | null | undefined>;
}

async function notificationsApiFetch(
    path: string,
    init: RequestInit,
    deps: NotificationsApiDeps,
): Promise<Response> {
    const fetchFn = deps.fetchFn ?? fetch;
    const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
    };
    if (deps.getIdToken) {
        try {
            const token = await deps.getIdToken();
            if (token) headers.Authorization = `Bearer ${token}`;
        } catch {
            // No token: fall through on the session cookie.
        }
    }
    const res = await fetchFn(path, { ...init, headers, credentials: 'include' });
    if (!res.ok) {
        throw new Error(`/api/notifications request failed: ${res.status}`);
    }
    return res;
}

/**
 * GET /api/notifications — the signed-in user's notifications,
 * newest first, limit 50, each row the full notification document
 * plus `id`, timestamp fields as ISO strings. Accepts either a bare
 * array body or a { notifications: [...] } / { data: [...] } envelope.
 */
export async function fetchPersonalNotificationsFromApi(
    deps: NotificationsApiDeps = {},
): Promise<SupaPersonalNotification[]> {
    const res = await notificationsApiFetch('/api/notifications', { method: 'GET' }, deps);
    const payload = await res.json();
    const rows: any[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.notifications)
            ? payload.notifications
            : Array.isArray(payload?.data)
                ? payload.data
                : [];
    if (!Array.isArray(payload) && rows.length === 0 && payload && typeof payload === 'object'
        && !('notifications' in payload) && !('data' in payload)) {
        throw new Error('/api/notifications returned an unrecognized payload shape');
    }
    return rows
        .filter((r) => r && typeof r === 'object' && r.id != null)
        .map((r) => reviveNotification(r));
}

/** PATCH /api/notifications with { id, isRead } — mark one read. */
export async function markNotificationReadViaApi(
    id: string,
    deps: NotificationsApiDeps = {},
): Promise<void> {
    await notificationsApiFetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, isRead: true }),
    }, deps);
}

/**
 * DELETE /api/notifications?id=<id> — delete one notification.
 * No current UI caller in this cluster (NotificationCenter has no
 * delete interaction today); the seam exposes it so the write
 * surface is complete against the G2 contract.
 */
export async function deleteNotificationViaApi(
    id: string,
    deps: NotificationsApiDeps = {},
): Promise<void> {
    await notificationsApiFetch(`/api/notifications?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
    }, deps);
}

// =============================================================================
// HOOK
// =============================================================================

export interface UseSupaPersonalNotifications {
    /** Revived notifications, newest first; null until first success. */
    data: SupaPersonalNotification[] | null;
    loading: boolean;
    /**
     * True after a read error. Callers must fall back to their
     * Firestore path (query/data/error) when this flips — the hook
     * stops polling and never retries, so fallback is terminal for
     * the mount, exactly like the Firestore listener error path.
     */
    failed: boolean;
    /** Optimistic mark-as-read; reverts the item if the PATCH fails. */
    markRead: (id: string) => Promise<void>;
    /** Optimistic mark-all-read over the currently loaded set. */
    markAllRead: () => Promise<void>;
    refresh: () => void;
}

export function useSupaPersonalNotifications(options: {
    enabled: boolean;
    getIdToken?: () => Promise<string | null | undefined>;
}): UseSupaPersonalNotifications {
    const { enabled } = options;
    const [data, setData] = useState<SupaPersonalNotification[] | null>(null);
    const [loading, setLoading] = useState<boolean>(enabled);
    const [failed, setFailed] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    // Keep the token provider in a ref so effect identity stays
    // stable across renders (the provider closes over the user).
    const depsRef = useRef<NotificationsApiDeps>({});
    depsRef.current = { getIdToken: options.getIdToken };

    // Mirror of `data` for the optimistic-write callbacks: updater
    // functions must not be used for side-effect bookkeeping (React
    // may invoke them later or twice), so the pre-write snapshot is
    // read from this ref instead.
    const dataRef = useRef<SupaPersonalNotification[] | null>(null);
    const applyData = useCallback((next: SupaPersonalNotification[] | null) => {
        dataRef.current = next;
        setData(next);
    }, []);

    const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

    // Refresh cadence when ON: the shared polling hook (5-minute
    // floor, hidden-tab pause). No new poller, and when OFF or failed
    // this hook drives nothing at all.
    usePollingRefresh(refresh, 5 * 60 * 1000, enabled && !failed);

    useEffect(() => {
        if (!enabled || failed) {
            if (!enabled) setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        fetchPersonalNotificationsFromApi(depsRef.current)
            .then((rows) => {
                if (cancelled) return;
                applyData(rows);
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('[notifications-supa] route fetch failed; falling back to Firestore:', err);
                setFailed(true);
                setLoading(false);
            });
        return () => { cancelled = true; };
    }, [enabled, failed, refreshKey, applyData]);

    const markRead = useCallback(async (id: string) => {
        const previous = dataRef.current;
        if (previous) {
            applyData(previous.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
        }
        try {
            await markNotificationReadViaApi(id, depsRef.current);
        } catch (err) {
            console.error('[notifications-supa] mark-as-read failed; reverting:', err);
            applyData(previous);
        }
    }, [applyData]);

    const markAllRead = useCallback(async () => {
        const previous = dataRef.current;
        if (!previous) return;
        const unreadIds = previous.filter((n) => n && n.isRead === false).map((n) => n.id);
        if (unreadIds.length === 0) return;
        applyData(previous.map((n) => (n.isRead === false ? { ...n, isRead: true } : n)));
        try {
            await Promise.all(unreadIds.map((id) => markNotificationReadViaApi(id, depsRef.current)));
        } catch (err) {
            console.error('[notifications-supa] mark-all-read failed; reverting:', err);
            applyData(previous);
        }
    }, [applyData]);

    return { data, loading, failed, markRead, markAllRead, refresh };
}
