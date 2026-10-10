'use client';

import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store';
import { updateLiveMissions, updateCommandFeed, setChapterCount } from '@/store/slices/missionSlice';
import { collection, query, orderBy, limit, onSnapshot, where } from 'firebase/firestore';
import { firestore, useUser } from '@/firebase';
import { useAuthorization } from '@/hooks/use-authorization';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { formatDistanceToNowStrict } from 'date-fns';
import { Rocket, Globe, Activity, TerminalSquare, ChevronRight, AlertTriangle, X } from 'lucide-react';
import CountdownTimer from '@/components/ui/countdown-timer';
import MissionCommandSkeleton from './mission-command-skeleton';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ResponsiveDialogContent from '@/components/ui/responsive-dialog-content';
import { Button } from '@/components/ui/button';

export default function MissionCommandPage() {
  const dispatch = useDispatch();
  const state = useSelector((s: RootState) => s.mission);
  const { isAuthorized, isLoading: authLoading } = useAuthorization('canAccessAdmin');
  const { user } = useUser();
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [intelMission, setIntelMission] = useState<any>(null);

  const handleStreamError = (label: string) => (err: unknown) => {
    console.error(`${label} stream error:`, err);
    setStreamError('Live data stream interrupted. Showing the last received data. Check your connection and reload the page to re-establish the uplink.');
    // Never leave the page stuck on the loading screen if a stream fails.
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

    // 3. Listen to Chapters
    const qChapters = query(collection(firestore, 'chapters'), where('isActive', '==', true));
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

  // While auth resolves, show a centered loading screen instead of a blank page.
  if (authLoading || !isAuthorized) {
    return (
      <AuthorizationGate permission="canAccessAdmin">
        <div className="min-h-screen bg-[#020617] text-[#F8FAFC] flex items-center justify-center p-6 border-t-4 border-indigo-500/20 rounded-3xl">
          <div className="flex flex-col items-center text-center max-w-sm">
            <div className="h-12 w-12 rounded-full border-2 border-slate-700 border-t-orange-500 animate-spin mb-6" aria-hidden="true" />
            <p className="text-xs sm:text-sm font-black uppercase tracking-[0.3em] text-slate-300">Verifying access</p>
            <p className="mt-2 text-xs text-slate-500">Checking your clearance for Mission Command&hellip;</p>
          </div>
        </div>
      </AuthorizationGate>
    );
  }

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="min-h-screen bg-[#020617] text-[#F8FAFC] px-4 py-6 md:px-6 md:py-8 lg:px-8 font-sans border-t-4 border-indigo-500/20 rounded-3xl max-w-[1600px] mx-auto w-full">

        {/* Stream error banner: centered, readable, dismissible */}
        {streamError && (
          <div
            role="alert"
            className="mb-8 mx-auto max-w-2xl flex items-start gap-3 sm:gap-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-4 sm:px-6"
          >
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-400 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-xs sm:text-sm font-black uppercase tracking-[0.2em] text-red-300">Uplink interrupted</p>
              <p className="mt-1 text-xs sm:text-sm leading-relaxed text-red-200/80">{streamError}</p>
            </div>
            <button
              type="button"
              onClick={() => setStreamError(null)}
              aria-label="Dismiss error"
              className="shrink-0 rounded-lg p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center text-red-300/70 hover:text-red-200 hover:bg-red-500/20 transition-colors"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Header Section */}
        <div className="flex flex-col md:flex-row justify-between items-start mb-8 md:mb-12 gap-6">
          <div className="space-y-2">
            <h1 className="text-2xl sm:text-3xl md:text-5xl font-black uppercase tracking-tighter flex items-center gap-3 sm:gap-4">
              <Rocket className="h-7 w-7 sm:h-8 sm:w-8 md:h-10 md:w-10 text-orange-500 shrink-0" />
              <span className="min-w-0 break-words">NATIONAL MISSION COMMAND</span>
            </h1>
            <p className="text-[10px] sm:text-[11px] md:text-xs font-mono text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse shrink-0" />
              <span className="min-w-0">REAL-TIME OPERATIONAL READINESS OF SEDS PAKISTAN CHAPTERS</span>
            </p>
          </div>
          <div className="flex items-center gap-4 w-full md:w-auto">
             <button className="flex-1 md:flex-none min-h-[44px] flex items-center justify-center gap-3 border border-red-500/30 bg-red-500/10 px-6 py-3 rounded-full text-[10px] sm:text-xs font-black uppercase tracking-widest text-red-500 shadow-[0_0_20px_rgba(239,68,68,0.15)] hover:bg-red-500/20 transition-all">
                <span className="h-2 w-2 rounded-full bg-red-500" /> LIVE NATIONAL STREAM
             </button>
             <div className="p-3 border border-slate-800 rounded-2xl bg-card/50 shadow-xl"><Activity className="h-5 w-5 text-muted-foreground" /></div>
          </div>
        </div>

        {loading ? (
          <MissionCommandSkeleton />
        ) : (
          <>
        {/* Tactical Grid: 1 col on mobile, 2 cols on tablet, 12-col 3/6/3 split on xl+ (lg is too narrow with sidebar open) */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-6 md:gap-8">
          
          {/* Left Column: Essential Metrics — full-width 3-card row on tablet/laptop, stacked rail on xl+ */}
          <div className="md:col-span-2 xl:col-span-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-1 gap-6">
            <div className="relative overflow-hidden border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 shadow-2xl group">
               <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <Rocket className="h-16 w-16 text-orange-500" />
               </div>
               <h3 className="text-[10px] sm:text-xs font-black uppercase tracking-[0.3em] text-muted-foreground mb-6">Active Missions</h3>
               <p className="text-3xl sm:text-5xl md:text-6xl font-black text-foreground font-mono tracking-tighter">{state.activeMissions}</p>
               <div className="mt-4 flex items-center gap-2 text-[10px] sm:text-xs font-bold text-[#22C55E] uppercase tracking-widest">
                  <Activity className="h-3 w-3" /> System Nominal
               </div>
            </div>

            <div className="relative overflow-hidden border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 shadow-2xl group">
               <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <Globe className="h-16 w-16 text-[#22C55E]" />
               </div>
               <h3 className="text-[10px] sm:text-xs font-black uppercase tracking-[0.3em] text-muted-foreground mb-6">Chapters</h3>
               <p className="text-3xl sm:text-5xl md:text-6xl font-black text-foreground font-mono tracking-tighter">{state.totalChapters}</p>
               <div className="mt-4 flex items-center gap-2 text-[10px] sm:text-xs font-bold text-blue-400 uppercase tracking-widest">
                  <Globe className="h-3 w-3" /> Global Network
               </div>
            </div>

            <div className="border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 shadow-2xl">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-[10px] sm:text-xs font-black uppercase tracking-[0.3em] text-muted-foreground">Global Sync</h3>
                  <span className="text-[10px] sm:text-xs text-[#22C55E] border border-[#22C55E]/30 px-2 py-0.5 rounded uppercase font-bold tracking-widest bg-[#22C55E]/5">Stable</span>
                </div>
                <div className="flex gap-1.5 h-2 w-full mb-4">
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className={`h-full flex-1 rounded-full transition-all duration-1000 ${i < (state.globalSyncLevel / 12.5) ? 'bg-orange-500 shadow-[0_0_8px_#f97316]' : 'bg-muted'}`} />
                  ))}
                </div>
                <p className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">Cross-chapter synchronization: {state.globalSyncLevel}%</p>
            </div>
            </div>
          </div>

          {/* Center Column: Live Mission Board */}
          <div className="md:col-span-1 xl:col-span-6 border border-slate-800 bg-[#0F172A] rounded-[2.5rem] p-5 sm:p-8 md:p-10 relative overflow-hidden flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.5)] min-w-0">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-slate-700/50 to-transparent" />
            
            <div className="flex flex-wrap justify-between items-center gap-4 mb-6 md:mb-10 pb-6 border-b border-slate-800/60">
               <h2 className="text-xs sm:text-sm font-black uppercase tracking-[0.2em] md:tracking-[0.4em] flex items-center gap-4 text-muted-foreground">
                  <Activity className="h-5 w-5 shrink-0 text-orange-500 animate-pulse" /> LIVE MISSION BOARD
               </h2>
               <div className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-500 animate-ping" />
                  <span className="text-[10px] sm:text-xs border border-slate-700 bg-card rounded-full px-4 py-1.5 font-mono text-foreground/80 whitespace-nowrap">{state.activeMissions} OPERATIONS</span>
               </div>
            </div>
            
            <div className="space-y-4 md:space-y-6 overflow-y-auto flex-1 max-h-[480px] sm:max-h-[600px] pr-4 custom-scrollbar">
              {state.liveMissions.length === 0 ? (
                 <div className="flex flex-col items-center justify-center flex-1 min-h-[280px] sm:min-h-[360px] px-6 py-12 text-center">
                    <div className="rounded-full border border-slate-800 bg-slate-900/60 p-5 sm:p-6 mb-5">
                      <Activity className="h-9 w-9 sm:h-12 sm:w-12 text-slate-500" aria-hidden="true" />
                    </div>
                    <p className="text-sm sm:text-base font-black uppercase tracking-[0.2em] text-slate-300">No active missions</p>
                    <p className="mt-2 max-w-xs text-xs sm:text-sm leading-relaxed text-slate-500">
                      No live telemetry detected. Missions in pending, in-progress, or under review will appear here.
                    </p>
                 </div>
              ) : (
                state.liveMissions.map((mission) => (
                  <div key={mission.id} className="group border border-slate-800 bg-[#1E293B]/20 rounded-3xl p-4 sm:p-6 hover:border-slate-600 hover:bg-[#1E293B]/30 transition-all duration-500">
                    <div className="flex justify-between items-start gap-3 mb-4 md:mb-6">
                       <div className="space-y-1 min-w-0">
                          <h4 className="text-sm sm:text-base font-black uppercase tracking-tight text-foreground group-hover:text-orange-500 transition-colors break-words">{mission.title}</h4>
                          <p className="text-[10px] sm:text-[11px] font-mono text-muted-foreground uppercase break-words">UID: {mission.id.substring(0,12)}</p>
                       </div>
                       <div className="text-xl sm:text-2xl font-black text-foreground font-mono flex flex-col items-end shrink-0">
                          {mission.status === 'completed' ? '100%' : mission.status === 'submitted-for-review' ? '95%' : '0%'}
                          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Completion</span>
                       </div>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-4 md:mb-6">
                       <span className="text-[10px] border border-orange-500/30 text-orange-500 bg-orange-500/10 px-3 py-1 rounded-lg font-black tracking-[0.2em] uppercase">NATIONAL DIRECTIVE</span>
                       <span className={`text-[10px] px-3 py-1 rounded-lg font-black tracking-[0.2em] uppercase ${mission.status === 'submitted-for-review' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30' : 'bg-muted text-muted-foreground border border-slate-700'}`}>
                          STATUS: {mission.status.replace(/-/g, ' ')}
                       </span>
                    </div>

                    <div className="flex gap-1.5 h-1.5 w-full mb-4 md:mb-6 bg-card rounded-full overflow-hidden p-0.5">
                       {[...Array(12)].map((_, i) => {
                          const isActive = mission.status === 'completed' || (mission.status === 'submitted-for-review' && i < 11) || i === 0;
                          return (
                            <div key={i} className={`h-full flex-1 rounded-sm transition-all duration-1000 ${isActive ? 'bg-orange-500/80' : 'bg-muted'}`} />
                          );
                       })}
                    </div>

                    <div className="flex flex-wrap justify-between items-center gap-3 text-[10px] sm:text-xs font-black uppercase tracking-widest text-muted-foreground">
                       <div className="flex flex-wrap items-center gap-3 md:gap-4 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                             <div className="h-6 w-6 shrink-0 rounded-full bg-muted border border-slate-700 flex items-center justify-center text-[10px] text-muted-foreground">OP</div>
                             <span className="truncate">Lead: {mission.assigneeId?.substring(0,8) || 'TBD'}</span>
                          </div>
                          <div className="border-l border-slate-800 h-4 mx-2 hidden sm:block" />
                          <CountdownTimer expiryDate={mission.deadline} className="border-none bg-transparent p-0" />
                       </div>
                       <button className="flex items-center justify-center gap-2 border border-slate-800 hover:border-slate-500 px-4 py-3 min-h-[44px] w-full sm:w-auto rounded-xl transition-all hover:bg-muted group/btn shrink-0">
                          OPERATIONAL INTEL <ChevronRight className="h-3 w-3 group-hover/btn:translate-x-1 transition-transform" />
                       </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Column: Command Feed & Diagnostics */}
          <div className="md:col-span-1 xl:col-span-3 space-y-6 min-w-0">
            <div className="border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 min-h-[380px] sm:min-h-[450px] flex flex-col shadow-2xl">
              <h3 className="text-[10px] sm:text-xs font-black uppercase tracking-[0.3em] text-muted-foreground flex items-center gap-3 mb-5 md:mb-8">
                <TerminalSquare className="h-4 w-4 text-orange-500" /> COMMAND FEED
              </h3>
              <div className="overflow-y-auto flex-1 space-y-4 md:space-y-5 pr-2 custom-scrollbar">
                 {state.commandFeed.length === 0 ? (
                    <div className="flex flex-col items-center justify-center flex-1 min-h-[200px] px-6 py-10 text-center">
                      <TerminalSquare className="h-8 w-8 sm:h-10 sm:w-10 text-slate-600 mb-4" aria-hidden="true" />
                      <p className="text-xs sm:text-sm font-black uppercase tracking-[0.2em] text-slate-400">Awaiting data uplink</p>
                      <p className="mt-2 max-w-[220px] text-[11px] sm:text-xs leading-relaxed text-slate-600">
                        Command feed entries will stream here in real time.
                      </p>
                    </div>
                 ) : (
                    state.commandFeed.map((log) => (
                      <div key={log.id} className="group border border-slate-800/50 bg-[#1E293B]/10 rounded-2xl p-4 relative hover:bg-[#1E293B]/20 transition-all border-l-4 border-l-orange-500/30 hover:border-l-orange-500">
                         <p className="text-[10px] sm:text-xs font-black uppercase tracking-wider text-foreground mb-1 leading-tight group-hover:text-foreground transition-colors">{log.action}</p>
                         <div className="flex justify-between items-center mt-2">
                            <p className="text-[10px] font-mono text-muted-foreground uppercase">{log.targetUidOrResource?.substring(0,15) || 'SYSTEM'}</p>
                            <p className="text-[10px] font-mono text-slate-600 uppercase">{formatDistanceToNowStrict(new Date(log.timestamp))} AGO</p>
                         </div>
                      </div>
                    ))
                 )}
              </div>
            </div>
            
            <div className="border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 min-h-[250px] flex flex-col items-center justify-center relative overflow-hidden group shadow-2xl">
               <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(59,130,246,0.1)_0%,transparent_70%)] group-hover:opacity-100 opacity-50 transition-opacity" />
               <Globe className="h-12 w-12 text-orange-500/40 mb-4 md:mb-6 animate-[spin_20s_linear_infinite]" />
               <p className="text-[10px] sm:text-xs font-black uppercase tracking-[0.2em] md:tracking-[0.4em] text-muted-foreground text-center px-2">Spatial Distribution Map</p>
               <div className="mt-2 flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-[#22C55E] animate-pulse" />
                  <p className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">Securing national link...</p>
               </div>
            </div>
          </div>

        </div>

        {/* Operational Readiness Footer */}
        <div className="mt-8 md:mt-12 border-t border-slate-800/60 pt-6 md:pt-10 pb-6">
           <div className="flex flex-col md:flex-row justify-between items-stretch md:items-end mb-6 md:mb-8 gap-6">
             <div className="space-y-2">
                <h4 className="text-xs sm:text-sm font-black uppercase tracking-[0.2em] md:tracking-[0.4em] text-[#22C55E] flex items-center gap-3 break-words">
                   <span className="h-2 w-2 rounded-full bg-[#22C55E] shadow-[0_0_10px_#22C55E]" /> NATIONAL MISSION READINESS (NMR)
                </h4>
                <p className="text-[10px] sm:text-xs text-muted-foreground uppercase font-mono tracking-[0.2em] leading-relaxed max-w-xl">
                   AGGREGATE OPERATIONAL CAPABILITY ACROSS ALL ACTIVE MISSION PARAMETERS AND CHAPTER SYNC LEVELS.
                </p>
             </div>
             <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-card/50 border border-slate-800 p-3 md:p-4 rounded-3xl shadow-xl">
               <span className="text-[10px] sm:text-xs text-muted-foreground uppercase font-black tracking-widest">READINESS INDEX:</span>
               <div className="text-3xl sm:text-4xl font-black text-foreground font-mono tracking-tighter">
                 {Math.round(state.readinessIndex)}<span className="text-orange-500 text-xl sm:text-2xl ml-1">%</span>
               </div>
             </div>
           </div>
           
           {/* Futuristic Progress Bar */}
           <div className="relative h-6 bg-slate-950 border border-slate-800 rounded-xl w-full overflow-hidden mb-4 md:mb-6 p-1">
              <div className="absolute inset-0 flex">
                 {[...Array(12)].map((_, i) => (
                    <div key={i} className="flex-1 border-r border-slate-800/40 last:border-0" />
                 ))}
              </div>
              <div 
                className="relative h-full bg-gradient-to-r from-orange-600 via-orange-500 to-orange-400 rounded-lg shadow-[0_0_20px_rgba(249,115,22,0.4)] transition-all duration-[2000ms] ease-out"
                style={{ width: `${state.readinessIndex}%` }}
              >
                 <div className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.1)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.1)_50%,rgba(255,255,255,0.1)_75%,transparent_75%,transparent)] bg-[length:20px_20px] animate-[progress-stripe_2s_linear_infinite]" />
              </div>
           </div>
           
           <div className="flex flex-col md:flex-row justify-between items-center text-[10px] font-black uppercase tracking-[0.3em] text-slate-600 gap-4">
             <div className="flex flex-wrap justify-center gap-4 md:gap-8">
                <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#22C55E]" /> NOMINAL OPERATIONAL STATUS</span>
                <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-orange-500 shadow-[0_0_8px_#f97316]" /> SYNCHRONIZED TELEMETRY</span>
             </div>
             <div className="flex flex-wrap items-center justify-center text-center gap-2 px-4 py-2 border border-slate-800/60 rounded-full bg-card/30">
                <span>TELEMETRY: VERIFIED</span>
                <span className="text-slate-800">•</span>
                <span>256-BIT ENCRYPTION ACTIVE</span>
             </div>
           </div>
        </div>
          </>
        )}

        <style jsx>{`
          .custom-scrollbar::-webkit-scrollbar {
            width: 4px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
            background: rgba(2, 6, 23, 0.5);
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(30, 41, 59, 0.8);
            border-radius: 10px;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: rgba(59, 130, 246, 0.3);
          }
          @keyframes progress-stripe {
            from { background-position: 0 0; }
            to { background-position: 40px 0; }
          }
        `}</style>

      </div>
    </AuthorizationGate>
  );
}
