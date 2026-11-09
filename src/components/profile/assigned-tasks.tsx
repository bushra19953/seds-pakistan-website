'use client';

import Link from 'next/link';
import { useMemo, useState, useEffect, useRef, memo } from 'react';
import { collection, query, where, limit, doc, getDoc } from 'firebase/firestore';
import { useUserContext } from '@/firebase/user-provider';
import { firestore } from '@/firebase/core';
import { useFirestore, useCollection } from '@/firebase';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { statusExemptsOverdue } from '@/lib/deadline-fairness';
import { useAuthorization } from '@/hooks/use-authorization';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ClipboardList, ChevronDown, ChevronUp, AlertCircle, Clock, CheckCircle2, Target, Zap, Timer, AlertTriangle, RefreshCw, Users, ExternalLink, Filter, LayoutGrid, List, Pencil, MessageSquare, MessageCircle, Github, Phone, Mail, Activity as ActivityIcon, Send } from 'lucide-react';
import { differenceInHours, isPast, format } from 'date-fns';
import CountdownTimer from '@/components/ui/countdown-timer';
import { Badge } from '@/components/ui/badge';
import { StatusBadge, getStatusConfig } from '@/components/ui/status-badge';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import ErrorBoundary from '@/components/error-boundary';
import { loadWorkflowContext } from './workflow-context';
import { TaskDetailDialog } from './task-detail-dialog';
import { TaskReportForm } from './task-report-form';
import { WorkflowTeamContext } from './workflow-team-context';
import ProofSubmissionDrawer from './proof-submission-drawer';

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
          <span className="font-accent text-[10px] font-semibold uppercase tracking-[0.25em] text-primary-text block mb-1.5">What</span>
          {what.body}
        </div>
      )}
      {rest.map((s) => (
        <details key={s.name} className="group border border-border/60 rounded-lg overflow-hidden">
          <summary className="flex items-center justify-between gap-2 px-4 py-3 cursor-pointer list-none font-accent text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors min-h-[44px]">
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
          <h4 className="font-accent text-[11px] font-semibold uppercase tracking-[0.25em] sm:tracking-[0.3em] text-primary-text flex items-center gap-2 sm:gap-3">
            <List className="h-4 w-4 shrink-0" /> Operational Mission Sequence
          </h4>
          <Badge variant="outline" className="text-xs font-code border-border text-muted-foreground uppercase h-6 px-3 whitespace-nowrap">
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
            <div key={step.id} className={`group/step relative rounded-lg border transition-all duration-500 ${isCurrent ? 'border-primary/60 dark:bg-primary/[0.04]' : 'border-border/60'}`}>
              <div className="p-4 sm:p-5 flex items-center gap-4 sm:gap-5">
                <div className={`flex-shrink-0 h-10 w-10 sm:h-12 sm:w-12 rounded-lg flex items-center justify-center text-xs sm:text-sm font-accent font-semibold border ${isDone ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : isCurrent ? 'bg-primary border-primary text-primary-foreground' : 'bg-muted border-transparent text-muted-foreground'}`}>
                  {isDone ? '✓' : String(idx + 1).padStart(2, '0')}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-1">
                    <p className={`font-heading uppercase text-lg leading-tight tracking-[0.02em] ${isCurrent ? 'text-primary-text' : isDone ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground/80'}`}>
                        {step.title}
                    </p>
                    {isCurrent && <Badge className="bg-primary text-primary-foreground text-xs h-4.5 px-2 font-accent font-semibold animate-pulse">ACTIVE</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-accent text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">
                    <span className="flex items-center gap-1.5 text-foreground bg-muted px-2.5 py-1 rounded-md border border-border/60"><Users className="h-3 w-3 text-primary-text" /> {assignee.name || 'Pending Assignment'}</span>
                    <span className="flex items-center gap-1.5 border border-border px-2.5 py-1 rounded-md"><Clock className="h-3 w-3" /> {step.status}</span>
                  </div>
                </div>

                <div className="flex gap-2 shrink-0">
                    {(assignee.whatsapp || assignee.email) && (
                        <div className="flex items-center gap-2">
                            {assignee.whatsapp && (
                                <a href={`https://wa.me/${assignee.whatsapp.replace(/[^0-9]/g, '')}`} target="_blank" rel="noopener noreferrer" className="p-2.5 rounded-lg text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-all border border-border hover:border-emerald-500/40" onClick={e => e.stopPropagation()}>
                                    <Phone className="h-4 w-4" />
                                </a>
                            )}
                            {assignee.email && (
                                <a href={`mailto:${assignee.email}`} className="p-2.5 rounded-lg text-primary-text hover:bg-primary/10 transition-all border border-border hover:border-primary/40" onClick={e => e.stopPropagation()}>
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

function TaskCardImpl({ task, isOwner, isAdmin, currentUserId, onTaskUpdated, expandedTaskId, setExpandedTaskId, onOpenDetail, onOpenProofDrawer }: any) {
  const isExpanded = expandedTaskId === task.id;
  const canEdit = isOwner || isAdmin;
  const isCompleted = task.status === 'completed';
  const taskAssigneeIds: string[] = Array.isArray((task as any).assigneeIds) && (task as any).assigneeIds.length
    ? (task as any).assigneeIds.map(String)
    : (task.assigneeId ? [String(task.assigneeId)] : []);
  const isYourTurn = taskAssigneeIds.includes(String(currentUserId)) && task.isCurrentStep && !isCompleted;
  // Deadline fairness (founder rule, 2026-10-26): submitted-for-review
  // never renders as overdue; the task is waiting on the reviewer, the
  // same exemption the silent-assignee rule below already applies.
  const isOverdue = task.deadline && isPast(task.deadline) && !isCompleted && !statusExemptsOverdue(task.status);
  // Silent-assignee detection: an incomplete task counts as silent when nobody
  // has touched it for 2+ days (no save, no submit, no check-in). Every PATCH
  // on /api/tasks stamps updatedAt server-side, so updatedAt is the last
  // activity. completed and submitted-for-review tasks never count as silent:
  // a completed task is done, and a submitted task is waiting on the reviewer.
  const lastActivityAt = safeDate(task.updatedAt) || safeDate(task.createdAt);
  const silentHours = lastActivityAt ? differenceInHours(new Date(), lastActivityAt) : 0;
  const silentDays = Math.floor(silentHours / 24);
  const isSilent = !isCompleted && task.status !== 'submitted-for-review' && silentHours >= 48;
  const viewerIsAssignee = taskAssigneeIds.includes(String(currentUserId));
  // Check-in state: records that the assignee is on the task without changing
  // its report, status, or files. The PATCH sends the report back unchanged,
  // and the server stamps updatedAt, which resets the silence clock.
  const [isCheckingIn, setIsCheckingIn] = useState(false);

  // Live mirror of the expanded card's report text. The text itself is
  // owned by TaskReportForm; the check-in below only reads the current
  // value, and a ref keeps typing from re-rendering this card.
  const reportValueRef = useRef(task.report || '');

  // Workflow Data
  const [steps, setSteps] = useState<any[]>([]);
  const [names, setNames] = useState<Record<string, any>>({});
  const [loadingContext, setLoadingContext] = useState(false);


  // Lazy visibility: the workflow context (team strip + mission
  // sequence) is only fetched once the card is expanded OR scrolls
  // near the viewport. Previously EVERY card fired its own
  // /api/workflows request on mount — no cache, no dedupe — so a
  // profile with dozens of workflow tasks (the founder's) opened
  // with dozens of parallel requests for data mostly below the fold.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [nearVisible, setNearVisible] = useState(false);
  useEffect(() => {
    if (nearVisible) return;
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNearVisible(true); return; }
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some(e => e.isIntersecting)) setNearVisible(true); },
      { rootMargin: '400px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nearVisible]);

  // Unified Context Hydration — gated on expansion/visibility and
  // served by the shared deduplicating loader, so cards in the same
  // workflow share one request and one cached payload.
  const shouldLoadContext = isExpanded || nearVisible;
  useEffect(() => {
    if (!task.workflowId || !shouldLoadContext) return;
    let cancelled = false;
    setLoadingContext(true);
    (async () => {
      const result = await loadWorkflowContext(task.workflowId, async () => {
        const { getAuth } = await import('firebase/auth');
        const user = getAuth().currentUser;
        return user ? user.getIdToken() : null;
      });
      if (cancelled) return;
      if (result) {
        setSteps(result.steps);
        setNames(result.names);
      }
      setLoadingContext(false);
    })();
    return () => { cancelled = true; };
  }, [task.workflowId, shouldLoadContext]);

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


  const handleCheckin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isCheckingIn) return;
    setIsCheckingIn(true);
    try {
      const { getAuth } = await import('firebase/auth');
      const token = await getAuth().currentUser?.getIdToken();
      // Only allowed fields may ride in updates (the API schema is strict).
      // Sending the report back unchanged is a no-op on the data, while the
      // server stamps updatedAt, which records the check-in and resets the
      // silence flag.
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, updates: { report: reportValueRef.current } })
      });
      if (!res.ok) throw new Error();
      toast.success("Check-in recorded. Mission Command knows you are on it.");
      onTaskUpdated();
    } catch (err) {
      toast.error("Check-in failed. Please try again.");
    } finally {
      setIsCheckingIn(false);
    }
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
    <>
    <div ref={cardRef} className={`group relative overflow-hidden rounded-lg border transition-all duration-300 bg-card ${isYourTurn ? 'border-primary/60 dark:bg-primary/[0.04]' : isCompleted ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-border'}`} onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}>
      
      {/* ── CARD HUD: Mission Timeline ── */}
      {task.workflowId && teamMembers.length > 0 && (
          <div className="border-b border-border/60 bg-muted/40 px-4 sm:px-8 py-6">
              <WorkflowTeamContext members={teamMembers} currentUserId={currentUserId} />
          </div>
      )}

      <div className="relative p-4 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 lg:gap-8">
          <div className="flex-1 min-w-0 space-y-4 sm:space-y-5">
            <div className="flex items-start gap-3 sm:gap-4">
              <div className={`flex-shrink-0 h-10 w-10 sm:h-12 sm:w-12 rounded-lg flex items-center justify-center border transition-all duration-300 ${isYourTurn ? 'bg-primary/15 border-primary/50 text-primary-text' : isCompleted ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'bg-muted/50 border-border text-muted-foreground'}`}>
                {isCompleted ? <CheckCircle2 className="h-5 w-5 sm:h-6 sm:w-6" /> : isYourTurn ? <Zap className="h-5 w-5 sm:h-6 sm:w-6 fill-current" /> : getStatusIcon(task.status)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <Badge variant="outline" className="text-xs font-accent font-semibold border-border bg-muted/50 text-primary-text px-2.5 h-6 uppercase tracking-[0.15em] whitespace-nowrap overflow-hidden text-ellipsis">DIRECTIVE # {task.id.slice(0, 8)}</Badge>
                  <StatusBadge status={isOverdue ? 'overdue' : task.status} size="sm" variant="solid" className="font-accent font-semibold tracking-widest h-6 px-3 text-xs whitespace-nowrap" />
                  {/* Silent-assignee flag: no activity on this task for 2+ days. */}
                  {isSilent && (
                    <span className="inline-flex items-center gap-1.5 font-accent text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-3 h-6 whitespace-nowrap">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      No update in {silentDays > 2 ? `${silentDays} days` : '2+ days'}
                    </span>
                  )}
                </div>
                <h3 className="text-[clamp(1.5rem,1.2rem+1.2vw,2rem)] font-heading tracking-[0.02em] text-foreground leading-[1.05] group-hover:text-primary-text transition-colors uppercase break-words">{task.title}</h3>
                
                {/* ── RESOURCE CHIPS ── */}
                {hasResources && (
                    <div className="flex flex-wrap gap-2 sm:gap-3 mt-4 sm:mt-6">
                        {Array.isArray(task.resources) ? task.resources.map((res: any, idx: number) => (
                            <a key={idx} href={res.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 sm:px-4 rounded-md bg-card border border-border hover:border-primary/50 hover:bg-primary/10 transition-all font-accent text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground hover:text-primary-text min-h-[44px]" onClick={e => e.stopPropagation()}>
                                {res.type === 'drive' ? <LayoutGrid className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> : res.type === 'github' ? <Github className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" /> : <ExternalLink className="h-3 w-3 sm:h-4 sm:w-4 shrink-0" />} <span className="break-words">{res.title}</span>
                            </a>
                        )) : task.resourceLinks?.split('\n').filter(Boolean).map((link: string, idx: number) => (
                            <a key={idx} href={link.startsWith('http') ? link : `https://${link}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 sm:px-4 rounded-md bg-card border border-border hover:border-primary/50 font-accent text-[10px] font-semibold uppercase tracking-[0.15em] text-primary-text hover:bg-primary/5 transition-all min-h-[44px]" onClick={e => e.stopPropagation()}>
                                <ExternalLink className="h-3 w-3 shrink-0" /> <span className="break-words">ATTACHMENT {idx + 1}</span>
                            </a>
                        ))}
                    </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-[1.5fr_1fr_1fr] sm:grid-cols-3 divide-x divide-border/70 border-y border-border/70 py-3 sm:py-4">
              <div className="px-3 sm:px-5 first:pl-0 min-w-0 overflow-hidden">
                <p className="font-accent text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.25em] mb-1.5 flex items-center gap-1.5 whitespace-nowrap"><Timer className="h-3 w-3 shrink-0 text-primary-text" /> Ends In</p>
                <CountdownTimer expiryDate={task.deadline} hideLabel className="border-none bg-transparent p-0 font-accent text-[10px] sm:text-[13px] tracking-tight whitespace-nowrap max-w-full" />
              </div>
              <div className="px-3 sm:px-5 min-w-0">
                <p className="font-accent text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.25em] mb-1.5 flex items-center gap-1.5 whitespace-nowrap"><Target className="h-3 w-3 shrink-0 text-primary-text" /> Bounty</p>
                <p className="font-heading text-xl sm:text-2xl leading-none text-foreground whitespace-nowrap">{task.points} <span className="font-accent text-[10px] font-semibold text-primary-text tracking-[0.2em]">PTS</span></p>
              </div>
              <div className="px-3 sm:px-5 min-w-0">
                <p className="font-accent text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.25em] mb-1.5 flex items-center gap-1.5 whitespace-nowrap"><ActivityIcon className="h-3 w-3 shrink-0 text-primary-text" /> Sync</p>
                <div className="flex items-center gap-2"><div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full bg-primary" style={{ width: `${syncPercentage}%` }} /></div><span className="text-xs font-code font-bold text-foreground/80">{syncPercentage}%</span></div>
              </div>
            </div>
          </div>

          <div className="flex flex-row flex-wrap lg:flex-col items-center lg:items-end gap-2 shrink-0 w-full lg:w-auto">
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
                  className="h-11 w-11 shrink-0 rounded-lg border border-border text-emerald-600 dark:text-emerald-400 hover:border-emerald-500/50 hover:bg-emerald-500/10 transition-all flex items-center justify-center"
                >
                  <MessageCircle className="h-4 w-4" />
                </a>
              )}
              <Button variant="outline" size="icon" className="h-11 w-11 shrink-0 rounded-lg border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground transition-all" onClick={(e) => { e.stopPropagation(); onOpenDetail(task); }}><Pencil className="h-4 w-4" /></Button>
              {viewerIsAssignee && !isCompleted && onOpenProofDrawer && (
                <Button variant="outline" size="icon" aria-label={`Submit proof for "${task.title}"`} title="Submit proof (drawer)" className="h-11 w-11 shrink-0 rounded-lg border-primary/40 bg-primary/10 text-primary-text hover:bg-primary hover:text-primary-foreground transition-all" onClick={(e) => { e.stopPropagation(); onOpenProofDrawer(task, names); }}><Send className="h-4 w-4" /></Button>
              )}
              <Button variant="outline" size="icon" className={`h-11 w-11 shrink-0 rounded-lg border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground transition-all ${isExpanded ? 'bg-primary text-primary-foreground border-primary' : ''}`} onClick={(e) => { e.stopPropagation(); setExpandedTaskId(isExpanded ? null : task.id); }}>
                {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        {/* ── PERSONNEL ── */}
        <div className="mt-6 pt-6 border-t border-border/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
            <div className="flex items-center gap-3 min-w-0">
                <div className="relative shrink-0">
                    <Avatar className="h-10 w-10 sm:h-12 sm:w-12 border border-border">
                        <AvatarImage src={currentOp.photoURL} />
                        <AvatarFallback className="bg-muted font-accent font-semibold text-xs uppercase">OP</AvatarFallback>
                    </Avatar>
                    {isYourTurn && <div className="absolute -top-1 -right-1 h-5 w-5 bg-primary rounded-full border-2 border-card flex items-center justify-center"><Zap className="h-3 w-3 text-primary-foreground" /></div>}
                </div>
                <div className="min-w-0">
                    <p className="flex items-center gap-2 min-w-0"><span className="font-heading text-foreground text-xl leading-none tracking-[0.03em] uppercase truncate">{currentOp.name || 'Pending Assignment'}</span>{isYourTurn && <span className="shrink-0 font-accent text-[10px] font-semibold text-primary-text bg-primary/10 px-2 py-0.5 rounded border border-primary/20 uppercase tracking-[0.15em]">YOU</span>}</p>
                    <p className="font-accent text-[10px] font-semibold text-primary-text uppercase tracking-[0.2em] mt-1">{currentOp.role || 'Personnel Required'}</p>
                    {(currentOp.whatsapp || currentOp.email) && currentOp.uid !== currentUserId && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                            {currentOp.whatsapp && (
                                <a href={`https://wa.me/${currentOp.whatsapp.replace(/[^0-9]/g, '')}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors" onClick={e => e.stopPropagation()}><Phone className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" /> <span className="break-all">{currentOp.whatsapp}</span></a>
                            )}
                            {currentOp.email && (
                                <a href={`mailto:${currentOp.email}`} className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors" onClick={e => e.stopPropagation()}><Mail className="h-3 w-3 shrink-0 text-primary-text" /> <span className="break-all">{currentOp.email}</span></a>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                    <p className="font-accent font-semibold text-foreground/90 text-[10px] tracking-[0.2em] uppercase">Mission Command</p>
                    <p className="text-[11px] font-code text-muted-foreground uppercase mt-0.5">Issued {safeDate(task.createdAt) ? format(safeDate(task.createdAt)!, 'MMM dd, yyyy') : 'Recently'}</p>
                </div>
                <Avatar className="h-9 w-9 border border-border">
                    <AvatarImage src={names[task.assignerId]?.photoURL} />
                    <AvatarFallback className="bg-muted text-xs font-accent font-semibold">HQ</AvatarFallback>
                </Avatar>
            </div>
        </div>

        {/* ── SILENT ASSIGNEE CHECK-IN ── */}
        {isSilent && viewerIsAssignee && (
          <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className="h-10 w-10 rounded-lg border border-amber-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-300" />
              </div>
              <div className="min-w-0">
                <p className="font-heading text-lg tracking-[0.02em] text-foreground leading-tight">No update in {silentDays > 2 ? `${silentDays} days` : '2+ days'}.</p>
                <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">Tap the button to let Mission Command know you are still on it, or open this task and log your progress.</p>
              </div>
            </div>
            <Button
              onClick={handleCheckin}
              disabled={isCheckingIn}
              className="w-full sm:w-auto h-11 px-6 rounded-lg bg-primary text-primary-foreground font-accent font-semibold uppercase tracking-[0.15em] text-[11px] hover:bg-primary/90 transition-all shrink-0"
            >
              {isCheckingIn ? 'Recording...' : 'Confirm you are on it'}
            </Button>
          </div>
        )}

        {/* ── EXPANDED INTEL ── */}
        {isExpanded && (
          <div className="mt-6 pt-6 sm:mt-12 sm:pt-12 border-t border-border/40 animate-in fade-in slide-in-from-top-6 duration-700 space-y-6 sm:space-y-12" onClick={(e) => e.stopPropagation()}>

            {/* Vertical stack: Briefing → SITREP → Steps (full width, no side-by-side squeeze) */}
            <div className="space-y-6">

              {/* ── Operational Briefing (full width) ── */}
              <div className="space-y-6">
                {task.description && (
                  <div className="bg-muted/30 p-4 sm:p-8 rounded-lg border border-border/60 min-w-0">
                    <h4 className="font-accent text-[11px] font-semibold uppercase tracking-[0.25em] sm:tracking-[0.3em] text-primary-text mb-4 sm:mb-6 flex items-center gap-2 sm:gap-3">
                        <ClipboardList className="h-4 w-4 shrink-0" /> Operational Briefing
                    </h4>
                    <StructuredBriefing description={task.description} />
                  </div>
                )}
              </div>

              {/* ── SITREP Panel: TaskReportForm owns the typing state, so
                  keystrokes never re-render the briefing, steps, team
                  strip, or chat around it. ── */}
              <TaskReportForm
                task={task}
                canEdit={canEdit}
                onTaskUpdated={onTaskUpdated}
                onExpand={() => setExpandedTaskId(task.id)}
                reportValueRef={reportValueRef}
              />

              {/* ── Mission Sequence (full width) ── */}
              {task.workflowId && (
                <div className="p-4 sm:p-6 rounded-lg border border-border/60 min-w-0 overflow-hidden">
                  <WorkflowStepsList steps={steps} names={names} currentTaskId={task.id} currentUserId={currentUserId} />
                </div>
              )}
            </div>

            {/* Phase 3: Collaborative Uplink */}
            {task.workflowId && (
              <div className="bg-card p-4 sm:p-10 rounded-lg border border-border space-y-6 sm:space-y-10 animate-in slide-in-from-bottom-12 duration-1000 min-w-0 overflow-hidden">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/60 pb-6 sm:pb-8 sm:px-4">
                    <div className="space-y-2 min-w-0">
                        <h4 className="font-accent text-sm sm:text-base font-semibold uppercase tracking-[0.25em] sm:tracking-[0.3em] text-primary-text flex items-center gap-2 sm:gap-4"><MessageSquare className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" /> <span className="break-words">Collaborative Mission Uplink</span></h4>
                        <p className="font-accent text-[10px] text-muted-foreground font-semibold uppercase tracking-[0.2em]">Secured real-time sequence coordination</p>
                    </div>
                    <Badge className="bg-muted text-muted-foreground font-accent font-semibold px-4 sm:px-6 py-2 tracking-[0.2em] animate-pulse border border-border rounded-md whitespace-nowrap self-start sm:self-auto">UPLINK ENCRYPTED</Badge>
                </div>
                <div className="rounded-lg overflow-hidden border border-border bg-muted/30">
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


    </>
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
  // Proof submission drawer: the dedicated slide-in for attaching proof,
  // writing notes, and submitting for review. onOpenProofDrawer is passed
  // to cards with the card's workflow assignee info (name/photo lookup).
  const [proofDrawerTask, setProofDrawerTask] = useState<any>(null);
  const [proofDrawerInfo, setProofDrawerInfo] = useState<Record<string, any>>({});
  const [proofDrawerOpen, setProofDrawerOpen] = useState(false);
  const onOpenProofDrawer = (task: any, info?: Record<string, any>) => {
    setProofDrawerTask(task);
    setProofDrawerInfo(info || {});
    setProofDrawerOpen(true);
  };

  const onOpenDetail = (task: any, tab?: 'overview' | 'report' | 'activity') => {
    // The pencil affordance suggests editing: the submitter's work surface (submission form)
    // lives on the Mission Report tab, and QR deep links already open there. Default assignees
    // to the report tab; everyone else keeps the Briefing overview.
    const viewerIsAssignee = !!currentUser?.uid && (
      task?.assigneeId === currentUser.uid ||
      (Array.isArray(task?.assigneeIds) && task.assigneeIds.includes(currentUser.uid))
    );
    setSelectedTaskForDetail(task);
    setDetailInitialTab(tab ?? (viewerIsAssignee ? 'report' : 'overview'));
    setDetailDialogOpen(true);
  };
  const [manualRefresh, setManualRefresh] = useState(0);

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

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

  const { data: fetchedTasks, loading: fetching } = useCollection(tasksQuery, { listen: !initialTasks });
  const { data: fetchedCoTasks, loading: fetchingCo } = useCollection(tasksQueryArray, { listen: !initialTasks });

  // Consumption boundary: this board shows only tasks ASSIGNED to the
  // profile owner (assigneeId / assigneeIds). workflowParticipantIds is
  // deliberately NOT a source here — POST /api/tasks stamps the creator
  // into that field on every task, so matching it rendered everything the
  // viewer had ever assigned out as their own active directives. The
  // server-fed list (GET /api/profile/[userId]) is assignee-only and stays
  // authoritative whenever it is present: exactly one source family feeds
  // the board, and live-query results are never merged into it. A manual
  // refresh switches wholesale to the live assignee queries, which are
  // scoped to the same assignee fields.
  const tasks = useMemo(() => {
    const primaryTasks = (initialTasks && manualRefresh === 0) ? initialTasks : [...(fetchedTasks || []), ...(fetchedCoTasks || [])];
    const taskMap = new Map();
    primaryTasks.forEach((t: any) => { if (!taskMap.has(t.id)) taskMap.set(t.id, t); });
    return Array.from(taskMap.values());
  }, [initialTasks, manualRefresh, fetchedTasks, fetchedCoTasks]);

  // Auto-open task detail when initialTaskId is provided (e.g. from QR code deep link)
  useEffect(() => {
    if (!initialTaskId) return;
    const target = (tasks || []).find((t: any) => t.id === initialTaskId);
    if (target) {
      onOpenDetail(target, 'report');
    }
  }, [initialTaskId, tasks]);

  const loading = (initialTasks && manualRefresh === 0) ? false : (fetching || fetchingCo);

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
      // Both terminal spellings leave the active board: approval can stamp
      // 'approved' instead of 'completed', and the old filter recognised
      // only 'completed', so approved tasks never drained from this board.
      const isNotTerminal = t.status !== 'completed' && t.status !== 'approved';
      return matchesStatus && matchesProject && isNotTerminal;
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

  // Render budget: mount at most TASK_RENDER_BUDGET task cards at a
  // time. Every card carries timers, avatars and (when visible) a
  // workflow team strip, so mounting a power user's full board at
  // once (89+ tasks) blocked first paint. Remaining cards mount via
  // the "Show more" button below; filters reset the budget. Visible
  // behaviour for normal-length boards is unchanged (they fit whole).
  const TASK_RENDER_BUDGET = 30;
  const [renderBudget, setRenderBudget] = useState(TASK_RENDER_BUDGET);
  useEffect(() => { setRenderBudget(TASK_RENDER_BUDGET); }, [statusFilter, projectFilter]);
  useEffect(() => {
    if (!expandedTaskId) return;
    const idx = normalized.findIndex((t: any) => t.id === expandedTaskId);
    if (idx >= renderBudget) setRenderBudget(idx + 1);
  }, [expandedTaskId, normalized, renderBudget]);

  const { visibleMissions, hiddenTaskCount } = useMemo(() => {
    let remaining = renderBudget;
    let rendered = 0;
    const visible: typeof categorizedMissions = [];
    for (const group of categorizedMissions) {
      if (remaining <= 0) break;
      const tasksSlice = group.tasks.slice(0, remaining);
      if (tasksSlice.length === 0) continue;
      visible.push({ ...group, tasks: tasksSlice });
      remaining -= tasksSlice.length;
      rendered += tasksSlice.length;
    }
    return { visibleMissions: visible, hiddenTaskCount: Math.max(0, normalized.length - rendered) };
  }, [categorizedMissions, normalized.length, renderBudget]);

  const [userNameCache, setUserNameCache] = useState<Record<string, any>>({});
  useEffect(() => {
    // The name/photo cache only feeds the task DETAIL DIALOG (opened
    // for one task at a time). It used to run a sequential getDoc per
    // unique assigner/assignee across the WHOLE board on mount; now
    // it resolves only the expanded/dialog task's people, on demand.
    if (!firestore || !expandedTaskId) return;
    const fetchUserNames = async () => {
      const uids = new Set<string>();
      normalized
        .filter((t: any) => t.id === expandedTaskId || (selectedTaskForDetail && t.id === selectedTaskForDetail.id))
        .forEach((t: any) => { if (t.assignerId) uids.add(t.assignerId); if (t.assigneeId) uids.add(t.assigneeId); });
      if (uids.size === 0) return;
      const info: Record<string, any> = {};
      for (const uid of Array.from(uids)) {
        try {
          const userDoc = await getDoc(doc(firestore, 'users', uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            info[uid] = { name: data?.displayName || uid, photoURL: data?.photoURL };
          } else { info[uid] = { name: uid }; }
        } catch { info[uid] = { name: uid }; }
      }
      setUserNameCache(info);
    };
    fetchUserNames();
  }, [firestore, normalized, expandedTaskId, selectedTaskForDetail]);

  return (
    <Card className="mt-8 border-none shadow-none bg-transparent">
      <CardHeader className="px-0 pt-0 flex flex-row items-center justify-between pb-8">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-4 font-heading text-4xl sm:text-5xl tracking-[0.02em] uppercase text-foreground leading-none">
            <div className="p-2.5 bg-primary/10 rounded-lg border border-primary/30">
              <Zap className="h-6 w-6 text-primary-text" />
            </div>
            <div className="flex flex-col">
                <span>Mission Control</span>
                {!loading && <span className="font-accent text-[10px] font-semibold border-primary/40 bg-primary/10 text-primary-text uppercase tracking-[0.3em] px-4 py-1 rounded-full mt-2 border max-w-fit">{normalized.length} ACTIVE DIRECTIVES</span>}
            </div>
          </CardTitle>
        </div>
        <Button variant="outline" size="icon" onClick={() => setManualRefresh(prev => prev + 1)} className="h-11 w-11 rounded-lg border-border bg-card hover:border-primary/50 transition-all group"><RefreshCw className={`h-5 w-5 group-hover:rotate-180 transition-transform duration-500 ${loading ? 'animate-spin' : ''}`} /></Button>
      </CardHeader>
      
      {!loading && normalized.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-4 mb-8 px-1 items-center">
          <div className="flex flex-col sm:flex-row gap-4 flex-1 w-full">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full max-w-[240px] bg-card border border-border hover:border-primary/50 h-11 font-accent text-[11px] font-semibold uppercase tracking-[0.2em] rounded-lg px-5"><div className="flex items-center gap-3"><Filter className="h-4 w-4 text-primary-text" /><SelectValue placeholder="Status" /></div></SelectTrigger>
                <SelectContent className="bg-card border border-border text-foreground"><SelectItem value="all">ALL STATUSES</SelectItem><SelectItem value="pending">STANDBY (TO DO)</SelectItem><SelectItem value="in-progress">ACTIVE (IN PROGRESS)</SelectItem><SelectItem value="submitted-for-review">IN REVIEW</SelectItem><SelectItem value="overdue">OVERDUE</SelectItem></SelectContent>
            </Select>
            {uniqueProjects.length > 0 && (
                <Select value={projectFilter} onValueChange={setProjectFilter}>
                    <SelectTrigger className="w-full max-w-[260px] bg-card border border-border hover:border-primary/50 h-11 font-accent text-[11px] font-semibold uppercase tracking-[0.2em] rounded-lg px-5"><div className="flex items-center gap-3"><Target className="h-4 w-4 text-primary-text" /><SelectValue placeholder="Project" /></div></SelectTrigger>
                    <SelectContent className="bg-card border border-border text-foreground"><SelectItem value="all">ALL PROJECTS</SelectItem><SelectItem value="uncategorized">AUTONOMOUS DIRECTIVES</SelectItem>{uniqueProjects.map(p => (<SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>))}</SelectContent>
                </Select>
            )}
          </div>
          <div className="flex items-center bg-card border border-border rounded-lg p-1 h-11">
            <Button variant="ghost" size="sm" className={`h-full px-5 font-accent text-[11px] font-semibold uppercase tracking-[0.15em] gap-2 transition-all duration-300 rounded-md ${viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setViewMode('grid')}><LayoutGrid className="h-4 w-4" /> Grid</Button>
            <Button variant="ghost" size="sm" className={`h-full px-5 font-accent text-[11px] font-semibold uppercase tracking-[0.15em] gap-2 transition-all duration-300 rounded-md ${viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setViewMode('list')}><List className="h-4 w-4" /> List</Button>
          </div>
        </div>
      )}

      <CardContent className="px-0">
        {!loading && normalized.length === 0 ? <div className="text-center py-24 border border-dashed rounded-lg border-border"><CheckCircle2 className="h-16 w-16 mx-auto text-muted-foreground/40 mb-6" /><p className="font-heading text-3xl text-muted-foreground uppercase tracking-[0.05em]">All Systems Nominal.</p><p className="text-sm text-muted-foreground font-code mt-2 uppercase tracking-widest">No active mission directives detected.</p></div> : (
          <div className="space-y-8">
            {visibleMissions.map(group => (
              <div key={group.id} className="animate-in fade-in slide-in-from-bottom-8 duration-1000">
                <div className="flex items-center justify-center mb-6 mt-8 relative"><div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border/60"></div></div><Badge variant="outline" className="relative tracking-[0.3em] font-accent text-[10px] font-semibold uppercase py-2 px-6 bg-card border border-border text-primary-text flex items-center gap-3 rounded-full max-w-[92%] text-center justify-center"><div className="h-2 w-2 rounded-full bg-primary animate-pulse" />{group.title}</Badge></div>
                <div className="space-y-6">
                    {group.tasks.map((task: any) => (<TaskCard key={task.id} task={task} isOwner={isOwner} isAdmin={isAdmin} currentUserId={currentUser?.uid} onTaskUpdated={() => setManualRefresh(prev => prev + 1)} expandedTaskId={expandedTaskId} setExpandedTaskId={setExpandedTaskId} onOpenDetail={(t: any, tab?: string) => onOpenDetail(t, tab as any)} onOpenProofDrawer={onOpenProofDrawer} />))}
                </div>
              </div>
            ))}
            {hiddenTaskCount > 0 && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  onClick={() => setRenderBudget(prev => prev + TASK_RENDER_BUDGET)}
                  className="h-11 px-8 rounded-lg border border-border bg-card font-accent text-[11px] font-semibold uppercase tracking-[0.2em] hover:border-primary/50"
                >
                  Show more directives ({hiddenTaskCount} remaining)
                </Button>
              </div>
            )}
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

      {/* Dedicated proof submission drawer (slide-in, not the detail modal). */}
      <ProofSubmissionDrawer
        task={proofDrawerTask}
        open={proofDrawerOpen}
        onOpenChange={setProofDrawerOpen}
        assigneeInfo={proofDrawerInfo}
        onTaskUpdated={() => setManualRefresh(prev => prev + 1)}
      />
    </Card>
  );
}
