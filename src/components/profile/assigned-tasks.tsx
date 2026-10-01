'use client';

import Link from 'next/link';
import { useMemo, useState, useEffect, memo } from 'react';
import { collection, query, where, limit, getDocs, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { useUserContext } from '@/firebase/user-provider';
import { firestore } from '@/firebase/core';
import { useFirestore, useCollection } from '@/firebase';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { useAuthorization } from '@/hooks/use-authorization';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ClipboardList, ChevronDown, ChevronUp, ChevronRight, AlertCircle, Clock, CheckCircle2, Target, Zap, Timer, AlertTriangle, RefreshCw, Users, ExternalLink, Filter, LayoutGrid, List, Pencil, MessageSquare, Github, Phone, Mail, Activity as ActivityIcon } from 'lucide-react';
import { differenceInHours, isPast, format } from 'date-fns';
import CountdownTimer from '@/components/ui/countdown-timer';
import { Badge } from '@/components/ui/badge';
import { StatusBadge, getStatusConfig } from '@/components/ui/status-badge';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';
import dynamic from 'next/dynamic';
import ErrorBoundary from '@/components/error-boundary';
import { TaskDetailDialog } from './task-detail-dialog';
import { WorkflowTeamContext } from './workflow-team-context';

const DynamicChat = dynamic(() => import('@/components/workflow/enhanced-workflow-chat'), { ssr: false, loading: () => <Skeleton className="h-96 w-full rounded-2xl" /> });

// ==========================================
// UTILS & HELPERS
// ==========================================
const safeDate = (d: any) => {
  if (!d) return null;
  try {
    if (d?.toDate && typeof d.toDate === 'function') return d.toDate();
    if (d && typeof d === 'object') {
      if (typeof d.seconds === 'number') return new Date(d.seconds * 1000);
      if (typeof d._seconds === 'number') return new Date(d._seconds * 1000); // Admin SDK serialized Timestamp
    }
    const date = new Date(d);
    return isNaN(date.getTime()) ? null : date;
  } catch { return null; }
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'completed': return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case 'in-progress': return <Clock className="h-5 w-5 text-blue-500" />;
    case 'submitted-for-review': return <AlertCircle className="h-5 w-5 text-yellow-500" />;
    default: return <Target className="h-5 w-5 text-orange-600" />;
  }
};

// ==========================================
// WORKFLOW STEPS LIST (Shared Context)
// ==========================================
const WorkflowStepsList = ({ steps, names, currentTaskId, currentUserId }: any) => {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between px-2">
          <h4 className="text-[11px] font-black uppercase tracking-[0.4em] text-indigo-400 flex items-center gap-3">
            <List className="h-4 w-4" /> Operational Mission Sequence
          </h4>
          <Badge variant="outline" className="text-xs font-mono border-indigo-500/20 text-indigo-400 uppercase h-6 px-3">
            {steps.length} Phases
          </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {steps.map((step: any, idx: number) => {
          const isCurrent = step.id === currentTaskId;
          const isDone = step.status === 'completed';
          const assignee = names[step.assigneeId] || { 
            name: step.assigneeName, 
            whatsapp: step.assigneeWhatsapp, 
            email: step.assigneeEmail,
            role: step.assigneeRole 
          };
          
          return (
            <div key={step.id} className={`group/step relative rounded-2xl border-2 transition-all duration-500 ${isCurrent ? 'border-primary bg-primary/5 shadow-2xl shadow-primary/5' : 'border-slate-800/60 bg-slate-900/30'}`}>
              <div className="p-5 flex items-center gap-6">
                <div className={`flex-shrink-0 h-12 w-12 rounded-xl flex items-center justify-center text-sm font-black shadow-lg ${isDone ? 'bg-emerald-500 text-black' : isCurrent ? 'bg-primary text-black scale-110' : 'bg-slate-800 text-slate-500'}`}>
                  {isDone ? '✓' : String(idx + 1).padStart(2, '0')}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-3 mb-1.5">
                    <p className={`font-black uppercase text-sm sm:text-base leading-tight tracking-tight ${isCurrent ? 'text-primary' : isDone ? 'text-emerald-400' : 'text-white/80'}`}>
                        {step.title}
                    </p>
                    {isCurrent && <Badge className="bg-primary text-black text-[9px] h-4.5 px-2 font-black animate-pulse">ACTIVE</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                    <span className="flex items-center gap-2 text-white bg-slate-800 px-3 py-1 rounded-lg border border-white/5"><Users className="h-3 w-3 text-primary" /> {assignee.name || 'Pending Assignment'}</span>
                    <span className="flex items-center gap-2 border border-slate-700 px-3 py-1 rounded-lg"><Clock className="h-3 w-3" /> {step.status}</span>
                  </div>
                </div>

                <div className="flex gap-2.5 shrink-0">
                    {(assignee.whatsapp || assignee.email) && (
                        <div className="flex items-center gap-2">
                            {assignee.whatsapp && (
                                <a href={`https://wa.me/${assignee.whatsapp.replace(/[^0-9]/g, '')}`} target="_blank" rel="noopener noreferrer" className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-black transition-all shadow-lg border border-emerald-500/20" onClick={e => e.stopPropagation()}>
                                    <Phone className="h-4 w-4" />
                                </a>
                            )}
                            {assignee.email && (
                                <a href={`mailto:${assignee.email}`} className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-black transition-all shadow-lg border border-indigo-500/20" onClick={e => e.stopPropagation()}>
                                    <Mail className="h-4 w-4" />
                                </a>
                            )}
                        </div>
                    )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ==========================================
// TASK CARD COMPONENT
// ==========================================
function TaskCardImpl({ task, isOwner, isAdmin, currentUserId, onTaskUpdated, expandedTaskId, setExpandedTaskId, onOpenDetail }: any) {
  const isExpanded = expandedTaskId === task.id;
  const canEdit = isOwner || isAdmin;
  const isCompleted = task.status === 'completed';
  const isYourTurn = task.assigneeId === currentUserId && task.isCurrentStep && !isCompleted;
  const isOverdue = task.deadline && isPast(task.deadline) && !isCompleted;

  const [inlineStatus, setInlineStatus] = useState(task.status || 'pending');
  const [inlineReport, setInlineReport] = useState(task.report || '');
  const [inlineHours, setInlineHours] = useState(typeof task.hoursWorked === 'number' ? String(task.hoursWorked) : '0.0');
  const [isUpdating, setIsUpdating] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Workflow Data
  const [steps, setSteps] = useState<any[]>([]);
  const [names, setNames] = useState<Record<string, any>>({});
  const [loadingContext, setLoadingContext] = useState(false);

  useEffect(() => {
    setInlineStatus(task.status || 'pending');
    setInlineReport(task.report || '');
    setInlineHours(typeof task.hoursWorked === 'number' ? String(task.hoursWorked) : '0.0');
  }, [task]);

  // Unified Context Hydration
  useEffect(() => {
    if (!task.workflowId) return;
    const fetchContext = async () => {
      setLoadingContext(true);
      try {
        const { getAuth } = await import('firebase/auth');
        const user = getAuth().currentUser;
        const token = user ? await user.getIdToken() : null;
        if (!token) return;

        const res = await fetch(`/api/workflows?workflowId=${encodeURIComponent(task.workflowId)}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          setSteps(data.tasks || []);
          if (data.assigneeInfo) {
            setNames(data.assigneeInfo);
          } else if (data.assigneeNames) {
            const details: any = {};
            Object.keys(data.assigneeNames).forEach(uid => {
                details[uid] = { 
                    name: data.assigneeNames[uid],
                    photoURL: data.assigneePhotos?.[uid],
                    whatsapp: data.assigneeWhatsapps?.[uid],
                    email: data.assigneeEmails?.[uid],
                    role: data.assigneeRoles?.[uid]
                };
            });
            setNames(details);
          }
        }
      } catch (err) { console.warn('[TaskCard] Workflow fetch failed', err); } finally { setLoadingContext(false); }
    };
    fetchContext();
  }, [task.workflowId]);

  const teamMembers = useMemo(() => {
    return steps.map((s, idx) => ({
        uid: s.assigneeId,
        name: names[s.assigneeId]?.name || s.assigneeName || 'Unknown',
        photoURL: names[s.assigneeId]?.photoURL || s.assigneePhoto,
        role: names[s.assigneeId]?.role || s.assigneeRole,
        status: s.status,
        isCurrentStep: s.isCurrentStep,
        whatsapp: names[s.assigneeId]?.whatsapp || s.assigneeWhatsapp,
        email: names[s.assigneeId]?.email || s.assigneeEmail,
        sequenceIndex: s.sequenceIndex ?? idx
    }));
  }, [steps, names]);

  const handleQuickAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setIsUpdating(true);
      const { getAuth } = await import('firebase/auth');
      const token = await getAuth().currentUser?.getIdToken();
      await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, updates: { status: 'submitted-for-review', report: 'Objective reached. Direct Transmit.' } })
      });
      setIsSuccess(true);
      toast.success("Mission Success Transmitted!");
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      setTimeout(() => { setIsSuccess(false); setIsUpdating(false); onTaskUpdated(); }, 1500);
    } catch (err) { setIsUpdating(false); }
  };

  const handleFullUpdate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setIsUpdating(true);
      const { getAuth } = await import('firebase/auth');
      const token = await getAuth().currentUser?.getIdToken();
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          updates: { status: inlineStatus, report: inlineReport, hoursWorked: parseFloat(inlineHours) || undefined }
        })
      });
      if (!res.ok) throw new Error();
      setIsSuccess(true);
      toast.success("Operational Log Saved.");
      setTimeout(() => { setIsSuccess(false); setIsUpdating(false); onTaskUpdated(); }, 1500);
    } catch (err) { toast.error("Fail."); setIsUpdating(false); }
  };

  const currentOp = names[task.assigneeId] || { 
    name: task.assigneeName, 
    role: task.assigneeRole,
    whatsapp: task.assigneeWhatsapp,
    email: task.assigneeEmail,
    photoURL: task.assigneePhoto
  };

  const hasResources = (task.resources && task.resources.length > 0) || task.resourceLinks;
  const completedSteps = steps.filter(s => s.status === 'completed').length;
  const syncPercentage = steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : 0;

  return (
    <div className={`group relative overflow-hidden rounded-[2.5rem] border-2 transition-all duration-700 hover:bg-slate-900/90 backdrop-blur-2xl ${isYourTurn ? 'border-primary bg-primary/5 shadow-2xl shadow-primary/10' : isCompleted ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-slate-800 bg-slate-950/60'}`} onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}>
      
      {/* ── CARD HUD: Mission Timeline ── */}
      {task.workflowId && teamMembers.length > 0 && (
          <div className="border-b border-slate-800/40 bg-slate-900/40 px-8 py-6">
              <WorkflowTeamContext members={teamMembers} currentUserId={currentUserId} />
          </div>
      )}

      <div className="relative p-6 sm:p-10">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-8 lg:gap-12">
          <div className="flex-1 min-w-0 space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-start gap-6 sm:gap-8">
              <div className={`flex-shrink-0 h-16 w-16 sm:h-20 sm:w-20 rounded-3xl flex items-center justify-center border-2 transition-all duration-700 ${isYourTurn ? 'bg-primary text-black border-primary sm:scale-110 shadow-2xl shadow-primary/30' : isCompleted ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>
                {isCompleted ? <CheckCircle2 className="h-8 w-8 sm:h-10 sm:w-10" /> : isYourTurn ? <Zap className="h-8 w-8 sm:h-10 sm:w-10 fill-current" /> : getStatusIcon(task.status)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <Badge variant="outline" className="text-[10px] sm:text-xs font-black border-slate-800 bg-slate-950/80 text-primary/70 px-3 h-7 uppercase tracking-[0.2em] whitespace-nowrap overflow-hidden text-ellipsis">DIRECTIVE # {task.id.slice(0, 8)}</Badge>
                  <StatusBadge status={isOverdue ? 'overdue' : task.status} size="sm" variant="solid" className="font-black tracking-widest h-7 px-4 text-[10px] sm:text-xs whitespace-nowrap" />
                </div>
                <h3 className="text-2xl sm:text-3xl lg:text-4xl font-accent font-black tracking-tight text-white leading-tight group-hover:text-primary transition-colors pb-1 uppercase break-words">{task.title}</h3>
                
                {/* ── RESOURCE CHIPS ── */}
                {hasResources && (
                    <div className="flex flex-wrap gap-2 sm:gap-3 mt-4 sm:mt-6">
                        {Array.isArray(task.resources) ? task.resources.map((res: any, idx: number) => (
                            <a key={idx} href={res.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-primary/50 hover:bg-primary/10 transition-all text-[10px] sm:text-xs font-black uppercase tracking-widest text-slate-400 hover:text-primary" onClick={e => e.stopPropagation()}>
                                {res.type === 'drive' ? <LayoutGrid className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> : res.type === 'github' ? <Github className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> : <ExternalLink className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />} <span className="truncate max-w-[150px] sm:max-w-[200px]">{res.title}</span>
                            </a>
                        )) : task.resourceLinks?.split('\n').filter(Boolean).map((link: string, idx: number) => (
                            <a key={idx} href={link.startsWith('http') ? link : `https://${link}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-primary/50 text-[10px] sm:text-xs font-black uppercase tracking-widest text-primary hover:bg-primary/5 transition-all" onClick={e => e.stopPropagation()}>
                                <ExternalLink className="h-3 w-3 shrink-0" /> <span className="truncate">ATTACHMENT {idx + 1}</span>
                            </a>
                        ))}
                    </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6">
              <div className="bg-slate-950/60 border border-slate-800/80 p-4 sm:p-5 rounded-2xl shadow-inner min-w-0">
                <p className="text-[10px] sm:text-[11px] font-black text-muted-foreground/40 uppercase tracking-[0.2em] sm:tracking-[0.3em] mb-2 flex items-center gap-2 w-full truncate"><Timer className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> Operational Clock</p>
                <CountdownTimer expiryDate={task.deadline} className="border-none bg-transparent p-0 font-accent text-lg sm:text-xl tracking-tight text-white flex-wrap" />
              </div>
              <div className="bg-slate-950/60 border border-slate-800/80 p-4 sm:p-5 rounded-2xl shadow-inner min-w-0">
                <p className="text-[10px] sm:text-[11px] font-black text-muted-foreground/40 uppercase tracking-[0.2em] sm:tracking-[0.3em] mb-2 flex items-center gap-2 w-full truncate"><Target className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> Bounty Value</p>
                <p className="text-2xl sm:text-3xl font-accent font-black text-white truncate">{task.points} <span className="text-xs sm:text-sm text-primary/60 tracking-widest">PTS</span></p>
              </div>
              <div className="hidden sm:block bg-slate-950/60 border border-slate-800/80 p-4 sm:p-5 rounded-2xl shadow-inner min-w-0">
                <p className="text-[10px] sm:text-[11px] font-black text-muted-foreground/40 uppercase tracking-[0.2em] sm:tracking-[0.3em] mb-2 flex items-center gap-2 w-full truncate"><ActivityIcon className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> Mission Sync</p>
                <div className="flex items-center gap-3"><div className="flex-1 h-2 sm:h-3 bg-slate-900 rounded-full overflow-hidden border border-white/5"><div className="h-full bg-gradient-to-r from-primary to-emerald-400 shadow-[0_0_10px_rgba(59,130,246,0.3)]" style={{ width: `${syncPercentage}%` }} /></div><span className="text-xs sm:text-sm font-mono font-black text-white/80">{syncPercentage}%</span></div>
              </div>
            </div>
          </div>

          <div className="flex flex-row flex-wrap lg:flex-col items-center lg:items-end gap-3 sm:gap-4 shrink-0 w-full lg:w-auto mt-4 lg:mt-0">
            {isYourTurn && (
              <Button onClick={handleQuickAction} disabled={isUpdating} className="h-auto py-4 px-6 sm:py-5 sm:px-8 bg-primary text-black font-black uppercase tracking-[0.1em] sm:tracking-[0.2em] text-[10px] sm:text-xs hover:scale-105 transition-all shadow-xl shadow-primary/20 border-2 border-white/10 hover:bg-white flex flex-col items-center justify-center gap-1 w-full lg:w-auto text-center rounded-2xl max-w-sm">
                {isUpdating ? <RefreshCw className="h-5 w-5 sm:h-6 sm:w-6 animate-spin" /> : isSuccess ? <CheckCircle2 className="h-6 w-6 sm:h-8 sm:w-8" /> : <><span className="flex items-center gap-2">TRANSMIT SUCCESS <ChevronRight className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" /></span><span className="text-[9px] sm:text-[10px] opacity-60 font-mono tracking-normal lowercase">Finalize Mission Goal</span></>}
              </Button>
            )}
            <div className="flex gap-2 sm:gap-3 w-full lg:w-auto justify-end">
              <Button variant="outline" size="icon" className="h-12 w-12 sm:h-14 sm:w-14 shrink-0 rounded-xl border-slate-800 bg-slate-950/80 text-slate-400 hover:border-primary transition-all shadow-lg" onClick={(e) => { e.stopPropagation(); onOpenDetail(task); }}><Pencil className="h-5 w-5 sm:h-6 sm:w-6" /></Button>
              <Button variant="outline" size="icon" className={`h-12 w-12 sm:h-14 sm:w-14 shrink-0 rounded-xl border-slate-800 bg-slate-950/80 text-slate-400 hover:border-primary transition-all shadow-lg ${isExpanded ? 'bg-primary text-black border-primary' : ''}`} onClick={(e) => { e.stopPropagation(); setExpandedTaskId(isExpanded ? null : task.id); }}>
                {isExpanded ? <ChevronUp className="h-5 w-5 sm:h-6 sm:w-6" /> : <ChevronDown className="h-5 w-5 sm:h-6 sm:w-6" />}
              </Button>
            </div>
          </div>
        </div>

        {/* ── PERSONNEL LEAD MATRIX ── */}
        <div className="mt-12 pt-10 border-t border-slate-800/40 flex flex-col md:flex-row md:items-center justify-between gap-12 relative z-10">
            <div className="space-y-6">
                <p className="text-[11px] font-black text-muted-foreground/30 uppercase tracking-[0.4em]">Operational Lead</p>
                <div className="flex items-center gap-6">
                    <div className="relative">
                        <Avatar className="h-20 w-20 border-4 border-slate-800 shadow-2xl ring-4 ring-slate-900/50">
                            <AvatarImage src={currentOp.photoURL} />
                            <AvatarFallback className="bg-slate-900 font-black text-xs uppercase">OP</AvatarFallback>
                        </Avatar>
                        {isYourTurn && <div className="absolute -top-1 -right-1 h-8 w-8 bg-primary rounded-full border-4 border-slate-950 flex items-center justify-center animate-pulse shadow-xl"><Zap className="h-4 w-4 text-black" /></div>}
                    </div>
                    <div className="space-y-2 text-left">
                        <p className="font-black text-white text-2xl tracking-tight leading-none uppercase">{currentOp.name || 'Pending Assignment'} {isYourTurn && <span className="ml-3 text-xs text-primary bg-primary/10 px-2.5 py-1 rounded border border-primary/20 uppercase tracking-widest font-black">YOU</span>}</p>
                        <p className="text-sm font-bold text-emerald-500 uppercase tracking-[0.2em] leading-none">{currentOp.role || 'Personnel Required'}</p>
                        <div className="flex items-center gap-6 pt-2">
                            {currentOp.uid !== currentUserId && currentOp.whatsapp && (
                                <a href={`https://wa.me/${currentOp.whatsapp.replace(/[^0-9]/g, '')}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 text-xs font-black text-emerald-400 hover:text-white transition-colors uppercase tracking-widest" onClick={e => e.stopPropagation()}><Phone className="h-4 w-4" /> {currentOp.whatsapp}</a>
                            )}
                            {currentOp.uid !== currentUserId && currentOp.email && (
                                <a href={`mailto:${currentOp.email}`} className="flex items-center gap-2.5 text-xs font-black text-indigo-400 hover:text-white transition-colors uppercase tracking-widest" onClick={e => e.stopPropagation()}><Mail className="h-4 w-4" /> {currentOp.email}</a>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="text-left md:text-right space-y-6">
                <p className="text-[11px] font-black text-muted-foreground/30 uppercase tracking-[0.4em]">Command Center</p>
                <div className="flex md:flex-row-reverse items-center gap-6 opacity-80">
                    <Avatar className="h-16 w-16 border-2 border-slate-800 shadow-xl">
                        <AvatarImage src={names[task.assignerId]?.photoURL} />
                        <AvatarFallback className="bg-slate-900 text-xs font-black">HQ</AvatarFallback>
                    </Avatar>
                    <div className="space-y-1.5">
                        <p className="font-bold text-white/90 text-lg tracking-tight leading-none uppercase">{names[task.assignerId]?.name || 'Mission Command'}</p>
                        <p className="text-xs font-mono text-slate-500 uppercase tracking-[0.2em]">Directive Issued {safeDate(task.createdAt) ? format(safeDate(task.createdAt)!, 'MMM dd, yyyy') : 'Recently'}</p>
                    </div>
                </div>
            </div>
        </div>

        {/* ── EXPANDED INTEL ── */}
        {isExpanded && (
          <div className="mt-12 pt-12 border-t border-slate-800/40 animate-in fade-in slide-in-from-top-6 duration-700 space-y-12" onClick={(e) => e.stopPropagation()}>

            {/* Unified Grid: Briefing + Steps (left) | SITREP sidebar (right) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

              {/* ── Left Column: Intel ── */}
              <div className="lg:col-span-7 xl:col-span-8 space-y-8">
                {task.description && (
                  <div className="bg-slate-950/50 p-8 rounded-3xl border border-slate-800/40">
                    <h4 className="text-xs font-black uppercase tracking-[0.4em] text-primary/70 mb-6 flex items-center gap-3">
                        <ClipboardList className="h-4 w-4" /> Operational Briefing
                    </h4>
                    <div className="text-base text-slate-300 leading-relaxed whitespace-pre-wrap">{task.description}</div>
                  </div>
                )}
                {task.workflowId && (
                  <div className="bg-slate-950/30 p-6 rounded-3xl border border-slate-800/40">
                    <WorkflowStepsList steps={steps} names={names} currentTaskId={task.id} currentUserId={currentUserId} />
                  </div>
                )}
              </div>

              {/* ── Right Column: SITREP Panel ── */}
              <div className="lg:col-span-5 xl:col-span-4">
                {canEdit ? (
                  <div className="lg:sticky lg:top-6 rounded-2xl border border-slate-700/50 overflow-hidden shadow-2xl shadow-black/40 bg-slate-950">
                    {/* Panel header */}
                    <div className="relative px-6 py-4 border-b border-slate-800/60 bg-gradient-to-r from-emerald-500/8 via-cyan-500/5 to-transparent">
                      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-500/5 to-transparent" />
                      <h4 className="relative text-[11px] font-black uppercase tracking-[0.35em] text-emerald-400 flex items-center gap-2.5">
                        <div className="h-6 w-6 rounded-lg bg-emerald-500/15 flex items-center justify-center"><RefreshCw className="h-3.5 w-3.5" /></div>
                        Tactical SITREP
                      </h4>
                    </div>

                    <div className="p-5 space-y-5">
                      {/* Status — Segmented pills */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Status</label>
                        <div className="grid grid-cols-3 gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800/80">
                          {[
                            { value: 'pending', label: 'Standby', activeClass: 'bg-slate-600 text-white shadow-md' },
                            { value: 'in-progress', label: 'Active', activeClass: 'bg-blue-500 text-black shadow-md shadow-blue-500/25' },
                            { value: 'submitted-for-review', label: 'Transmit', activeClass: 'bg-amber-500 text-black shadow-md shadow-amber-500/25' }
                          ].map(s => (
                            <button key={s.value} onClick={() => setInlineStatus(s.value)}
                              className={`py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all duration-200
                                ${inlineStatus === s.value ? s.activeClass : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/60'}`}>
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Hours — Stepper input */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Hours Logged</label>
                        <div className="flex items-center bg-slate-900 border border-slate-800/80 rounded-xl p-1">
                          <button onClick={() => setInlineHours(String(Math.max(0, (parseFloat(inlineHours) || 0) - 0.5)))}
                            className="h-10 w-10 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center font-black text-base transition-all shrink-0">-</button>
                          <Input type="number" step="0.5" value={inlineHours} onChange={e => setInlineHours(e.target.value)}
                            className="flex-1 bg-transparent border-0 text-center text-xl font-black font-mono h-10 focus-visible:ring-0 focus-visible:ring-offset-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                          <button onClick={() => setInlineHours(String((parseFloat(inlineHours) || 0) + 0.5))}
                            className="h-10 w-10 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center font-black text-base transition-all shrink-0">+</button>
                        </div>
                      </div>

                      {/* Execution Log */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Execution Log</label>
                        <Textarea value={inlineReport} onChange={(e) => setInlineReport(e.target.value)} rows={5}
                          placeholder="Detail outcomes, blockers, and deliverables..."
                          className="bg-slate-900 border-slate-800/80 resize-none text-sm rounded-xl p-4 focus:ring-emerald-500/20 min-h-[120px] placeholder:text-slate-600" />
                      </div>

                      {/* Submit */}
                      <SubmitButton onClick={handleFullUpdate} isSubmitting={isUpdating} isSuccess={isSuccess}
                        className="w-full h-12 bg-gradient-to-r from-emerald-500 to-cyan-500 text-black font-black uppercase tracking-[0.15em] text-xs rounded-xl shadow-lg shadow-emerald-500/15 hover:shadow-emerald-500/30 hover:brightness-110 transition-all border border-white/10">
                        {inlineStatus === 'submitted-for-review' ? 'TRANSMIT FOR REVIEW' : inlineStatus === 'completed' ? 'MISSION ACCOMPLISHED' : 'SUBMIT SITREP'}
                      </SubmitButton>
                    </div>
                  </div>
                ) : (
                  <div className="p-8 rounded-2xl bg-slate-950/40 border border-slate-800/40 text-center text-sm text-slate-500 italic">
                    Restricted to mission-critical personnel.
                  </div>
                )}
              </div>
            </div>

            {/* Phase 3: Collaborative Uplink */}
            {task.workflowId && (
              <div className="bg-slate-950/80 p-10 rounded-[4rem] border-2 border-slate-800/80 shadow-2xl space-y-10 animate-in slide-in-from-bottom-12 duration-1000">
                <div className="flex items-center justify-between border-b-2 border-slate-800/60 pb-8 px-4">
                    <div className="space-y-2">
                        <h4 className="text-base font-black uppercase tracking-[0.5em] text-indigo-400 flex items-center gap-4"><MessageSquare className="h-6 w-6" /> Collaborative Mission Uplink</h4>
                        <p className="text-xs text-slate-500 font-bold uppercase tracking-[0.2em] opacity-70">Secured real-time sequence coordination</p>
                    </div>
                    <Badge className="bg-indigo-600 text-white font-black px-6 py-2 tracking-widest animate-pulse border-2 border-white/10 rounded-xl shadow-lg shadow-indigo-500/20">UPLINK ENCRYPTED</Badge>
                </div>
                <div className="min-h-[600px] rounded-[2.5rem] overflow-hidden border border-white/5 bg-black/20 shadow-inner">
                    <ErrorBoundary fallback={<div className="p-32 text-center text-red-500 uppercase font-black text-xl tracking-[0.5em]">Link Failure. Re-authenticate directive.</div>}>
                        <DynamicChat 
                            workflowId={task.workflowId} 
                            taskId={task.id} 
                            workflowTitle={task.workflowTitle || task.title} 
                            participants={task.workflowParticipantIds || [task.assigneeId, task.assignerId].filter(Boolean)} 
                            showHeader={true} 
                            enabled={true} 
                        />
                    </ErrorBoundary>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const TaskCard = memo(TaskCardImpl);
TaskCard.displayName = 'TaskCard';


// ==========================================
// MAIN BOARD (MISSION CONTROL)
// ==========================================
export function AssignedTasks({ userId, initialTasks, initialTaskId }: { userId: string, initialTasks?: any[], initialTaskId?: string | null }) {
  const firestore = useFirestore();
  const { user: currentUser } = useUserContext();
  const { isAuthorized: isAdmin } = useAuthorization('canManageTasks');
  const isOwner = currentUser?.uid === userId;

  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [detailInitialTab, setDetailInitialTab] = useState<'overview' | 'report' | 'activity'>('overview');
  const [selectedTaskForDetail, setSelectedTaskForDetail] = useState<any>(null);

  const onOpenDetail = (task: any, tab: 'overview' | 'report' | 'activity' = 'overview') => {
    setSelectedTaskForDetail(task);
    setDetailInitialTab(tab);
    setDetailDialogOpen(true);
  };
  const [manualRefresh, setManualRefresh] = useState(0);

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const [workflowTasks, setWorkflowTasks] = useState<any[]>([]);
  const [workflowLoading, setWorkflowLoading] = useState(false);

  const tasksQuery = useMemoFirebase(
    () => {
      if (initialTasks && manualRefresh === 0) return null as any;
      if (!firestore || !currentUser) return null as any;
      const targetUserId = isOwner || isAdmin ? userId : currentUser.uid;
      return query(collection(firestore, 'tasks'), where('assigneeId', '==', targetUserId), limit(100));
    },
    [firestore, userId, currentUser, isOwner, isAdmin, manualRefresh, initialTasks]
  );

  useEffect(() => {
    if (!firestore || !currentUser || (initialTasks && manualRefresh === 0)) return;
    const fetchWorkflowTasks = async () => {
      setWorkflowLoading(true);
      try {
        const wfQuery = query(collection(firestore, 'tasks'), where('workflowParticipantIds', 'array-contains', currentUser.uid), limit(100));
        const snapshot = await getDocs(wfQuery);
        setWorkflowTasks(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      } catch (err) { console.warn('Workflow fetch failed', err); } finally { setWorkflowLoading(false); }
    };
    fetchWorkflowTasks();
  }, [firestore, currentUser, manualRefresh, initialTasks]);

  const { data: fetchedTasks, loading: fetching } = useCollection(tasksQuery, { listen: !initialTasks });

  const tasks = useMemo(() => {
    const primaryTasks = (initialTasks && manualRefresh === 0) ? initialTasks : (fetchedTasks || []);
    const taskMap = new Map();
    [...primaryTasks, ...workflowTasks].forEach((t: any) => { if (!taskMap.has(t.id)) taskMap.set(t.id, t); });
    return Array.from(taskMap.values());
  }, [initialTasks, manualRefresh, fetchedTasks, workflowTasks]);

  const loading = (initialTasks && manualRefresh === 0) ? false : (fetching || workflowLoading);

  const normalized = useMemo(() => {
    const uniqueTasks = new Map();
    (tasks || []).forEach((t: any) => {
      if (!uniqueTasks.has(t.id)) {
        uniqueTasks.set(t.id, {
          ...t,
          deadline: safeDate(t?.individualDeadline) || safeDate(t?.deadline),
          createdAt: safeDate(t?.createdAt),
          updatedAt: safeDate(t?.updatedAt),
          completedAt: safeDate(t?.completedAt),
        });
      }
    });

    const activeOnly = Array.from(uniqueTasks.values()).filter((t: any) => {
      const matchesStatus = statusFilter === 'all' || t.status === statusFilter;
      const matchesProject = projectFilter === 'all' || (t.projectId || 'uncategorized') === projectFilter;
      const isNotCompleted = t.status !== 'completed';
      return matchesStatus && matchesProject && isNotCompleted;
    });

    return [...activeOnly].sort((a: any, b: any) => {
      if (a.isCurrentStep && !b.isCurrentStep) return -1;
      if (!a.isCurrentStep && b.isCurrentStep) return 1;
      if (a.deadline && b.deadline) return a.deadline.getTime() - b.deadline.getTime();
      return 0;
    });
  }, [tasks, statusFilter, projectFilter]);

  const uniqueProjects = useMemo(() => {
    if (!tasks) return [];
    const projects = new Map<string, string>();
    (tasks as any[]).forEach(t => { if (t.projectId) projects.set(t.projectId, t.projectTitle || t.projectId); });
    return Array.from(projects.entries()).map(([id, title]) => ({ id, title }));
  }, [tasks]);

  const categorizedMissions = useMemo(() => {
    const groups: Record<string, { id: string, title: string, tasks: any[], priorityScore: number }> = {};
    normalized.forEach((task: any) => {
      const groupId = task.workflowId || task.projectId || 'uncategorized';
      const groupTitle = task.workflowTitle || task.projectTitle || 'Autonomous Directives';
      if (!groups[groupId]) groups[groupId] = { id: groupId, title: groupTitle, tasks: [], priorityScore: 0 };
      groups[groupId].tasks.push(task);
      if (task.isCurrentStep && task.status !== 'completed') groups[groupId].priorityScore += 1000;
      if (task.deadline && isPast(task.deadline) && task.status !== 'completed') groups[groupId].priorityScore += 500;
      if (task.status === 'pending') groups[groupId].priorityScore += 10;
    });
    Object.values(groups).forEach(group => {
      group.tasks.sort((a, b) => {
        if (a.isCurrentStep && !b.isCurrentStep) return -1;
        if (!a.isCurrentStep && b.isCurrentStep) return 1;
        if (typeof a.sequenceIndex === 'number' && typeof b.sequenceIndex === 'number') return a.sequenceIndex - b.sequenceIndex;
        if (a.deadline && b.deadline) return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
        return 0;
      });
    });
    return Object.values(groups).sort((a, b) => {
      if (a.id === 'uncategorized' && b.id !== 'uncategorized') return 1;
      if (b.id === 'uncategorized' && a.id !== 'uncategorized') return -1;
      return b.priorityScore - a.priorityScore;
    });
  }, [normalized]);

  const [userNameCache, setUserNameCache] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!firestore || !normalized || normalized.length === 0) return;
    const fetchUserNames = async () => {
      const uids = new Set<string>();
      normalized.forEach((t: any) => { if (t.assignerId) uids.add(t.assignerId); if (t.assigneeId) uids.add(t.assigneeId); });
      if (uids.size === 0) return;
      const info: Record<string, any> = {};
      for (const uid of Array.from(uids)) {
        try {
          const userDoc = await getDoc(doc(firestore, 'users', uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            info[uid] = { name: data?.displayName || data?.email || uid, photoURL: data?.photoURL };
          } else { info[uid] = { name: uid }; }
        } catch { info[uid] = { name: uid }; }
      }
      setUserNameCache(info);
    };
    fetchUserNames();
  }, [firestore, normalized]);

  return (
    <Card className="mt-8 border-none shadow-none bg-transparent">
      <CardHeader className="px-0 pt-0 flex flex-row items-center justify-between pb-8">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-4 text-4xl font-black tracking-tighter uppercase text-white leading-none">
            <div className="p-3 bg-primary/10 rounded-xl border-2 border-primary/20 shadow-2xl shadow-primary/10">
              <Zap className="h-10 w-10 text-primary animate-pulse fill-primary/20" />
            </div>
            <div className="flex flex-col">
                <span>Mission Control</span>
                {!loading && <span className="text-xs font-mono font-black border-primary/40 bg-primary/10 text-primary uppercase tracking-[0.4em] px-4 py-1 rounded-full mt-2 border max-w-fit">{normalized.length} ACTIVE DIRECTIVES</span>}
            </div>
          </CardTitle>
        </div>
        <Button variant="outline" size="icon" onClick={() => setManualRefresh(prev => prev + 1)} className="h-14 w-14 rounded-2xl border-slate-800 bg-slate-900/50 hover:bg-primary transition-all shadow-2xl group"><RefreshCw className={`h-6 w-6 group-hover:rotate-180 transition-transform duration-500 ${loading ? 'animate-spin' : ''}`} /></Button>
      </CardHeader>
      
      {!loading && normalized.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-6 mb-16 px-1 items-center">
          <div className="flex gap-4 flex-1 w-full">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full max-w-[240px] bg-slate-950/80 border-2 border-slate-800 hover:border-primary/50 h-12 text-xs font-black uppercase tracking-[0.2em] rounded-2xl shadow-2xl px-6"><div className="flex items-center gap-3"><Filter className="h-4 w-4 text-primary" /><SelectValue placeholder="Status" /></div></SelectTrigger>
                <SelectContent className="bg-slate-950 border-2 border-slate-800 text-white shadow-2xl"><SelectItem value="all">ALL STATUSES</SelectItem><SelectItem value="pending">STANDBY (TO DO)</SelectItem><SelectItem value="in-progress">ACTIVE (IN PROGRESS)</SelectItem><SelectItem value="submitted-for-review">IN REVIEW</SelectItem><SelectItem value="overdue">OVERDUE</SelectItem></SelectContent>
            </Select>
            {uniqueProjects.length > 0 && (
                <Select value={projectFilter} onValueChange={setProjectFilter}>
                    <SelectTrigger className="w-full max-w-[260px] bg-slate-950/80 border-2 border-slate-800 hover:border-primary/50 h-12 text-xs font-black uppercase tracking-[0.2em] rounded-2xl shadow-2xl px-6"><div className="flex items-center gap-3"><Target className="h-4 w-4 text-amber-500" /><SelectValue placeholder="Project" /></div></SelectTrigger>
                    <SelectContent className="bg-slate-950 border-2 border-slate-800 text-white shadow-2xl"><SelectItem value="all">ALL PROJECTS</SelectItem><SelectItem value="uncategorized">AUTONOMOUS DIRECTIVES</SelectItem>{uniqueProjects.map(p => (<SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>))}</SelectContent>
                </Select>
            )}
          </div>
          <div className="flex items-center bg-slate-950/80 border-2 border-slate-800 rounded-2xl p-1.5 h-14 backdrop-blur-md shadow-2xl">
            <Button variant="ghost" size="sm" className={`h-full px-6 text-xs font-black uppercase tracking-widest gap-3 transition-all duration-500 rounded-xl ${viewMode === 'grid' ? 'bg-primary text-black shadow-xl shadow-primary/20' : 'text-slate-500 hover:text-slate-300'}`} onClick={() => setViewMode('grid')}><LayoutGrid className="h-4 w-4" /> Grid</Button>
            <Button variant="ghost" size="sm" className={`h-full px-6 text-xs font-black uppercase tracking-widest gap-3 transition-all duration-500 rounded-xl ${viewMode === 'list' ? 'bg-primary text-black shadow-xl shadow-primary/20' : 'text-slate-500 hover:text-slate-300'}`} onClick={() => setViewMode('list')}><List className="h-4 w-4" /> List</Button>
          </div>
        </div>
      )}

      <CardContent className="px-0">
        {!loading && normalized.length === 0 ? <div className="text-center py-32 border-4 border-dashed rounded-[4rem] border-slate-800/40 bg-slate-900/10"><CheckCircle2 className="h-24 w-24 mx-auto text-slate-800/50 mb-8" /><p className="text-3xl font-accent font-black text-slate-600 uppercase tracking-[0.3em]">All Systems Nominal.</p><p className="text-sm text-slate-700 font-mono mt-2 uppercase tracking-widest">No active mission directives detected.</p></div> : (
          <div className="space-y-20">
            {categorizedMissions.map(group => (
              <div key={group.id} className="animate-in fade-in slide-in-from-bottom-8 duration-1000">
                <div className="flex items-center justify-center mb-16 mt-20 relative"><div className="absolute inset-0 flex items-center"><div className="w-full border-t-2 border-slate-800/40"></div></div><Badge variant="outline" className="relative tracking-[0.5em] text-xs font-black uppercase py-4 px-10 bg-slate-950 border-2 border-slate-800 text-primary shadow-[0_0_50px_rgba(59,130,246,0.1)] flex items-center gap-5 rounded-full border-t-white/10"><div className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse shadow-[0_0_15px_rgba(59,130,246,1)]" />{group.title}</Badge></div>
                <div className="space-y-10">
                    {group.tasks.map((task: any) => (<TaskCard key={task.id} task={task} isOwner={isOwner} isAdmin={isAdmin} currentUserId={currentUser?.uid} onTaskUpdated={() => setManualRefresh(prev => prev + 1)} expandedTaskId={expandedTaskId} setExpandedTaskId={setExpandedTaskId} onOpenDetail={(t: any, tab?: string) => onOpenDetail(t, tab as any)} />))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <TaskDetailDialog
        task={selectedTaskForDetail ? {
          ...selectedTaskForDetail,
          assigneeName: selectedTaskForDetail.assigneeName || userNameCache[selectedTaskForDetail.assigneeId]?.name || 'Unknown',
          assigneePhoto: userNameCache[selectedTaskForDetail.assigneeId]?.photoURL,
          creatorName: selectedTaskForDetail.assignerId ? (userNameCache[selectedTaskForDetail.assignerId]?.name || ' HQ') : 'Unknown',
          creatorPhoto: selectedTaskForDetail.assignerId ? userNameCache[selectedTaskForDetail.assignerId]?.photoURL : undefined,
        } : null}
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        onTaskUpdated={() => setManualRefresh(prev => prev + 1)}
        isManager={isOwner || isAdmin}
        initialTab={detailInitialTab}
      />
    </Card>
  );
}
