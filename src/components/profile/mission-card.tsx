import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
    CheckCircle2, Clock, AlertCircle, Target,
    ChevronDown, ChevronUp, Timer, ClipboardList, ExternalLink, Zap
} from 'lucide-react';
import { format, differenceInHours, isPast } from 'date-fns';
import CountdownTimer from '@/components/ui/countdown-timer';
import { StatusBadge, getStatusConfig } from '@/components/ui/status-badge';
import { TaskDetailDialog } from './task-detail-dialog';
import { WorkflowStepsInline } from './workflow-steps-inline';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import { invalidateWorkflowCache } from '@/lib/workflow-cache';
import confetti from 'canvas-confetti';
import { SubmitButton } from '@/components/ui/submit-button';

const DynamicChat = dynamic(() => import('@/components/workflow/enhanced-workflow-chat'), { ssr: false });

interface MissionCardProps {
    task: any;
    isHero?: boolean;
    isExpanded: boolean;
    onExpand: () => void;
    currentUser: any;
    onRefresh: () => void;
    locallyCompletedTasks: Set<string>;
    onLocalComplete: (id: string) => void;
    localStatusUpdates: Record<string, string>;
    onLocalStatusUpdate: (id: string, status: string) => void;
}

export function MissionCard({
    task,
    isHero = false,
    isExpanded,
    onExpand,
    currentUser,
    onRefresh,
    locallyCompletedTasks,
    onLocalComplete,
    localStatusUpdates,
    onLocalStatusUpdate
}: MissionCardProps) {
    const [inlineStatus, setInlineStatus] = React.useState(task.status || 'pending');
    const [inlineReport, setInlineReport] = React.useState('');
    const [inlineHours, setInlineHours] = React.useState('');
    const [inlineResourceLinks, setInlineResourceLinks] = React.useState('');
    const [updatingInline, setUpdatingInline] = React.useState(false);
    const [detailDialogOpen, setDetailDialogOpen] = React.useState(false);
    const [detailInitialTab, setDetailInitialTab] = React.useState<'overview' | 'report'>('overview');

    const openDetails = (tab: 'overview' | 'report' = 'overview') => {
        setDetailInitialTab(tab);
        setDetailDialogOpen(true);
    };

    // Sync state when expanded
    React.useEffect(() => {
        if (isExpanded) {
            setInlineStatus(task.status || 'pending');
            setInlineReport(task.report || '');
            setInlineHours(typeof task.hoursWorked === 'number' && !Number.isNaN(task.hoursWorked) ? String(task.hoursWorked) : '');
            setInlineResourceLinks(task.resourceLinks || '');
        }
    }, [isExpanded, task]);

    const handleInlineUpdate = async () => {
        try {
            if (!currentUser) return;
            setUpdatingInline(true);

            let hours: number | undefined = undefined;
            if (inlineHours.trim().length > 0) {
                const parsed = parseFloat(inlineHours);
                if (Number.isNaN(parsed) || parsed < 0) {
                    setUpdatingInline(false);
                    toast.error("Please enter valid hours.");
                    return;
                }
                hours = parsed;
            }

            const idToken = await currentUser.getIdToken(true);
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: task.id,
                    updates: {
                        status: inlineStatus,
                        report: inlineReport,
                        hoursWorked: hours,
                        resourceLinks: inlineResourceLinks.trim() || undefined
                    }
                })
            });

            const data = await res.json();

            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'Update failed');
            }

            toast.success("Mission Report Filed Successfully! 🎉");
            onLocalStatusUpdate(task.id, inlineStatus);

            if (task.workflowId) {
                invalidateWorkflowCache(task.workflowId);
            }

            if (inlineStatus === 'completed') {
                confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
                onLocalComplete(task.id);
            }

            setTimeout(() => {
                setUpdatingInline(false);
                onRefresh();
            }, 1000);

        } catch (err) {
            console.error(err);
            toast.error("Failed to submit report. Please try again.");
            setUpdatingInline(false);
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'completed': return <CheckCircle2 className="h-5 w-5 text-green-500" />;
            case 'in-progress': return <Clock className="h-5 w-5 text-blue-500" />;
            case 'submitted-for-review': return <AlertCircle className="h-5 w-5 text-yellow-500" />;
            default: return <Target className="h-5 w-5 text-orange-600" />;
        }
    };

    const getStatusBorderColor = (status: string) => {
        const config = getStatusConfig(status);
        return config.border.replace('border-', 'border-') + ' ' + config.bg;
    };

    const isLocallyCompleted = locallyCompletedTasks.has(task.id);
    const isCompleted = task.status === 'completed' || isLocallyCompleted;
    const isUrgent = !isCompleted;
    const statusColor = isCompleted ? getStatusBorderColor('completed') : getStatusBorderColor(task.status);
    
    // Safe date calculations
    const deadlineDate = React.useMemo(() => {
        if (!task.deadline) return null;
        const d = new Date(task.deadline);
        return isNaN(d.getTime()) ? null : d;
    }, [task.deadline]);

    const isOverdue = deadlineDate ? isPast(deadlineDate) && !isCompleted : false;
    const isCritical = !isOverdue && deadlineDate && differenceInHours(deadlineDate, new Date()) < 24 && !isCompleted;

    // Render Logic
    if (isHero) {
        return (
            <div className={`relative overflow-hidden rounded-xl border-2 border-l-[6px] transition-all duration-300 shadow-2xl scale-[1.02] mb-6 ${statusColor} bg-slate-900/80`}>
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent animate-pulse pointer-events-none" />
                <div className="absolute right-0 top-0 h-32 w-32 bg-gradient-to-bl from-primary/20 to-transparent -mr-10 -mt-10 rotate-45 transform blur-xl" />

                <div className="relative p-6">
                    <div className="flex items-start justify-between gap-4 mb-4">
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                                <Badge className="bg-primary text-primary-foreground font-black tracking-widest uppercase animate-pulse">Priority Alpha</Badge>
                                {isCritical && <StatusBadge status="critical" size="sm" variant="outline" />}
                            </div>
                            <h3 className="text-2xl font-black text-white tracking-tight leading-none mb-2">{task.title}</h3>
                            <p className="text-slate-400 line-clamp-2 text-sm max-w-2xl">{task.description || "No briefing provided for this mission."}</p>
                        </div>
                        {task.deadline && !isCompleted && (
                            <div className="flex flex-col items-end">
                                <span className="text-[10px] uppercase tracking-widest text-primary font-bold mb-1">T-Minus</span>
                                <CountdownTimer expiryDate={task.deadline} className="text-4xl font-black font-mono text-white tracking-tighter" />
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-3 mt-4 border-t border-white/10 pt-4">
                        <Button onClick={onExpand} variant={isExpanded ? "secondary" : "default"} className={isExpanded ? "" : "bg-primary text-primary-foreground hover:bg-primary/90 font-bold"}>
                            {isExpanded ? <ChevronUp className="h-4 w-4 mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
                            {isExpanded ? "Hide Details" : "Engage Mission"}
                        </Button>
                        {!isExpanded && (
                            <div className="flex items-center gap-4 text-xs font-mono text-slate-400 ml-auto">
                                {task.points > 0 && <span>+{task.points} PTS</span>}
                                <span>ID: {task.id.slice(0, 6)}</span>
                            </div>
                        )}
                    </div>
                </div>

                {isExpanded && (
                    <div className="p-6 pt-0 border-t border-white/10 bg-black/20 animate-in slide-in-from-top-2">
                        <ExpandedContent
                            task={task}
                            currentUser={currentUser}
                            inlineStatus={inlineStatus}
                            setInlineStatus={setInlineStatus}
                            inlineReport={inlineReport}
                            setInlineReport={setInlineReport}
                            inlineHours={inlineHours}
                            setInlineHours={setInlineHours}
                            inlineResourceLinks={inlineResourceLinks}
                            setInlineResourceLinks={setInlineResourceLinks}
                            updatingInline={updatingInline}
                            handleInlineUpdate={handleInlineUpdate}
                            onOpenDetail={openDetails}
                        />
                    </div>
                )}

                <TaskDetailDialog
                    task={task}
                    open={detailDialogOpen}
                    onOpenChange={setDetailDialogOpen}
                    onTaskUpdated={onRefresh}
                    initialTab={detailInitialTab}
                />
            </div>
        );
    }

    return (
        <div className={`group relative overflow-hidden rounded-lg border border-l-[4px] bg-slate-900/50 transition-all duration-200 hover:bg-slate-800/80 mb-2 ${statusColor}`}
            onClick={(e) => {
                if ((e.target as HTMLElement).closest('button, input, textarea, a')) return;
                onExpand();
            }}
        >
            <div className="p-3 flex items-center justify-between gap-3 cursor-pointer">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                    {isCompleted ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : getStatusIcon(task.status)}
                    <span className="font-bold text-sm text-slate-200 truncate">{task.title}</span>
                    {isCritical && <StatusBadge status="critical" size="xs" variant="outline" showTooltip={false} />}
                    {!isCompleted && task.status === 'in-progress' && <StatusBadge status="in-progress" size="xs" showTooltip={false} />}
                </div>
                <div className="flex items-center gap-4">
                    {(() => {
                        if (!task.deadline || isCompleted) return <span className="text-xs text-slate-500">—</span>;
                        const d = new Date(task.deadline);
                        if (isNaN(d.getTime())) return <span className="text-xs text-slate-500">—</span>;
                        
                        return (
                            <div className={`text-xs font-mono ${isOverdue ? 'text-red-400 font-bold' : 'text-primary'}`}>
                                {isOverdue ? "OVERDUE" : format(d, 'MMM d')}
                            </div>
                        );
                    })()}
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-500">
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                </div>
            </div>

            {isExpanded && (
                <div className="p-4 border-t border-white/5 bg-black/20 text-sm">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="md:col-span-2 space-y-4">
                            {task.description && (
                                <div className="prose prose-invert prose-sm max-w-none text-slate-400">
                                    <p>{task.description}</p>
                                </div>
                            )}
                            {task.workflowId && (
                                <div className="mt-4">
                                    <WorkflowStepsInline workflowId={task.workflowId} workflowTitle={task.workflowTitle} currentTaskId={task.id} currentUserId={currentUser?.uid || ''} />
                                </div>
                            )}
                        </div>
                        <div className="md:col-span-1 space-y-4">
                            <ExpandedContent
                                task={task}
                                currentUser={currentUser}
                                inlineStatus={inlineStatus}
                                setInlineStatus={setInlineStatus}
                                inlineReport={inlineReport}
                                setInlineReport={setInlineReport}
                                inlineHours={inlineHours}
                                setInlineHours={setInlineHours}
                                inlineResourceLinks={inlineResourceLinks}
                                setInlineResourceLinks={setInlineResourceLinks}
                                updatingInline={updatingInline}
                                handleInlineUpdate={handleInlineUpdate}
                                onOpenDetail={openDetails}
                                compactMode={true}
                            />
                        </div>
                    </div>
                </div>
            )}

            <TaskDetailDialog
                task={task}
                open={detailDialogOpen}
                onOpenChange={setDetailDialogOpen}
                onTaskUpdated={onRefresh}
                initialTab={detailInitialTab}
            />
        </div>
    );
}

function ExpandedContent({
    task, currentUser, inlineStatus, setInlineStatus, inlineReport, setInlineReport,
    inlineHours, setInlineHours, inlineResourceLinks, setInlineResourceLinks,
    updatingInline, handleInlineUpdate, onOpenDetail, compactMode = false
}: any) {
    return (
        <div className={`space-y-4 ${compactMode ? '' : 'mt-4'}`}>
            <div className="bg-slate-950/50 p-4 rounded-lg border border-slate-800">
                <div className="flex items-center justify-between mb-3">
                    <h5 className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-400">
                        <ClipboardList className="h-3 w-3" /> Mission Report
                    </h5>
                    <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 text-[10px] text-primary hover:bg-primary/10" 
                        onClick={() => onOpenDetail('report')}
                    >
                        Expand Report <ExternalLink className="h-2 w-2 ml-1" />
                    </Button>
                </div>

                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                        {['in-progress', 'submitted-for-review', 'completed'].map((s) => (
                            <button key={s} onClick={() => setInlineStatus(s)}
                                className={`px-3 py-2 rounded text-xs font-bold uppercase transition-all border ${inlineStatus === s ? 'bg-primary/20 border-primary text-primary' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>
                                {s.replace(/-/g, ' ')}
                            </button>
                        ))}
                    </div>
                    <Textarea placeholder="Situation Report (Brief)..." value={inlineReport} onChange={(e) => setInlineReport(e.target.value)} className="bg-slate-900 border-slate-700 min-h-[80px] text-xs" />
                    <div className="grid grid-cols-2 gap-2">
                        <Input type="number" placeholder="Hrs" value={inlineHours} onChange={(e) => setInlineHours(e.target.value)} className="bg-slate-900 border-slate-700 text-xs" />
                        <Input placeholder="Link (Doc/URL)" value={inlineResourceLinks} onChange={(e) => setInlineResourceLinks(e.target.value)} className="bg-slate-900 border-slate-700 text-xs" />
                    </div>
                    <SubmitButton onClick={handleInlineUpdate} isSubmitting={updatingInline} className="w-full text-xs h-8 font-bold" variant={inlineStatus === 'completed' ? 'success' : 'default'}>
                        {inlineStatus === 'completed' ? 'MISSION ACCOMPLISHED' : 'UPDATE STATUS'}
                    </SubmitButton>
                </div>
            </div>

            <Button variant="ghost" size="sm" className="w-full text-xs text-slate-500 hover:text-white" onClick={() => onOpenDetail('overview')}>
                View Full Briefing & Utils <ExternalLink className="h-3 w-3 ml-2" />
            </Button>
        </div>
    );
}
