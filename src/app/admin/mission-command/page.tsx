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
import { Rocket, Globe, Activity, TerminalSquare, ChevronRight } from 'lucide-react';
import CountdownTimer from '@/components/ui/countdown-timer';

export default function MissionCommandPage() {
  const dispatch = useDispatch();
  const state = useSelector((s: RootState) => s.mission);
  const { isAuthorized } = useAuthorization('canAccessAdmin');
  const { user } = useUser();
  const [loading, setLoading] = useState(true);

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
    }, (err) => console.error("Mission stream error:", err));

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
    }, (err) => console.error("Log stream error:", err));

    // 3. Listen to Chapters
    const qChapters = query(collection(firestore, 'chapters'), where('isActive', '==', true));
    const unsubChapters = onSnapshot(qChapters, (snap) => {
      dispatch(setChapterCount(snap.size));
      setLoading(false);
    }, (err) => console.error("Chapter stream error:", err));

    return () => {
      unsubTasks();
      unsubLogs();
      unsubChapters();
    };
  }, [isAuthorized, user, dispatch]);

  if (!isAuthorized) return null;

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="min-h-screen bg-[#020617] text-[#F8FAFC] p-4 md:p-8 font-sans border-t-4 border-indigo-500/20 rounded-3xl">
        
        {/* Header Section */}
        <div className="flex flex-col md:flex-row justify-between items-start mb-12 gap-6">
          <div className="space-y-2">
            <h1 className="text-3xl md:text-5xl font-black uppercase tracking-tighter flex items-center gap-4">
              <Rocket className="h-8 w-8 md:h-10 md:w-10 text-orange-500" />
              NATIONAL MISSION COMMAND
            </h1>
            <p className="text-[10px] md:text-xs font-mono text-slate-500 uppercase tracking-widest pl-1 md:pl-14 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              REAL-TIME OPERATIONAL READINESS OF SEDS PAKISTAN CHAPTERS
            </p>
          </div>
          <div className="flex items-center gap-4 w-full md:w-auto">
             <button className="flex-1 md:flex-none flex items-center justify-center gap-3 border border-red-500/30 bg-red-500/10 px-6 py-3 rounded-full text-[10px] font-black uppercase tracking-widest text-red-500 shadow-[0_0_20px_rgba(239,68,68,0.15)] hover:bg-red-500/20 transition-all">
                <span className="h-2 w-2 rounded-full bg-red-500" /> LIVE NATIONAL STREAM
             </button>
             <div className="p-3 border border-slate-800 rounded-2xl bg-slate-900/50 shadow-xl"><Activity className="h-5 w-5 text-slate-400" /></div>
          </div>
        </div>

        {/* Tactical Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Column: Essential Metrics */}
          <div className="col-span-1 lg:col-span-3 space-y-6">
            <div className="relative overflow-hidden border border-slate-800 bg-[#0F172A] rounded-[2rem] p-8 shadow-2xl group">
               <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <Rocket className="h-16 w-16 text-orange-500" />
               </div>
               <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 mb-6">Active Missions</h3>
               <p className="text-6xl font-black text-white font-mono tracking-tighter">{state.activeMissions}</p>
               <div className="mt-4 flex items-center gap-2 text-[10px] font-bold text-[#22C55E] uppercase tracking-widest">
                  <Activity className="h-3 w-3" /> System Nominal
               </div>
            </div>

            <div className="relative overflow-hidden border border-slate-800 bg-[#0F172A] rounded-[2rem] p-8 shadow-2xl group">
               <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <Globe className="h-16 w-16 text-[#22C55E]" />
               </div>
               <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 mb-6">Chapters</h3>
               <p className="text-6xl font-black text-white font-mono tracking-tighter">{state.totalChapters}</p>
               <div className="mt-4 flex items-center gap-2 text-[10px] font-bold text-blue-400 uppercase tracking-widest">
                  <Globe className="h-3 w-3" /> Global Network
               </div>
            </div>

            <div className="border border-slate-800 bg-[#0F172A] rounded-[2rem] p-8 shadow-2xl">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500">Global Sync</h3>
                  <span className="text-[10px] text-[#22C55E] border border-[#22C55E]/30 px-2 py-0.5 rounded uppercase font-bold tracking-widest bg-[#22C55E]/5">Stable</span>
                </div>
                <div className="flex gap-1.5 h-2 w-full mb-4">
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className={`h-full flex-1 rounded-full transition-all duration-1000 ${i < (state.globalSyncLevel / 12.5) ? 'bg-orange-500 shadow-[0_0_8px_#f97316]' : 'bg-slate-800'}`} />
                  ))}
                </div>
                <p className="text-[9px] font-mono text-slate-600 uppercase tracking-widest">Cross-chapter synchronization: {state.globalSyncLevel}%</p>
            </div>
          </div>

          {/* Center Column: Live Mission Board */}
          <div className="col-span-1 lg:col-span-6 border border-slate-800 bg-[#0F172A] rounded-[2.5rem] p-8 md:p-10 relative overflow-hidden flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.5)]">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-slate-700/50 to-transparent" />
            
            <div className="flex justify-between items-center mb-10 pb-6 border-b border-slate-800/60">
               <h2 className="text-sm font-black uppercase tracking-[0.4em] flex items-center gap-4 text-slate-400">
                  <Activity className="h-5 w-5 text-orange-500 animate-pulse" /> LIVE MISSION BOARD
               </h2>
               <div className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-500 animate-ping" />
                  <span className="text-[10px] border border-slate-700 bg-slate-900 rounded-full px-4 py-1.5 font-mono text-white/80">{state.activeMissions} OPERATIONS</span>
               </div>
            </div>
            
            <div className="space-y-6 overflow-y-auto flex-1 max-h-[600px] pr-4 custom-scrollbar">
              {state.liveMissions.length === 0 ? (
                 <div className="flex flex-col items-center justify-center py-32 space-y-4 opacity-30">
                    <Activity className="h-12 w-12 text-slate-700" />
                    <p className="text-center text-slate-600 font-mono text-xs uppercase tracking-[0.3em]">No active telemetry detected.</p>
                 </div>
              ) : (
                state.liveMissions.map((mission) => (
                  <div key={mission.id} className="group border border-slate-800 bg-[#1E293B]/20 rounded-3xl p-6 hover:border-slate-600 hover:bg-[#1E293B]/30 transition-all duration-500">
                    <div className="flex justify-between items-start mb-6">
                       <div className="space-y-1">
                          <h4 className="text-base font-black uppercase tracking-tight text-white group-hover:text-orange-500 transition-colors">{mission.title}</h4>
                          <p className="text-[10px] font-mono text-slate-500 uppercase">UID: {mission.id.substring(0,12)}</p>
                       </div>
                       <div className="text-2xl font-black text-white font-mono flex flex-col items-end">
                          {mission.status === 'completed' ? '100%' : mission.status === 'submitted-for-review' ? '95%' : '0%'}
                          <span className="text-[8px] text-slate-500 uppercase tracking-widest">Completion</span>
                       </div>
                    </div>
                    
                    <div className="flex items-center gap-4 mb-6">
                       <span className="text-[9px] border border-orange-500/30 text-orange-500 bg-orange-500/10 px-3 py-1 rounded-lg font-black tracking-[0.2em] uppercase">NATIONAL DIRECTIVE</span>
                       <span className={`text-[9px] px-3 py-1 rounded-lg font-black tracking-[0.2em] uppercase ${mission.status === 'submitted-for-review' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'}`}>
                          STATUS: {mission.status.replace(/-/g, ' ')}
                       </span>
                    </div>

                    <div className="flex gap-1.5 h-1.5 w-full mb-6 bg-slate-900 rounded-full overflow-hidden p-0.5">
                       {[...Array(12)].map((_, i) => {
                          const isActive = mission.status === 'completed' || (mission.status === 'submitted-for-review' && i < 11) || i === 0;
                          return (
                            <div key={i} className={`h-full flex-1 rounded-sm transition-all duration-1000 ${isActive ? 'bg-orange-500/80' : 'bg-slate-800'}`} />
                          );
                       })}
                    </div>

                    <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                       <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2">
                             <div className="h-6 w-6 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[8px] text-slate-500">OP</div>
                             <span>Lead: {mission.assigneeId?.substring(0,8) || 'TBD'}</span>
                          </div>
                          <div className="border-l border-slate-800 h-4 mx-2" />
                          <CountdownTimer expiryDate={mission.deadline} className="border-none bg-transparent p-0" />
                       </div>
                       <button className="flex items-center gap-2 border border-slate-800 hover:border-slate-500 px-4 py-2 rounded-xl transition-all hover:bg-slate-800 group/btn">
                          OPERATIONAL INTEL <ChevronRight className="h-3 w-3 group-hover/btn:translate-x-1 transition-transform" />
                       </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Column: Command Feed & Diagnostics */}
          <div className="col-span-1 lg:col-span-3 space-y-6">
            <div className="border border-slate-800 bg-[#0F172A] rounded-[2rem] p-8 h-[450px] flex flex-col shadow-2xl">
              <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 flex items-center gap-3 mb-8">
                <TerminalSquare className="h-4 w-4 text-orange-500" /> COMMAND FEED
              </h3>
              <div className="overflow-y-auto flex-1 space-y-5 pr-2 custom-scrollbar">
                 {state.commandFeed.length === 0 ? (
                    <p className="text-[10px] font-mono text-slate-700 uppercase tracking-widest text-center mt-20">Awaiting data uplink...</p>
                 ) : (
                    state.commandFeed.map((log) => (
                      <div key={log.id} className="group border border-slate-800/50 bg-[#1E293B]/10 rounded-2xl p-4 relative hover:bg-[#1E293B]/20 transition-all border-l-4 border-l-orange-500/30 hover:border-l-orange-500">
                         <p className="text-[10px] font-black uppercase tracking-wider text-slate-200 mb-1 leading-tight group-hover:text-white transition-colors">{log.action}</p>
                         <div className="flex justify-between items-center mt-2">
                            <p className="text-[8px] font-mono text-slate-500 uppercase">{log.targetUidOrResource?.substring(0,15) || 'SYSTEM'}</p>
                            <p className="text-[8px] font-mono text-slate-600 uppercase">{formatDistanceToNowStrict(new Date(log.timestamp))} AGO</p>
                         </div>
                      </div>
                    ))
                 )}
              </div>
            </div>
            
            <div className="border border-slate-800 bg-[#0F172A] rounded-[2rem] p-8 h-[250px] flex flex-col items-center justify-center relative overflow-hidden group shadow-2xl">
               <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(59,130,246,0.1)_0%,transparent_70%)] group-hover:opacity-100 opacity-50 transition-opacity" />
               <Globe className="h-12 w-12 text-orange-500/40 mb-6 animate-[spin_20s_linear_infinite]" />
               <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-500">Spatial Distribution Map</p>
               <div className="mt-2 flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-[#22C55E] animate-pulse" />
                  <p className="text-[9px] font-mono text-slate-600 uppercase tracking-widest">Securing national link...</p>
               </div>
            </div>
          </div>

        </div>

        {/* Operational Readiness Footer */}
        <div className="mt-12 border-t border-slate-800/60 pt-10 pb-6">
           <div className="flex flex-col md:flex-row justify-between items-end mb-8 gap-6">
             <div className="space-y-2">
                <h4 className="text-sm font-black uppercase tracking-[0.4em] text-[#22C55E] flex items-center gap-3">
                   <span className="h-2 w-2 rounded-full bg-[#22C55E] shadow-[0_0_10px_#22C55E]" /> NATIONAL MISSION READINESS (NMR)
                </h4>
                <p className="text-[10px] text-slate-500 uppercase font-mono tracking-[0.2em] leading-relaxed max-w-xl">
                   AGGREGATE OPERATIONAL CAPABILITY ACROSS ALL ACTIVE MISSION PARAMETERS AND CHAPTER SYNC LEVELS.
                </p>
             </div>
             <div className="flex items-center gap-6 bg-slate-900/50 border border-slate-800 p-4 rounded-3xl shadow-xl">
               <span className="text-[10px] text-slate-500 uppercase font-black tracking-widest">READINESS INDEX:</span>
               <div className="text-4xl font-black text-white font-mono tracking-tighter">
                 {Math.round(state.readinessIndex)}<span className="text-orange-500 text-2xl ml-1">%</span>
               </div>
             </div>
           </div>
           
           {/* Futuristic Progress Bar */}
           <div className="relative h-6 bg-slate-950 border border-slate-800 rounded-xl w-full overflow-hidden mb-6 p-1">
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
           
           <div className="flex flex-col md:flex-row justify-between items-center text-[9px] font-black uppercase tracking-[0.3em] text-slate-600 gap-4">
             <div className="flex gap-8">
                <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#22C55E]" /> NOMINAL OPERATIONAL STATUS</span>
                <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-orange-500 shadow-[0_0_8px_#f97316]" /> SYNCHRONIZED TELEMETRY</span>
             </div>
             <div className="flex items-center gap-2 px-4 py-2 border border-slate-800/60 rounded-full bg-slate-900/30">
                <span>TELEMETRY: VERIFIED</span>
                <span className="text-slate-800">•</span>
                <span>256-BIT ENCRYPTION ACTIVE</span>
             </div>
           </div>
        </div>

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
