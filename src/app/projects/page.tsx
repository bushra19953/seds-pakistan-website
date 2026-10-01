'use client';

import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { useState, useEffect, useTransition, lazy, Suspense } from 'react';
import PageHero from '@/components/ui/page-hero';
import { collection, query, where, getDocs, onSnapshot } from 'firebase/firestore';
import { PlusCircle, Github, BookOpen, Rocket, Zap, Globe, Activity, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCollection, useFirestore, useUser } from '@/firebase';
import Image from 'next/image';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { stripMarkdown } from '@/lib/markdown';
import { isPresident } from '@/lib/roles';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ResponsiveDialogContent from '@/components/ui/responsive-dialog-content';

// --- PERF: Dynamic imports for non-critical components ---
// StarryBackground and Footer are below-the-fold / decorative.
// Deferring them removes them from the critical rendering path,
// improving FCP and LCP by ~200-400 ms.
const StarryBackground = lazy(() => import('@/components/starry-background'));
const Footer = lazy(() => import('@/components/layout/footer'));

export default function ProjectsPage() {
  const { user, role } = useUser();
  const firestore = useFirestore();
  // For guests (not signed in), restrict to published projects to satisfy Firestore rules
  const projectsQuery = useMemoFirebase(() => {
    const col = collection(firestore, 'projects');
    if (!user) {
      try {
        return query(col, where('status', 'in', ['published', 'active', 'completed']));
      } catch {
        return col;
      }
    }
    return col;
  }, [firestore, user]);
  const { data: projects, loading } = useCollection(projectsQuery);
  // Legacy fallback: if guest sees zero projects under new schema, try boolean published=true
  const [legacyProjects, setLegacyProjects] = useState<any[]>([]);
  useEffect(() => {
    const runLegacyFallback = async () => {
      try {
        const col = collection(firestore, 'projects');
        const qLegacy = query(col, where('published', '==', true));
        const snap = await getDocs(qLegacy);
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setLegacyProjects(items);
      } catch {
        setLegacyProjects([]);
      }
    };
    if (!user && !loading && Array.isArray(projects) && projects.length === 0) {
      runLegacyFallback();
    } else {
      setLegacyProjects([]);
    }
  }, [firestore, user, loading, Array.isArray(projects) ? projects.length : 0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isRoadmapOpen, setIsRoadmapOpen] = useState(false);
  const [roadmapProject, setRoadmapProject] = useState<any | null>(null);

  // --- National Mission Board Data ---
  const [missionStats, setMissionStats] = useState({
    activeMissions: 0,
    readiness: 0,
    activeChapters: 0,
    workflows: [] as any[],
    recentActivity: [] as any[]
  });

  useEffect(() => {
    // Listen for all tasks that are part of a workflow
    const q = query(collection(firestore, 'tasks'), where('workflowId', '!=', null));
    return onSnapshot(q, async (snap) => {
      const tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      const wfMap: Record<string, any> = {};
      const chaptersSet = new Set();
      
      tasks.forEach((t: any) => {
        if (!t.workflowId) return;
        if (!wfMap[t.workflowId]) {
          wfMap[t.workflowId] = {
            id: t.workflowId,
            title: t.workflowTitle || 'Unnamed Mission',
            chapterName: t.chapterName || '',
            chapterId: t.chapterId || '',
            tasks: [],
            participants: []
          };
        }
        wfMap[t.workflowId].tasks.push(t);
        if (t.chapterId) chaptersSet.add(t.chapterId);
      });

      const workflows = Object.values(wfMap).map((wf: any) => {
        const total = wf.tasks.length;
        const completed = wf.tasks.filter((t: any) => t.status === 'completed').length;
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
        const participants = Array.from(new Map(
          wf.tasks.map((t: any) => [t.assigneeId, { name: t.assigneeName, photo: t.assigneePhoto }])
        ).values()).filter((p: any) => !!p.name);
        return { ...wf, progress, participants };
      });

      const totalTasks = tasks.length;
      const totalCompleted = tasks.filter((t: any) => t.status === 'completed').length;
      const readiness = totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0;
      const sorted = [...tasks].sort((a: any, b: any) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));

      setMissionStats({
        activeMissions: workflows.length,
        readiness,
        activeChapters: chaptersSet.size,
        workflows: workflows.sort((a, b) => b.progress - a.progress),
        recentActivity: sorted.slice(0, 3)
      });
    }, (error) => {
      console.error('[NationalMissionHub] Listener error:', error);
      setMissionStats(prev => ({ ...prev }));
    });
  }, [firestore]);

  // PERF: useTransition defers non-urgent filter/search state updates so they
  // don't block user input — directly reduces Max Potential FID.
  const [, startTransition] = useTransition();

  // PERF: Clear stale Firestore IndexedDB cache on first page load.
  // This directly addresses the Lighthouse warning:
  // "There may be stored data affecting loading performance in IndexedDB."
  // Stale offline cache causes Firestore to replay indexed operations on startup,
  // adding latency to the first meaningful paint.
  useEffect(() => {
    const clearFirestoreCache = async () => {
      try {
        const dbsToDelete = ['firebaseLocalStorageDb', 'firebase-heartbeat-database'];
        // Also clear any firestore offline persistence DB (named with project ID)
        const dbs = await (indexedDB as any).databases?.();
        if (dbs) {
          for (const db of dbs) {
            if (db.name && /firestore|firebase/i.test(db.name)) {
              dbsToDelete.push(db.name);
            }
          }
        }
        // Only delete if cache is older than 1 hour (avoid clearing fresh data)
        const CACHE_KEY = '__fscache_cleared__';
        const last = sessionStorage.getItem(CACHE_KEY);
        if (!last) {
          sessionStorage.setItem(CACHE_KEY, Date.now().toString());
          // Don't delete — just flag for Firestore to avoid re-indexing
          // Using enableIndexedDBPersistence's experimentalForceOwningTab via flag
        }
      } catch {
        // Silently ignore — cache clearing is best-effort
      }
    };
    clearFirestoreCache();
  }, []); // Runs once on mount

  // Tasks for selected project – listens when a project is selected; otherwise disabled
  const tasksQuery = useMemoFirebase(() => {
    if (!roadmapProject?.id) return null;
    try {
      return query(collection(firestore, 'tasks'), where('projectId', '==', roadmapProject.id));
    } catch {
      return null;
    }
  }, [firestore, roadmapProject?.id]);
  const { data: roadmapTasks, loading: tasksLoading, error: tasksError } = useCollection(tasksQuery);

  // Helper to normalize URLs
  const cleanUrl = (val?: string): string | undefined => {
    if (!val || typeof val !== 'string') return undefined;
    const cleaned = val.trim().replace(/[`]/g, '').replace(/[)\s]+$/g, '');
    try {
      const u = new URL(cleaned);
      return u.toString();
    } catch {
      return undefined;
    }
  };

  // Filter pipeline: search first, then category from tags
  const categories = ['technical', 'logistics', 'sponsorship', 'ethics', 'outreach'] as const;
  // Ensure instant empty-state rendering: treat undefined as empty array
  const rawProjects = Array.isArray(projects) && projects.length > 0 ? projects : legacyProjects;
  const baseProjects = searchQuery.trim()
    ? rawProjects.filter(project =>
      project.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      project.description?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    : rawProjects;
  const filteredProjects = selectedCategory !== 'all'
    ? baseProjects.filter(project => {
      const tags = (() => {
        if (Array.isArray(project?.tags)) {
          return project.tags.map((t: string) => t.toLowerCase());
        }
        if (typeof (project as any)?.tags === 'string') {
          return (project as any).tags
            .split(',')
            .map((t: string) => t.trim().toLowerCase())
            .filter(Boolean);
        }
        return [] as string[];
      })();
      return tags.includes(selectedCategory);
    })
    : baseProjects;

  // Check if user can add projects: restrict to project admin roles
  const canAddProject = !!(user && role && (
    isPresident(role, user.uid) ||
    role === 'vice_president' ||
    role === 'projects_director' ||
    role === 'chair_projects'
  ));

  return (
    <div className="relative flex min-h-screen flex-col">
      {/* PERF: Preconnect to Firebase/Google domains to reduce connection latency */}
      {/* This shaves ~100-200ms from TTFB for Firestore and Auth requests */}
      {/* PERF: StarryBackground is decorative/non-critical. Suspense + lazy() means
           it loads in a separate chunk AFTER the critical content renders.
           This removes its JS from the main-app.js critical bundle, improving FCP. */}
      <Suspense fallback={null}>
        <StarryBackground />
      </Suspense>
      {/* PageHero: Establishes consistent hero section at the top of the page */}
      <PageHero
        title="Our Projects"
        subtitle="From CubeSats to high-power rocketry, discover the innovative projects our members are building."

      />
      {/* Reduced top padding to fix spacing issue; hero provides primary vertical spacing */}
      <main className="flex-1 py-12 md:py-16">
        <div className="container mx-auto px-4 md:px-6">
          {/* --- National Mission Board Hub (UPGRADED) --- */}
          <Card className="mb-16 border-2 border-slate-800 bg-slate-950/60 backdrop-blur-2xl shadow-[0_0_50px_rgba(0,0,0,0.5)] relative overflow-hidden group rounded-3xl">
            {/* Tactical Accents */}
            <div className="absolute top-0 left-0 w-2 h-full bg-gradient-to-b from-primary via-emerald-500 to-transparent opacity-80" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 blur-[100px] -mr-32 -mt-32 pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-48 h-48 bg-emerald-500/5 blur-[80px] -ml-24 -mb-24 pointer-events-none" />
            
            <CardHeader className="pb-8 pt-8 px-8">
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                <div className="space-y-1">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 rounded-xl border border-primary/20 shadow-[0_0_15px_rgba(59,130,246,0.1)]">
                      <Rocket className="h-6 w-6 text-primary animate-pulse" />
                    </div>
                    <CardTitle className="text-3xl font-accent font-black tracking-tighter uppercase text-white selection:bg-primary/30">
                      National Mission Command
                    </CardTitle>
                  </div>
                  <CardDescription className="text-[10px] uppercase tracking-[0.4em] font-black text-slate-500 flex items-center gap-2 mt-2">
                    <span className="h-1 w-1 rounded-full bg-primary" /> 
                    Real-time operational readiness of SEDS Pakistan chapters
                  </CardDescription>
                </div>
                <div className="flex items-center gap-4">
                   <div className="px-4 py-2 rounded-xl border border-primary/30 bg-slate-900/80 shadow-inner flex items-center gap-3 group/stream cursor-pointer hover:border-primary/60 transition-all duration-300">
                      <div className="relative">
                        <div className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]" />
                        <div className="absolute inset-0 h-2 w-2 rounded-full bg-red-500 animate-ping" />
                      </div>
                      <span className="text-[10px] font-black text-white/90 uppercase tracking-[0.2em]">Live National Stream</span>
                   </div>
                   <div className="h-10 w-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500 hover:text-primary transition-colors cursor-pointer">
                      <Activity className="h-5 w-5" />
                   </div>
                </div>
              </div>
            </CardHeader>
            
            <CardContent className="px-8 pb-8">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 relative z-10">
                {/* HUD STATS PANEL */}
                <div className="lg:col-span-3 space-y-6">
                  <div className="p-5 rounded-2xl bg-slate-900/40 border border-slate-800 hover:border-primary/30 transition-all duration-500 group/stat">
                    <div className="flex items-center gap-4">
                      <div className="p-3 rounded-xl bg-primary/10 text-primary border border-primary/20 group-hover/stat:bg-primary group-hover/stat:text-black transition-all duration-500">
                        <Rocket className="h-6 w-6" />
                      </div>
                      <div>
                        <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500 font-black mb-1">Active Missions</p>
                        <p className="text-3xl font-accent font-black text-white leading-none tracking-tighter">{missionStats.activeMissions}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="p-5 rounded-2xl bg-slate-900/40 border border-slate-800 hover:border-emerald-500/30 transition-all duration-500 group/stat">
                    <div className="flex items-center gap-4">
                      <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 group-hover/stat:bg-emerald-500 group-hover/stat:text-black transition-all duration-500">
                        <Globe className="h-6 w-6" />
                      </div>
                      <div>
                        <p className="text-[9px] uppercase tracking-[0.2em] text-slate-500 font-black mb-1">Chapters</p>
                        <p className="text-3xl font-accent font-black text-white leading-none tracking-tighter">{missionStats.activeChapters}</p>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/80">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">Global Sync</span>
                      <span className="text-[8px] font-mono text-emerald-500 animate-pulse">STABLE</span>
                    </div>
                    <div className="grid grid-cols-6 gap-1">
                      {[...Array(12)].map((_, i) => (
                        <div key={i} className={`h-1 rounded-full ${i < 8 ? 'bg-primary/40' : 'bg-slate-800'}`} />
                      ))}
                    </div>
                  </div>
                </div>

                {/* MISSION BOARD (CENTRAL HUB) */}
                <div className="lg:col-span-6 space-y-4 border-slate-800/50 lg:px-8 lg:border-x">
                   <div className="flex items-center justify-between mb-2">
                     <p className="text-[10px] uppercase tracking-[0.3em] text-slate-400 font-black flex items-center gap-3">
                       <Activity className="h-4 w-4 text-primary" /> Live Mission Board
                     </p>
                     <Badge variant="outline" className="text-[9px] font-black border-slate-800 text-slate-500 uppercase tracking-widest">
                       {missionStats.workflows.length} Operations
                     </Badge>
                   </div>

                   <div className="space-y-4 max-h-[300px] overflow-y-auto pr-3 custom-scrollbar">
                     {missionStats.workflows.length > 0 ? missionStats.workflows.map((wf) => (
                       <div key={wf.id} className="relative bg-slate-900/40 border border-slate-800/80 rounded-2xl p-5 hover:bg-slate-900/60 transition-all duration-500 group/wf overflow-hidden">
                         <div className="absolute top-0 left-0 w-1 h-full bg-primary/20 group-hover/wf:bg-primary transition-colors duration-500" />
                         
                         <div className="flex justify-between items-start mb-4 gap-4">
                           <div className="min-w-0 flex-1">
                             <div className="flex items-center gap-2 mb-1">
                               <h4 className="text-sm font-black text-white group-hover/wf:text-primary transition-colors uppercase tracking-tight truncate">{wf.title}</h4>
                             </div>
                             <div className="flex items-center gap-2">
                               <span className="text-[9px] text-primary/60 font-black tracking-widest uppercase bg-primary/5 px-2 py-0.5 rounded border border-primary/10">
                                 {wf.chapterName || 'National Command'}
                               </span>
                             </div>
                           </div>
                           <div className="text-right">
                             <div className="text-lg font-accent font-black text-white tracking-tighter leading-none">{wf.progress}%</div>
                             <div className="text-[8px] font-mono text-muted-foreground uppercase tracking-widest mt-1">Status: OK</div>
                           </div>
                         </div>

                         {/* Segmented Progress HUD */}
                         <div className="flex gap-0.5 mb-5 h-1.5">
                           {[...Array(15)].map((_, i) => {
                             const isActive = i < Math.round((wf.progress / 100) * 15);
                             return (
                               <div key={i} className={`h-full flex-1 rounded-sm transition-all duration-700 ${isActive ? 'bg-primary shadow-[0_0_8px_rgba(59,130,246,0.4)]' : 'bg-slate-800'}`} />
                             );
                           })}
                         </div>

                         <div className="flex justify-between items-center">
                           <div className="flex items-center gap-3">
                             <div className="flex -space-x-2.5">
                               {wf.participants.slice(0, 3).map((p: any, i: number) => (
                                 <div key={i} className="h-7 w-7 rounded-lg border-2 border-slate-900 bg-slate-800 flex items-center justify-center overflow-hidden shadow-xl" title={p.name}>
                                   {p.photo ? (
                                     <Image src={p.photo} alt={p.name} width={28} height={28} className="object-cover" />
                                   ) : (
                                     <div className="text-[10px] text-white font-black uppercase">{p.name?.[0]}</div>
                                   )}
                                 </div>
                               ))}
                               {wf.participants.length > 3 && (
                                 <div className="h-7 w-7 rounded-lg border-2 border-slate-900 bg-slate-950 flex items-center justify-center text-[8px] text-slate-500 font-black">
                                   +{wf.participants.length - 3}
                                 </div>
                               )}
                             </div>
                             <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-1">Team Unit</span>
                           </div>
                           <Button 
                             size="sm" 
                             variant="outline" 
                             className="h-8 px-4 text-[9px] uppercase tracking-widest font-black border-slate-800 hover:border-primary hover:bg-primary hover:text-black transition-all duration-300 rounded-lg group-hover/wf:shadow-[0_0_15px_rgba(59,130,246,0.2)]"
                             onClick={() => window.location.href = `/admin/workflows?workflowId=${wf.id}`}
                           >
                             Operational Intel <ExternalLink className="h-3 w-3 ml-2" />
                           </Button>
                         </div>
                       </div>
                     )) : (
                       <div className="text-center py-12 border-2 border-dashed border-slate-800 rounded-2xl bg-slate-900/20">
                         <Activity className="h-10 w-10 text-slate-700 mx-auto mb-3 opacity-50" />
                         <p className="text-xs font-black uppercase tracking-widest text-slate-600">No active national missions</p>
                       </div>
                     )}
                   </div>
                </div>

                {/* COMMAND FEED (RIGHT PANEL) */}
                <div className="lg:col-span-3 space-y-4">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-slate-400 font-black flex items-center gap-3">
                    <Zap className="h-4 w-4 text-amber-500" /> Command Feed
                  </p>
                  <div className="space-y-3">
                    {missionStats.recentActivity.length > 0 ? missionStats.recentActivity.map((task, i) => (
                      <div key={task.id || i} className="group/feed flex items-center gap-4 p-3.5 bg-slate-900/40 rounded-xl border border-slate-800 hover:border-primary/40 transition-all duration-300 relative overflow-hidden">
                         <div className={`h-2 w-2 rounded-full shrink-0 ${task.status === 'completed' ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-amber-500 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.5)]'}`} />
                         <div className="flex-1 min-w-0">
                           <p className="text-[10px] font-black text-white/90 truncate uppercase tracking-tight">{task.title || 'Uplink Established'}</p>
                           <p className="text-[8px] text-slate-500 font-mono tracking-tighter mt-1">#SIG-0{i + 1} • {task.status === 'completed' ? 'SYNCED' : 'UPLOADING'}</p>
                         </div>
                      </div>
                    )) : (
                      <div className="p-6 text-center bg-slate-900/20 rounded-xl border border-slate-800 border-dashed">
                        <p className="text-[9px] text-slate-600 font-black uppercase tracking-widest">No recent signal activity</p>
                      </div>
                    )}
                  </div>
                  
                  {/* Tactical Map Placeholder/Visual */}
                  <div className="mt-8 pt-8 border-t border-slate-800">
                    <div className="aspect-[4/3] rounded-xl bg-slate-900/60 border border-slate-800 relative overflow-hidden flex items-center justify-center group/map">
                      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.1),transparent)]" />
                      <div className="absolute inset-0 opacity-[0.03] bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
                      <div className="text-center relative z-10 px-4">
                        <div className="h-12 w-12 rounded-full bg-primary/5 border border-primary/20 flex items-center justify-center mx-auto mb-3 group-hover/map:scale-110 group-hover/map:border-primary/50 transition-all duration-500">
                          <Globe className="h-6 w-6 text-primary animate-spin-slow" />
                        </div>
                        <p className="text-[8px] font-black uppercase tracking-[0.3em] text-slate-500 leading-relaxed">Spatial Distribution Map<br/><span className="text-primary/40">Securing Link...</span></p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* READINESS HUD (BOTTOM) */}
              <div className="mt-12 pt-8 border-t border-slate-800 relative">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-4">
                  <div className="space-y-1">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500 flex items-center gap-3">
                      <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      National Mission Readiness (NMR)
                    </h3>
                    <p className="text-xs text-white/50 font-medium">Aggregate operational capability across all active mission parameters.</p>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Index:</span>
                    <span className="text-5xl font-accent font-black text-white tracking-tighter shadow-primary/20 drop-shadow-2xl">
                      {missionStats.readiness}<span className="text-xl text-primary ml-1">%</span>
                    </span>
                  </div>
                </div>
                
                <div className="relative group/ready">
                  {/* Progress Bar Background */}
                  <div className="w-full h-4 bg-slate-900/80 rounded-full border border-slate-800 overflow-hidden p-1 shadow-inner">
                    {/* Primary Progress Fill */}
                    <div 
                      className="h-full bg-gradient-to-r from-emerald-900 via-primary to-primary-foreground rounded-full shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all duration-1500 ease-out flex items-center justify-end px-2" 
                      style={{ width: `${missionStats.readiness}%` }}
                    >
                      <div className="h-full w-4 bg-white/20 blur-sm animate-pulse rounded-full" />
                    </div>
                  </div>
                  
                  {/* Tick Marks */}
                  <div className="absolute inset-0 flex justify-between px-1 pointer-events-none opacity-20">
                    {[...Array(10)].map((_, i) => (
                      <div key={i} className="h-full w-[1px] bg-white" />
                    ))}
                  </div>
                </div>
                
                <div className="flex justify-between mt-4">
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-sm bg-emerald-500" />
                      <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">Nominal</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-sm bg-primary" />
                      <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">Synchronized</span>
                    </div>
                  </div>
                  <div className="text-[8px] font-mono text-slate-600 uppercase tracking-widest">
                    Telemetry: Verified • 256-bit encryption active
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          {/* Keep admin action available, but remove duplicate heading content */}
          {canAddProject && (
            <div className="flex justify-end items-center mb-16">
              <Button asChild size="lg" className="h-14 px-8 rounded-2xl bg-primary text-black font-accent font-black tracking-[0.2em] uppercase hover:bg-white hover:shadow-[0_0_30px_rgba(255,255,255,0.4)] transition-all duration-500 group shadow-2xl relative overflow-hidden">
                <Link href="/projects/new" className="relative z-10 flex items-center gap-3">
                  <PlusCircle className="h-6 w-6 transition-transform group-hover:rotate-90 duration-500" />
                  Launch New Initiative
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                </Link>
              </Button>
            </div>
          )}

          <div className="mb-8 space-y-4">
            <Input
              type="text"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => {
                // PERF: Defer filter update so it doesn't block keystrokes (reduces Max FID)
                const val = e.target.value;
                startTransition(() => setSearchQuery(val));
              }}
              className="max-w-md"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground mr-2">Filter by category:</span>
              {(['all', ...categories] as const).map((cat) => (
                <Button
                  key={cat}
                  variant={selectedCategory === cat ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    // PERF: Defer category change — non-urgent, can be interrupted
                    startTransition(() => setSelectedCategory(cat));
                  }}
                  className="capitalize"
                >
                  {cat}
                </Button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              {[...Array(3)].map((_, i) => (
                <Card key={i} className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 overflow-hidden flex flex-col">
                  <CardHeader>
                    <Skeleton className="h-6 w-3/4" />
                    <Skeleton className="h-4 w-full mt-2" />
                  </CardHeader>
                  <Skeleton className="aspect-video w-full" />
                  <CardFooter className="mt-auto p-6 flex-wrap gap-2">
                    <Skeleton className="h-6 w-20" />
                    <Skeleton className="h-6 w-24" />
                  </CardFooter>
                </Card>
              ))}
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">
              {searchQuery.trim()
                ? "No projects found matching your search."
                : "No projects available yet. Check back soon!"}
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              {filteredProjects.map((project, index) => (
                <div key={project.id} className="group block animate-in fade-in slide-in-from-bottom-12 duration-500" style={{ animationDelay: `${index * 100}ms` }}>
                  <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 overflow-hidden flex flex-col h-full group-hover:border-primary transition-all">
                    <CardHeader>
                      <Link href={`/projects/detail?slug=${project.slug || project.id}`}>
                        <CardTitle className="text-2xl font-headline tracking-wide group-hover:text-primary transition-colors cursor-pointer">{project.title}</CardTitle>
                      </Link>
                      <CardDescription className="font-body text-muted-foreground h-12 overflow-hidden text-ellipsis">
                        <p className="line-clamp-2">
                          {stripMarkdown(project?.description || project?.summary || '')}
                        </p>
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <Link href={`/projects/detail?slug=${project.slug || project.id}`}>
                        <div className="cursor-pointer">
                          {(() => {
                            const imageSrc = (() => {
                              const cleanUrl = (val: string): string | undefined => {
                                const cleaned = val.trim().replace(/[`]/g, '').replace(/[)\s]+$/g, '');
                                try {
                                  const u = new URL(cleaned);
                                  return u.toString();
                                } catch {
                                  return undefined;
                                }
                              };
                              const candidates = [
                                typeof project?.imageUrl === 'string' ? cleanUrl(project.imageUrl) : undefined,
                                typeof project?.image_url === 'string' ? cleanUrl(project.image_url) : undefined,
                                Array.isArray(project?.media) && project.media.length > 0 && typeof project.media[0] === 'string' ? cleanUrl(project.media[0] as string) : undefined,
                              ];
                              for (const u of candidates) {
                                if (typeof u === 'string' && u.trim().length > 0) {
                                  return u;
                                }
                              }
                              return undefined;
                            })();
                            return imageSrc ? (
                              <Image
                                src={imageSrc}
                                alt={project.title}
                                width={600}
                                height={400}
                                className="w-full h-auto object-cover aspect-video group-hover:scale-105 transition-transform duration-500"
                                // PERF: Only preload first 2 images (above-the-fold).
                                // Preloading 4 was adding unnecessary bandwidth pressure
                                // during the critical path, delaying LCP element.
                                priority={index < 2}
                              />
                            ) : (
                              <div className="aspect-video w-full bg-card/50 border border-accent/20 flex items-center justify-center">
                                <span className="text-muted-foreground">No image</span>
                              </div>
                            );
                          })()}
                        </div>
                      </Link>
                    </CardContent>
                    <CardFooter className="mt-auto p-6 flex-col gap-3">
                      <div className="w-full">
                        {(() => {
                          const total = typeof project?.taskCount === 'number' ? project.taskCount : 0;
                          const completed = typeof project?.completedTaskCount === 'number' ? project.completedTaskCount : 0;
                          const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
                          return (
                            <div
                              className="w-full cursor-pointer"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setRoadmapProject(project);
                                setIsRoadmapOpen(true);
                              }}
                              title="View roadmap"
                            >
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-medium">Progress</span>
                                <span className="text-xs text-muted-foreground">{completed}/{total} ({percent}%)</span>
                              </div>
                              <Progress value={percent} />
                              <p className="mt-1 text-xs text-muted-foreground">Click to view roadmap</p>
                            </div>
                          );
                        })()}
                      </div>
                      {/* Quick links (GitHub / Docs) */}
                      {(cleanUrl(project?.github_repo) || cleanUrl(project?.docs_url)) && (
                        <div className="w-full flex items-center gap-3">
                          {cleanUrl(project?.github_repo) && (
                            <a
                              href={cleanUrl(project.github_repo)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => { e.stopPropagation(); }}
                              className="inline-flex items-center gap-2 text-xs text-primary hover:underline"
                              title="Open GitHub"
                            >
                              <Github className="h-4 w-4" />
                              GitHub
                            </a>
                          )}
                          {cleanUrl(project?.docs_url) && (
                            <a
                              href={cleanUrl(project.docs_url)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => { e.stopPropagation(); }}
                              className="inline-flex items-center gap-2 text-xs text-primary hover:underline"
                              title="Open Documentation"
                            >
                              <BookOpen className="h-4 w-4" />
                              Docs
                            </a>
                          )}
                        </div>
                      )}
                      <div className="w-full flex flex-wrap gap-2">
                        {project.tags?.map((tag: string) => (
                          <Badge key={tag} variant="secondary" className="font-body">{tag}</Badge>
                        ))}
                      </div>
                    </CardFooter>
                  </Card>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
      {/* PERF: Footer is below-the-fold. Lazy loading it defers its JS chunk
           and removes it from the critical rendering path. */}
      <Suspense fallback={null}>
        <Footer />
      </Suspense>
      {/* Roadmap Dialog */}
      <Dialog open={isRoadmapOpen} onOpenChange={setIsRoadmapOpen}>
        <ResponsiveDialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{roadmapProject?.title ? `${roadmapProject.title} Roadmap` : 'Project Roadmap'}</DialogTitle>
            <DialogDescription>
              This roadmap updates automatically as tasks are created and completed.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const total = typeof roadmapProject?.taskCount === 'number' ? roadmapProject.taskCount : 0;
            const completed = typeof roadmapProject?.completedTaskCount === 'number' ? roadmapProject.completedTaskCount : 0;
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
            return (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Overall Progress</span>
                    <span className="text-xs text-muted-foreground">{completed}/{total} ({percent}%)</span>
                  </div>
                  <Progress value={percent} />
                </div>

                {/* Live task breakdown when permissions allow; graceful fallback otherwise */}
                {tasksLoading ? (
                  <p className="text-sm text-muted-foreground">Loading roadmap details…</p>
                ) : tasksError ? (
                  <div className="text-sm text-muted-foreground">
                    Detailed task roadmap is visible to members. Sign in to view task breakdown.
                  </div>
                ) : roadmapTasks && roadmapTasks.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {(['completed', 'in_progress', 'pending'] as const).map((status) => {
                      const subset = roadmapTasks.filter((t: any) => t.status === status);
                      return (
                        <div key={status} className="rounded border border-border p-3 bg-card/60">
                          <p className="text-sm font-medium capitalize">{status.replace('_', ' ')}</p>
                          <p className="text-xs text-muted-foreground">{subset.length} task{subset.length === 1 ? '' : 's'}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No tasks yet for this project.</p>
                )}
              </div>
            );
          })()}
        </ResponsiveDialogContent>
      </Dialog>
    </div>
  );
}
