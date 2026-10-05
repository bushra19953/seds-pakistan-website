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
import { ClipboardList, ChevronDown, ChevronUp, ChevronRight, AlertCircle, Clock, CheckCircle2, Target, Zap, Timer, AlertTriangle, RefreshCw, Users, ExternalLink, Filter, LayoutGrid, List, Pencil, MessageSquare, MessageCircle, Github, Phone, Mail, Activity as ActivityIcon } from 'lucide-react';
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

// ── Structured briefing: parses WHAT / HOW / STANDARDS / RESOURCES / VERIFICATION
// sections from a task description. WHAT stays visible; the rest are native
// <details> accordions so the working person sees the core first and expands
// only what they need. Falls back to plain text for unstructured descriptions.
const BRIEF_SECTIONS = ['WHAT', 'HOW', 'STANDARDS', 'RESOURCES', 'VERIFICATION'] as const;

function parseBriefing(description: string): { sections: { name: string; body: string }[]; isStructured: boolean } {
  const sections: { name: string; body: string }[] = [];
  const pattern = new RegExp(`^(${BRIEF_SECTIONS.join('|')}):\\s*`, 'gm');
  let match: RegExpExecArray | null;
  const indices: { name: string; start: number; bodyStart: number }[] = [];
  while ((match = pattern.exec(description)) !== null) {
    indices.push({ name: match[1], start: match.index, bodyStart: match.index + match[0].length });
  }
  if (indices.length === 0) return { sections: [], isStructured: false };
  for (let i = 0; i < indices.length; i++) {
    const end = i + 1 < indices.length ? indices[i + 1].start : description.length;
    const body = description.slice(indices[i].bodyStart, end).trim();
    if (body) sections.push({ name: indices[i].name, body });
  }
  return { sections, isStructured: sections.length > 0 };
}

function StructuredBriefing({ description }: { description: string }) {
  const { sections, isStructured } = parseBriefing(description);
  if (!isStructured) {
    return <div className="text-sm sm:text-base text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">{description}</div>;
  }
  const [what, ...rest] = sections;
  return (
    <div className="space-y-3">
      {what && (
        <div className="text-sm sm:text-base text-foreground leading-relaxed break-words">
          <span className="text-[10px] font-black uppercase tracking-[0.25em] text-primary/80 block mb-1.5">What</span>
          {what.body}
        </div>
      )}
      {rest.map((s) => (
        <details key={s.name} className="group bg-card/60 border border-border/60 rounded-xl overflow-hidden">
          <summary className="flex items-center justify-between gap-2 px-4 py-3 cursor-pointer list-none text-[11px] font-black uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors min-h-[44px]">
            <span>{s.name.charAt(0) + s.name.slice(1).toLowerCase()}</span>
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed break-words border-t border-border/40 pt-3">
            {s.body}
          </div>
        </details>
      ))}
    </div>
  );
}

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
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1 sm:px-2">
          <h4 className="text-[11px] font-black uppercase tracking-[0.25em] sm:tracking-[0.4em] text-indigo-400 flex items-center gap-2 sm:gap-3">
            <List className="h-4 w-4 shrink-0" /> Operational Mission Sequence
          </h4>
          <Badge variant="outline" className="text-xs font-mono border-indigo-500/20 text-indigo-400 uppercase h-6 px-3 whitespace-nowrap">
            {steps.length} Phases
          </Badge>
      </div>

      <div className="grid grid-cols-1 gap-3">
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
            <div key={step.id} className={`group/step relative rounded-2xl border-2 transition-all duration-500 ${isCurrent ? 'border-primary bg-primary/5 shadow-2xl shadow-primary/5' : 'border-border/60 bg-card/30'}`}>
              <div className="p-4 sm:p-5 flex items-center gap-4 sm:gap-5">
                <div className={`flex-shrink-0 h-10 w-10 sm:h-12 sm:w-12 rounded-xl flex items-center justify-center text-xs sm:text-sm font-black shadow-lg ${isDone ? 'bg-emerald-500 text-black' : isCurrent ? 'bg-primary text-black scale-110' : 'bg-muted text-muted-foreground'}`}>
                  {isDone ? '✓' : String(idx + 1).padStart(2, '0')}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-1">
                    <p className={`font-black uppercase text-xs sm:text-sm leading-tight tracking-tight ${isCurrent ? 'text-primary' : isDone ? 'text-emerald-400' : 'text-foreground/80'}`}>
                        {step.title}
                    </p>
                    {isCurrent && <Badge className="bg-primary text-black text-[9px] h-4.5 px-2 font-black animate-pulse">ACTIVE</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-black text-muted-foreground uppercase tracking-[0.15em]">
                    <span className="flex items-center gap-1.5 text-foreground bg-muted px-2.5 py-1 rounded-lg border border-white/5"><Users className="h-3 w-3 text-primary" /> {assignee.name || 'Pending Assignment'}</span>
                    <span className="flex items-center gap-1.5 border border-border px-2.5 py-1 rounded-lg"><Clock className="h-3 w-3" /> {step.status}</span>
                  </div>
                </div>

                <div className="flex gap-2 shrink-0">
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
  const taskAssigneeIds: string[] = Array.isArray((task as any).assigneeIds) && (task as any).assigneeIds.length
    ? (task as any).assigneeIds.map(String)
    : (task.assigneeId ? [String(task.assigneeId)] : []);
  const isYourTurn = taskAssigneeIds.includes(String(currentUserId)) && task.isCurrentStep && !isCompleted;
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
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, updates: { status: 'submitted-for-review', report: 'Objective reached. Direct Transmit.' } })
      });
      if (!res.ok) throw new Error(`Transmit failed (${res.status})`);
      const data = await res.json().catch(() => null);
      if (!data?.ok || data?.taskAfter?.status !== 'submitted-for-review') throw new Error('Transmit not confirmed by server');
      setIsSuccess(true);
      toast.success("Mission Success Transmitted!");
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      setTimeout(() => { setIsSuccess(false); setIsUpdating(false); onTaskUpdated(); }, 1500);
    } catch (err) {
      setIsUpdating(false);
      toast.error("Transmit failed. Please try again.");
    }
  };

  const handleRecall = async (e: React.MouseEvent) => {
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
          updates: { status: 'in-progress' }
        })
      });
      if (!res.ok) throw new Error();
      setIsSuccess(true);
      toast.success("Submission recalled — back to Active.");
      setTimeout(() => { setIsSuccess(false); setIsUpdating(false); onTaskUpdated(); }, 1500);
    } catch (err) { toast.error("Fail."); setIsUpdating(false); }
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
    <div className={`group relative overflow-hidden rounded-3xl sm:rounded-[2.5rem] border-2 transition-all duration-700 hover:bg-card/90 backdrop-blur-2xl ${isYourTurn ? 'border-primary bg-primary/5 shadow-2xl shadow-primary/10' : isCompleted ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-border bg-card/60'}`} onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}>
      
      {/* ── CARD HUD: Mission Timeline ── */}
      {task.workflowId && teamMembers.length > 0 && (
          <div className="border-b border-border/40 bg-card/40 px-8 py-6">
              <WorkflowTeamContext members={teamMembers} currentUserId={currentUserId} />
          </div>
      )}

      <div className="relative p-4 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 lg:gap-8">
          <div className="flex-1 min-w-0 space-y-4 sm:space-y-5">
            <div className="flex items-start gap-3 sm:gap-4">
              <div className={`flex-shrink-0 h-10 w-10 sm:h-12 sm:w-12 rounded-xl flex items-center justify-center border-2 transition-all duration-700 ${isYourTurn ? 'bg-primary text-black border-primary shadow-xl shadow-primary/30' : isCompleted ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' : 'bg-card border-border text-muted-foreground'}`}>
                {isCompleted ? <CheckCircle2 className="h-5 w-5 sm:h-6 sm:w-6" /> : isYourTurn ? <Zap className="h-5 w-5 sm:h-6 sm:w-6 fill-current" /> : getStatusIcon(task.status)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <Badge variant="outline" className="text-[10px] font-black border-border bg-card/80 text-primary/70 px-2.5 h-6 uppercase tracking-[0.15em] whitespace-nowrap overflow-hidden text-ellipsis">DIRECTIVE # {task.id.slice(0, 8)}</Badge>
                  <StatusBadge status={isOverdue ? 'overdue' : task.status} size="sm" variant="solid" className="font-black tracking-widest h-6 px-3 text-[10px] whitespace-nowrap" />
                </div>
                <h3 className="text-[clamp(1.05rem,0.95rem+0.8vw,1.4rem)] font-accent font-black tracking-tight text-foreground leading-snug group-hover:text-primary transition-colors uppercase break-words">{task.title}</h3>
                
                {/* ── RESOURCE CHIPS ── */}
                {hasResources && (
                    <div className="flex flex-wrap gap-2 sm:gap-3 mt-4 sm:mt-6">
                        {Array.isArray(task.resources) ? task.resources.map((res: any, idx: number) => (
                            <a key={idx} href={res.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 sm:px-4 rounded-xl bg-card border border-border hover:border-primary/50 hover:bg-primary/10 transition-all text-[10px] sm:text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-primary min-h-[44px]" onClick={e => e.stopPropagation()}>
                                {res.type === 'drive' ? <LayoutGrid className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> : res.type === 'github' ? <Github className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> : <ExternalLink className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />} <span className="break-words">{res.title}</span>
                            </a>
                        )) : task.resourceLinks?.split('\n').filter(Boolean).map((link: string, idx: number) => (
                            <a key={idx} href={link.startsWith('http') ? link : `https://${link}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 sm:px-4 rounded-xl bg-card border border-border hover:border-primary/50 text-[10px] sm:text-xs font-black uppercase tracking-widest text-primary hover:bg-primary/5 transition-all min-h-[44px]" onClick={e => e.stopPropagation()}>
                                <ExternalLink className="h-3 w-3 shrink-0" /> <span className="break-words">ATTACHMENT {idx + 1}</span>
                            </a>
                        ))}
                    </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-4">
              <div className="bg-card/60 border border-border/80 p-3 sm:p-4 rounded-xl shadow-inner min-w-0 overflow-hidden">
                <p className="text-[10px] sm:text-xs font-black text-muted-foreground/60 uppercase tracking-[0.15em] mb-1 flex items-center gap-1.5 whitespace-nowrap"><Timer className="h-3 w-3 shrink-0" /> Ends In</p>
                <CountdownTimer expiryDate={task.deadline} hideLabel className="border-none bg-transparent p-0 font-accent text-xs sm:text-sm tracking-tight text-foreground whitespace-nowrap max-w-full overflow-hidden" />
              </div>
              <div className="bg-card/60 border border-border/80 p-3 sm:p-4 rounded-xl shadow-inner min-w-0 overflow-hidden">
                <p className="text-[10px] sm:text-xs font-black text-muted-foreground/60 uppercase tracking-[0.15em] mb-1 flex items-center gap-1.5 whitespace-nowrap"><Target className="h-3 w-3 shrink-0" /> Bounty</p>
                <p className="text-lg sm:text-xl font-accent font-black text-foreground whitespace-nowrap">{task.points} <span className="text-[10px] text-primary/60 tracking-widest">PTS</span></p>
              </div>
              <div className="bg-card/60 border border-border/80 p-3 sm:p-4 rounded-xl shadow-inner min-w-0 overflow-hidden">
                <p className="text-[10px] sm:text-xs font-black text-muted-foreground/60 uppercase tracking-[0.15em] mb-1 flex items-center gap-1.5 whitespace-nowrap"><ActivityIcon className="h-3 w-3 shrink-0" /> Sync</p>
                <div className="flex items-center gap-2"><div className="flex-1 h-1.5 bg-card rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-primary to-emerald-400" style={{ width: `${syncPercentage}%` }} /></div><span className="text-[10px] sm:text-xs font-mono font-black text-foreground/80">{syncPercentage}%</span></div>
              </div>
            </div>
          </div>

          <div className="flex flex-row flex-wrap lg:flex-col items-center lg:items-end gap-2 shrink-0 w-full lg:w-auto">
            {isYourTurn && (
              <Button onClick={handleQuickAction} disabled={isUpdating} className="h-11 px-5 bg-primary text-black font-black uppercase tracking-[0.1em] text-[11px] hover:bg-white transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2 w-full lg:w-auto rounded-xl">
                {isUpdating ? <RefreshCw className="h-4 w-4 animate-spin" /> : isSuccess ? <CheckCircle2 className="h-5 w-5" /> : <><span>TRANSMIT SUCCESS</span><ChevronRight className="h-4 w-4 shrink-0" /></>}
              </Button>
            )}
            <div className="flex gap-2 w-full lg:w-auto justify-end">
              {(isAdmin || isOwner) && currentOp.whatsapp && currentUserId !== task.assigneeId && (
                <a
                  href={`https://wa.me/${currentOp.whatsapp.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(
                    `Assalam-o-Alaikum ${currentOp.name || 'Team Member'}! You have a new SEDS task:\n\n${task.title}\nDeadline: ${task.deadline ? new Date(task.deadline?.toDate ? task.deadline.toDate() : task.deadline).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : 'No deadline set'}\nPoints: ${task.points || 0}\n\nView it here: https://sedspakistan.live/profile/unified/${task.assigneeId}?task=${task.id}`
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title="Notify assignee via WhatsApp"
                  className="h-11 w-11 shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-black transition-all flex items-center justify-center"
                >
                  <MessageCircle className="h-4 w-4" />
                </a>
              )}
              <Button variant="outline" size="icon" className="h-11 w-11 shrink-0 rounded-xl border-border bg-card/80 text-muted-foreground hover:border-primary transition-all" onClick={(e) => { e.stopPropagation(); onOpenDetail(task); }}><Pencil className="h-4 w-4" /></Button>
              <Button variant="outline" size="icon" className={`h-11 w-11 shrink-0 rounded-xl border-border bg-card/80 text-muted-foreground hover:border-primary transition-all ${isExpanded ? 'bg-primary text-black border-primary' : ''}`} onClick={(e) => { e.stopPropagation(); setExpandedTaskId(isExpanded ? null : task.id); }}>
                {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        {/* ── PERSONNEL ── */}
        <div className="mt-6 pt-6 border-t border-border/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
            <div className="flex items-center gap-3 min-w-0">
                <div className="relative shrink-0">
                    <Avatar className="h-10 w-10 sm:h-12 sm:w-12 border-2 border-border shadow-xl">
                        <AvatarImage src={currentOp.photoURL} />
                        <AvatarFallback className="bg-card font-black text-xs uppercase">OP</AvatarFallback>
                    </Avatar>
                    {isYourTurn && <div className="absolute -top-1 -right-1 h-5 w-5 bg-primary rounded-full border-2 border-slate-950 flex items-center justify-center"><Zap className="h-3 w-3 text-black" /></div>}
                </div>
                <div className="min-w-0">
                    <p className="font-black text-foreground text-sm sm:text-base tracking-tight leading-tight uppercase truncate">{currentOp.name || 'Pending Assignment'} {isYourTurn && <span className="ml-1.5 text-[10px] text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20 uppercase tracking-widest font-black">YOU</span>}</p>
                    <p className="text-[11px] font-bold text-emerald-500 uppercase tracking-[0.15em]">{currentOp.role || 'Personnel Required'}</p>
                    {(currentOp.whatsapp || currentOp.email) && currentOp.uid !== currentUserId && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                            {currentOp.whatsapp && (
                                <a href={`https://wa.me/${currentOp.whatsapp.replace(/[^0-9]/g, '')}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-400 hover:text-foreground transition-colors" onClick={e => e.stopPropagation()}><Phone className="h-3 w-3 shrink-0" /> <span className="break-all">{currentOp.whatsapp}</span></a>
                            )}
                            {currentOp.email && (
                                <a href={`mailto:${currentOp.email}`} className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-400 hover:text-foreground transition-colors" onClick={e => e.stopPropagation()}><Mail className="h-3 w-3 shrink-0" /> <span className="break-all">{currentOp.email}</span></a>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-3 shrink-0 opacity-80">
                <div className="text-right">
                    <p className="font-bold text-foreground/90 text-xs tracking-tight uppercase">Mission Command</p>
                    <p className="text-[10px] font-mono text-muted-foreground uppercase">Issued {safeDate(task.createdAt) ? format(safeDate(task.createdAt)!, 'MMM dd, yyyy') : 'Recently'}</p>
                </div>
                <Avatar className="h-9 w-9 border-2 border-border">
                    <AvatarImage src={names[task.assignerId]?.photoURL} />
                    <AvatarFallback className="bg-card text-[10px] font-black">HQ</AvatarFallback>
                </Avatar>
            </div>
        </div>

        {/* ── EXPANDED INTEL ── */}
        {isExpanded && (
          <div className="mt-6 pt-6 sm:mt-12 sm:pt-12 border-t border-border/40 animate-in fade-in slide-in-from-top-6 duration-700 space-y-6 sm:space-y-12" onClick={(e) => e.stopPropagation()}>

            {/* Vertical stack: Briefing → SITREP → Steps (full width, no side-by-side squeeze) */}
            <div className="space-y-6">

              {/* ── Operational Briefing (full width) ── */}
              <div className="space-y-6">
                {task.description && (
                  <div className="bg-card/50 p-4 sm:p-8 rounded-2xl sm:rounded-3xl border border-border/40 min-w-0">
                    <h4 className="text-xs font-black uppercase tracking-[0.2em] sm:tracking-[0.4em] text-primary/70 mb-4 sm:mb-6 flex items-center gap-2 sm:gap-3">
                        <ClipboardList className="h-4 w-4 shrink-0" /> Operational Briefing
                    </h4>
                    <StructuredBriefing description={task.description} />
                  </div>
                )}
              </div>

              {/* ── SITREP Panel (full width, below briefing) ── */}
              <div>
                {canEdit ? (
                  <div className="rounded-2xl border border-border/50 overflow-hidden shadow-2xl shadow-black/40 bg-card">
                    {/* Panel header */}
                    <div className="relative px-6 py-4 border-b border-border/60 bg-gradient-to-r from-emerald-500/8 via-cyan-500/5 to-transparent">
                      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-500/5 to-transparent" />
                      <h4 className="relative text-[11px] font-black uppercase tracking-[0.35em] text-emerald-400 flex items-center gap-2.5">
                        <div className="h-6 w-6 rounded-lg bg-emerald-500/15 flex items-center justify-center"><RefreshCw className="h-3.5 w-3.5" /></div>
                        Tactical SITREP
                      </h4>
                    </div>

                    <div className="p-5 space-y-5">
                      {task.status === 'submitted-for-review' ? (
                        /* Locked while under review — no silent edits */
                        <div className="space-y-4">
                          <div className="text-center py-8 bg-amber-500/5 border border-dashed border-amber-500/30 rounded-2xl px-4">
                            <p className="text-amber-300 font-black uppercase tracking-widest text-xs">Transmitted — awaiting review</p>
                            <p className="text-muted-foreground text-[11px] mt-2 leading-relaxed">
                              Locked while the reviewer decides. Recall it to keep working on it.
                            </p>
                          </div>
                          <SubmitButton onClick={handleRecall} isSubmitting={isUpdating} isSuccess={isSuccess}
                            className="w-full h-11 bg-muted text-muted-foreground font-black uppercase tracking-[0.15em] text-[11px] rounded-xl hover:bg-slate-700 transition-all border border-border">
                            Recall submission
                          </SubmitButton>
                        </div>
                      ) : (
                      <>
                      {/* Reviewer feedback — visible so revision requests are actionable */}
                      {task.status === 'changes-requested' && task.feedback_history && task.feedback_history.length > 0 && (
                        <div className="bg-amber-500/10 border border-amber-500/40 p-4 rounded-xl">
                          <p className="text-[10px] font-black text-amber-400 uppercase tracking-widest mb-2">Reviewer feedback</p>
                          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">
                            {task.feedback_history[task.feedback_history.length - 1].text}
                          </p>
                        </div>
                      )}
                      {/* Status — Segmented pills */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest ml-1">Status</label>
                        <div className="grid grid-cols-3 gap-1 bg-card p-1 rounded-xl border border-border/80">
                          {[
                            { value: 'pending', label: 'Standby', activeClass: 'bg-slate-600 text-foreground shadow-md' },
                            { value: 'in-progress', label: 'Active', activeClass: 'bg-blue-500 text-black shadow-md shadow-blue-500/25' },
                            { value: 'submitted-for-review', label: 'Transmit', activeClass: 'bg-amber-500 text-black shadow-md shadow-amber-500/25' }
                          ].map(s => (
                            <button key={s.value} onClick={() => setInlineStatus(s.value)}
                              className={`py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all duration-200
                                ${inlineStatus === s.value ? s.activeClass : 'text-muted-foreground hover:text-muted-foreground hover:bg-muted/60'}`}>
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Hours — Stepper input */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest ml-1">Hours Logged</label>
                        <div className="flex items-center bg-card border border-border/80 rounded-xl p-1">
                          <button onClick={() => setInlineHours(String(Math.max(0, (parseFloat(inlineHours) || 0) - 0.5)))}
                            className="h-10 w-10 rounded-lg bg-muted hover:bg-slate-700 text-muted-foreground hover:text-foreground flex items-center justify-center font-black text-base transition-all shrink-0">-</button>
                          <Input type="number" step="0.5" value={inlineHours} onChange={e => setInlineHours(e.target.value)}
                            className="flex-1 bg-transparent border-0 text-center text-xl font-black font-mono h-10 focus-visible:ring-0 focus-visible:ring-offset-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                          <button onClick={() => setInlineHours(String((parseFloat(inlineHours) || 0) + 0.5))}
                            className="h-10 w-10 rounded-lg bg-muted hover:bg-slate-700 text-muted-foreground hover:text-foreground flex items-center justify-center font-black text-base transition-all shrink-0">+</button>
                        </div>
                      </div>

                      {/* Execution Log */}
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest ml-1">Execution Log</label>
                        <Textarea value={inlineReport} onChange={(e) => setInlineReport(e.target.value)} rows={5}
                          placeholder="Detail outcomes, blockers, and deliverables..."
                          className="bg-card border-border/80 resize-none text-sm rounded-xl p-4 focus:ring-emerald-500/20 min-h-[120px] placeholder:text-muted-foreground" />
                      </div>

                      {/* Submit */}
                      <SubmitButton onClick={handleFullUpdate} isSubmitting={isUpdating} isSuccess={isSuccess}
                        className="w-full h-12 bg-gradient-to-r from-emerald-500 to-cyan-500 text-black font-black uppercase tracking-[0.15em] text-xs rounded-xl shadow-lg shadow-emerald-500/15 hover:shadow-emerald-500/30 hover:brightness-110 transition-all border border-border">
                        {inlineStatus === 'submitted-for-review' ? 'TRANSMIT FOR REVIEW' : 'SUBMIT SITREP'}
                      </SubmitButton>
                      </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-8 rounded-2xl bg-card/40 border border-border/40 text-center text-sm text-muted-foreground italic">
                    Restricted to mission-critical personnel.
                  </div>
                )}
              </div>

              {/* ── Mission Sequence (full width) ── */}
              {task.workflowId && (
                <div className="bg-card/30 p-4 sm:p-6 rounded-2xl sm:rounded-3xl border border-border/40 min-w-0 overflow-hidden">
                  <WorkflowStepsList steps={steps} names={names} currentTaskId={task.id} currentUserId={currentUserId} />
                </div>
              )}
            </div>

            {/* Phase 3: Collaborative Uplink */}
            {task.workflowId && (
              <div className="bg-card/80 p-4 sm:p-10 rounded-3xl sm:rounded-[4rem] border-2 border-border/80 shadow-2xl space-y-6 sm:space-y-10 animate-in slide-in-from-bottom-12 duration-1000 min-w-0 overflow-hidden">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b-2 border-border/60 pb-6 sm:pb-8 sm:px-4">
                    <div className="space-y-2 min-w-0">
                        <h4 className="text-sm sm:text-base font-black uppercase tracking-[0.2em] sm:tracking-[0.5em] text-indigo-400 flex items-center gap-2 sm:gap-4"><MessageSquare className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" /> <span className="break-words">Collaborative Mission Uplink</span></h4>
                        <p className="text-[11px] sm:text-xs text-muted-foreground font-bold uppercase tracking-[0.15em] sm:tracking-[0.2em] opacity-70">Secured real-time sequence coordination</p>
                    </div>
                    <Badge className="bg-indigo-600 text-white font-black px-4 sm:px-6 py-2 tracking-widest animate-pulse border-2 border-border rounded-xl shadow-lg shadow-indigo-500/20 whitespace-nowrap self-start sm:self-auto">UPLINK ENCRYPTED</Badge>
                </div>
                <div className="rounded-2xl sm:rounded-[2.5rem] overflow-hidden border border-white/5 bg-black/20 shadow-inner">
                    <ErrorBoundary fallback={<div className="p-32 text-center text-red-500 uppercase font-black text-xl tracking-[0.5em]">Link Failure. Re-authenticate directive.</div>}>
                        <DynamicChat 
                            workflowId={task.workflowId} 
                            taskId={task.id} 
                            workflowTitle={task.workflowTitle || task.title} 
                            participants={task.workflowParticipantIds || Array.from(new Set([task.assigneeId, ...((task as any).assigneeIds || []), task.assignerId].filter(Boolean).map(String)))} 
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

  // Auto-open task detail when initialTaskId is provided (e.g. from QR code deep link)
  useEffect(() => {
    if (!initialTaskId) return;
    const allTasks = [...(initialTasks || []), ...workflowTasks];
    const target = allTasks.find((t: any) => t.id === initialTaskId);
    if (target) {
      onOpenDetail(target, 'report');
    }
  }, [initialTaskId, initialTasks, workflowTasks]);

  const tasksQuery = useMemoFirebase(
    () => {
      if (initialTasks && manualRefresh === 0) return null as any;
      if (!firestore || !currentUser) return null as any;
      const targetUserId = isOwner || isAdmin ? userId : currentUser.uid;
      return query(collection(firestore, 'tasks'), where('assigneeId', '==', targetUserId), limit(100));
    },
    [firestore, userId, currentUser, isOwner, isAdmin, manualRefresh, initialTasks]
  );

  // Co-assignees live in the assigneeIds array; a singular query misses them.
  const tasksQueryArray = useMemoFirebase(
    () => {
      if (initialTasks && manualRefresh === 0) return null as any;
      if (!firestore || !currentUser) return null as any;
      const targetUserId = isOwner || isAdmin ? userId : currentUser.uid;
      return query(collection(firestore, 'tasks'), where('assigneeIds', 'array-contains', targetUserId), limit(100));
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
  const { data: fetchedCoTasks, loading: fetchingCo } = useCollection(tasksQueryArray, { listen: !initialTasks });

  const tasks = useMemo(() => {
    const primaryTasks = (initialTasks && manualRefresh === 0) ? initialTasks : [...(fetchedTasks || []), ...(fetchedCoTasks || [])];
    const taskMap = new Map();
    [...primaryTasks, ...workflowTasks].forEach((t: any) => { if (!taskMap.has(t.id)) taskMap.set(t.id, t); });
    return Array.from(taskMap.values());
  }, [initialTasks, manualRefresh, fetchedTasks, fetchedCoTasks, workflowTasks]);

  const loading = (initialTasks && manualRefresh === 0) ? false : (fetching || fetchingCo || workflowLoading);

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
          <CardTitle className="flex items-center gap-4 text-4xl font-black tracking-tighter uppercase text-foreground leading-none">
            <div className="p-3 bg-primary/10 rounded-xl border-2 border-primary/20 shadow-2xl shadow-primary/10">
              <Zap className="h-10 w-10 text-primary animate-pulse fill-primary/20" />
            </div>
            <div className="flex flex-col">
                <span>Mission Control</span>
                {!loading && <span className="text-xs font-mono font-black border-primary/40 bg-primary/10 text-primary uppercase tracking-[0.4em] px-4 py-1 rounded-full mt-2 border max-w-fit">{normalized.length} ACTIVE DIRECTIVES</span>}
            </div>
          </CardTitle>
        </div>
        <Button variant="outline" size="icon" onClick={() => setManualRefresh(prev => prev + 1)} className="h-14 w-14 rounded-2xl border-border bg-card/50 hover:bg-primary transition-all shadow-2xl group"><RefreshCw className={`h-6 w-6 group-hover:rotate-180 transition-transform duration-500 ${loading ? 'animate-spin' : ''}`} /></Button>
      </CardHeader>
      
      {!loading && normalized.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-4 mb-8 px-1 items-center">
          <div className="flex gap-4 flex-1 w-full">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full max-w-[240px] bg-card/80 border-2 border-border hover:border-primary/50 h-12 text-xs font-black uppercase tracking-[0.2em] rounded-2xl shadow-2xl px-6"><div className="flex items-center gap-3"><Filter className="h-4 w-4 text-primary" /><SelectValue placeholder="Status" /></div></SelectTrigger>
                <SelectContent className="bg-card border-2 border-border text-foreground shadow-2xl"><SelectItem value="all">ALL STATUSES</SelectItem><SelectItem value="pending">STANDBY (TO DO)</SelectItem><SelectItem value="in-progress">ACTIVE (IN PROGRESS)</SelectItem><SelectItem value="submitted-for-review">IN REVIEW</SelectItem><SelectItem value="overdue">OVERDUE</SelectItem></SelectContent>
            </Select>
            {uniqueProjects.length > 0 && (
                <Select value={projectFilter} onValueChange={setProjectFilter}>
                    <SelectTrigger className="w-full max-w-[260px] bg-card/80 border-2 border-border hover:border-primary/50 h-12 text-xs font-black uppercase tracking-[0.2em] rounded-2xl shadow-2xl px-6"><div className="flex items-center gap-3"><Target className="h-4 w-4 text-amber-500" /><SelectValue placeholder="Project" /></div></SelectTrigger>
                    <SelectContent className="bg-card border-2 border-border text-foreground shadow-2xl"><SelectItem value="all">ALL PROJECTS</SelectItem><SelectItem value="uncategorized">AUTONOMOUS DIRECTIVES</SelectItem>{uniqueProjects.map(p => (<SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>))}</SelectContent>
                </Select>
            )}
          </div>
          <div className="flex items-center bg-card/80 border-2 border-border rounded-2xl p-1.5 h-14 backdrop-blur-md shadow-2xl">
            <Button variant="ghost" size="sm" className={`h-full px-6 text-xs font-black uppercase tracking-widest gap-3 transition-all duration-500 rounded-xl ${viewMode === 'grid' ? 'bg-primary text-black shadow-xl shadow-primary/20' : 'text-muted-foreground hover:text-muted-foreground'}`} onClick={() => setViewMode('grid')}><LayoutGrid className="h-4 w-4" /> Grid</Button>
            <Button variant="ghost" size="sm" className={`h-full px-6 text-xs font-black uppercase tracking-widest gap-3 transition-all duration-500 rounded-xl ${viewMode === 'list' ? 'bg-primary text-black shadow-xl shadow-primary/20' : 'text-muted-foreground hover:text-muted-foreground'}`} onClick={() => setViewMode('list')}><List className="h-4 w-4" /> List</Button>
          </div>
        </div>
      )}

      <CardContent className="px-0">
        {!loading && normalized.length === 0 ? <div className="text-center py-32 border-4 border-dashed rounded-[4rem] border-border/40 bg-card/10"><CheckCircle2 className="h-24 w-24 mx-auto text-slate-800/50 mb-8" /><p className="text-3xl font-accent font-black text-slate-600 uppercase tracking-[0.3em]">All Systems Nominal.</p><p className="text-sm text-slate-700 font-mono mt-2 uppercase tracking-widest">No active mission directives detected.</p></div> : (
          <div className="space-y-8">
            {categorizedMissions.map(group => (
              <div key={group.id} className="animate-in fade-in slide-in-from-bottom-8 duration-1000">
                <div className="flex items-center justify-center mb-6 mt-8 relative"><div className="absolute inset-0 flex items-center"><div className="w-full border-t-2 border-border/40"></div></div><Badge variant="outline" className="relative tracking-[0.3em] text-xs font-black uppercase py-2 px-6 bg-card border-2 border-border text-primary shadow-[0_0_50px_rgba(59,130,246,0.1)] flex items-center gap-3 rounded-full border-t-white/10"><div className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse shadow-[0_0_15px_rgba(59,130,246,1)]" />{group.title}</Badge></div>
                <div className="space-y-6">
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
