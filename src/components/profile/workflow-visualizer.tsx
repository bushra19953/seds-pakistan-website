import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFirestore, useCollection, useUser } from '@/firebase';
import { collection, query, where, orderBy, limit, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import CountdownTimer from '@/components/ui/countdown-timer';
import { User, AlertTriangle, CheckCircle, Activity, Circle, Eye, Users, Link2, ExternalLink } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDistanceToNow } from 'date-fns';

export default function WorkflowVisualizer({ workflowId, headerTitle, enabled = false }: { workflowId: string; headerTitle?: string; enabled?: boolean }) {
  const { user } = useUser();
  const firestore = useFirestore();
  const envRealtime = String(process.env.NEXT_PUBLIC_REALTIME_ENABLED).toLowerCase() === 'true';
  const realtime = enabled || envRealtime;

  // Presence Logic
  const [presence, setPresence] = useState<any[]>([]);

  useEffect(() => {
    if (!firestore || !workflowId || !realtime) return;

    const q = query(
      collection(firestore, 'workflow_presence'),
      where('workflowId', '==', workflowId)
    );

    const unsub = onSnapshot(q, (snap) => {
      const list: any[] = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.isOnline) {
          list.push({ ...data, id: d.id });
        }
      });
      setPresence(list);
    });

    return () => unsub();
  }, [firestore, workflowId, realtime]);

  const wfQueryAll = useMemoFirebase(
    () => {
      if (!firestore || !workflowId) return null as any;
      return query(
        collection(firestore, 'tasks'),
        where('workflowId', '==', workflowId),
        orderBy('sequenceIndex', 'asc')
      );
    },
    [firestore, workflowId]
  );
  const { data: wfTasks } = useCollection(wfQueryAll as any, { listen: realtime });

  const msgsQuery = useMemoFirebase(
    () => {
      if (!firestore || !workflowId || !user?.uid) return null as any;
      return query(
        collection(firestore, 'messages'),
        where('workflowId', '==', workflowId),
        where('participantIds', 'array-contains', user.uid),
        orderBy('createdAt', 'desc'),
        limit(10)
      );
    },
    [firestore, workflowId, user?.uid]
  );
  const { data: wfMsgs } = useCollection(msgsQuery as any, { listen: realtime });

  const [names, setNames] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const run = async () => {
      const ids = Array.from(new Set((wfTasks || []).map((t: any) => String(t.assigneeId || '')))).filter(Boolean);
      const next: Record<string, string> = {};
      await Promise.all(ids.map(async (uid) => {
        try {
          const snap = await getDoc(doc(firestore, 'users', uid));
          next[uid] = String((snap.data() as any)?.displayName || uid);
        } catch { }
      }));
      setNames(next);
    };
    if (wfTasks && wfTasks.length) run();
  }, [wfTasks, firestore]);

  const title = headerTitle || (wfTasks && wfTasks[0]?.workflowTitle) || 'Workflow';
  const masterFinalDeadline = (wfTasks && wfTasks[0]?.deadline) || null;
  const currentIndex = (wfTasks || []).findIndex((t: any) => !!t.isCurrentStep);
  const visibleTasks = (() => {
    const list = wfTasks || [];
    if (showAll || list.length <= 7) return list;
    const prev = currentIndex > 0 ? [list[currentIndex - 1]] : [];
    const curr = currentIndex >= 0 ? [list[currentIndex]] : [];
    const next = currentIndex >= 0 && currentIndex + 1 < list.length ? [list[currentIndex + 1]] : [];
    return [...prev, ...curr, ...next];
  })();

  const getStepStatus = (task: any) => {
    const isCompleted = String(task.status) === 'completed';
    const isCurrent = !!task.isCurrentStep;
    const isInProgress = String(task.status) === 'in-progress';
    const isOverdue = String(task.status) === 'overdue';
    return { isCompleted, isCurrent, isInProgress, isOverdue };
  };

  const getStepIcon = (status: any) => {
    const iconClass = 'h-5 w-5';
    if (status.isCompleted) return <CheckCircle className={`${iconClass} text-green-500`} />;
    if (status.isCurrent) return <Activity className={`${iconClass} text-blue-500 animate-pulse`} />;
    if (status.isOverdue) return <AlertTriangle className={`${iconClass} text-red-500`} />;
    return <Circle className={`${iconClass} text-gray-400`} />;
  };

  const totalSteps = (wfTasks || []).length;
  const completedSteps = (wfTasks || []).filter((t: any) => String(t.status) === 'completed').length;
  const progressPercentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  const listRef = useRef<HTMLDivElement>(null);
  const useVirtual = showAll && totalSteps > 50;
  // Always call the hook (rules of hooks); inert when virtualization is off.
  const virtualizer = useVirtualizer({
    count: useVirtual ? visibleTasks.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 80,
    overscan: 10,
  });

  return (
    <div className="mt-4 border-t pt-4 bg-muted/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <span className="text-xs text-muted-foreground">({completedSteps}/{totalSteps})</span>
        </div>
        <div className="flex items-center gap-4">
          {presence.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Viewing:</span>
              <div className="flex -space-x-2">
                {presence.slice(0, 3).map((p) => (
                  <TooltipProvider key={p.id}>
                    <Tooltip>
                      <TooltipTrigger>
                        <Avatar className="h-6 w-6 border-2 border-background">
                          <AvatarImage src={p.userPhoto} alt={p.userName} />
                          <AvatarFallback className="text-[10px] bg-primary/20 text-primary">
                            {(p.userName || 'U').charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">{p.userName}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ))}
                {presence.length > 3 && (
                  <div className="h-6 w-6 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[10px] text-muted-foreground">
                    +{presence.length - 3}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-muted-foreground">{progressPercentage}%</div>
            <div className="w-16 h-2 bg-muted rounded-full overflow-hidden border border-border">
              <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progressPercentage}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div className="relative">
        <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-primary/20" />
        <div ref={listRef} className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
          {(useVirtual ? virtualizer.getVirtualItems() : visibleTasks.map((_: any, i: number) => ({ index: i, start: 0, size: 0 }))).map((vi: any) => {
            const index = vi.index;
            const task = visibleTasks[index];
            const status = getStepStatus(task);
            const assigneeName = names[String(task.assigneeId || '')] || String(task.assigneeId || '');
            const deadlineTs = task.individualDeadline || task.deadline;
            const deadline = deadlineTs && typeof deadlineTs.toDate === 'function' ? deadlineTs.toDate() : (deadlineTs ? new Date(deadlineTs) : null);
            const description = task.description || '';

            return (
              <div key={task.id} style={useVirtual ? { transform: `translateY(${vi.start}px)` } : undefined} className={`relative flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 border ${status.isCurrent ? 'bg-background border-primary/50 shadow-sm' :
                status.isCompleted ? 'bg-muted/50 border-transparent opacity-75' : 'bg-muted/30 border-transparent'
                }`}>
                <div className="flex items-start gap-4">
                  <div className="relative flex items-center justify-center shrink-0">
                    <div className={`absolute w-8 h-8 rounded-full border-2 ${status.isCompleted ? 'bg-green-500 border-green-500' :
                      status.isCurrent ? 'bg-primary border-primary' :
                        status.isOverdue ? 'bg-red-500 border-red-500' :
                          'bg-muted border-muted-foreground/30'
                      } ${status.isCurrent ? 'animate-pulse' : ''}`} />
                    <div className={`relative z-10 text-xs font-bold ${status.isCompleted || status.isCurrent || status.isOverdue ? 'text-white' : 'text-muted-foreground'}`}>{index + 1}</div>
                    <div className="absolute -top-1 -right-1 bg-background rounded-full p-0.5 shadow-sm">{getStepIcon(status)}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className={`text-sm font-semibold truncate ${status.isCurrent ? 'text-primary' : 'text-foreground'}`}>{task.title}</p>
                      {status.isCurrent && <Badge variant="outline" className="text-[10px] h-5 border-primary/30 text-primary">Current Step</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1 font-medium text-foreground/80"><User className="h-3 w-3" />{assigneeName} {task.role && <span className="text-primary/70">({task.role})</span>}</span>
                      {deadline && (
                        <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{deadline.toLocaleDateString()}</span>
                      )}
                      <StatusBadge
                        status={status.isCompleted ? 'completed' : status.isCurrent ? 'in-progress' : status.isOverdue ? 'overdue' : 'pending'}
                        size="xs"
                        showTooltip={false}
                      />
                    </div>
                  </div>
                </div>
                {description && (
                  <div className="pl-12">
                    <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2 hover:line-clamp-none transition-all duration-200">
                      {description}
                    </p>
                  </div>
                )}
                {/* Step Resources */}
                {Array.isArray(task.resources) && task.resources.length > 0 && (
                  <div className="pl-12 mt-2">
                    <div className="flex flex-wrap gap-1.5">
                      {task.resources.map((res: any, rIdx: number) => (
                        <a
                          key={rIdx}
                          href={res.url.startsWith('http') ? res.url : `https://${res.url}`}
                          target="_blank"
                          rel="noopener noreferrer"

                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-muted hover:bg-muted/80 border border-border text-[10px] text-foreground/80 hover:text-foreground transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          <span className="truncate max-w-[120px]">{res.title || 'Resource'}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {masterFinalDeadline && (
        <div className="mt-6 pt-3 border-t border-border text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-semibold text-foreground">Deadline</span>
              <span>{(() => { const d = typeof (masterFinalDeadline as any)?.toDate === 'function' ? (masterFinalDeadline as any).toDate() : new Date(masterFinalDeadline as any); return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; })()}</span>
            </div>
            <CountdownTimer expiryDate={masterFinalDeadline as any} ariaLabel="Time remaining" />
          </div>
        </div>
      )}

      <div className="mt-6">
        <h4 className="text-sm font-semibold mb-2 text-foreground flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Recent Activity
        </h4>
        <div className="space-y-2 bg-background rounded-md p-2 border border-border/50">
          {(wfMsgs || []).map((m: any) => {
            const date = m.createdAt?.toDate?.() || (m.createdAt ? new Date(m.createdAt) : new Date());
            return (
              <div key={m.id} className="text-xs flex flex-col py-1 border-b border-border/30 last:border-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-primary truncate mr-2">{m.senderName || m.senderId}</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {formatDistanceToNow(date, { addSuffix: true })}
                  </span>
                </div>
                <span className="text-muted-foreground break-words mt-0.5">{m.message}</span>
              </div>
            );
          })}
          {(!wfMsgs || wfMsgs.length === 0) && (<div className="text-xs text-muted-foreground italic p-2 text-center">No recent messages</div>)}
        </div>
      </div>
    </div>
  );
}