"use client";
import { doc, onSnapshot, getDoc } from 'firebase/firestore';
import { useFirestore } from '@/firebase';

import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Clock, CheckCircle2, AlertCircle, Calendar, User, FileText,
    Loader2, RefreshCw, ClipboardList, Coins, Pencil, ExternalLink, Link2,
    Target, Sparkles, LayoutGrid, Activity as ActivityIcon, Eye, BellRing,
    ArrowRightLeft, ShieldAlert, Award, Briefcase, ChevronRight, MessageSquare
} from 'lucide-react';
import { useUser } from '@/firebase/auth/use-user';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { format, formatDistanceToNow } from 'date-fns';
import { DelegateTaskDialog } from './delegate-task-dialog';

export interface TaskDetail {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue' | 'changes-requested';
    actualStatus?: 'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue' | 'changes-requested';
    priority: 'low' | 'medium' | 'high' | 'critical';
    assigneeId: string;
    assigneeName?: string;
    assigneePhoto?: string;
    assignerId?: string; 
    creatorId?: string; 
    creatorName?: string;
    creatorPhoto?: string;
    deadline: string | null;
    individualDeadline?: string | null;
    createdAt: string | null;
    completedAt: string | null;
    isOverdue: boolean;
    hoursWorked?: number;
    report?: string;
    workflowId?: string;
    workflowTitle?: string;
    updatedAt?: any;
    resourceLinks?: string;
    resources?: Array<{
        type: 'link' | 'drive' | 'github' | 'doc' | 'video' | 'other';
        url: string;
        title: string;
    }>;
    points?: number;
    penaltyPoints?: number;
    workflowBonusPoints?: number;
    completionBadgeId?: string;
    projectId?: string;
    projectTitle?: string;
    guidance?: {
        description: string;
        steps: string[];
        estimatedTime?: number;
    };
    isSubTask?: boolean;
    parentTaskId?: string;
    orchestration?: any;
    feedback_history?: Array<{
        admin_id?: string;
        timestamp?: any;
        text?: string;
        previous_status?: string;
    }>;
}

interface TaskDetailDialogProps {
    task: TaskDetail | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onTaskUpdated?: () => void;
    isManager?: boolean;
    initialTab?: 'overview' | 'report' | 'activity';
}

const STATUS_CONFIG = {
    pending: { label: 'To Do', color: 'bg-slate-500', icon: Clock },
    'in-progress': { label: 'In Progress', color: 'bg-blue-500', icon: ActivityIcon },
    'submitted-for-review': { label: 'In Review', color: 'bg-amber-500', icon: Eye },
    completed: { label: 'Completed', color: 'bg-green-500', icon: CheckCircle2 },
    overdue: { label: 'Overdue', color: 'bg-red-500', icon: AlertCircle },
    'changes-requested': { label: 'Revision', color: 'bg-orange-600', icon: RefreshCw }
};

const PRIORITY_CONFIG = {
    low: { color: 'text-muted-foreground', bg: 'bg-slate-500/20', label: 'Low' },
    medium: { color: 'text-blue-400', bg: 'bg-blue-500/20', label: 'Medium' },
    high: { color: 'text-amber-400', bg: 'bg-amber-500/20', label: 'High' },
    critical: { color: 'text-red-400', bg: 'bg-red-500/20', label: 'Critical' }
};

const safeDateParse = (d: any) => {
    if (!d) return null;
    try {
        if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
        if (typeof d === 'string') {
            const parsed = new Date(d);
            return isNaN(parsed.getTime()) ? null : parsed;
        }
        if (d.toDate && typeof d.toDate === 'function') return d.toDate();
        if (typeof d === 'object') {
            if (typeof d.seconds === 'number') return new Date(d.seconds * 1000);
            if (typeof d._seconds === 'number') return new Date(d._seconds * 1000); // Admin SDK serialized Timestamp
        }
        return new Date(d);
    } catch { return null; }
};

const safeFormat = (dateData: any, formatStr: string, fallback = 'Unknown Date') => {
    const d = safeDateParse(dateData);
    if (!d) return fallback;
    return format(d, formatStr);
};

const safeFormatDistance = (dateData: any, fallback = 'Unknown time') => {
    const d = safeDateParse(dateData);
    if (!d) return fallback;
    return formatDistanceToNow(d, { addSuffix: true });
};

export function TaskDetailDialog({ task, open, onOpenChange, onTaskUpdated, isManager = false, initialTab = 'overview' }: TaskDetailDialogProps) {
    const firestore = useFirestore();
    const { user } = useUser();
    const { showSuccessToast, showErrorToast } = useEnhancedToast();
    
    const [updating, setUpdating] = useState(false);
    const [liveTask, setLiveTask] = useState<TaskDetail | null>(null);
    const [activeTab, setActiveTab] = useState(initialTab);
    const [showFullDescription, setShowFullDescription] = useState(false);
    
    // UI Hydration
    const [assigner, setAssigner] = useState<{name: string, photo?: string}>({name: ''});
    const [assignee, setAssignee] = useState<{name: string, photo?: string}>({name: ''});
    const [projectTitle, setProjectTitle] = useState<string>('');
    const [badgeName, setBadgeName] = useState<string>('');

    // Form state
    const [status, setStatus] = useState(task?.status || 'pending');
    const [hoursWorked, setHoursWorked] = useState(task?.hoursWorked?.toString() || '');
    const [report, setReport] = useState(task?.report || '');
    const [resourceLinks, setResourceLinks] = useState(task?.resourceLinks || '');

    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState(task?.title || '');
    const [editDescription, setEditDescription] = useState(task?.description || '');
    
    const [showFeedbackDialog, setShowFeedbackDialog] = useState(false);
    const [feedbackText, setFeedbackText] = useState('');

    const [activities, setActivities] = useState<any[]>([]);
    const [activitiesLoading, setActivitiesLoading] = useState(false);

    const [showDelegateDialog, setShowDelegateDialog] = useState(false);

    const displayTask = liveTask || task;
    const displayAssigneeIds: string[] = Array.isArray((displayTask as any)?.assigneeIds) && (displayTask as any).assigneeIds.length
      ? (displayTask as any).assigneeIds.map(String)
      : (displayTask?.assigneeId ? [String(displayTask.assigneeId)] : []);
    const isAssignee = !!user?.uid && displayAssigneeIds.includes(user.uid);

    useEffect(() => {
        if (open) setActiveTab(initialTab);
    }, [open, initialTab, task?.id]);

    // Live Subscription
    useEffect(() => {
        if (!open || !task?.id || !firestore) return;
        const docRef = doc(firestore, 'tasks', task.id);
        const unsubscribe = onSnapshot(docRef, (snap) => {
            if (snap.exists()) setLiveTask({ id: snap.id, ...snap.data() } as any);
        });
        return () => unsubscribe();
    }, [open, task?.id, firestore]);

    // Sync form state
    useEffect(() => {
        if (displayTask) {
            setStatus(displayTask.actualStatus || displayTask.status);
            setHoursWorked(displayTask.hoursWorked?.toString() || '');
            setReport(displayTask.report || '');
            setResourceLinks(displayTask.resourceLinks || '');
            setEditTitle(displayTask.title);
            setEditDescription(displayTask.description || '');
            
            if (displayTask.creatorName) setAssigner(prev => ({...prev, name: displayTask.creatorName!}));
            if (displayTask.assigneeName) setAssignee(prev => ({...prev, name: displayTask.assigneeName!}));
            if (displayTask.projectTitle) setProjectTitle(displayTask.projectTitle);
        }
    }, [displayTask]);

    // Name & Data Hydration
    useEffect(() => {
        if (!open || !displayTask || !firestore) return;

        const hydrate = async () => {
            const aid = displayTask.assignerId || displayTask.creatorId;
            if (aid && !assigner.name) {
                try {
                    const uSnap = await getDoc(doc(firestore, 'users', aid));
                    if (uSnap.exists()) setAssigner({
                        name: uSnap.data().displayName || uSnap.data().email || 'Assigner',
                        photo: uSnap.data().photoURL
                    });
                } catch (e) { console.error(e); }
            }

            if (displayTask.assigneeId && !assignee.name) {
                try {
                    const uSnap = await getDoc(doc(firestore, 'users', displayTask.assigneeId));
                    if (uSnap.exists()) setAssignee({
                        name: uSnap.data().displayName || uSnap.data().email || 'Assignee',
                        photo: uSnap.data().photoURL
                    });
                } catch (e) { console.error(e); }
            }

            if (displayTask.projectId && !projectTitle) {
                try {
                    const pSnap = await getDoc(doc(firestore, 'projects', displayTask.projectId));
                    if (pSnap.exists()) setProjectTitle(pSnap.data().title || pSnap.data().name || 'Project');
                } catch (e) { console.error(e); }
            }

            if (displayTask.completionBadgeId && !badgeName) {
                try {
                    const bSnap = await getDoc(doc(firestore, 'badges', displayTask.completionBadgeId));
                    if (bSnap.exists()) setBadgeName(bSnap.data().name || 'Badge');
                } catch (e) { console.error(e); }
            }
        };

        hydrate();
    }, [open, displayTask, firestore]);

    // Fetch activities
    useEffect(() => {
        if (open && task?.id && user && activeTab === 'activity') {
            const fetchActivities = async () => {
                setActivitiesLoading(true);
                try {
                    const token = await user.getIdToken();
                    const res = await fetch(`/api/tasks/${task.id}/activity`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setActivities(data.activities || []);
                    }
                } catch (e) { console.error(e); } finally { setActivitiesLoading(false); }
            };
            fetchActivities();
        }
    }, [open, task?.id, user, activeTab]);

    const handleUpdateMission = async () => {
        if (!user || !task || !displayTask || (!isAssignee && !isManager)) return;
        setUpdating(true);
        try {
            const token = await user.getIdToken();
            const updates: any = { status };
            if (hoursWorked.trim()) updates.hoursWorked = parseFloat(hoursWorked);
            if (report.trim()) updates.report = report.trim();
            if (resourceLinks.trim()) updates.resourceLinks = resourceLinks.trim();
            
            const lastUpdated = safeDateParse((displayTask as any).updatedAt);
            
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    taskId: displayTask.id, 
                    lastUpdatedAt: lastUpdated ? lastUpdated.toISOString() : undefined,
                    updates 
                })
            });
            
            if (!res.ok) throw new Error('Failed to update');
            showSuccessToast('Mission Report Transmitted');
            onTaskUpdated?.();
        } catch (err) { showErrorToast('Transmission failed'); } finally { setUpdating(false); }
    };

    const handleRecallSubmission = async () => {
        if (!user || !displayTask || !isAssignee) return;
        setUpdating(true);
        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: displayTask.id,
                    updates: { status: 'in-progress' }
                })
            });
            if (!res.ok) throw new Error('Recall failed');
            setStatus('in-progress');
            showSuccessToast('Submission recalled — back to In Progress');
            onTaskUpdated?.();
        } catch (err) { showErrorToast('Recall failed'); } finally { setUpdating(false); }
    };

    const handleSaveManagerEdits = async () => {        if (!user || !task || !isManager) return;
        setUpdating(true);
        try {
            const token = await user.getIdToken();
            await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: task.id,
                    updates: { title: editTitle, description: editDescription }
                })
            });
            showSuccessToast('Briefing updated');
            setIsEditing(false);
            onTaskUpdated?.();
        } catch (err) { showErrorToast('Failed to update briefing'); } finally { setUpdating(false); }
    };

    const handleApprove = async () => {
        if (!user || !displayTask || !isManager) return;
        setUpdating(true);
        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: displayTask.id,
                    updates: { status: 'completed' }
                })
            });
            if (!res.ok) throw new Error('Approval failed');
            showSuccessToast('Mission Accomplished & Points Awarded');
            onTaskUpdated?.();
        } catch (err) { showErrorToast('Approval failed'); } finally { setUpdating(false); }
    };

    const handleRequestRevision = async () => {
        if (!user || !displayTask || !isManager || !feedbackText.trim()) return;
        setUpdating(true);
        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: displayTask.id,
                    updates: { status: 'changes-requested', feedback_text: feedbackText }
                })
            });
            if (!res.ok) throw new Error('Revision request failed');
            showSuccessToast('Revision Instructions Transmitted');
            setShowFeedbackDialog(false);
            setFeedbackText('');
            onTaskUpdated?.();
        } catch (err) { showErrorToast('Failed to request revision'); } finally { setUpdating(false); }
    };

    if (!task || !displayTask) return null;

    const statusConfig = STATUS_CONFIG[displayTask.status] || STATUS_CONFIG.pending;
    const priorityConfig = PRIORITY_CONFIG[displayTask.priority] || PRIORITY_CONFIG.medium;
    const StatusIcon = statusConfig.icon;
    const progress = displayTask.status === 'completed' ? 100 : displayTask.status === 'submitted-for-review' ? 80 : displayTask.status === 'in-progress' ? 40 : 10;
    const needsReview = isManager && (displayTask.status === 'submitted-for-review' || displayTask.actualStatus === 'submitted-for-review');

    const tabs = [
        { id: 'overview', label: 'Briefing', icon: ClipboardList },
        { id: 'report', label: 'Mission Report', icon: FileText, badge: !!displayTask.report },
        { id: 'activity', label: 'History', icon: Clock },
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="bg-slate-950 border-slate-800 text-foreground p-0 gap-0 flex flex-col w-[95vw] max-w-4xl h-[95vh] sm:h-auto sm:max-h-[90vh] rounded-xl overflow-hidden shadow-2xl">
                
                {/* Header */}
                <div className="flex-shrink-0 border-b border-slate-800 bg-card/50 p-4 sm:p-6">
                    {needsReview && (
                        <div className="mb-4 bg-amber-500/10 border border-amber-500/30 px-4 py-2 rounded-lg flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <BellRing className="h-4 w-4 text-amber-500 animate-pulse" />
                                <span className="text-amber-400 text-sm font-bold">AWAITING REVIEW</span>
                            </div>
                            <Button size="sm" className="bg-amber-500 text-black hover:bg-amber-400 h-7" onClick={() => setActiveTab('report')}>Review Now</Button>
                        </div>
                    )}

                    <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                            <DialogTitle className="text-lg sm:text-2xl font-black font-mono tracking-tight">
                                {isEditing ? (
                                    <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} className="bg-muted border-primary/50 text-foreground font-bold h-10" />
                                ) : displayTask.title}
                            </DialogTitle>
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                                <Badge variant="outline" className={`${priorityConfig.bg} ${priorityConfig.color} border-0 text-[10px] uppercase font-bold`}>{priorityConfig.label} Priority</Badge>
                                <span className="text-slate-600 font-mono text-[10px]">#{displayTask.id.slice(0, 8)}</span>
                                {projectTitle && (
                                    <Badge variant="secondary" className="bg-blue-500/10 text-blue-400 border-0 text-[10px] flex items-center gap-1">
                                        <Briefcase className="h-3 w-3" /> {projectTitle}
                                    </Badge>
                                )}
                            </div>
                        </div>
                        <Badge className={`${statusConfig.color} text-foreground px-3 py-1 rounded-full text-xs font-bold shrink-0`}>
                            <StatusIcon className="h-3 w-3 mr-1" /> {statusConfig.label}
                        </Badge>
                    </div>

                    <div className="mt-6">
                        <div className="flex items-center justify-between text-[10px] uppercase tracking-widest font-bold text-muted-foreground mb-1.5">
                            <span>Mission Progress</span>
                            <span>{progress}%</span>
                        </div>
                        <Progress value={progress} className="h-1.5 bg-muted" />
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex-shrink-0 bg-card/80 border-b border-slate-800">
                    <div className="flex px-4 overflow-x-auto no-scrollbar">
                        {tabs.map(tab => (
                            <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
                                className={`relative flex items-center gap-2 px-4 py-4 text-xs font-black uppercase tracking-widest transition-all shrink-0
                                           ${activeTab === tab.id ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-muted-foreground hover:text-foreground'}`}>
                                <tab.icon className="h-4 w-4" />
                                {tab.label}
                                {tab.badge && <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto bg-slate-950/50">
                    <div className="p-4 sm:p-6 space-y-8">
                        {activeTab === 'overview' && (
                            <div className="space-y-8 animate-in fade-in duration-300">
                                {/* Metadata Grid */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                                    <div className="bg-card/50 border border-slate-800 p-4 rounded-xl">
                                        <div className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-2"><Calendar className="h-3 w-3" /> Deadline</div>
                                        <div className={`font-mono font-bold text-sm ${displayTask.isOverdue ? 'text-red-500' : 'text-foreground'}`}>
                                            {safeFormat(displayTask.individualDeadline || displayTask.deadline, 'MMM dd, yyyy', 'No Deadline')}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground mt-1">{safeFormatDistance(displayTask.individualDeadline || displayTask.deadline)}</div>
                                    </div>
                                    <div className="bg-card/50 border border-slate-800 p-4 rounded-xl">
                                        <div className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-2"><Coins className="h-3 w-3" /> Mission Value</div>
                                        <div className="font-mono font-black text-xl text-primary">{displayTask.points || 0} PTS</div>
                                        {(displayTask.penaltyPoints || displayTask.workflowBonusPoints) && (
                                            <div className="flex items-center gap-2 mt-1 text-[9px] font-bold">
                                                {displayTask.penaltyPoints && <span className="text-red-500">-{displayTask.penaltyPoints} PENALTY</span>}
                                                {displayTask.workflowBonusPoints && <span className="text-emerald-500">+{displayTask.workflowBonusPoints} BONUS</span>}
                                            </div>
                                        )}
                                    </div>
                                    <div className="bg-card/50 border border-slate-800 p-4 rounded-xl">
                                        <div className="text-[10px] uppercase font-bold text-muted-foreground mb-2 flex items-center gap-2"><User className="h-3 w-3" /> Assigner</div>
                                        <div className="flex items-center gap-2">
                                            <Avatar className="h-8 w-8 border border-primary/20 shrink-0">
                                                <AvatarImage src={assigner.photo} />
                                                <AvatarFallback className="bg-primary/10 text-primary text-[10px] font-black uppercase">{assigner.name?.charAt(0)}</AvatarFallback>
                                            </Avatar>
                                            <div className="min-w-0">
                                                <p className="font-bold text-xs text-foreground leading-tight">{assigner.name || 'System'}</p>
                                                <p className="text-[9px] text-muted-foreground uppercase">Launched {safeFormatDistance(displayTask.createdAt)}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="bg-card/50 border border-slate-800 p-4 rounded-xl">
                                        <div className="text-[10px] uppercase font-bold text-muted-foreground mb-2 flex items-center gap-2"><Target className="h-3 w-3" /> Operator</div>
                                        <div className="flex items-center gap-2">
                                            <Avatar className="h-8 w-8 border border-primary/20 shrink-0">
                                                <AvatarImage src={assignee.photo} />
                                                <AvatarFallback className="bg-primary/10 text-primary text-[10px] font-black uppercase">{assignee.name?.charAt(0)}</AvatarFallback>
                                            </Avatar>
                                            <div className="min-w-0">
                                                <p className="font-bold text-xs text-foreground leading-tight">{assignee.name || 'Unknown'}</p>
                                                <p className="text-[9px] text-muted-foreground uppercase truncate">Status: {displayTask.status.replace(/-/g, ' ')}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Reviewer Feedback */}
                                {displayTask.feedback_history && displayTask.feedback_history.length > 0 && (
                                    <div className="space-y-3">
                                        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                                            <MessageSquare className="h-4 w-4 text-amber-500" /> Reviewer Feedback
                                        </h3>
                                        <div className="space-y-3">
                                            {displayTask.feedback_history.slice().reverse().map((fb, i) => (
                                                <div key={i} className={`p-4 rounded-2xl border ${displayTask.status === 'changes-requested' && i === 0 ? 'bg-amber-500/10 border-amber-500/40' : 'bg-card/50 border-slate-800'}`}>
                                                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{fb.text || 'No details provided.'}</p>
                                                    <p className="text-[10px] text-muted-foreground mt-2 font-mono uppercase tracking-widest">
                                                        Reviewer{fb.timestamp ? ` · ${safeFormatDistance(fb.timestamp)}` : ''}
                                                    </p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Briefing Section */}
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2"><FileText className="h-4 w-4 text-primary" /> Mission Briefing</h3>
                                        <div className="flex gap-2">
                                            {isAssignee && !displayTask.orchestration && displayTask.status !== 'completed' && (
                                                <Button variant="outline" size="sm" className="h-7 text-[10px] border-amber-500 text-amber-500 hover:bg-amber-500/10 font-bold" onClick={() => setShowDelegateDialog(true)}>
                                                    <ArrowRightLeft className="h-3 w-3 mr-1" /> Delegate
                                                </Button>
                                            )}
                                            {isManager && !isEditing && (
                                                <Button variant="ghost" size="sm" className="h-7 text-[10px] text-primary font-bold" onClick={() => setIsEditing(true)}>
                                                    <Pencil className="h-3 w-3 mr-1" /> Edit Briefing
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="bg-card/30 border border-slate-800/50 p-5 rounded-2xl">
                                        {isEditing ? (
                                            <div className="space-y-4">
                                                <Textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} className="bg-muted border-slate-700 min-h-[200px] text-sm leading-relaxed" />
                                                <div className="flex justify-end gap-2">
                                                    <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>Cancel</Button>
                                                    <Button size="sm" onClick={handleSaveManagerEdits} disabled={updating} className="bg-primary text-black font-bold">Save Mission Profile</Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className={`text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed ${!showFullDescription && (displayTask.description || '').length > 800 ? 'line-clamp-6' : ''}`}>
                                                {displayTask.description || 'No detailed briefing provided.'}
                                            </div>
                                        )}
                                        {!isEditing && (displayTask.description || '').length > 800 && (
                                            <Button variant="ghost" size="sm" className="mt-3 text-primary text-[10px] font-black uppercase tracking-widest" onClick={() => setShowFullDescription(!showFullDescription)}>
                                                {showFullDescription ? 'Collapse Briefing' : 'Read Full Intelligence Report'}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                {/* Guidance / Requirements */}
                                {displayTask.guidance && (
                                    <div className="space-y-4 animate-in slide-in-from-bottom-2">
                                        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-emerald-500" /> Execution Guidance</h3>
                                        <div className="bg-emerald-500/5 border border-emerald-500/20 p-5 rounded-2xl space-y-4">
                                            {displayTask.guidance.description && (
                                                <p className="text-sm text-emerald-100/80 leading-relaxed italic border-l-2 border-emerald-500/30 pl-4">{displayTask.guidance.description}</p>
                                            )}
                                            {displayTask.guidance.steps && displayTask.guidance.steps.length > 0 && (
                                                <div className="space-y-2">
                                                    <p className="text-[10px] font-black text-emerald-500/70 uppercase tracking-widest">Protocol Steps</p>
                                                    <div className="grid gap-2">
                                                        {displayTask.guidance.steps.map((step, i) => (
                                                            <div key={i} className="flex items-start gap-3 bg-card/40 p-3 rounded-xl border border-slate-800/50">
                                                                <div className="h-5 w-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-[10px] font-black shrink-0">{i + 1}</div>
                                                                <p className="text-xs text-muted-foreground leading-tight">{step}</p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Completion Reward */}
                                {badgeName && (
                                    <div className="space-y-3">
                                        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2"><Award className="h-4 w-4 text-amber-500" /> Commendation</h3>
                                        <div className="flex items-center gap-4 bg-amber-500/5 border border-amber-500/20 p-4 rounded-xl">
                                            <div className="bg-amber-500/20 p-3 rounded-full"><Award className="h-6 w-6 text-amber-500" /></div>
                                            <div>
                                                <p className="text-xs font-bold text-foreground">Award: {badgeName}</p>
                                                <p className="text-[10px] text-muted-foreground uppercase tracking-tighter">Awarded automatically upon mission verification</p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Reference Resources */}
                                {displayTask.resources && displayTask.resources.length > 0 && (
                                    <div className="space-y-3">
                                        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2"><Link2 className="h-4 w-4 text-blue-400" /> Operational Resources</h3>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            {displayTask.resources.map((res, i) => (
                                                <a key={i} href={res.url.startsWith('http') ? res.url : `https://${res.url}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 p-4 rounded-xl bg-card/50 border border-slate-800 hover:border-primary/50 transition-all group">
                                                    <div className="bg-primary/10 p-2 rounded-lg text-primary group-hover:bg-primary group-hover:text-black transition-all"><ExternalLink className="h-4 w-4" /></div>
                                                    <div className="min-w-0">
                                                        <p className="text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors uppercase tracking-tight">{res.title}</p>
                                                        <p className="text-[9px] text-muted-foreground truncate font-mono">{res.url}</p>
                                                    </div>
                                                </a>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'report' && (
                            <div className="space-y-8 animate-in fade-in duration-300">
                                {/* Current Report View (Read-Only/Manager) */}
                                {(!isAssignee || displayTask.status === 'completed') && (
                                    <div className="space-y-6">
                                        {displayTask.report ? (
                                            <div className="bg-emerald-500/5 border border-emerald-500/20 p-6 rounded-2xl space-y-6">
                                                <div className="flex items-center justify-between border-b border-emerald-500/10 pb-4">
                                                    <div className="flex items-center gap-3">
                                                        <Avatar className="h-12 w-12 ring-2 ring-emerald-500/20">
                                                            <AvatarImage src={assignee.photo} />
                                                            <AvatarFallback className="bg-emerald-600 font-black uppercase text-lg">{assignee.name.charAt(0)}</AvatarFallback>
                                                        </Avatar>
                                                        <div>
                                                            <p className="font-black text-foreground uppercase tracking-tighter text-base">Mission Report (SITREP)</p>
                                                            <p className="text-[10px] text-muted-foreground font-mono uppercase">Submitted {safeFormatDistance(displayTask.updatedAt || displayTask.completedAt)}</p>
                                                        </div>
                                                    </div>
                                                    {displayTask.hoursWorked && <Badge className="bg-emerald-500/20 text-emerald-400 border-0 font-mono text-xs px-3">{displayTask.hoursWorked}H LOGGED</Badge>}
                                                </div>
                                                <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap bg-slate-950/50 p-6 rounded-2xl border border-slate-800 shadow-inner">
                                                    {displayTask.report}
                                                </div>
                                                {displayTask.resourceLinks && (
                                                    <div className="space-y-3 pt-2">
                                                        <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest flex items-center gap-2"><LayoutGrid className="h-3 w-3" /> Submitted Deliverables</p>
                                                        <div className="grid gap-2">
                                                            {displayTask.resourceLinks.split('\n').filter(Boolean).map((link, i) => (
                                                                <a key={i} href={link.startsWith('http') ? link : `https://${link}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 p-3 rounded-xl bg-card border border-slate-800 hover:bg-muted text-xs text-blue-400 hover:text-blue-300 transition-all font-mono truncate">
                                                                    <ExternalLink className="h-3 w-3 shrink-0" /> {link}
                                                                </a>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="text-center py-20 bg-card/30 border border-dashed border-slate-800 rounded-3xl">
                                                <div className="bg-muted/50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-700"><FileText className="h-8 w-8 text-slate-600" /></div>
                                                <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">Waiting for Operator Transmission...</p>
                                            </div>
                                        )}

                                        {/* Manager Controls */}
                                        {isManager && (displayTask.status === 'submitted-for-review' || displayTask.actualStatus === 'submitted-for-review') && (
                                            <div className="flex flex-col sm:flex-row gap-3 pt-6 border-t border-slate-800">
                                                <Button disabled={updating} className="flex-1 bg-primary text-black hover:bg-primary/90 font-black h-14 text-sm uppercase tracking-[0.2em] shadow-lg shadow-primary/10" onClick={handleApprove}>
                                                    {updating ? <Loader2 className="h-5 w-5 animate-spin" /> : "Approve Mission"}
                                                </Button>
                                                <Button disabled={updating} variant="outline" className="flex-1 border-red-500/50 text-red-500 hover:bg-red-500/10 font-black h-14 text-sm uppercase tracking-[0.2em]" onClick={() => setShowFeedbackDialog(true)}>
                                                    Request Revision
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Update Form (For Assignee) */}
                                {isAssignee && (displayTask.status === 'pending' || displayTask.status === 'in-progress' || displayTask.status === 'changes-requested') && (
                                    <div className="space-y-8 animate-in slide-in-from-bottom-4">
                                        {displayTask.status === 'changes-requested' && displayTask.feedback_history && displayTask.feedback_history.length > 0 && (
                                            <div className="bg-amber-500/10 border border-amber-500/40 p-4 rounded-2xl">
                                                <p className="text-[10px] font-black text-amber-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                                                    <MessageSquare className="h-3 w-3" /> Latest reviewer feedback
                                                </p>
                                                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                                                    {displayTask.feedback_history[displayTask.feedback_history.length - 1].text}
                                                </p>
                                            </div>
                                        )}
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest flex items-center gap-2"><ActivityIcon className="h-3 w-3" /> Mission Status</label>
                                                <Select value={status} onValueChange={(v: any) => setStatus(v)}>
                                                    <SelectTrigger className="bg-card border-slate-800 h-12 font-mono font-bold text-sm">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent className="bg-card border-slate-800">
                                                        <SelectItem value="pending">STANDBY (TO DO)</SelectItem>
                                                        <SelectItem value="in-progress">ACTIVE (IN PROGRESS)</SelectItem>
                                                        <SelectItem value="submitted-for-review">SUBMIT INTELLIGENCE (REVIEW)</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-2">
                                                <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest flex items-center gap-2"><Clock className="h-3 w-3" /> Time Logged (Hours)</label>
                                                <Input type="number" step="0.5" value={hoursWorked} onChange={e => setHoursWorked(e.target.value)} className="bg-card border-slate-800 h-12 font-mono text-center text-lg font-bold" placeholder="0.0" />
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest flex items-center gap-2"><ClipboardList className="h-3 w-3" /> Situation Report (SITREP)</label>
                                            <Textarea value={report} onChange={e => setReport(e.target.value)} className="bg-card border-slate-800 min-h-[200px] text-sm leading-relaxed p-4 focus:ring-primary/20" placeholder="Provide a detailed report of progress, blockers, and results..." />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest flex items-center gap-2"><Link2 className="h-3 w-3" /> Artifact Links (Deliverables)</label>
                                            <Textarea value={resourceLinks} onChange={e => setResourceLinks(e.target.value)} className="bg-card border-slate-800 min-h-[100px] text-xs font-mono p-4" placeholder="https://github.com/...\nhttps://drive.google.com/..." />
                                        </div>
                                        <Button className="w-full bg-primary text-black hover:bg-primary/90 font-black h-16 uppercase tracking-[0.2em] shadow-xl shadow-primary/5 text-base" onClick={handleUpdateMission} disabled={updating}>
                                            {updating ? <Loader2 className="h-6 w-6 animate-spin mr-3" /> : <RefreshCw className="h-6 w-6 mr-3" />}
                                            Transmit Mission Update
                                        </Button>
                                    </div>
                                )}

                                {/* Awaiting Review (Locked) */}
                                {isAssignee && displayTask.status === 'submitted-for-review' && (
                                    <div className="space-y-6 animate-in slide-in-from-bottom-4">
                                        <div className="text-center py-12 bg-amber-500/5 border border-dashed border-amber-500/30 rounded-3xl px-6">
                                            <div className="bg-amber-500/15 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                                                <Eye className="h-8 w-8 text-amber-400" />
                                            </div>
                                            <p className="text-amber-300 font-black uppercase tracking-widest text-sm">Transmitted — awaiting review</p>
                                            <p className="text-muted-foreground text-xs mt-2 max-w-sm mx-auto leading-relaxed">
                                                Your report is locked while the reviewer decides. You will be notified when it is approved or changes are requested.
                                            </p>
                                        </div>
                                        <Button variant="outline" className="w-full border-slate-700 text-muted-foreground hover:text-foreground hover:bg-muted font-bold h-12 uppercase tracking-widest text-xs" onClick={handleRecallSubmission} disabled={updating}>
                                            {updating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                                            Recall submission
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'activity' && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                {activitiesLoading ? (
                                    <div className="flex flex-col items-center py-20 space-y-4">
                                        <Loader2 className="h-10 w-10 text-primary animate-spin" /><p className="text-muted-foreground font-mono text-[10px] uppercase tracking-[0.3em]">Retrieving mission telemetry...</p>
                                    </div>
                                ) : activities.length === 0 ? (
                                    <div className="text-center py-20 text-slate-600 italic text-sm font-mono border border-dashed border-slate-800 rounded-3xl">No mission activity recorded in the log.</div>
                                ) : (
                                    <div className="relative space-y-8 pl-6 border-l-2 border-slate-800 ml-4 py-4">
                                        {activities.map((a) => (
                                            <div key={a.id} className="relative group">
                                                <div className="absolute -left-[33px] top-1.5 w-4 h-4 rounded-full bg-card border-4 border-slate-700 group-hover:border-primary transition-all shadow-lg" />
                                                <div className="flex flex-col gap-1.5">
                                                    <div className="flex items-center gap-3 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                                                        <span className="text-foreground bg-muted px-2 py-0.5 rounded">{a.userName}</span>
                                                        <ChevronRight className="h-3 w-3 text-slate-700" />
                                                        <span>{safeFormatDistance(a.createdAt)}</span>
                                                    </div>
                                                    <p className="text-xs text-muted-foreground bg-card/30 p-3 rounded-xl border border-slate-800/50 inline-block max-w-fit">
                                                        {a.type === 'comment' ? a.data.text : <span className="font-mono">{a.type.replace(/_/g, ' ')}</span>}
                                                    </p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </DialogContent>

            <Dialog open={showFeedbackDialog} onOpenChange={setShowFeedbackDialog}>
                <DialogContent className="bg-slate-950 border-slate-800 max-w-md shadow-2xl">
                    <DialogHeader>
                        <DialogTitle className="text-red-400 flex items-center gap-2 font-black uppercase tracking-tighter text-xl"><ShieldAlert className="h-6 w-6" /> Request Mission Revision</DialogTitle>
                        <DialogDescription className="text-muted-foreground text-xs font-mono uppercase mt-1">Specify operational deficiencies for correction.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 pt-6">
                        <Textarea placeholder="Detail the requested enhancements and required changes..." value={feedbackText} onChange={e => setFeedbackText(e.target.value)} className="bg-card border-slate-800 min-h-[180px] text-sm p-4" />
                        <div className="flex gap-3">
                            <Button variant="ghost" className="flex-1 font-bold text-muted-foreground" onClick={() => setShowFeedbackDialog(false)}>CANCEL</Button>
                            <Button disabled={updating || !feedbackText.trim()} className="flex-[2] bg-red-600 hover:bg-red-500 text-foreground font-black uppercase tracking-widest h-12" onClick={handleRequestRevision}>
                                {updating ? <Loader2 className="h-5 w-5 animate-spin" /> : "Transmit Feedback"}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {displayTask && (
                <DelegateTaskDialog 
                    open={showDelegateDialog}
                    onOpenChange={setShowDelegateDialog}
                    taskId={displayTask.id}
                    taskTitle={displayTask.title}
                    taskDescription={displayTask.description}
                    totalPoints={displayTask.points || 0}
                    onDelegated={() => {
                        onTaskUpdated?.();
                        onOpenChange(false);
                    }}
                />
            )}
        </Dialog>
    );
}
