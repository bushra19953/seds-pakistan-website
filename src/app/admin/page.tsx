"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { firestore, useUser } from "@/firebase";
import { useAuthorization } from "@/hooks/use-authorization";
import { type PermissionKey } from "@/config/permissions.config";
import { collection, query, orderBy, limit, onSnapshot, where } from "firebase/firestore";
import {
  Users, FolderKanban, Newspaper, Calendar,
  ClipboardList, Megaphone, FileClock, Globe
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { ChapterSwitcher } from "@/components/admin/chapter-switcher";
import { getRoleScope } from "@/config/permission-registry";
import AuthorizationGate from "@/components/admin/AuthorizationGate";

// The Overhaul Master Plan: MetricCard<T> Abstraction
function MetricCard({
  icon: Icon, title, subtitle, value, loading
}: {
  icon: any; title: string; subtitle: string; value: number | string | null; loading: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-card/80 backdrop-blur-md p-6 transition-all duration-300 hover:border-white/20 hover:bg-card/90 group text-white">
      <div className="flex items-center justify-between mb-4">
        <h3 className="flex items-center gap-2 font-semibold text-card-foreground">
          <Icon className="h-5 w-5 text-primary" /> {title}
        </h3>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="text-4xl font-bold tracking-tight">
        {loading ? (
          <div className="h-10 w-24 animate-pulse rounded bg-white/10" />
        ) : (
          value ?? 0
        )}
      </div>
    </div>
  );
}

// The Overhaul Master Plan: Centralized QuickAction registry with interactive intent
function ActionGrid() {
  const router = useRouter();
  const QUICK_ACTIONS = [
    { id: 'new_blog', label: 'New Blog Post', icon: Newspaper, href: '/admin/blogs/new', req: 'canManageBlogs' as PermissionKey },
    { id: 'new_event', label: 'New Event', icon: Calendar, href: '/admin/events/new', req: 'canManageEvents' as PermissionKey },
    { id: 'manage_announcements', label: 'Manage Announcements', icon: Megaphone, href: '/admin/announcements', req: 'canManageAnnouncements' as PermissionKey },
    { id: 'manage_projects', label: 'Manage Projects', icon: FolderKanban, href: '/admin/projects', req: 'canManageProjects' as PermissionKey },
    { id: 'review_apps', label: 'Review Applications', icon: ClipboardList, href: '/admin/applications', req: 'canManageApplications' as PermissionKey },
    { id: 'view_audit', label: 'View Audit Logs', icon: FileClock, href: '/admin/audit-logs', req: 'canViewAuditLogs' as PermissionKey }
  ];

  // We perform hook-based filtering to ensure reactivity
  const blogAuth = useAuthorization('canManageBlogs');
  const eventAuth = useAuthorization('canManageEvents');
  const annAuth = useAuthorization('canManageAnnouncements');
  const projAuth = useAuthorization('canManageProjects');
  const appAuth = useAuthorization('canManageApplications');
  const auditAuth = useAuthorization('canViewAuditLogs');

  const authMap: Record<string, boolean> = {
    canManageBlogs: blogAuth.isAuthorized,
    canManageEvents: eventAuth.isAuthorized,
    canManageAnnouncements: annAuth.isAuthorized,
    canManageProjects: projAuth.isAuthorized,
    canManageApplications: appAuth.isAuthorized,
    canViewAuditLogs: auditAuth.isAuthorized,
  };

  const allowedActions = QUICK_ACTIONS.filter(action => authMap[action.req]);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {allowedActions.map((action) => (
        <Link
          key={action.id}
          href={action.href}
          onMouseEnter={() => router.prefetch(action.href)}
          className="group relative flex items-center gap-3 rounded-lg border border-white/5 bg-background/50 px-4 py-3 transition-transform duration-200 hover:-translate-y-1 hover:border-primary/50 hover:bg-background/80 hover:shadow-[0_0_15px_rgba(255,255,255,0.1)] text-white"
        >
          <div className="rounded-md bg-primary/10 p-2 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
            <action.icon className="h-5 w-5" />
          </div>
          <span className="font-medium text-sm">{action.label}</span>
        </Link>
      ))}
    </div>
  );
}

// Unified Formatter 
function relativeTime(dateStr: string) {
  try {
    return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: true });
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// 💥 NUCLEAR ADMIN DASHBOARD
// ---------------------------------------------------------------------------
export default function AdminDashboardPage() {
  const { user, role, isLoading: userLoading } = useUser();
  const { isAuthorized: canAccessAdmin } = useAuthorization('canAccessAdmin');
  const { isAuthorized: canManageApplications } = useAuthorization('canManageApplications');
  const { isAuthorized: canViewAuditLogs } = useAuthorization('canViewAuditLogs');

  const [counts, setCounts] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);

  const scope = role ? getRoleScope(role) : 'chapter';
  const isNational = scope === 'global';

  // Initialize Data
  useEffect(() => {
    // Only load if user has admin panel access
    if (!userLoading && canAccessAdmin) {
      loadDashboard(selectedChapterId);
      const unsubscribe = setupRealtimeAudit(selectedChapterId);
      return () => { if (unsubscribe) unsubscribe(); };
    }
  }, [user, canAccessAdmin, userLoading, selectedChapterId]);

  async function loadDashboard(chapterId: string | null) {
    try {
      setLoading(true);
      setError(null);
      const token = await user?.getIdToken();
      if (!token) throw new Error("No auth token");
      const url = chapterId
        ? `/api/admin/dashboard/init?chapterId=${chapterId}`
        : "/api/admin/dashboard/init";

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.details || data.error || "Failed to fetch dashboard metrics");
      }

      setCounts(data.metrics);
      setAudit(prev => (prev.length === 0 || chapterId) ? data.auditLogs : prev);
      
      if (data.errors && data.errors.length > 0) {
        setError(`System Alert: ${data.errors.join(" | ")}`);
      }
    } catch (e: any) {
      console.error(e);
      setError(e.message || "Failed to initialize dashboard matrix.");
    } finally {
      setLoading(false);
    }
  }

  function setupRealtimeAudit(chapterId: string | null) {
    if (!canViewAuditLogs) return;
    
    let q = query(collection(firestore, "audit_logs"), orderBy("timestamp", "desc"), limit(20));
    
    // Apply chapter filter if selecting a specific chapter or if user is scoped
    if (chapterId) {
        q = query(collection(firestore, "audit_logs"), where('chapterId', '==', chapterId), orderBy("timestamp", "desc"), limit(20));
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const logs = snapshot.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          action: d.action,
          targetUidOrResource: d.targetUidOrResource,
          timestamp: d.timestamp?.toDate ? d.timestamp.toDate().toISOString() : new Date().toISOString()
        };
      });
      
      const compressedLogs: any[] = [];
      let currentBatch: any | null = null;
      let batchCount = 1;

      for (const log of logs) {
        if (!currentBatch) { currentBatch = { ...log }; continue; }
        const timeDiff = new Date(currentBatch.timestamp).getTime() - new Date(log.timestamp).getTime();
        if (currentBatch.action === log.action && currentBatch.targetUidOrResource === log.targetUidOrResource && timeDiff < 10000) {
          batchCount++;
        } else {
          if (batchCount > 1) currentBatch.action = `${currentBatch.action} (x${batchCount})`;
          compressedLogs.push(currentBatch);
          currentBatch = { ...log };
          batchCount = 1;
        }
      }
      if (currentBatch) {
        if (batchCount > 1) currentBatch.action = `${currentBatch.action} (x${batchCount})`;
        compressedLogs.push(currentBatch);
      }
      setAudit(compressedLogs);
    }, (error) => {
      console.error("Audit log stream interrupted:", error);
    });
    return unsubscribe;
  }

  if (userLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="container mx-auto py-8">
        {/* HEADER WITH CHAPTER SWITCHER */}
        <div className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="mb-2 text-4xl font-extrabold tracking-tight text-white uppercase tracking-tighter" style={{ filter: "drop-shadow(0 0 12px rgba(34,197,94,0.3))" }}>
              MISSION CONTROL
            </h1>
            <p className="text-muted-foreground tracking-widest font-mono text-[10px] uppercase">
              {selectedChapterId ? `Chapter: ${selectedChapterId} Deployment Registry` : 'All Chapter Readiness & Fleet Telemetry'}
            </p>
          </div>
          
          {isNational && (
            <ChapterSwitcher 
              currentChapterId={selectedChapterId} 
              onChapterChange={setSelectedChapterId} 
            />
          )}
        </div>

        {/* 4 STAT CARDS */}
        <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard icon={Users} title="Personnel" subtitle="Total registered" value={counts?.users} loading={loading} />
          <MetricCard icon={FolderKanban} title="Initiatives" subtitle="Active projects" value={counts?.projects} loading={loading} />
          <MetricCard icon={Newspaper} title="Intelligence" subtitle="Blog articles" value={counts?.blogs} loading={loading} />
          <MetricCard icon={Calendar} title="Deployments" subtitle="Events scheduled" value={counts?.events} loading={loading} />
        </div>

        {/* 3 APPLICATION METRICS */}
        {canManageApplications && (
          <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-3">
            <MetricCard icon={ClipboardList} title="Recruitment" subtitle="Pending" value={counts?.applicationsPending} loading={loading} />
            <MetricCard icon={ClipboardList} title="Shortlisted" subtitle="Ready" value={counts?.applicationsShortlisted} loading={loading} />
            <MetricCard icon={ClipboardList} title="Rejected" subtitle="Archived" value={counts?.applicationsRejected} loading={loading} />
          </div>
        )}

        {/* QUICK ACTIONS */}
        <div className="mb-8 rounded-xl border border-white/10 bg-card/60 p-6 backdrop-blur-md">
          <div className="mb-6 flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg text-primary"><FileClock className="h-6 w-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-white uppercase tracking-tight">Rapid Command</h2>
              <p className="text-[10px] text-muted-foreground uppercase font-mono">Instant access to administrative modules</p>
            </div>
          </div>
          <ActionGrid />
        </div>

        {/* RECENT ACTIVITY LOGS */}
        <div className="rounded-xl border border-white/10 bg-card/60 p-6 backdrop-blur-md">
          <div className="mb-6">
            <h2 className="text-xl font-bold text-white uppercase tracking-tight">Mission Logs</h2>
            <p className="text-[10px] text-muted-foreground uppercase font-mono">Real-time system-wide activity stream</p>
          </div>

          {error ? (
            <p className="text-destructive font-mono text-xs">{error}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-white/5 bg-background/50">
              <table className="w-full text-left text-sm">
                <tbody>
                  {audit.length === 0 && !loading && (
                    <tr><td className="p-12 text-center text-muted-foreground italic font-mono text-xs uppercase">No telemetry detected in current scope.</td></tr>
                  )}
                  {loading && audit.length === 0 && (
                    <tr><td className="p-12 text-center text-muted-foreground animate-pulse font-mono text-xs uppercase tracking-widest">Establishing secure log stream...</td></tr>
                  )}
                  {audit.map((log: any) => (
                    <tr key={log.id} className="border-b border-white/5 transition-colors hover:bg-white/[0.02] group">
                      <td className="p-4 font-mono font-bold text-[11px] text-primary/80 uppercase group-hover:text-primary transition-colors">
                        {log.action}
                      </td>
                      <td className="p-4 font-mono text-[11px] text-muted-foreground">
                        {log.targetUidOrResource?.length > 30
                          ? `${log.targetUidOrResource.substring(0, 8)}...${log.targetUidOrResource.slice(-4)}`
                          : log.targetUidOrResource}
                      </td>
                      <td className="p-4 text-right text-[10px] text-slate-600 font-mono" title={new Date(log.timestamp).toLocaleString()}>
                        {relativeTime(log.timestamp).toUpperCase()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AuthorizationGate>
  );
}
