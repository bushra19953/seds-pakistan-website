'use client';

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Bell, ExternalLink, Check, Volume2, VolumeX, Megaphone, User, Clock, MapPin, Users, Timer } from 'lucide-react';
import { useFirestore, useUser } from '@/firebase';
import { collection, doc, orderBy, query, where, limit, onSnapshot } from 'firebase/firestore';
;
import { useCollection } from '@/firebase';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import { fetchVisibleAnnouncements, isAnnouncementVisibleTo, resolveAnnouncementViewer, type AnnouncementDoc } from '@/lib/announcements';
import { usePollingRefresh } from '@/hooks/use-polling-refresh';
import { requestPushPermission, getNotificationPermission } from '@/lib/push-notifications';
import { serverWrite } from '@/lib/client/server-write';
import { notificationsSupaEnabled, useSupaPersonalNotifications } from '@/lib/notifications-supa-client';


// =============================================================================
// TYPES
// =============================================================================

interface PersonalNotification {
    id: string;
    title?: string;
    body?: string;
    link?: string;
    isRead: boolean;
    timestamp?: any;
    deadline?: any;
    capacity?: number;
    location?: string;
}

interface NotificationCenterProps {
    /** Enable sound on new notifications (default: true) */
    enableSound?: boolean;
    /** Show full notifications page link (default: true) */
    showViewAllLink?: boolean;
    /** Custom class name */
    className?: string;
    /**
     * Whether this instance may fetch data (default: true). The header
     * mounts a single instance (read-burn fix F7); this gate remains
     * for any surface that mounts the bell next to another instance:
     * an inactive instance renders its shell but runs no listener, no
     * fetch, and no polling.
     */
    active?: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

function toDate(ts: any): Date | null {
    try {
        if (!ts) return null;
        return ts?.toDate ? ts.toDate() : new Date(ts);
    } catch {
        return null;
    }
}

function isExpired(ts: any): boolean {
    const d = toDate(ts);
    return d ? d.getTime() < Date.now() : false;
}

function isNew(ts: any, days: number = 7): boolean {
    const d = toDate(ts);
    if (!d) return false;
    const threshold = days * 24 * 60 * 60 * 1000;
    return Date.now() - d.getTime() <= threshold;
}

function formatTimeAgo(ts: any): string {
    const d = toDate(ts);
    if (!d) return '';

    const now = Date.now();
    const diff = now - d.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
}

// =============================================================================
// SOUND HOOK
// =============================================================================

function useNotificationSound(enabled: boolean) {
    const audioContextRef = useRef<AudioContext | null>(null);
    const [soundMuted, setSoundMuted] = useState(false);

    // Load muted preference from localStorage
    useEffect(() => {
        try {
            const muted = localStorage.getItem('notification-sound-muted');
            if (muted === 'true') setSoundMuted(true);
        } catch { }
    }, []);

    const toggleMute = useCallback(() => {
        setSoundMuted(prev => {
            const next = !prev;
            try {
                localStorage.setItem('notification-sound-muted', String(next));
            } catch { }
            return next;
        });
    }, []);

    const playSound = useCallback(() => {
        if (!enabled || soundMuted) return;

        try {
            // Check if AudioContext is supported
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContextClass) return;

            // Prevent browser console warnings by not initializing AudioContext 
            // before the user has interacted with the document
            if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
                return;
            }

            // Use Web Audio API for reliable sound playback
            if (!audioContextRef.current) {
                audioContextRef.current = new AudioContextClass();
            }

            const ctx = audioContextRef.current;

            // If suspended (browser autoplay policy), try to resume, but catch if it fails
            if (ctx.state === 'suspended') {
                ctx.resume().catch(() => {
                    // Ignore resume errors (user hasn't interacted yet)
                });
            }

            // Create a simple notification "ding" sound
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            oscillator.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
            oscillator.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1); // Drop to A4

            gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

            oscillator.start(ctx.currentTime);
            oscillator.stop(ctx.currentTime + 0.3);

            // Vibrate removed to prevent browser console intervention warnings
        } catch (err) {
            // Silently fail for audio policy errors to keep console clean
            // console.debug('Could not play notification sound:', err);
        }
    }, [enabled, soundMuted]);

    return { playSound, soundMuted, toggleMute };
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * NotificationCenter - Unified notification bell component
 * 
 * Combines ALL features from the previous 3 bells:
 * - Personal notifications (users/{uid}/notifications)
 * - Global announcements (announcements collection)
 * - Tabs: All / Personal / Announcements
 * - Mark as read (individual + all)
 * - Expiration filtering for announcements
 * - Sound on new notifications
 * - Accurate combined unread badge
 */
export function NotificationCenter({
    enableSound = true,
    showViewAllLink = true,
    className,
    active = true,
}: NotificationCenterProps) {
    const { user, role } = useUser();
    const db = useFirestore();
    const [open, setOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'all' | 'personal' | 'announcements'>('all');

    // Deep-link navigation: internal links route in-app (no new tab), so a
    // notification tap lands the user exactly where the notification points.
    // External links keep opening in a new tab.
    const router = useRouter();
    const openNotificationLink = useCallback((link?: string) => {
        if (!link) return;
        setOpen(false);
        if (link.startsWith('/') && !link.startsWith('//')) {
            router.push(link);
        } else {
            window.open(link, '_blank', 'noopener,noreferrer');
        }
    }, [router]);

    // Handle push permission request when opening the popover
    useEffect(() => {
        if (open && user?.uid && getNotificationPermission() === 'default') {
            requestPushPermission(user.uid).catch(err =>
                console.error('[NotificationCenter] Push permission request failed:', err)
            );
        }
    }, [open, user?.uid]);

    // Previous counts for sound triggering
    const prevUnreadRef = useRef<number>(0);
    const initialLoadRef = useRef<boolean>(true);

    // Sound system
    const { playSound, soundMuted, toggleMute } = useNotificationSound(enableSound);

    // Read tracking for announcements (stored in localStorage per user)
    const [readAnnouncementIds, setReadAnnouncementIds] = useState<Set<string>>(new Set());
    const [announcementRefreshKey, setAnnouncementRefreshKey] = useState(0);

    // Auto-refresh announcements on the shared polling cadence (5-minute
    // floor, paused while the tab is hidden) so a stale bell cannot sit
    // on 60-second re-reads of the whole visible set. An inactive
    // instance does not poll at all, and the refresh itself resolves
    // through the shared announcement memo (see the fetch effect).
    const bumpAnnouncementRefresh = useCallback(() => {
        setAnnouncementRefreshKey(prev => prev + 1);
    }, []);
    usePollingRefresh(bumpAnnouncementRefresh, 5 * 60 * 1000, active);

    useEffect(() => {
        if (!user?.uid) return;
        try {
            const stored = localStorage.getItem(`read-announcements-${user.uid}`);
            if (stored) {
                setReadAnnouncementIds(new Set(JSON.parse(stored)));
            }
        } catch { }
    }, [user?.uid]);

    const markAnnouncementRead = useCallback((id: string) => {
        if (!user?.uid) return;
        setReadAnnouncementIds(prev => {
            const next = new Set(prev);
            next.add(id);
            try {
                localStorage.setItem(`read-announcements-${user.uid}`, JSON.stringify([...next]));
            } catch { }
            return next;
        });
    }, [user?.uid]);

    // ==========================================================================
    // PERSONAL NOTIFICATIONS SOURCE (Supabase seam)
    // ==========================================================================
    // When the `notifications` surface is ON (NEXT_PUBLIC_SUPA_SURFACES),
    // personal notifications come from the /api/notifications route via
    // the seam in lib/notifications-supa-client and refresh on the
    // shared 5-minute polling cadence; the Firestore listener below is
    // never built. On any route error the seam reports `failed` and
    // this component falls back to the Firestore listener verbatim:
    // same query, same shapes, same error surface. When the surface is
    // OFF none of this engages and the Firestore path is untouched.
    const getIdToken = useCallback(
        () => (user && typeof (user as any).getIdToken === 'function'
            ? (user as any).getIdToken()
            : Promise.resolve(null)),
        [user]
    );
    const supaPersonal = useSupaPersonalNotifications({
        enabled: notificationsSupaEnabled() && active && !!user,
        getIdToken,
    });
    const useSupaPersonal = notificationsSupaEnabled() && active && !supaPersonal.failed;
    const supaMarkRead = supaPersonal.markRead;
    const supaMarkAllRead = supaPersonal.markAllRead;

    // ==========================================================================
    // PERSONAL NOTIFICATIONS QUERY
    // ==========================================================================

    const personalQuery = useMemo(() => {
        if (!db || !user || !active || useSupaPersonal) return null as any;
        try {
            return query(
                collection(doc(db, 'users', user.uid), 'notifications'),
                orderBy('timestamp', 'desc'),
                limit(50)
            );
        } catch {
            return null as any;
        }
    }, [db, user?.uid, active, useSupaPersonal]);

    // Real-time control logic
    const envRealtime = process.env.NEXT_PUBLIC_REALTIME_ENABLED;
    const enableRealtime = envRealtime === undefined || String(envRealtime).toLowerCase() === 'true';

    useEffect(() => {
        if (process.env.NODE_ENV === 'development') {
            console.log('[NotificationCenter] Real-time updates status:', enableRealtime ? 'ENABLED' : 'DISABLED', `(env: ${envRealtime})`);
        }
    }, [enableRealtime, envRealtime]);

    const { data: fsPersonalNotifs, loading: fsLoadingPersonal, error: fsErrorPersonal } = useCollection<PersonalNotification>(
        personalQuery,
        { listen: enableRealtime }
    );

    // Effective personal-notification source: the Supa route data when
    // the surface is ON and healthy, the Firestore listener otherwise
    // (flag OFF, or the terminal fallback after a route error). The
    // seam returns the listener's exact shape, Timestamps included.
    const personalNotifs = useSupaPersonal
        ? (supaPersonal.data as PersonalNotification[] | null)
        : fsPersonalNotifs;
    const loadingPersonal = useSupaPersonal ? supaPersonal.loading : fsLoadingPersonal;
    const errorPersonal = useSupaPersonal ? null : fsErrorPersonal;

    // Debug log errors
    useEffect(() => {
        if (errorPersonal) {
            console.error('[NotificationCenter] Error fetching personal notifications:', errorPersonal);
        }
    }, [errorPersonal]);

    // ==========================================================================
    // ANNOUNCEMENTS QUERY
    // ==========================================================================

    // Split queries for the signed-in viewer's tiers (Item 10): this bell
    // only renders for a signed-in user, so the members tier is always in
    // the set; the officers tier is added only when the viewer is an
    // officer. The fetch goes through the shared module-wide memo
    // (fetchVisibleAnnouncements), so every header consumer shares one
    // fetch round per 5-minute window instead of re-running the split
    // queries per mount and per polling tick.
    const announcementViewer = useMemo(
        () => resolveAnnouncementViewer({ uid: user?.uid, role }),
        [user?.uid, role]
    );
    const [rawAnnouncements, setRawAnnouncements] = useState<AnnouncementDoc[] | null>(null);
    const [loadingAnnouncements, setLoadingAnnouncements] = useState(true);
    const [errorAnnouncements, setErrorAnnouncements] = useState<Error | null>(null);

    useEffect(() => {
        if (!active) { setLoadingAnnouncements(false); return; }
        if (!db) { setLoadingAnnouncements(false); return; }
        let cancelled = false;
        setLoadingAnnouncements(true);
        fetchVisibleAnnouncements(db, announcementViewer, { limitCount: 10 })
            .then((docs) => {
                if (cancelled) return;
                setRawAnnouncements(docs);
                setErrorAnnouncements(null);
                setLoadingAnnouncements(false);
            })
            .catch((err) => {
                if (cancelled) return;
                setRawAnnouncements([]);
                setErrorAnnouncements(err as Error);
                setLoadingAnnouncements(false);
            });
        return () => { cancelled = true; };
    }, [db, announcementRefreshKey, announcementViewer, active]);

    // Filter out expired announcements and enforce publish_date + audience
    const announcements = useMemo(() => {
        return (rawAnnouncements || [])
            .filter(a => isAnnouncementVisibleTo(a, announcementViewer))
            .filter(a => !isExpired(a.expiresAt));
    }, [rawAnnouncements, announcementViewer]);

    // ==========================================================================
    // COMPUTED VALUES
    // ==========================================================================

    const personal = useMemo(() => {
        const result = personalNotifs || [];
        if (process.env.NODE_ENV === 'development') {
            console.log('[NotificationCenter] Personal notifications fetched:', result.length, result.map(n => ({ id: n.id, type: (n as any).type, title: n.title, isRead: n.isRead })));
        }
        return result;
    }, [personalNotifs]);

    const unreadPersonal = useMemo(() => {
        return personal.filter(n => n && n.isRead === false).length;
    }, [personal]);

    const unreadAnnouncements = useMemo(() => {
        return announcements.filter(a => !readAnnouncementIds.has(a.id)).length;
    }, [announcements, readAnnouncementIds]);

    const totalUnread = unreadPersonal + unreadAnnouncements;

    // Combined list for "All" tab
    const allItems = useMemo(() => {
        const items: Array<{ type: 'personal' | 'announcement'; item: any; timestamp: Date | null }> = [];

        personal.forEach(n => {
            items.push({ type: 'personal', item: n, timestamp: toDate(n.timestamp) });
        });

        announcements.forEach(a => {
            items.push({ type: 'announcement', item: a, timestamp: toDate(a.updated_at) });
        });

        // Sort by timestamp descending
        items.sort((a, b) => {
            const ta = a.timestamp?.getTime() || 0;
            const tb = b.timestamp?.getTime() || 0;
            return tb - ta;
        });

        return items.slice(0, 15);
    }, [personal, announcements]);

    // ==========================================================================
    // SOUND ON NEW NOTIFICATION
    // ==========================================================================

    useEffect(() => {
        // Skip sound on initial load
        if (initialLoadRef.current) {
            initialLoadRef.current = false;
            prevUnreadRef.current = totalUnread;
            return;
        }

        // Play sound if unread count increased
        if (totalUnread > prevUnreadRef.current) {
            playSound();
        }

        prevUnreadRef.current = totalUnread;
    }, [totalUnread, playSound]);

    // ==========================================================================
    // ACTIONS
    // ==========================================================================

    const markPersonalRead = useCallback(async (id: string) => {
        // Supa path: PATCH /api/notifications through the seam
        // (optimistic, reverts on failure).
        if (useSupaPersonal) {
            await supaMarkRead(id);
            return;
        }
        if (!user) return;
        try {
            // WS10: the Firestore branch goes through the same
            // PATCH /api/notifications route (identity design S-20:
            // the route implements exactly this mutation, with the
            // fs_group_notifications mirror the client write lacked).
            await serverWrite('/api/notifications', 'PATCH', { id });
        } catch (err) {
            console.error('Failed to mark notification read:', err);
        }
    }, [user, useSupaPersonal, supaMarkRead]);

    const markAllPersonalRead = useCallback(async () => {
        if (useSupaPersonal) {
            await supaMarkAllRead();
            return;
        }
        if (!user || !personal.length) return;
        try {
            // WS10: the route's { all: true } arm performs the same
            // mutation over its loaded window (unread docs only),
            // with mirrors.
            await serverWrite('/api/notifications', 'PATCH', { all: true });
        } catch (err) {
            console.error('Failed to mark all notifications read:', err);
        }
    }, [user, personal, useSupaPersonal, supaMarkAllRead]);

    const markAllAnnouncementsRead = useCallback(() => {
        if (!user?.uid) return;
        const allIds = announcements.map(a => a.id);
        setReadAnnouncementIds(prev => {
            const next = new Set([...prev, ...allIds]);
            try {
                localStorage.setItem(`read-announcements-${user.uid}`, JSON.stringify([...next]));
            } catch { }
            return next;
        });
    }, [user?.uid, announcements]);

    const markAllRead = useCallback(async () => {
        await markAllPersonalRead();
        markAllAnnouncementsRead();
    }, [markAllPersonalRead, markAllAnnouncementsRead]);

    // ==========================================================================
    // RENDER HELPERS
    // ==========================================================================

    const renderPersonalItem = (n: PersonalNotification, compact: boolean = false) => {
        const isActuallyRead = n.isRead;

        // FOMO BADGE LOGIC
        let fomoBadge = null;
        if (n.deadline) {
            const d = toDate(n.deadline);
            if (d && d.getTime() > Date.now()) {
                const hoursLeft = Math.floor((d.getTime() - Date.now()) / 3600000);
                if (hoursLeft < 72) {
                    fomoBadge = <Badge variant="destructive" className="ml-2 text-[9px] px-1 py-0 uppercase h-4">Closes in {hoursLeft}h</Badge>;
                } else {
                    fomoBadge = <Badge variant="secondary" className="ml-2 text-[9px] px-1 py-0 uppercase h-4">Open</Badge>;
                }
            } else if (d && d.getTime() <= Date.now()) {
                fomoBadge = <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 uppercase h-4">Closed</Badge>;
            }
        }

        return (
            <div
                key={n.id}
                onClick={() => {
                    if (!isActuallyRead) markPersonalRead(n.id);
                    openNotificationLink(n.link);
                }}
                className={`border rounded-lg p-3 text-sm transition-all duration-200 cursor-pointer group ${isActuallyRead ? 'opacity-70 bg-muted/20' : 'bg-background hover:bg-muted/40 hover:border-primary/30 shadow-sm hover:shadow'
                    }`}
            >
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                        <User className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="font-medium line-clamp-1 flex items-center">
                                {n.title || 'Notification'}
                                {fomoBadge}
                            </div>
                            {n.body && (
                                <div className="text-muted-foreground mt-1 line-clamp-3 text-[11px] leading-relaxed">{n.body}</div>
                            )}

                            {/* EVENT DETAILS GRID */}
                            {(n.location || n.capacity || n.deadline) && !compact && (
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] mt-2 text-muted-foreground font-medium border-t border-primary/10 pt-1.5">
                                    {n.deadline && <span className="flex items-center gap-1 text-primary/80"><Timer className="h-3 w-3" /> Due: {toDate(n.deadline)?.toLocaleDateString() || 'N/A'}</span>}
                                    {n.location && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {n.location.length > 20 ? n.location.substring(0, 20) + '...' : n.location}</span>}
                                    {n.capacity && <span className="flex items-center gap-1"><Users className="h-3 w-3" /> Max {n.capacity}</span>}
                                </div>
                            )}

                            <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1.5">
                                <Clock className="h-3 w-3" />
                                {formatTimeAgo(n.timestamp)}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        {n.link && (
                            <Button variant="ghost" size="sm" asChild className="h-7 px-2">
                                <a href={n.link} target="_blank" rel="noreferrer">
                                    <ExternalLink className="h-3 w-3" />
                                </a>
                            </Button>
                        )}
                        {!isActuallyRead && (
                            <Button variant="ghost" size="sm" onClick={() => markPersonalRead(n.id)} className="h-7 px-2">
                                <Check className="h-3 w-3" />
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const renderAnnouncementItem = (a: AnnouncementDoc & { deadline?: any; capacity?: number; location?: string }, compact: boolean = false) => {
        const isRead = readAnnouncementIds.has(a.id);
        const isNewAnnouncement = isNew(a.updated_at);

        // FOMO BADGE LOGIC
        let fomoBadge = null;
        if (a.deadline) {
            const d = toDate(a.deadline);
            if (d && d.getTime() > Date.now()) {
                const hoursLeft = Math.floor((d.getTime() - Date.now()) / 3600000);
                if (hoursLeft < 72) {
                    fomoBadge = <Badge variant="destructive" className="ml-2 text-[9px] px-1 py-0 uppercase h-4">Closes in {hoursLeft}h</Badge>;
                } else {
                    fomoBadge = <Badge variant="secondary" className="ml-2 text-[9px] px-1 py-0 uppercase h-4">Open</Badge>;
                }
            } else if (d && d.getTime() <= Date.now()) {
                fomoBadge = <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 uppercase h-4">Closed</Badge>;
            }
        }

        return (
            <div
                key={a.id}
                className={`border rounded-lg p-3 text-sm transition-colors ${isRead ? 'opacity-60 bg-muted/30' : 'bg-background hover:bg-muted/50'
                    }`}
            >
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                        <Megaphone className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center">
                                <span className="font-medium line-clamp-1">{a.title || 'Announcement'}</span>
                                {isNewAnnouncement && !isRead && (
                                    <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0 h-4">NEW</Badge>
                                )}
                                {fomoBadge}
                            </div>
                            {!compact && a.content && (
                                <div className="text-muted-foreground mt-1 line-clamp-2 text-[11px] leading-relaxed">{a.content}</div>
                            )}

                            {/* EVENT DETAILS GRID */}
                            {(a.location || a.capacity || a.deadline) && !compact && (
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] mt-2 text-muted-foreground font-medium border-t border-primary/10 pt-1.5">
                                    {a.deadline && <span className="flex items-center gap-1 text-primary/80"><Timer className="h-3 w-3" /> Due: {toDate(a.deadline)?.toLocaleDateString() || 'N/A'}</span>}
                                    {a.location && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {a.location.length > 20 ? a.location.substring(0, 20) + '...' : a.location}</span>}
                                    {a.capacity && <span className="flex items-center gap-1"><Users className="h-3 w-3" /> Max {a.capacity}</span>}
                                </div>
                            )}

                            <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1.5">
                                <Clock className="h-3 w-3" />
                                {formatTimeAgo(a.updated_at)}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        {a.ctaLink && (
                            <Button variant="ghost" size="sm" asChild className="h-7 px-2">
                                <a
                                    href={a.ctaLink}
                                    target={a.ctaLink.startsWith('http') ? '_blank' : undefined}
                                    rel={a.ctaLink.startsWith('http') ? 'noopener noreferrer' : undefined}
                                >
                                    <ExternalLink className="h-3 w-3" />
                                </a>
                            </Button>
                        )}
                        {!isRead && (
                            <Button variant="ghost" size="sm" onClick={() => markAnnouncementRead(a.id)} className="h-7 px-2">
                                <Check className="h-3 w-3" />
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // ==========================================================================
    // MAIN RENDER
    // ==========================================================================

    if (!user) return null;

    const loading = loadingPersonal || loadingAnnouncements;
    const hasError = errorPersonal || errorAnnouncements;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Notifications${totalUnread > 0 ? ` (${totalUnread} unread)` : ''}`}
                    title="Notifications"
                    className={`relative ${className || ''}`}
                >
                    <Bell className={`h-4 w-4 ${totalUnread > 0 ? 'text-primary' : ''}`} />
                    {totalUnread > 0 && (
                        <span className="absolute -top-1 -right-1 text-[10px] px-1.5 py-0.5 rounded-full bg-red-600 text-foreground font-medium min-w-[18px] text-center animate-pulse">
                            {totalUnread > 99 ? '99+' : totalUnread}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>

            <PopoverContent className="w-96 p-0" align="end">
                {/* Header */}
                <div className="flex items-center justify-between p-3 border-b">
                    <span className="font-semibold">Notifications</span>
                    <div className="flex items-center gap-1">
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={toggleMute}
                                        className="h-8 w-8 p-0"
                                    >
                                        {soundMuted ? (
                                            <VolumeX className="h-4 w-4 text-muted-foreground" />
                                        ) : (
                                            <Volume2 className="h-4 w-4" />
                                        )}
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{soundMuted ? 'Unmute notifications' : 'Mute notifications'}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={markAllRead}
                            disabled={totalUnread === 0}
                            className="h-8 text-xs"
                        >
                            <Check className="h-3 w-3 mr-1" />
                            Mark all read
                        </Button>
                    </div>
                </div>

                {/* Tabs */}
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="w-full">
                    <TabsList className="w-full justify-start rounded-none border-b bg-transparent p-0">
                        <TabsTrigger
                            value="all"
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-4"
                        >
                            All
                            {totalUnread > 0 && (
                                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                                    {totalUnread}
                                </Badge>
                            )}
                        </TabsTrigger>
                        <TabsTrigger
                            value="personal"
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-4"
                        >
                            Personal
                            {unreadPersonal > 0 && (
                                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                                    {unreadPersonal}
                                </Badge>
                            )}
                        </TabsTrigger>
                        <TabsTrigger
                            value="announcements"
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-4"
                        >
                            Announcements
                            {unreadAnnouncements > 0 && (
                                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                                    {unreadAnnouncements}
                                </Badge>
                            )}
                        </TabsTrigger>
                    </TabsList>

                    {/* Content */}
                    <div className="max-h-80 overflow-y-auto p-2">
                        {loading ? (
                            <div className="space-y-2 p-2">
                                <Skeleton className="h-16 w-full rounded-lg" />
                                <Skeleton className="h-16 w-full rounded-lg" />
                                <Skeleton className="h-16 w-full rounded-lg" />
                            </div>
                        ) : hasError ? (
                            <div className="text-center py-8 text-sm text-destructive">
                                Failed to load notifications. Please try again.
                            </div>
                        ) : (
                            <>
                                {/* All Tab */}
                                <TabsContent value="all" className="mt-0 space-y-2">
                                    {allItems.length === 0 ? (
                                        <div className="text-center py-8 text-sm text-muted-foreground">
                                            No notifications yet.
                                        </div>
                                    ) : (
                                        allItems.map(({ type, item }) =>
                                            type === 'personal'
                                                ? renderPersonalItem(item, true)
                                                : renderAnnouncementItem(item, true)
                                        )
                                    )}
                                </TabsContent>

                                {/* Personal Tab */}
                                <TabsContent value="personal" className="mt-0 space-y-2">
                                    {personal.length === 0 ? (
                                        <div className="text-center py-8 text-sm text-muted-foreground">
                                            No personal notifications.
                                        </div>
                                    ) : (
                                        personal.map(n => renderPersonalItem(n))
                                    )}
                                </TabsContent>

                                {/* Announcements Tab */}
                                <TabsContent value="announcements" className="mt-0 space-y-2">
                                    {announcements.length === 0 ? (
                                        <div className="text-center py-8 text-sm text-muted-foreground">
                                            No announcements right now.
                                        </div>
                                    ) : (
                                        announcements.map(a => renderAnnouncementItem(a))
                                    )}
                                </TabsContent>
                            </>
                        )}
                    </div>
                </Tabs>

                {/* Footer */}
                {showViewAllLink && (
                    <div className="border-t p-2 flex justify-end">
                        <Button variant="outline" size="sm" onClick={() => {
                            setOpen(false);
                            window.location.href = '/notifications';
                        }}>
                            View all notifications
                        </Button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}

export default NotificationCenter;
