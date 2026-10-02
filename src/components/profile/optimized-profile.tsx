'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useUserContext } from '@/firebase/user-provider';
import { auth, firestore } from '@/firebase/core';
import { signOut } from 'firebase/auth';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';

// UI Components
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';

// Icons
import {
  Edit3, Save, X, Rocket, ArrowRight, Github, Linkedin, User, Shield,
  LogOut, AlertTriangle, RefreshCw, ExternalLink, Camera, Link as LinkIcon,
  MapPin, Calendar, BookOpen, Trophy, Zap, Activity, CheckCircle, AlertCircle, Users,
  Ticket, ShoppingBag, Clock, CheckCircle2, XCircle, Package
} from 'lucide-react';

// Hooks & Libs
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { hasSiteAdminAccess, getRoleDisplayName } from '@/lib/roles';
import { collection, query, where, orderBy, getDocs, limit, onSnapshot } from 'firebase/firestore';

// Dynamic Imports — defer all heavy components from initial render
const ProfileEditForm = dynamic(() => import('@/components/profile/profile-edit-form'), {
  loading: () => <Skeleton className="h-96 w-full" />
});
const DynamicNotifications = dynamic(() => import('@/components/profile/user-notifications-listener'), { ssr: false, loading: () => null });

// Tab content components — lazy-loaded so they don't block FCP/LCP
const AssignedTasks = dynamic(() => import('@/components/profile/assigned-tasks').then(m => m.AssignedTasks), {
  loading: () => <Skeleton className="h-48 w-full rounded-xl" />,
  ssr: false,
});
const TaskHistory = dynamic(() => import('@/components/profile/task-history').then(m => m.TaskHistory), {
  loading: () => <Skeleton className="h-32 w-full rounded-xl" />,
  ssr: false,
});
const MyTeam = dynamic(() => import('@/components/profile/my-team').then(m => m.MyTeam), {
  loading: () => <Skeleton className="h-32 w-full rounded-xl" />,
  ssr: false,
});
const VacationToggle = dynamic(() => import('@/components/profile/vacation-toggle'), {
  loading: () => <Skeleton className="h-12 w-full rounded-xl" />,
  ssr: false,
});
const SubmitCompetition = dynamic(
  () => import('@/components/profile/submit-competition').catch(() => {
    // Gracefully degrade if the chunk fails to load (e.g., stale build cache)
    const Fallback = () => null;
    Fallback.displayName = 'SubmitCompetitionFallback';
    return { default: Fallback };
  }),
  { loading: () => null, ssr: false }
);


interface ProfileData {
  profile: any;
  projects: any[];
  badges: any[];
  skills: any[];
  chapter: any;
  certificates: any[];
  warnings: any[];
  tasks: any[];
  myTeam: any[];
  eventsAttended?: any[];
  sectionStatuses?: Record<string, { success: boolean; error?: string; errorCode?: string }>;
}

// ── Orders Tab Sub-Component ───────────────────────────────────────────────────
function OrdersTab({ uid }: { uid: string }) {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid || !firestore) return;
    setLoading(true);

    let unsub: (() => void) | undefined;

    const attachListener = (withOrderBy: boolean) => {
      if (unsub) unsub();
      const col = collection(firestore, 'orders');
      const q = withOrderBy
        ? query(col, where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(30))
        : query(col, where('userId', '==', uid), limit(50));

      unsub = onSnapshot(
        q,
        (snap) => {
          let docs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
          if (!withOrderBy) {
            // Client-side sort when composite index is missing
            docs = docs.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
          }
          setOrders(docs.slice(0, 30));
          setLoading(false);
        },
        (err) => {
          if (withOrderBy && (err as any).code === 'failed-precondition') {
            // Composite index missing — retry without orderBy, sort client-side
            console.warn('[OrdersTab] Composite index missing — falling back to client sort');
            attachListener(false);
          } else {
            console.error('[OrdersTab] onSnapshot error:', err);
            setLoading(false);
          }
        }
      );
    };

    attachListener(true);
    return () => { if (unsub) unsub(); };
  }, [uid]);

  const getStatusConfig = (status: string, paymentStatus: string) => {
    if (status === 'delivered' || paymentStatus === 'completed') return { label: 'Completed', icon: <CheckCircle2 className="h-3 w-3" />, cls: 'bg-green-500/15 text-green-400 border-green-500/20' };
    if (status === 'cancelled' || paymentStatus === 'failed') return { label: 'Cancelled', icon: <XCircle className="h-3 w-3" />, cls: 'bg-red-500/15 text-red-400 border-red-500/20' };
    if (status === 'processing') return { label: 'Processing', icon: <Package className="h-3 w-3" />, cls: 'bg-blue-500/15 text-blue-400 border-blue-500/20' };
    return { label: 'Pending', icon: <Clock className="h-3 w-3" />, cls: 'bg-amber-500/15 text-amber-400 border-amber-500/20' };
  };

  if (loading) return (
    <div className="space-y-3">
      {[1, 2, 3].map(i => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}
    </div>
  );

  if (orders.length === 0) return (
    <div className="text-center py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
      <ShoppingBag className="h-10 w-10 text-slate-600 mx-auto mb-3 opacity-40" />
      <h3 className="text-xl font-heading font-bold text-white mb-2">No orders yet</h3>
      <p className="text-slate-400 max-w-sm mx-auto text-sm">Your purchases will appear here after checkout.</p>
    </div>
  );

  return (
    <div className="space-y-3">
      {orders.map((order: any) => {
        const statusCfg = getStatusConfig(order.status, order.paymentStatus);
        const itemName = order.items?.[0]?.productName || order.items?.[0]?.title || 'Order';
        const total = order.total ?? order.amount ?? 0;
        const currency = order.currency || 'PKR';
        const createdDate = order.createdAt?.seconds
          ? new Date(order.createdAt.seconds * 1000).toLocaleDateString()
          : (order.createdAt ? new Date(order.createdAt).toLocaleDateString() : '—');

        return (
          <div key={order.id} className="flex items-center gap-4 p-4 rounded-xl border border-white/10 bg-black/30 hover:bg-white/5 transition-all">
            <div className={`h-10 w-10 shrink-0 rounded-lg flex items-center justify-center border ${statusCfg.cls}`}>
              {statusCfg.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-200 truncate">{itemName}</p>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${statusCfg.cls}`}>
                  {statusCfg.icon} {statusCfg.label}
                </span>
                {order.originatingModule && (
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">{order.originatingModule}</span>
                )}
                <span className="text-[10px] text-slate-600 font-mono">{createdDate}</span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-bold text-white tabular-nums">{currency} {typeof total === 'number' ? total.toLocaleString() : total}</p>
              <p className="text-[10px] font-mono text-slate-600 uppercase">{order.id.slice(0, 8)}</p>
            </div>
            {order.eventId && (
              <Link href="/user/profile?tab=tickets" className="shrink-0 ml-1">
                <Button variant="ghost" size="icon" className="h-8 w-8 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10" title="View Ticket">
                  <Ticket className="h-4 w-4" />
                </Button>
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface OptimizedProfileProps {
  uid?: string;
  showProjects?: boolean;
  showLayout?: boolean;
  showStarryBackground?: boolean;
  simpleLayout?: boolean;
}

export function OptimizedProfile({
  uid: propUid,
  showProjects = true,
  showLayout = true,
  showStarryBackground = false,
  simpleLayout = false,
}: OptimizedProfileProps) {
  // ---------------------------------------------------------------------------
  // State & Data Fetching
  // ---------------------------------------------------------------------------
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user: currentUser, role: currentUserRole, isLoading: userLoading } = useUserContext();
  const { showErrorToast, showSuccessToast } = useEnhancedToast();

  const uid = propUid || searchParams.get('uid') || searchParams.get('id') || currentUser?.uid;
  const isOwnProfile = currentUser?.uid === uid;
  const isDevelopment = process.env.NODE_ENV === 'development';

  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<any>({});
  const [refreshingPhoto, setRefreshingPhoto] = useState(false);
  const taskIdParam = searchParams.get('task');
  const editFormRef = useRef<(() => any) | null>(null);

  // Data extraction at top level to avoid TDZ errors in hooks
  const { profile, projects, badges, chapter, certificates, warnings, tasks, sectionStatuses } = profileData || {};

  // Fetch Profile — does NOT wait for auth to resolve before starting.
  // We fire the fetch immediately when uid is known, then attach the token
  // if the user already resolved. If not yet resolved we retry once auth settles.
  useEffect(() => {
    if (!uid) return;
    if (isEditing) return;
    // If auth is still loading we'll re-run once userLoading flips to false.
    // But we start the fetch immediately if uid is already present from URL.
    if (userLoading && !currentUser) return;

    const fetchProfileData = async () => {
      setLoading(true);
      setError(null);

      try {
        // Get token only when user is already resolved — don't block if not.
        let idToken: string | null = null;
        try {
          idToken = currentUser ? await currentUser.getIdToken(false) : null;
        } catch {
          // Token fetch error — continue without token (API will handle auth)
        }

        const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
        else if (isDevelopment) headers['Authorization'] = 'Bearer dev_token';

        const response = await fetch(`${baseUrl}/api/profile/${uid}`, { headers });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error(errorData.error || `Failed to fetch profile: ${response.statusText}`);
        }

        const data = await response.json();
        setProfileData(data);
      } catch (err) {
        // Downgrade to warn — profile fetch failures are recoverable and expected in dev/offline
        console.warn('[OptimizedProfile] Profile fetch failed:', err instanceof Error ? err.message : err);
        const params = new URLSearchParams(window.location.search);
        const isDebug = params.get('debug') === 'true';
        const errorMessage = err instanceof Error ? err.message : 'Failed to load profile';
        setError(errorMessage);
        if (isDebug) showErrorToast(`Debug: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    };

    fetchProfileData();
  }, [uid, currentUser, userLoading, isEditing, isDevelopment]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const handleLogout = async () => {
    try {
      if (auth) await signOut(auth);
      showSuccessToast('Signed out successfully');
      router.replace('/auth');
    } catch (err) {
      showErrorToast('Failed to sign out');
    }
  };

  const handleRefreshPhoto = async () => {
    if (!currentUser || !uid) return;
    try {
      setRefreshingPhoto(true);
      await currentUser.reload();
      const newPhoto = currentUser.photoURL || '';
      const idToken = await currentUser.getIdToken(true);
      const res = await fetch(`/api/profile/${uid}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoURL: newPhoto })
      });
      if (res.ok) {
        const updated = await res.json();
        setProfileData((prev) => prev ? { ...prev, profile: updated.profile } : prev);
        showSuccessToast('Photo updated');
      } else {
        throw new Error('Failed to update photo');
      }
    } catch (e) {
      showErrorToast('Failed to refresh photo');
    } finally {
      setRefreshingPhoto(false);
    }
  };

  const handleSaveProfile = async () => {
    try {
      const idToken = currentUser ? await currentUser.getIdToken(true) : null;
      const currentValues = editFormRef.current ? editFormRef.current() : form;

      // Basic validation
      const whatsapp = String(currentValues.whatsappNumber || '').trim();
      if (whatsapp && !/^\+?[0-9\s-]{6,}$/.test(whatsapp)) {
        showErrorToast('Please enter a valid WhatsApp number');
        return;
      }

      const res = await fetch(`/api/profile/${uid}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${idToken || ''}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(currentValues)
      });

      if (!res.ok) throw new Error('Failed to save');

      const updated = await res.json();
      setProfileData((prev) => prev ? { ...prev, profile: updated.profile } : prev);
      setIsEditing(false);
      showSuccessToast('Profile updated');
    } catch (err) {
      showErrorToast('Failed to save profile');
    }
  };

  // Group tickets by event, keeping only the LATEST ticket per event to prevent duplicates
  const groupedTickets = useMemo(() => {
    const attended = profile?.eventsAttended || [];
    if (attended.length === 0) return [];

    // Deduplicate: keep only the ticket with the highest ticketId (latest issued) per event
    const bestTicketPerEvent = attended.reduce((acc: Record<string, any>, curr: any) => {
      if (!curr.eventId) return acc;
      const existing = acc[curr.eventId];
      // If no existing, or current ticket number is higher, use current
      if (!existing || (curr.ticketId || '') > (existing.ticketId || '')) {
        acc[curr.eventId] = curr;
      }
      return acc;
    }, {});

    // Return as grouped structure (one ticket per event)
    return Object.values(bestTicketPerEvent).map((ticket: any) => ({
      eventId: ticket.eventId,
      eventTitle: ticket.eventTitle,
      tickets: [ticket] // Always exactly one ticket per event group
    }));
  }, [profile?.eventsAttended]);

  // Deduplicated flat list for sidebar display
  const deduplicatedEventsAttended = useMemo(() => {
    const attended = profile?.eventsAttended || [];
    const seen = new Set<string>();
    return attended.filter((e: any) => {
      if (!e.eventId || seen.has(e.eventId)) return false;
      seen.add(e.eventId);
      return true;
    });
  }, [profile?.eventsAttended]);

  // ---------------------------------------------------------------------------
  // Render Logic
  // ---------------------------------------------------------------------------

  // Loading State — only block render on data loading, NOT on auth loading.
  // userLoading alone no longer keeps the whole page blank.
  if (loading) {
    if (showLayout) {
      return (
        <div className="container mx-auto px-4 py-8 max-w-7xl animate-pulse">
          <div className="h-48 rounded-3xl bg-white/5 mb-8" />
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
            <div className="md:col-span-4"><div className="h-96 rounded-3xl bg-white/5" /></div>
            <div className="md:col-span-8"><div className="h-96 rounded-3xl bg-white/5" /></div>
          </div>
        </div>
      );
    }
    return <Skeleton className="h-96 w-full" />;
  }

  // Not Authenticated
  if (!currentUser && !isDevelopment) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <Shield className="h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-2xl font-bold mb-2">Access Restricted</h2>
        <p className="text-muted-foreground mb-6">Please sign in to view this profile.</p>
        <Button onClick={() => router.push('/auth')}>Sign In</Button>
      </div>
    );
  }

  // Metrics

  // Metrics
  const efficiency = (profile?.tasksAssignedCount || 0) > 0
    ? Math.round(((profile?.tasksCompletedOnTimeCount || 0) / (profile?.tasksAssignedCount || 1)) * 100)
    : 100;


  // ---------------------------------------------------------------------------
  // EDIT MODE
  // ---------------------------------------------------------------------------
  if (isEditing) {
    return (
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <Card className="border-primary/20 bg-background/50 backdrop-blur-md">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/50 pb-6">
            <div>
              <CardTitle className="text-2xl font-heading tracking-wide">Edit Profile</CardTitle>
              <CardDescription>Update your personal information and preferences.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setIsEditing(false)}>Cancel</Button>
              <Button onClick={handleSaveProfile} className="gap-2"><Save className="h-4 w-4" /> Save Changes</Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <ProfileEditForm
              initialForm={form}
              onGetValuesRef={(getValues: () => any) => { editFormRef.current = getValues; }}
              chapters={(chapter?.allChapters || []).map((c: any) => ({ id: c.id, name: c.name }))}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // VIEW MODE (Premium UI)
  // ---------------------------------------------------------------------------
  return (
    <div className={`mx-auto ${simpleLayout ? 'max-w-4xl' : 'container max-w-7xl'} px-4 py-8 md:py-12 space-y-8`}>
      <DynamicNotifications />

      {/* 1. Header Card */}
      <div className="relative rounded-3xl overflow-hidden border border-white/10 bg-black/40 backdrop-blur-md shadow-2xl">
        {/* Cover gradient or image */}
        <div className="absolute inset-0 h-32 bg-gradient-to-r from-blue-900/40 to-purple-900/40 pointer-events-none" />

        <div className="relative pt-16 px-6 pb-6 flex flex-col md:flex-row items-start md:items-end gap-6">
          {/* Avatar */}
          <div className="relative group shrink-0">
            <div className="absolute -inset-0.5 rounded-full bg-gradient-to-br from-primary to-purple-600 opacity-75 blur-sm group-hover:opacity-100 transition duration-500"></div>
            <Avatar className="h-32 w-32 border-4 border-black relative z-10">
              <AvatarImage src={profile?.photoURL || undefined} className="object-cover" />
              <AvatarFallback className="text-4xl font-heading bg-muted text-muted-foreground">
                {profile?.displayName?.charAt(0) || 'U'}
              </AvatarFallback>
            </Avatar>
            {isOwnProfile && (
              <button
                onClick={handleRefreshPhoto}
                disabled={refreshingPhoto}
                className="absolute bottom-1 right-1 z-20 p-2 rounded-full bg-slate-800 text-white hover:bg-primary transition-colors border border-slate-700 shadow-md"
                title="Refresh Photo"
              >
                <RefreshCw className={`h-4 w-4 ${refreshingPhoto ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>

          {/* Info */}
          <div className="flex-1 mb-2">
            <div className="flex flex-col">
              <h1 className="text-3xl md:text-5xl font-heading font-bold text-white tracking-wide text-glow mb-2">
                {profile?.displayName || 'Unknown User'}
              </h1>
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
                {chapter?.name && (
                  <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 backdrop-blur-sm gap-1 pl-2">
                    <MapPin className="h-3 w-3" /> {chapter.name}
                  </Badge>
                )}

                <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/20 backdrop-blur-sm gap-1 pl-2 uppercase">
                  <Shield className="h-3 w-3" /> {getRoleDisplayName(profile?.role, uid)}
                </Badge>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 mt-4 md:mt-0">
            {isOwnProfile ? (
              <>
                <Button
                  onClick={() => {
                    setForm({
                      displayName: profile?.displayName || '',
                      bio: profile?.bio || '',
                      githubUrl: profile?.githubUrl || '',
                      linkedinUrl: profile?.linkedinUrl || '',
                      whatsappNumber: profile?.whatsappNumber || '',
                      university: profile?.university || '',
                      fieldOfStudy: profile?.fieldOfStudy || '',
                      chapterId: chapter?.id || profile?.chapterId || ''
                    });
                    setIsEditing(true);
                  }}
                  variant="secondary"
                  className="gap-2 shadow-lg hover:shadow-primary/20 transition-all font-heading tracking-wide"
                >
                  <Edit3 className="h-4 w-4" /> Edit Profile
                </Button>
                <Button variant="destructive" size="icon" onClick={handleLogout} title="Logout">
                  <LogOut className="h-4 w-4" />
                </Button>
              </>
            ) : null}

            {hasSiteAdminAccess(currentUserRole || 'member') && (
              <Link href="/admin">
                <Button variant="outline" className="gap-2 border-white/20 hover:bg-white/10 text-white">
                  <Shield className="h-4 w-4" /> Admin
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* 2. Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* LEFT COLUMN: Identity & Stats */}
        <div className="lg:col-span-4 space-y-6">
          {/* Stats Cards */}
          <div className="grid grid-cols-3 gap-4">
            <Card className="bg-black/40 border-white/5 backdrop-blur-sm">
              <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                <div className="text-3xl font-heading text-yellow-500 tabular-nums mb-1">{profile?.points || 0}</div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground font-bold">Points</div>
              </CardContent>
            </Card>
            <Card className="bg-black/40 border-white/5 backdrop-blur-sm">
              <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                <div className={`text-3xl font-heading tabular-nums mb-1 ${efficiency >= 80 ? 'text-green-500' : 'text-orange-500'}`}>{efficiency}%</div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground font-bold">Efficiency</div>
              </CardContent>
            </Card>
            <Card className="bg-black/40 border-white/5 backdrop-blur-sm">
              <CardContent className="p-4 flex flex-col items-center justify-center text-center">
                <div className="text-3xl font-heading text-cyan-400 tabular-nums mb-1">{profile?.totalHoursWorked || 0}h</div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground font-bold">Hours</div>
              </CardContent>
            </Card>
          </div>

          {/* Vacation & Submissions (Own Profile Only) */}
          {isOwnProfile && (
            <div className="space-y-4">
              <VacationToggle />
              <div className="flex justify-center">
                <SubmitCompetition />
              </div>
            </div>
          )}

          {/* Bio & Details */}
          <Card className="border-white/10 bg-black/40 backdrop-blur-md overflow-hidden">
            <CardHeader className="bg-white/5 pb-4">
              <CardTitle className="text-lg font-heading tracking-wide flex items-center gap-2">
                <User className="h-4 w-4 text-primary" /> Identity
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              {/* About */}
              <div>
                <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2">Details</h4>
                <dl className="space-y-2 text-sm">
                  {profile?.university && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">University</dt>
                      <dd className="font-medium text-right text-slate-200">{profile.university}</dd>
                    </div>
                  )}
                  {profile?.fieldOfStudy && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Field</dt>
                      <dd className="font-medium text-right text-slate-200">{profile.fieldOfStudy}</dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Joined</dt>
                    <dd className="font-medium text-right text-slate-200">
                      {profile?.createdAt
                        ? (profile.createdAt.seconds
                          ? new Date(profile.createdAt.seconds * 1000).getFullYear()
                          : (profile.createdAt._seconds
                            ? new Date(profile.createdAt._seconds * 1000).getFullYear()
                            : new Date(profile.createdAt).getFullYear()))
                        : new Date().getFullYear()}
                    </dd>
                  </div>
                </dl>
              </div>
              <Separator className="bg-white/10" />
              {/* Bio */}
              {profile?.bio && (
                <div className="prose prose-sm prose-invert max-w-none">
                  <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2">Bio</h4>
                  <p className="text-slate-400 leading-relaxed font-body">
                    {profile.bio}
                  </p>
                </div>
              )}

              <Separator className="bg-white/10" />

              {/* Skills */}
              <div>
                <h4 className="text-xs font-bold uppercase text-muted-foreground mb-3">Capabilities</h4>
                <div className="flex flex-wrap gap-2">
                  {(profileData?.skills || []).map((s: any) => (
                    <Badge key={s.id} variant="secondary" className="bg-white/5 hover:bg-white/10 text-slate-300 font-normal">
                      {s.name}
                    </Badge>
                  ))}
                  {(profileData?.skills || []).length === 0 && <p className="text-sm text-muted-foreground italic">No skills calibrated.</p>}
                </div>
              </div>

              {/* Socials */}
              <div className="flex gap-2 pt-2">
                {profile?.githubUrl && (
                  <Link href={profile.githubUrl} target="_blank" className="flex-1">
                    <Button variant="outline" size="sm" className="w-full gap-2 border-white/10 bg-black/20 hover:bg-white/5">
                      <Github className="h-4 w-4" /> GitHub
                    </Button>
                  </Link>
                )}
                {profile?.linkedinUrl && (
                  <Link href={profile.linkedinUrl} target="_blank" className="flex-1">
                    <Button variant="outline" size="sm" className="w-full gap-2 border-white/10 bg-black/20 hover:bg-white/5">
                      <Linkedin className="h-4 w-4" /> LinkedIn
                    </Button>
                  </Link>
                )}
              </div>

              <Separator className="bg-white/10" />

              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-bold uppercase text-muted-foreground">Events Attended</h4>
                  <Badge variant="secondary" className="bg-primary/20 text-primary hover:bg-primary/30 text-[10px]">
                    {deduplicatedEventsAttended.length}
                  </Badge>
                </div>

                <div className="space-y-3">
                  {deduplicatedEventsAttended.length > 0 ? (
                    deduplicatedEventsAttended.slice(0, 3).map((event: any) => (
                      <Link key={event.eventId} href={`/events/ticket/${event.ticketId}`}>
                        <div className="flex items-center gap-3 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors group">
                          <div className="h-10 w-10 shrink-0 rounded bg-slate-800 flex items-center justify-center border border-white/5 group-hover:border-primary/50 overflow-hidden relative">
                            {event.uniqueTicketUrl ? (
                              <Image
                                src={event.uniqueTicketUrl}
                                alt=""
                                fill
                                sizes="40px"
                                className="object-cover"
                              />
                            ) : (
                              <Ticket className="h-5 w-5 text-slate-500" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-200 truncate">{event.eventTitle}</p>
                            <p className="text-[10px] text-slate-500 font-mono truncate">{event.ticketId}</p>
                          </div>
                          <ArrowRight className="h-3 w-3 text-slate-600 group-hover:text-primary transition-colors shrink-0" />
                        </div>
                      </Link>
                    ))
                  ) : (
                    <div className="text-center py-6 rounded-lg border border-dashed border-white/10 bg-white/5">
                      <Ticket className="h-6 w-6 text-slate-600 mx-auto mb-2 opacity-20" />
                      <p className="text-[10px] text-slate-500">No events attended yet.</p>
                    </div>
                  )}

                  {deduplicatedEventsAttended.length > 3 && (
                    <Button variant="ghost" size="sm" className="w-full text-[10px] h-8 text-slate-400 hover:text-white" asChild>
                      <Link href="#tickets">View All {deduplicatedEventsAttended.length} Tickets</Link>
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Legal / Warnings Small */}
          {(isOwnProfile || sectionStatuses?.warnings?.success === false) && (
            <Card className="border-white/10 bg-black/40 backdrop-blur-md">
              <CardContent className="p-4 space-y-2">
                {/* Terms Status */}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Legal Consent</span>
                  {profile?.termsAccepted ? (
                    <span className="text-green-500 flex items-center gap-1 font-medium text-xs"><CheckCircle className="h-3 w-3" /> Active</span>
                  ) : (
                    <Link href="/terms-and-conditions" className="text-red-400 hover:underline text-xs flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" /> Review Terms
                    </Link>
                  )}
                </div>

                {/* Warnings Preview */}
                {warnings && warnings.length > 0 && (
                  <div className="pt-2 border-t border-white/10 mt-2">
                    <div className="text-amber-500 text-sm font-bold flex items-center gap-2 mb-2">
                      <AlertTriangle className="h-4 w-4" /> {warnings.length} Active Warnings
                    </div>
                    <p className="text-xs text-muted-foreground">Check Mission Control for details.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* RIGHT COLUMN: Tabs Content */}
        <div className="lg:col-span-8">
          <Tabs defaultValue="mission-control" className="w-full">
            <TabsList className="w-full justify-start bg-black/40 border border-white/10 p-1.5 h-auto rounded-xl backdrop-blur-md mb-6 gap-2 flex-wrap">
              <TabsTrigger value="mission-control" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-black text-slate-400 py-2.5 px-4 rounded-lg transition-all font-heading tracking-wide">
                <Zap className="h-4 w-4" /> Mission Control
              </TabsTrigger>
              <TabsTrigger value="my-team" className="flex items-center gap-2 data-[state=active]:bg-emerald-500 data-[state=active]:text-black text-slate-400 py-2.5 px-4 rounded-lg transition-all font-heading tracking-wide">
                <Users className="h-4 w-4" /> My Team
              </TabsTrigger>
              <TabsTrigger value="projects" className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:text-black text-slate-400 py-2.5 px-4 rounded-lg transition-all font-heading tracking-wide">
                <Rocket className="h-4 w-4" /> Projects
              </TabsTrigger>
              <TabsTrigger value="certificates" className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:text-black text-slate-400 py-2.5 px-4 rounded-lg transition-all font-heading tracking-wide">
                <Trophy className="h-4 w-4" /> Credentials
              </TabsTrigger>
              <TabsTrigger value="tickets" className="flex items-center gap-2 data-[state=active]:bg-cyan-500 data-[state=active]:text-black text-slate-400 py-2.5 px-4 rounded-lg transition-all font-heading tracking-wide">
                <Ticket className="h-4 w-4" /> Tickets
              </TabsTrigger>
              <TabsTrigger value="orders" className="flex items-center gap-2 data-[state=active]:bg-amber-500 data-[state=active]:text-black text-slate-400 py-2.5 px-4 rounded-lg transition-all font-heading tracking-wide">
                <ShoppingBag className="h-4 w-4" /> Orders
              </TabsTrigger>
            </TabsList>

            {/* 1. Mission Control Tab */}
            <TabsContent value="mission-control" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {/* Warnings Section (Extended) */}
              {warnings && warnings.length > 0 && (
                <Card className="border-amber-500/50 bg-amber-950/20">
                  <CardHeader className="pb-3"><CardTitle className="text-amber-500 flex items-center gap-2"><AlertTriangle className="h-5 w-5" /> Active Directives & Warnings</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {warnings.map((w: any) => (
                        <div key={w.id} className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex justify-between items-center">
                          <div>
                            <p className="font-medium text-amber-200 text-sm">{w.reason}</p>
                            <p className="text-xs text-amber-500/70">Expires: {w.expiresAt ? new Date(w.expiresAt).toLocaleDateString() : 'Never'}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Assigned Tasks Component */}
              <AssignedTasks userId={uid || ''} initialTasks={tasks} initialTaskId={taskIdParam} />

              {/* Task History / Archive - Lazy loaded */}
              <TaskHistory userId={uid || ''} />
            </TabsContent>

            {/* 2. My Team Tab */}
            <TabsContent value="my-team" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {profileData?.myTeam !== undefined ? (
                <MyTeam initialData={profileData.myTeam} />
              ) : (
                <div className="animate-pulse">
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-24 w-full mt-4" />
                </div>
              )}
            </TabsContent>

            {/* 3. Projects Tab */}
            <TabsContent value="projects" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {/* Badges Row */}
              {badges && badges.length > 0 && (
                <div className="flex flex-wrap gap-4 mb-6 p-4 rounded-xl border border-white/10 bg-white/5">
                  {badges.map((b: any) => (
                    b.imageUrl ? (
                      <div key={b.slug} className="flex flex-col items-center gap-1 group">
                        <div className="relative h-12 w-12 transition-transform group-hover:scale-110">
                          <Image src={b.imageUrl} alt={b.name} fill sizes="48px" className="object-contain drop-shadow-lg" />
                        </div>
                        <span className="text-[10px] uppercase font-bold text-slate-400">{b.name}</span>
                      </div>
                    ) : (
                      <Badge key={b.slug} variant="secondary">{b.name}</Badge>
                    )
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4">
                {projects && projects.length > 0 ? projects.map((project: any) => (
                  <Link key={project.id} href={`/projects/detail?slug=${project.id}`}>
                    <Card className="group border-white/10 bg-black/40 hover:bg-white/5 transition-all hover:border-primary/50 overflow-hidden">
                      <div className="flex md:items-center gap-5 p-5">
                        <div className="relative h-20 w-20 shrink-0 rounded-lg overflow-hidden bg-muted">
                          <Image src={project.imageUrl || '/images/placeholder-project.jpg'} alt={project.title} fill sizes="80px" className="object-cover group-hover:scale-110 transition duration-700" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-xl font-heading font-bold text-white mb-1 group-hover:text-primary transition-colors">{project.title}</h3>
                          <p className="text-slate-400 text-sm line-clamp-2 md:line-clamp-1 mb-2">{project.description}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Activity className="h-3 w-3" /> Active Project
                          </div>
                        </div>
                        <div className="hidden md:block">
                          <ArrowRight className="h-5 w-5 text-slate-500 group-hover:text-primary group-hover:translate-x-1 transition-all" />
                        </div>
                      </div>
                    </Card>
                  </Link>
                )) : (
                  <div className="text-center py-12 border border-dashed border-white/10 rounded-xl bg-white/5">
                    <Rocket className="h-10 w-10 text-slate-600 mx-auto mb-3" />
                    <p className="text-slate-400">No active project assignments.</p>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* 3. Credentials Tab */}
            <TabsContent value="certificates" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {certificates && certificates.length > 0 ? certificates.map((c: any) => (
                  <div key={c.id} className="relative group p-6 rounded-xl border border-white/10 bg-gradient-to-br from-white/5 to-transparent hover:border-primary/30 transition-all">
                    <div className="absolute top-4 right-4 text-white/10 group-hover:text-primary/20 transition-colors">
                      <Trophy className="h-12 w-12" />
                    </div>
                    <div className="relative z-10">
                      <h4 className="font-heading text-lg font-bold text-slate-200 mb-1 leading-tight pr-10">
                        {c.achievement || c.eventName || 'Certificate of Completion'}
                      </h4>
                      <p className="text-xs text-slate-400 font-mono mb-4">
                        Issued: {c.issueDate ? new Date(c.issueDate).toLocaleDateString() : 'Unknown'}
                      </p>

                      <div className="flex items-center justify-between mt-4">
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase text-slate-500 font-bold">Verification Code</span>
                          <span className="font-mono text-xs text-primary">{c.code}</span>
                        </div>
                        <Link href={`/verify/${encodeURIComponent(c.code)}`}>
                          <Button size="sm" variant="ghost" className="h-8 text-xs hover:bg-primary/20">
                            Verify <ExternalLink className="ml-1 h-3 w-3" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="col-span-full text-center py-12 border border-dashed border-white/10 rounded-xl bg-white/5">
                    <Trophy className="h-10 w-10 text-slate-600 mx-auto mb-3" />
                    <p className="text-slate-400">No credentials issued yet.</p>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* 5. Tickets Tab */}
            <TabsContent value="tickets" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500" id="tickets">
              <div className="flex flex-col gap-8">
                {groupedTickets.length === 0 ? (
                  <div className="text-center py-20 border border-dashed border-white/10 rounded-3xl bg-white/5">
                    <div className="h-20 w-20 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-6">
                      <Ticket className="h-10 w-10 text-slate-600 opacity-50" />
                    </div>
                    <h3 className="text-2xl font-heading font-bold text-white mb-2">No tickets found</h3>
                    <p className="text-slate-400 max-w-sm mx-auto">Attend SEDS events to generate your high-resolution commemorative tickets.</p>
                  </div>
                ) : (
                  groupedTickets.map((group: any) => (
                    <div key={group.eventId} className="space-y-4">
                      {/* Event Header Group */}
                      <div className="flex items-center gap-4 bg-white/5 p-4 rounded-2xl border border-white/10 backdrop-blur-sm">
                        <div className="h-12 w-12 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/20 shrink-0">
                          <Rocket className="h-6 w-6 text-primary" />
                        </div>
                        <div>
                          <h3 className="font-heading font-bold text-xl text-white leading-tight">{group.eventTitle}</h3>
                          <p className="text-xs text-slate-500 mt-1 uppercase tracking-widest font-bold">
                            {group.tickets.length} Visual Credential{group.tickets.length > 1 ? 's' : ''} • Secured
                          </p>
                        </div>
                      </div>

                      {/* Tickets Grid for this Event */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pl-2 md:pl-6 border-l-2 border-primary/20 ml-6 pb-2">
                        {group.tickets.map((event: any) => (
                          <Card key={event.ticketId} className="group overflow-hidden border-white/10 bg-black/40 hover:bg-white/5 transition-all shadow-2xl relative">
                            <div className="relative aspect-[1.618/1] bg-muted overflow-hidden">
                              {event.uniqueTicketUrl ? (
                                <Image
                                  src={event.uniqueTicketUrl}
                                  alt={event.eventTitle}
                                  fill
                                  sizes="(max-width: 768px) 100vw, 400px"
                                  className="object-cover group-hover:scale-105 transition-transform duration-700"
                                />
                              ) : (
                                <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-white/5 border-b border-white/5">
                                  <Ticket className="h-12 w-12 mb-2 opacity-20" />
                                  <span className="text-sm font-medium">Standard Digital Ticket</span>
                                </div>
                              )}
                              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-6 gap-2">
                                <Link href={`/events/ticket/${event.ticketId}`} className="w-full">
                                  <Button className="w-full gap-2 bg-primary text-black hover:bg-primary/90 font-bold shadow-lg h-10">
                                    <ExternalLink className="h-4 w-4" /> View Full Ticket
                                  </Button>
                                </Link>
                                {hasSiteAdminAccess(currentUserRole || 'member') && (
                                  <Link href={`/admin/events/registrations?eventId=${event.eventId}&uid=${uid}`} className="w-full">
                                    <Button variant="secondary" className="w-full gap-2 bg-white/10 text-white hover:bg-white/20 font-bold backdrop-blur-sm border border-white/10 h-10">
                                      <Edit3 className="h-4 w-4" /> Edit Registration
                                    </Button>
                                  </Link>
                                )}
                              </div>
                            </div>
                            <CardContent className="p-5">
                              <div className="flex justify-between items-start mb-3">
                                <h3 className="font-heading font-bold text-base text-white truncate flex-1 leading-tight tracking-wide">{event.ticketId}</h3>
                                <Badge variant="outline" className="text-[10px] h-5 border-emerald-500/30 text-emerald-400 bg-emerald-400/5 font-mono uppercase tracking-tighter">
                                  Authentic
                                </Badge>
                              </div>
                              <div className="flex items-center justify-between text-xs text-slate-400">
                                <div className="flex items-center gap-4">
                                  <span className="flex items-center gap-1.5">
                                    <Calendar className="h-3.5 w-3.5" />
                                    {(() => {
                                      if (!event.attendedAt) return 'Active';
                                      try {
                                        const d = event.attendedAt.seconds
                                          ? new Date(event.attendedAt.seconds * 1000)
                                          : new Date(event.attendedAt);
                                        return isNaN(d.getTime()) ? 'N/A' : d.toLocaleDateString();
                                      } catch {
                                        return 'N/A';
                                      }
                                    })()}
                                  </span>
                                  <span className="flex items-center gap-1.5 text-green-400 font-medium">
                                    <CheckCircle className="h-3.5 w-3.5" /> ID Verified
                                  </span>
                                </div>

                                <Link href={`/events/ticket/${event.ticketId}`} className="text-primary hover:underline font-bold flex items-center gap-1">
                                  Details <ArrowRight className="h-3 w-3" />
                                </Link>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </TabsContent>

            {/* 6. Orders Tab */}
            <TabsContent value="orders" className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <OrdersTab uid={uid || ''} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
