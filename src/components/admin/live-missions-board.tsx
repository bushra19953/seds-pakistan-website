'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store';
import { updateLiveMissions, updateCommandFeed, setChapterCount } from '@/store/slices/missionSlice';
import { collection, doc, getDoc, query, orderBy, limit, onSnapshot, where } from 'firebase/firestore';
import { firestore, useUser } from '@/firebase';
import { canonicalRoleTitle } from '@/lib/roles';
import { useCustomRoleDefinitions } from '@/components/roles/custom-role-registry';
import { useAuthorization } from '@/hooks/use-authorization';
import { formatDistanceToNowStrict } from 'date-fns';
import { Rocket, Globe, Activity, TerminalSquare, AlertTriangle, X } from 'lucide-react';
import CountdownTimer from '@/components/ui/countdown-timer';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Live Missions section of the admin dashboard.
 *
 * This is the real content of the retired /admin/mission-command page,
 * moved onto the dashboard: the live task board (pending / in-progress /
 * submitted-for-review tasks with status, lead and deadline countdown),
 * the active-chapters count, and the command feed (audit_logs stream).
 * State still flows through the mission Redux slice, fed by the same
 * three Firestore listeners the standalone page used.
 *
 * READ BUDGET (census 06 #7, read-bleed fix train 2): no seam-backed
 * route returns this board's payload today (GET
 * /api/admin/dashboard/init serves metrics + the page's own audit
 * widget, not this board's task list / chapter count), so the three
 * listeners stay, each BOUNDED. Worst case per mount: tasks <= 20
 * reads (status predicate + limit 20), audit_logs <= 15 reads
 * (orderBy + limit 15; no safe predicate exists for a global feed),
 * chapters <= 100 reads bound
 * (isActive predicate + limit 100; the chapters corpus is 1 doc, so
 * the bound never truncates the displayed count), plus <= 1 users
 * getDoc per unique assignee per mount (fetchedUidsRef fetched-set
 * cache below). While mounted, each listener then bills only
 * +1 read per changed doc delivered. A future polling conversion
 * belongs behind the 'live-admin' client surface once a route
 * serves this exact payload.
 */
export default function LiveMissionsBoard() {
  // Custom-role registry: lead role titles resolve custom definition
  // titles (consumers Surface 5).
  useCustomRoleDefinitions();
  const dispatch = useDispatch();
  const state = useSelector((s: RootState) => s.mission);
  const { isAuthorized } = useAuthorization('canAccessAdmin');
  const { user } = useUser();
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  // UID -> resolved lead identity, fetched lazily from the users collection
  // so the mission board shows real names ("Tahir Shamim") instead of UID
  // substrings. Entries are cached here for the component lifetime.
  const [assigneeDirectory, setAssigneeDirectory] = useState<Record<string, { name: string; role: string | null }>>({});
  const fetchedUidsRef = useRef<Set<string>>(new Set());

  // Resolve a mission's primary assignee to a displayable lead identity.
  // Returns "Unassigned" when the mission has no assignee at all.
  const resolveLead = (mission: any): { name: string; role: string | null } => {
    const ids: string[] = [];
    if (mission.assigneeId) ids.push(mission.assigneeId);
    if (Array.isArray(mission.assigneeIds)) {
      for (const id of mission.assigneeIds) {
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
    const primary = ids[0];
    if (!primary) return { name: 'Unassigned', role: null };
    const info = assigneeDirectory[primary];
    // While the directory entry is still loading, show a short UID fragment
    // so the row never renders "TBD" for an assigned mission.
    if (!info) return { name: primary.substring(0, 8), role: null };
    return info;
  };

  // Lazily fetch user docs for assignee UIDs we have not resolved yet.
  // Safe to call from the missions onSnapshot: real-time updates keep
  // flowing and each UID is fetched exactly once.
  const resolveAssigneeUids = (missions: any[]) => {
    const missing: string[] = [];
    for (const m of missions) {
      const ids: string[] = [];
      if (m.assigneeId) ids.push(m.assigneeId);
      if (Array.isArray(m.assigneeIds)) ids.push(...m.assigneeIds);
      for (const id of ids) {
        if (id && !fetchedUidsRef.current.has(id)) {
          fetchedUidsRef.current.add(id);
          missing.push(id);
        }
      }
    }
    if (missing.length === 0) return;
    Promise.all(
      missing.map(async (uid) => {
        try {
          const uSnap = await getDoc(doc(firestore, 'users', uid));
          if (uSnap.exists()) {
            const u = uSnap.data() as any;
            return [uid, { name: u.displayName || u.name || uid, role: u.role || null }] as const;
          }
        } catch {
          // Directory lookup is best-effort; the row keeps its fallback label.
        }
        return [uid, { name: uid, role: null }] as const;
      })
    ).then((results) => {
      setAssigneeDirectory((prev) => {
        const next = { ...prev };
        for (const [uid, info] of results) {
          next[uid] = info;
        }
        return next;
      });
    });
  };

  const handleStreamError = (label: string) => (err: unknown) => {
    console.error(`${label} stream error:`, err);
    setStreamError('Live data stream interrupted. Showing the last received data. Check your connection and reload the page to re-establish the uplink.');
    // Never leave the section stuck on the loading state if a stream fails.
    setLoading(false);
  };

  useEffect(() => {
    if (!isAuthorized || !user) return;

    // 1. Listen to Live Missions (Tasks) - Aggregated View
    const qTasks = query(
      collection(firestore, 'tasks'),
      where('status', 'in', ['pending', 'in-progress', 'submitted-for-review']),
      limit(20)
    );
    const unsubTasks = onSnapshot(qTasks, (snap) => {
      const missions = snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
        deadline: d.data().deadline,
        timestamp: d.data().createdAt?.toDate ? d.data().createdAt.toDate() : new Date()
      }));
      dispatch(updateLiveMissions(missions));
      // Resolve lead UIDs to real names without disturbing the real-time stream.
      resolveAssigneeUids(missions);
    }, handleStreamError('Mission'));

    // 2. Listen to Command Feed (Audit Logs)
    const qLogs = query(collection(firestore, 'audit_logs'), orderBy('timestamp', 'desc'), limit(15));
    const unsubLogs = onSnapshot(qLogs, (snap) => {
      const logs = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          action: data.action,
          targetUidOrResource: data.targetUidOrResource,
          timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : new Date().toISOString()
        };
      });
      dispatch(updateCommandFeed(logs));
    }, handleStreamError('Log'));

    // 3. Listen to Chapters (bounded: isActive predicate + limit 100;
    // the chapters corpus is a single doc today, so the count shown
    // is identical — the limit only caps a future runaway scan)
    const qChapters = query(collection(firestore, 'chapters'), where('isActive', '==', true), limit(100));
    const unsubChapters = onSnapshot(qChapters, (snap) => {
      dispatch(setChapterCount(snap.size));
      setLoading(false);
    }, handleStreamError('Chapter'));

    return () => {
      unsubTasks();
      unsubLogs();
      unsubChapters();
    };
  }, [isAuthorized, user, dispatch]);

  return (
    <section aria-label="Live missions" className="mb-8 rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
      {/* Section header with the board's two real counts */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg text-primary"><Rocket className="h-6 w-6" /></div>
          <div>
            <h2 className="text-xl font-bold text-foreground uppercase tracking-tight">Live Missions</h2>
            <p className="text-[10px] text-muted-foreground uppercase font-mono">Real-time task board &amp; command feed</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-border bg-background/50 px-4 py-2 text-center">
            <p className="text-lg font-bold leading-none text-foreground">{loading ? '–' : state.activeMissions}</p>
            <p className="mt-1 text-[10px] font-mono uppercase text-muted-foreground">Active Missions</p>
          </div>
          <div className="rounded-lg border border-border bg-background/50 px-4 py-2 text-center">
            <p className="text-lg font-bold leading-none text-foreground">{loading ? '–' : state.totalChapters}</p>
            <p className="mt-1 flex items-center gap-1 text-[10px] font-mono uppercase text-muted-foreground">
              <Globe className="h-3 w-3" aria-hidden="true" /> Chapters
            </p>
          </div>
        </div>
      </div>

      {/* Stream error banner: readable, dismissible */}
      {streamError && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4"
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-xs sm:text-sm font-bold uppercase tracking-wide text-destructive">Uplink interrupted</p>
            <p className="mt-1 text-xs sm:text-sm leading-relaxed text-foreground/80">{streamError}</p>
          </div>
          <button
            type="button"
            onClick={() => setStreamError(null)}
            aria-label="Dismiss error"
            className="shrink-0 rounded-lg p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {loading ? (
        <div role="status" aria-label="Loading live missions" aria-busy="true">
          <span className="sr-only">Loading live missions&hellip;</span>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" aria-hidden="true">
            <div className="lg:col-span-2 space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
            <div className="space-y-4">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Live Mission Board */}
          <div className="lg:col-span-2 min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-card-foreground">
                <Activity className="h-4 w-4 text-primary" aria-hidden="true" /> Mission Board
              </h3>
              <span className="flex items-center gap-2 rounded-full border border-border bg-background/50 px-3 py-1 font-mono text-[10px] uppercase text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
                {state.activeMissions} operations
              </span>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-background/50">
              {state.liveMissions.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                  <Activity className="h-10 w-10 text-muted-foreground mb-4" aria-hidden="true" />
                  <p className="text-sm font-bold uppercase tracking-wide text-foreground">No active missions</p>
                  <p className="mt-2 max-w-xs text-xs sm:text-sm leading-relaxed text-muted-foreground">
                    No live telemetry detected. Missions in pending, in-progress, or under review will appear here.
                  </p>
                </div>
              ) : (
                <div className="max-h-[600px] overflow-y-auto live-missions-scroll">
                  {state.liveMissions.map((mission) => {
                    const lead = resolveLead(mission);
                    const leadRoleTitle = lead.role ? canonicalRoleTitle(lead.role) : null;
                    return (
                      <div key={mission.id} className="border-b border-border/60 p-4 transition-colors last:border-b-0 hover:bg-muted/30">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <h4 className="break-words text-sm font-bold uppercase tracking-tight text-foreground">{mission.title}</h4>
                            <p className="break-words font-mono text-[10px] uppercase text-muted-foreground">UID: {mission.id.substring(0, 12)}</p>
                          </div>
                          <span className={`shrink-0 rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${mission.status === 'submitted-for-review' ? 'border border-blue-500/30 bg-blue-500/10 text-blue-400' : 'border border-border bg-muted text-muted-foreground'}`}>
                            Status: {mission.status.replace(/-/g, ' ')}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[10px] text-muted-foreground" aria-hidden="true">
                              {lead.name === 'Unassigned' ? '?' : lead.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="truncate">
                              Lead: {lead.name}
                              {leadRoleTitle && leadRoleTitle !== 'Guest' && (
                                <span className="text-muted-foreground/70"> ({leadRoleTitle})</span>
                              )}
                            </span>
                          </div>
                          <div className="hidden h-4 border-l border-border sm:block" aria-hidden="true" />
                          <CountdownTimer expiryDate={mission.deadline} className="border-none bg-transparent p-0" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Command Feed */}
          <div className="min-w-0">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-card-foreground">
                <TerminalSquare className="h-4 w-4 text-primary" aria-hidden="true" /> Command Feed
              </h3>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-background/50">
              {state.commandFeed.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                  <TerminalSquare className="h-10 w-10 text-muted-foreground mb-4" aria-hidden="true" />
                  <p className="text-xs sm:text-sm font-bold uppercase tracking-wide text-foreground">Awaiting data uplink</p>
                  <p className="mt-2 max-w-[220px] text-[11px] sm:text-xs leading-relaxed text-muted-foreground">
                    Command feed entries will stream here in real time.
                  </p>
                </div>
              ) : (
                <div className="max-h-[600px] overflow-y-auto live-missions-scroll">
                  {state.commandFeed.map((log) => (
                    <div key={log.id} className="border-b border-border/60 p-3 transition-colors last:border-b-0 hover:bg-muted/30">
                      <p className="mb-1 text-[11px] font-bold uppercase leading-tight tracking-wider text-foreground">{log.action}</p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <p className="truncate font-mono text-[10px] uppercase text-muted-foreground">{log.targetUidOrResource?.substring(0, 15) || 'SYSTEM'}</p>
                        <p className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{formatDistanceToNowStrict(new Date(log.timestamp))} ago</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>
      )}

      <style jsx>{`
        .live-missions-scroll::-webkit-scrollbar {
          width: 4px;
        }
        .live-missions-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .live-missions-scroll::-webkit-scrollbar-thumb {
          background: hsl(var(--border));
          border-radius: 10px;
        }
      `}</style>
    </section>
  );
}
