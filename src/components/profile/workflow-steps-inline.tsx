import Image from "next/image";
import * as React from 'react';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { format, isPast } from 'date-fns';
import { Clock, Users, ExternalLink } from 'lucide-react';
import CountdownTimer from '@/components/ui/countdown-timer';
import { workflowCache, inflightRequests, WORKFLOW_CACHE_DURATION, WORKFLOW_STALE_DURATION } from '@/lib/workflow-cache';

export const WorkflowStepsInline = React.memo(function WorkflowStepsInline({ workflowId, workflowTitle, currentTaskId, currentUserId }: {
    workflowId: string;
    workflowTitle?: string;
    currentTaskId: string;
    currentUserId: string;
}) {
    const [steps, setSteps] = useState<any[]>([]);
    const [names, setNames] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);

    // Fetch all workflow tasks via API
    useEffect(() => {
        if (!workflowId) return;

        let isMounted = true;

        // Check cache first
        const cached = workflowCache[workflowId];
        const now = Date.now();
        const isFresh = cached && (now - cached.timestamp < WORKFLOW_STALE_DURATION);
        const isValid = cached && (now - cached.timestamp < WORKFLOW_CACHE_DURATION);

        // If fresh cache exists, use it immediately
        if (isFresh) {
            setSteps(cached.steps);
            setNames(cached.names);
            setLoading(false);
            return;
        }

        // If stale but valid cache, show immediately but revalidate in background
        if (isValid) {
            setSteps(cached.steps);
            setNames(cached.names);
            setLoading(false);
        }

        const fetchSteps = async (): Promise<{ steps: any[], names: Record<string, string> } | null> => {
            try {
                const { getAuth } = await import('firebase/auth');
                const auth = getAuth();
                const user = auth.currentUser;
                const token = user ? await user.getIdToken() : null;

                if (!token) return null;

                const res = await fetch(`/api/workflows?workflowId=${encodeURIComponent(workflowId)}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                });
                const data = await res.json();

                if (res.ok && data.ok) {
                    const taskList = data.tasks || [];
                    const assigneeNames = data.assigneeInfo || data.assigneeNames || {};

                    // Update cache
                    workflowCache[workflowId] = { steps: taskList, names: assigneeNames, timestamp: Date.now() };

                    return { steps: taskList, names: assigneeNames };
                }
                return null;
            } catch (err) {
                console.error('[WorkflowStepsInline] Error:', err);
                return null;
            }
        };

        const doFetch = async () => {
            if (!inflightRequests[workflowId]) {
                inflightRequests[workflowId] = fetchSteps().finally(() => {
                    setTimeout(() => { delete inflightRequests[workflowId]; }, 1000);
                });
            }

            const result = await inflightRequests[workflowId];

            if (isMounted && result) {
                setSteps(result.steps);
                setNames(result.names);
            }
            if (isMounted) {
                setLoading(false);
            }
        };

        doFetch();

        return () => { isMounted = false; };
    }, [workflowId]);

    const formatDeadline = (d: any) => {
        if (!d) return null;
        try {
            const date = d?.toDate ? d.toDate() : d?.seconds ? new Date(d.seconds * 1000) : new Date(d);
            return isNaN(date.getTime()) ? null : date;
        } catch {
            return null;
        }
    };

    const completedCount = steps.filter(s => s.status === 'completed').length;

    if (loading) {
        return (
            <div className="bg-gradient-to-br from-slate-900/50 to-slate-800/30 p-5 rounded-xl mb-6 border border-slate-700/50">
                <Skeleton className="h-6 w-48 mb-4" />
                <Skeleton className="h-16 w-full mb-2" />
                <Skeleton className="h-16 w-full" />
            </div>
        );
    }

    return (
        <div className="bg-gradient-to-br from-slate-900/60 to-slate-800/40 p-5 rounded-xl mb-6 border border-slate-700/50 shadow-lg">
            <div className="flex items-center justify-between mb-4">
                <h4 className="text-base font-black uppercase tracking-wider text-foreground flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" />
                    <span className="bg-gradient-to-r from-primary to-amber-400 bg-clip-text text-transparent">
                        {workflowTitle || 'Mission Timeline'}
                    </span>
                </h4>
                <Badge variant="outline" className="text-xs font-bold border-primary/30 text-primary bg-primary/10">
                    {completedCount}/{steps.length} Complete
                </Badge>
            </div>

            <div className="mb-5">
                <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-primary via-emerald-500 to-green-500 rounded-full transition-all duration-700"
                        style={{ width: `${steps.length > 0 ? (completedCount / steps.length) * 100 : 0}%` }}
                    />
                </div>
            </div>

            <div className="space-y-3">
                {steps.map((step, idx) => {
                    const deadline = formatDeadline(step.individualDeadline || step.deadline);
                    const isCompleted = step.status === 'completed';
                    const isCurrent = step.isCurrentStep;
                    const isYou = step.assigneeId === currentUserId;
                    const isOverdue = deadline && isPast(deadline) && !isCompleted;
                    const assigneeName = step.assigneeName || names[step.assigneeId] || step.assigneeId || 'Unknown';

                    return (
                        <div
                            key={step.id}
                            className={`relative overflow-hidden rounded-xl border-2 transition-all duration-300 ${isCurrent
                                ? 'bg-gradient-to-r from-primary/20 via-primary/10 to-transparent border-primary shadow-lg shadow-primary/30'
                                : isCompleted
                                    ? 'bg-gradient-to-r from-green-500/15 to-transparent border-green-500/40'
                                    : isOverdue
                                        ? 'bg-gradient-to-r from-red-500/15 to-transparent border-red-500/40'
                                        : 'bg-card/50 border-slate-700/50 hover:border-slate-600/70'
                                }`}
                        >
                            {isCurrent && (
                                <div className="absolute inset-0 bg-gradient-to-r from-primary/10 to-transparent animate-pulse pointer-events-none" />
                            )}

                            <div className="relative p-4">
                                <div className="flex items-start gap-4">
                                    <div className={`flex-shrink-0 h-10 w-10 rounded-full flex items-center justify-center text-base font-black shadow-lg ${isCompleted
                                        ? 'bg-gradient-to-br from-green-400 to-green-600 text-foreground'
                                        : isCurrent
                                            ? 'bg-gradient-to-br from-primary to-amber-500 text-black ring-2 ring-primary/50 ring-offset-2 ring-offset-background'
                                            : isOverdue
                                                ? 'bg-gradient-to-br from-red-400 to-red-600 text-foreground'
                                                : 'bg-slate-700 text-muted-foreground border border-slate-600'
                                        }`}>
                                        {isCompleted ? '✓' : idx + 1}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap mb-2">
                                            <span className={`font-bold text-base ${isCurrent ? 'text-primary' : isCompleted ? 'text-green-400' : isOverdue ? 'text-red-400' : 'text-foreground'
                                                }`}>
                                                {step.title}
                                            </span>
                                            {isCurrent && (
                                                <Badge className="bg-gradient-to-r from-green-500 to-emerald-600 text-foreground text-[10px] h-5 px-2 font-bold shadow-md animate-pulse">
                                                    ACTIVE
                                                </Badge>
                                            )}
                                            {isCompleted && (
                                                <Badge className="bg-green-500/20 text-green-400 border border-green-500/50 text-[10px] h-5 px-2">
                                                    DONE
                                                </Badge>
                                            )}
                                            {isOverdue && !isCompleted && (
                                                <Badge className="bg-red-500/20 text-red-400 border border-red-500/50 text-[10px] h-5 px-2 animate-pulse">
                                                    OVERDUE
                                                </Badge>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap items-center gap-3 mb-3">
                                            <Link
                                                href={`/profile/unified?uid=${step.assigneeId}`}
                                                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-105 ${isYou
                                                    ? 'bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30'
                                                    : 'bg-muted text-muted-foreground border border-slate-700 hover:bg-slate-700 hover:text-foreground'
                                                    }`}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <div className={`h-6 w-6 rounded-full overflow-hidden flex-shrink-0 ${step.assigneePhoto ? '' : 'bg-slate-600 flex items-center justify-center'
                                                    }`}>
                                                    {step.assigneePhoto ? (
                                                        <Image
                                                            src={step.assigneePhoto}
                                                            alt={assigneeName}
                                                            width={24} height={24}
                                                            className="h-full w-full object-cover"
                                                        />
                                                    ) : (
                                                        <span className="text-[10px] font-bold text-muted-foreground">
                                                            {(assigneeName || 'U').charAt(0).toUpperCase()}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="font-semibold leading-tight">
                                                        {isYou ? 'You' : assigneeName}
                                                    </span>
                                                    {step.assigneePosition && (
                                                        <span className="text-[9px] opacity-70 leading-tight">
                                                            {step.assigneePosition}
                                                        </span>
                                                    )}
                                                </div>
                                            </Link>

                                            {step.role && (
                                                <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30">
                                                    {step.role}
                                                </div>
                                            )}

                                            {/* AI rationale: why this person was picked, if recorded */}
                                            {step.reason && (
                                                <div className="text-[11px] italic text-muted-foreground leading-snug max-w-xs">
                                                    AI pick: {step.reason}
                                                </div>
                                            )}

                                            {/* WhatsApp Contact */}
                                            {step.assigneeWhatsapp && (step.assigneeId !== currentUserId) && (
                                                <a
                                                    href={`https://wa.me/${step.assigneeWhatsapp.replace(/\D/g, '')}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20 transition-colors"
                                                    onClick={(e) => e.stopPropagation()}
                                                    title="Contact via WhatsApp"
                                                >
                                                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                                                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
                                                    </svg>
                                                    WhatsApp
                                                </a>
                                            )}

                                            {/* Hierarchy Role Badge */}
                                            {step.assigneeRole && !isYou && (
                                                <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium bg-violet-500/10 text-violet-400 border border-violet-500/30">
                                                    {step.assigneeRole.replace(/_/g, ' ')}
                                                </div>
                                            )}

                                            <Badge
                                                variant="outline"
                                                className={`text-[10px] h-6 px-2 font-semibold ${step.status === 'completed' ? 'border-green-500/50 text-green-400 bg-green-500/10' :
                                                    step.status === 'in-progress' ? 'border-blue-500/50 text-blue-400 bg-blue-500/10' :
                                                        step.status === 'submitted-for-review' ? 'border-yellow-500/50 text-yellow-400 bg-yellow-500/10' :
                                                            'border-slate-500/50 text-muted-foreground bg-slate-500/10'
                                                    }`}
                                            >
                                                {step.status || 'pending'}
                                            </Badge>
                                        </div>

                                        {deadline && (
                                            <div className={`flex items-center gap-2 p-2 rounded-lg ${isOverdue && !isCompleted
                                                ? 'bg-red-500/10 border border-red-500/30'
                                                : isCompleted
                                                    ? 'bg-muted/50'
                                                    : 'bg-muted/80 border border-slate-700/50'
                                                }`}>
                                                <Clock className={`h-4 w-4 flex-shrink-0 ${isOverdue && !isCompleted ? 'text-red-400' : isCompleted ? 'text-muted-foreground' : 'text-primary'
                                                    }`} />
                                                {isCompleted ? (
                                                    <span className="text-xs text-muted-foreground">
                                                        Completed on time
                                                    </span>
                                                ) : isOverdue ? (
                                                    <span className="text-xs font-bold text-red-400">
                                                        Deadline passed: {format(deadline, 'MMM d, yyyy h:mm a')}
                                                    </span>
                                                ) : (
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs text-muted-foreground">Due:</span>
                                                        <CountdownTimer
                                                            expiryDate={deadline}
                                                            className="text-xs font-mono font-bold text-primary"
                                                        />
                                                        <span className="text-[10px] text-muted-foreground">
                                                            ({format(deadline, 'MMM d, h:mm a')})
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {Array.isArray(step.resources) && step.resources.length > 0 && (
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                {step.resources.map((res: any, rIdx: number) => (
                                                    <a
                                                        key={rIdx}
                                                        href={res.url.startsWith('http') ? res.url : `https://${res.url}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"

                                                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 transition-colors"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <ExternalLink className="h-3 w-3" />
                                                        {res.title || 'Link'}
                                                    </a>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {steps.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No workflow steps found</p>
            )}
        </div>
    );
});
