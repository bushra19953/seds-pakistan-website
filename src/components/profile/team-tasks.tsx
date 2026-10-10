"use client";

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge, getStatusConfig, type StatusType } from '@/components/ui/status-badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Plus, Search, Filter, RefreshCw, Clock, CheckCircle2, AlertCircle,
    Calendar, User, ArrowRight, Loader2, LayoutGrid, List, AlertTriangle, ShieldX, Sparkles, Timer
} from 'lucide-react';
import { useUser } from '@/firebase/auth/use-user';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { format, formatDistanceToNow } from 'date-fns';
import { TaskForm, TaskFormValues, WorkflowStep } from '@/components/admin/tasks/task-form';
import { TaskDetailDialog, TaskDetail } from './task-detail-dialog';

interface Task {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue';
    actualStatus?: string; // The real status when display status is overdue (e.g., 'submitted-for-review')
    priority: 'low' | 'medium' | 'high' | 'critical';
    assigneeId: string;
    assigneeName: string;
    assigneePhoto?: string;
    creatorId?: string;
    creatorName?: string;
    creatorPhoto?: string;
    deadline: string | null;
    createdAt: string | null;
    completedAt: string | null;
    isOverdue: boolean;
    hoursWorked?: number;
    points?: number; // Task points for gamification
    report?: string;
    workflowId?: string;
    workflowTitle?: string;
    resources?: Array<{
        type: 'link' | 'drive' | 'github' | 'doc' | 'video' | 'other';
        url: string;
        title: string;
    }>;
    foundVia?: string; // Debug: how task was found (assigneeId vs workflowParticipant)
}

interface TeamMember {
    id: string;
    displayName: string;
    email: string | null;
    photoURL: string | null;
}

// Task status labels for UI (actual styling from StatusBadge)
const STATUS_LABELS: Record<string, string> = {
    pending: 'To Do',
    'in-progress': 'In Progress',
    'submitted-for-review': 'Review',
    completed: 'Done'
};

const PRIORITY_CONFIG = {
    low: { color: 'text-muted-foreground', bg: 'bg-slate-500/20' },
    medium: { color: 'text-blue-400', bg: 'bg-blue-500/20' },
    high: { color: 'text-amber-400', bg: 'bg-amber-500/20' },
    critical: { color: 'text-red-400', bg: 'bg-red-500/20' }
};

export function TeamTasks() {
    const { user } = useUser();
    const { showSuccessToast, showErrorToast } = useEnhancedToast();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
    const [teamSize, setTeamSize] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<{ message: string; type: 'permission' | 'network' | 'unknown' } | null>(null);
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    // Filters
    const [filterAssignee, setFilterAssignee] = useState<string>('all');
    const [filterStatus, setFilterStatus] = useState<string>('all');
    const [searchQuery, setSearchQuery] = useState('');

    // Pre-selected member for context-aware task creation
    const [preSelectedMember, setPreSelectedMember] = useState<{ id: string; name: string } | null>(null);

    // Scalability: Limit completed tasks shown in kanban view
    const [showAllCompleted, setShowAllCompleted] = useState(false);
    const COMPLETED_TASKS_LIMIT = 5;

    const fetchTasks = useCallback(async () => {
        if (!user) {
            setError({ message: 'Not authenticated', type: 'permission' });
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const token = await user.getIdToken();

            const tasksRes = await fetch('/api/tasks/team', {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (tasksRes.status === 401) {
                setError({ message: 'Session expired. Please refresh.', type: 'permission' });
                return;
            }
            if (tasksRes.status === 403) {
                setError({ message: 'Permission denied.', type: 'permission' });
                return;
            }
            if (!tasksRes.ok) {
                const errData = await tasksRes.json().catch(() => ({}));
                throw new Error(errData.error || `Error: ${tasksRes.status}`);
            }

            const tasksData = await tasksRes.json();
            setTasks(tasksData.tasks || []);
            setTeamSize(tasksData.teamSize || 0);

            // Fetch team members
            try {
                const teamRes = await fetch('/api/profile/my-team', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (teamRes.ok) {
                    const teamData = await teamRes.json();
                    setTeamMembers(teamData.reports || []);
                }
            } catch { }

        } catch (err) {
            setError({ message: err instanceof Error ? err.message : 'Failed to load', type: 'network' });
        } finally {
            setLoading(false);
        }
    }, [user?.uid]);

    useEffect(() => {
        if (user?.uid) {
            fetchTasks();
        }
    }, [user?.uid, fetchTasks]);

    // Keyboard shortcut: 'N' for new task
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey &&
                !(e.target instanceof HTMLInputElement) &&
                !(e.target instanceof HTMLTextAreaElement)) {
                e.preventDefault();
                setCreateModalOpen(true);
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, []);

    // Handle FULL task form submission
    const handleTaskSubmit = async (values: TaskFormValues) => {
        if (!user) return;

        try {
            const token = await user.getIdToken();

            // Call the SAME /api/tasks endpoint as admin
            const res = await fetch('/api/tasks', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: values.title,
                    description: values.description,
                    assigneeIds: values.assigneeIds,
                    deadline: values.deadline,
                    status: values.status || 'pending',
                    completionBadgeId: values.completionBadgeId,
                    points: values.points,
                    chapterId: values.chapterId,
                    projectId: values.projectId,
                })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to create task');
            }

            const assigneeNames = values.assigneeIds
                .map(id => teamMembers.find(m => m.id === id)?.displayName)
                .filter(Boolean)
                .join(', ');

            showSuccessToast(`Task assigned to ${assigneeNames || 'team member'}`);
            setCreateModalOpen(false);
            fetchTasks();

        } catch (err) {
            showErrorToast(err instanceof Error ? err.message : 'Failed to create task');
        }
    };

    // CRITICAL FIX: Handle workflow creation (multi-step tasks with resources)
    // This was MISSING causing workflows to collapse to single step when assigned from profile
    const handleCreateWorkflow = async (values: TaskFormValues, steps: WorkflowStep[]) => {
        if (!user) return;

        try {
            const token = await user.getIdToken();
            const deadlineIso = values.deadline ? new Date(values.deadline).toISOString() : new Date().toISOString();
            const workflowId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            // Ensure each step has a UNIQUE title
            const stepsWithUniqueTitles = steps.map((s, i) => {
                const baseTitle = s.title?.trim() || values.title || 'Workflow Task';
                const uniqueTitle = baseTitle.includes(`Step ${i + 1}`)
                    ? baseTitle
                    : `${baseTitle} · Step ${i + 1}`;
                return { ...s, title: uniqueTitle };
            });

            const payload = {
                workflowId,
                workflowTitle: values.title || 'Workflow',
                finalDeadline: deadlineIso,
                steps: stepsWithUniqueTitles.map((s) => ({
                    title: s.title,
                    description: s.description || values.description || '',
                    role: s.role ?? undefined,
                    assigneeId: s.assigneeId!,
                    stepSpecificBadgeId: (s as any).stepSpecificBadgeId || undefined,
                    individualDeadline: (s as any).individualDeadlineIso ? new Date((s as any).individualDeadlineIso).toISOString() : undefined,
                    resources: Array.isArray((s as any).resources) ? [...(s as any).resources] : [],
                })),
                projectId: values.projectId ?? undefined,
                chapterId: values.chapterId ?? undefined,
                resources: Array.isArray(values.resources) ? [...values.resources] : [],
            };

            console.log('[TeamTasks] Creating workflow:', JSON.stringify(payload, null, 2));

            const res = await fetch('/api/workflows', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to create workflow');
            }

            showSuccessToast(`Workflow created with ${steps.length} step(s)`);
            setCreateModalOpen(false);
            fetchTasks();

        } catch (err) {
            showErrorToast(err instanceof Error ? err.message : 'Failed to create workflow');
        }
    };

    const handleStatusChange = async (taskId: string, newStatus: string) => {
        if (!user) return;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus as any } : t));
        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId, updates: { status: newStatus } })
            });
            if (!res.ok) throw new Error('Failed');
            showSuccessToast(`Status updated`);
        } catch {
            fetchTasks();
            showErrorToast('Failed to update');
        }
    };

    // Filter
    const filteredTasks = tasks.filter(t => {
        if (filterAssignee !== 'all') {
            const ids: string[] = Array.isArray((t as any).assigneeIds) && (t as any).assigneeIds.length
                ? (t as any).assigneeIds.map(String)
                : (t.assigneeId ? [String(t.assigneeId)] : []);
            if (!ids.includes(String(filterAssignee))) return false;
        }
        
        // Status filter should consider both display status and actual status
        if (filterStatus !== 'all') {
            const matchesDisplay = t.status === filterStatus;
            const matchesActual = t.actualStatus === filterStatus;
            // If filtering for "overdue", only match display status
            if (filterStatus === 'overdue') {
                if (!matchesDisplay) return false;
            } else {
                // If filtering for others (pending, in-progress, etc.), match either
                if (!matchesDisplay && !matchesActual) return false;
            }
        }
        
        if (searchQuery && !t.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
    });

    const tasksByStatus = {
        pending: filteredTasks.filter(t => (t.actualStatus || t.status) === 'pending'),
        'in-progress': filteredTasks.filter(t => (t.actualStatus || t.status) === 'in-progress'),
        'submitted-for-review': filteredTasks.filter(t => (t.actualStatus || t.status) === 'submitted-for-review'),
        completed: filteredTasks.filter(t => (t.actualStatus || t.status) === 'completed')
    };

    if (loading) {
        return (
            <Card className="border-border bg-background/80">
                <CardHeader><Skeleton className="h-6 w-48" /></CardHeader>
                <CardContent className="space-y-4">
                    <Skeleton className="h-10 w-full" />
                    <div className="grid grid-cols-4 gap-4">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-48" />)}</div>
                </CardContent>
            </Card>
        );
    }

    if (error) {
        return (
            <Card className={`${error.type === 'permission' ? 'border-amber-500/30 bg-amber-950/20' : 'border-red-500/30 bg-red-950/20'}`}>
                <CardContent className="py-8 text-center">
                    {error.type === 'permission' ? <ShieldX className="h-10 w-10 text-amber-400 mx-auto mb-3" /> : <AlertTriangle className="h-10 w-10 text-red-400 mx-auto mb-3" />}
                    <p className={`font-medium mb-2 ${error.type === 'permission' ? 'text-amber-400' : 'text-red-400'}`}>
                        {error.type === 'permission' ? 'Access Denied' : 'Loading Error'}
                    </p>
                    <p className="text-muted-foreground text-sm mb-4">{error.message}</p>
                    <Button variant="outline" onClick={fetchTasks}><RefreshCw className="h-4 w-4 mr-2" />Retry</Button>
                </CardContent>
            </Card>
        );
    }

    if (teamSize === 0) {
        return (
            <Card className="border-border bg-background/80">
                <CardContent className="py-12 text-center">
                    <User className="h-10 w-10 text-slate-600 mx-auto mb-3" />
                    <p className="text-muted-foreground font-medium">No Team Members</p>
                    <p className="text-xs text-muted-foreground mt-1">Tasks appear when you have direct reports</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
                        <LayoutGrid className="h-5 w-5 text-primary" />Team Tasks
                    </h2>
                    <p className="text-sm text-muted-foreground">{tasks.length} tasks • {teamSize} team members</p>
                </div>

                <div className="flex items-center gap-2">
                    <Button size="sm" variant={viewMode === 'kanban' ? 'default' : 'outline'} onClick={() => setViewMode('kanban')}>
                        <LayoutGrid className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant={viewMode === 'list' ? 'default' : 'outline'} onClick={() => setViewMode('list')}>
                        <List className="h-4 w-4" />
                    </Button>

                    {/* FULL TASK CREATION MODAL */}
                    <Dialog open={createModalOpen} onOpenChange={(open) => {
                        setCreateModalOpen(open);
                        if (!open) setPreSelectedMember(null); // Reset on close
                    }}>
                        <DialogTrigger asChild>
                            <Button className="bg-primary text-black hover:bg-primary/90" title="Create full-featured task (same as admin) - Press N">
                                <Plus className="h-4 w-4 mr-1" />
                                <Sparkles className="h-3 w-3 mr-1" />
                                Assign Task
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="bg-card border-slate-700 text-foreground max-w-4xl max-h-[90vh] p-0">
                            <DialogHeader className="p-6 pb-0">
                                <DialogTitle className="flex items-center gap-2">
                                    <Sparkles className="h-5 w-5 text-primary" />
                                    {preSelectedMember
                                        ? `Assign Task to ${preSelectedMember.name}`
                                        : 'Assign Task to Team Member'}
                                </DialogTitle>
                                <DialogDescription className="text-muted-foreground">
                                    {preSelectedMember
                                        ? `Pre-selected assignee from context. You can change this below.`
                                        : 'Full task creation with workflows, badges, and AI assistance'}
                                </DialogDescription>
                            </DialogHeader>
                            <ScrollArea className="max-h-[calc(90vh-100px)] p-6 pt-4">
                                <TaskForm
                                    initialValues={{
                                        assigneeIds: preSelectedMember ? [preSelectedMember.id] : [],
                                        status: 'pending',
                                    }}
                                    preSelectedAssignee={preSelectedMember}
                                    onSubmit={handleTaskSubmit}
                                    onSubmitWithPlan={handleCreateWorkflow}
                                    onCancel={() => setCreateModalOpen(false)}
                                    submitLabel="Assign Task"
                                />
                            </ScrollArea>
                        </DialogContent>
                    </Dialog>
                </div>
            </div>

            {/* Filters */}
            <Card className="border-border bg-background/80">
                <CardContent className="py-3">
                    <div className="flex flex-wrap gap-3 items-center">
                        <div className="relative flex-1 min-w-[200px]">
                            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input placeholder="Search tasks..." className="pl-9 bg-muted border-slate-700" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
                        </div>
                        <Select value={filterAssignee} onValueChange={setFilterAssignee}>
                            <SelectTrigger className="w-40 bg-muted border-slate-700"><User className="h-4 w-4 mr-2" /><SelectValue /></SelectTrigger>
                            <SelectContent className="bg-muted border-slate-700">
                                <SelectItem value="all">All Members</SelectItem>
                                {teamMembers.map(m => <SelectItem key={m.id} value={m.id}>{m.displayName}</SelectItem>)}
                            </SelectContent>
                        </Select>
                        <Select value={filterStatus} onValueChange={setFilterStatus}>
                            <SelectTrigger className="w-36 bg-muted border-slate-700"><Filter className="h-4 w-4 mr-2" /><SelectValue /></SelectTrigger>
                            <SelectContent className="bg-muted border-slate-700">
                                <SelectItem value="all">All Status</SelectItem>
                                <SelectItem value="pending">To Do</SelectItem>
                                <SelectItem value="in-progress">In Progress</SelectItem>
                                <SelectItem value="submitted-for-review">Review</SelectItem>
                                <SelectItem value="completed">Done</SelectItem>
                            </SelectContent>
                        </Select>
                        <Button size="icon" variant="outline" onClick={fetchTasks}><RefreshCw className="h-4 w-4" /></Button>
                    </div>
                </CardContent>
            </Card>

            {/* Stats */}
            <div className="grid grid-cols-4 gap-4">
                {Object.entries(tasksByStatus).map(([status, items]) => {
                    return (
                        <Card key={status} className="border-border bg-background/80">
                            <CardContent className="py-4 text-center">
                                <p className="text-2xl font-bold text-foreground">{items.length}</p>
                                <p className="text-xs text-muted-foreground">{STATUS_LABELS[status] || status}</p>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            {/* Kanban */}
            {viewMode === 'kanban' && (
                <div className="grid grid-cols-4 gap-4">
                    {Object.entries(tasksByStatus).map(([status, items]) => {
                        // Scalability: Limit completed tasks shown
                        const isCompleted = status === 'completed';
                        const displayItems = isCompleted && !showAllCompleted
                            ? items.slice(0, COMPLETED_TASKS_LIMIT)
                            : items;
                        const hasMore = isCompleted && items.length > COMPLETED_TASKS_LIMIT;

                        return (
                            <div key={status} className="space-y-3">
                                <div className="flex items-center gap-2 px-2">
                                    <StatusBadge status={status as StatusType} size="xs" showLabel={false} showTooltip={false} />
                                    <span className="font-medium text-foreground text-sm">{STATUS_LABELS[status] || status}</span>
                                    <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>
                                </div>
                                <div className="space-y-2 min-h-[200px]">
                                    {displayItems.map(task => {
                                        // Determine if this task needs review (direct or overdue+submitted)
                                        const needsReview = task.status === 'submitted-for-review' ||
                                            (task.status === 'overdue' && task.actualStatus === 'submitted-for-review');
                                        const isOverdueButSubmitted = task.status === 'overdue' && task.actualStatus === 'submitted-for-review';

                                        return (
                                            <Card
                                                key={task.id}
                                                className={`border-border bg-card/80 hover:bg-card hover:border-primary/30 transition-colors cursor-pointer group ${(task.actualStatus || task.status) === 'submitted-for-review' ? 'ring-1 ring-amber-500/50' : ''}`}
                                                onClick={() => { setSelectedTask(task); setDetailOpen(true); }}
                                            >
                                                <CardContent className="p-3">
                                                    {/* Visual indicators for overdue or review */}
                                                    <div className="flex items-center gap-1.5 mb-2">
                                                        {task.isOverdue && (
                                                            <StatusBadge status="overdue" size="xs" showLabel={true} showTooltip={false} />
                                                        )}
                                                        {(task.actualStatus || task.status) === 'submitted-for-review' && (
                                                            <StatusBadge status="submitted-for-review" size="xs" customLabel="Review needed" showTooltip={false} />
                                                        )}
                                                    </div>
                                                    <h4 className="font-medium text-foreground text-sm line-clamp-2 group-hover:text-primary transition-colors">{task.title}</h4>
                                                    {/* Assignee */}
                                                    <div className="flex items-center gap-2 mt-2">
                                                        <Avatar className="h-5 w-5"><AvatarFallback className="text-[10px] bg-slate-700">{task.assigneeName?.charAt(0)}</AvatarFallback></Avatar>
                                                        <span className="text-xs text-muted-foreground truncate">{task.assigneeName}</span>
                                                    </div>
                                                    {/* Assigned by - Creator/Assigner */}
                                                    {task.creatorName && (
                                                        <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-muted-foreground">
                                                            <User className="h-3 w-3" />
                                                            <span>Assigned by</span>
                                                            <span className="text-muted-foreground font-medium">{task.creatorName}</span>
                                                        </div>
                                                    )}
                                                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                                                        {task.deadline && !isNaN(new Date(task.deadline).getTime()) && (
                                                            <div className={`flex items-center gap-1 text-xs ${task.isOverdue ? 'text-red-400' : 'text-muted-foreground'}`}>
                                                                <Calendar className="h-3 w-3" />
                                                                {format(new Date(task.deadline), 'MMM d')}
                                                                {task.isOverdue && <AlertCircle className="h-3 w-3" />}
                                                            </div>
                                                        )}
                                                        {task.hoursWorked && task.hoursWorked > 0 && (
                                                            <Badge variant="secondary" className="text-[10px] bg-primary/20 text-primary">
                                                                <Timer className="h-3 w-3 mr-1" />
                                                                {task.hoursWorked}h
                                                            </Badge>
                                                        )}
                                                        {/* Points badge - shows task value */}
                                                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-amber-500/30 bg-amber-500/10 text-amber-400">
                                                            {typeof task.points === 'number' && task.points > 0 ? `${task.points} PTS` : '0 PTS'}
                                                        </Badge>
                                                        {task.createdAt && !isNaN(new Date(task.createdAt).getTime()) && (
                                                            <span className="text-[10px] text-muted-foreground">
                                                                Updated {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center justify-between mt-2">
                                                        <Badge className={`text-[10px] ${PRIORITY_CONFIG[task.priority].bg} ${PRIORITY_CONFIG[task.priority].color}`}>{task.priority}</Badge>
                                                        <Select value={task.status} onValueChange={v => handleStatusChange(task.id, v)}>
                                                            <SelectTrigger className="h-6 w-20 text-[10px] bg-transparent border-slate-700" onClick={e => e.stopPropagation()}><SelectValue /></SelectTrigger>
                                                            <SelectContent className="bg-muted border-slate-700">
                                                                <SelectItem value="pending">To Do</SelectItem>
                                                                <SelectItem value="in-progress">In Progress</SelectItem>
                                                                <SelectItem value="submitted-for-review">Review</SelectItem>
                                                                <SelectItem value="completed">Done</SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                </CardContent>
                                            </Card>
                                        );
                                    })}
                                    {items.length === 0 && (
                                        <div className="h-24 border-2 border-dashed border-slate-800 rounded-lg flex items-center justify-center">
                                            <p className="text-xs text-slate-600">No tasks</p>
                                        </div>
                                    )}
                                    {/* Show More / Show Less for completed tasks */}
                                    {hasMore && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="w-full text-xs text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowAllCompleted(!showAllCompleted)}
                                        >
                                            {showAllCompleted ? `Show Less` : `Show ${items.length - COMPLETED_TASKS_LIMIT} More`}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* List */}
            {viewMode === 'list' && (
                <Card className="border-border bg-background/80">
                    <CardContent className="p-0">
                        <div className="divide-y divide-white/5">
                            {filteredTasks.length === 0 ? (
                                <div className="py-12 text-center">
                                    <p className="text-muted-foreground">No tasks match filters</p>
                                    <Button variant="link" onClick={() => { setFilterAssignee('all'); setFilterStatus('all'); setSearchQuery(''); }}>Clear</Button>
                                </div>
                            ) : filteredTasks.map(task => (
                                <div
                                    key={task.id}
                                    className="flex items-center gap-4 p-4 hover:bg-muted cursor-pointer group"
                                    onClick={() => { setSelectedTask(task); setDetailOpen(true); }}
                                >
                                    <StatusBadge status={task.status as StatusType} size="xs" showLabel={false} showTooltip={false} />
                                    <div className="flex-1 min-w-0">
                                        <h4 className="font-medium text-foreground truncate group-hover:text-primary transition-colors">{task.title}</h4>
                                        <p className="text-xs text-muted-foreground">{task.assigneeName}</p>
                                    </div>
                                    {task.hoursWorked && task.hoursWorked > 0 && (
                                        <div className="flex items-center gap-1 text-xs text-primary">
                                            <Timer className="h-3 w-3" />{task.hoursWorked}h
                                        </div>
                                    )}
                                    <Badge variant="outline" className="text-[10px] border-amber-500/30 bg-amber-500/10 text-amber-400">
                                        {typeof task.points === 'number' && task.points > 0 ? `${task.points} PTS` : '0 PTS'}
                                    </Badge>
                                    <Badge className={`${PRIORITY_CONFIG[task.priority].bg} ${PRIORITY_CONFIG[task.priority].color}`}>{task.priority}</Badge>
                                    {task.deadline && !isNaN(new Date(task.deadline).getTime()) && <span className={`text-xs ${task.isOverdue ? 'text-red-400' : 'text-muted-foreground'}`}>{format(new Date(task.deadline), 'MMM d')}</span>}
                                    <Select value={task.status} onValueChange={v => handleStatusChange(task.id, v)}>
                                        <SelectTrigger className="w-28 h-8 text-xs" onClick={e => e.stopPropagation()}><SelectValue /></SelectTrigger>
                                        <SelectContent className="bg-muted border-slate-700">
                                            <SelectItem value="pending">To Do</SelectItem>
                                            <SelectItem value="in-progress">In Progress</SelectItem>
                                            <SelectItem value="submitted-for-review">Review</SelectItem>
                                            <SelectItem value="completed">Done</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Shortcut hint */}
            <p className="text-xs text-muted-foreground text-center">Press <kbd className="px-1.5 py-0.5 bg-muted rounded text-muted-foreground">N</kbd> to create a new task • Click any task for full details</p>

            {/* Task Detail Dialog */}
            <TaskDetailDialog
                task={selectedTask as TaskDetail | null}
                open={detailOpen}
                onOpenChange={setDetailOpen}
                onTaskUpdated={fetchTasks}
                // Server verdict: teamSize counts [userId, ...subordinateIds], so
                // > 1 means this viewer actually has people below them.
                isManager={teamSize > 1}
            />
        </div>
    );
}
