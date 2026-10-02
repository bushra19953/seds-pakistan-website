'use client';

import { useState } from 'react';
import Link from 'next/link';
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { useFirestore } from '@/firebase';
import { useUser } from '@/firebase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
    History, CheckCircle2, Clock, Calendar, ChevronDown, ChevronUp,
    Trophy, Target, FileText, ExternalLink
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { TaskDetailDialog } from './task-detail-dialog';

interface CompletedTask {
    id: string;
    title: string;
    description?: string;
    completedAt: Date | null;
    deadline: Date | null;
    hoursWorked?: number;
    report?: string;
    points?: number;
    workflowId?: string;
    workflowTitle?: string;
    assignerId?: string;
    assignerName?: string;
    assignerPhoto?: string;
    wasOnTime?: boolean;
}

interface TaskHistoryProps {
    userId: string;
}

export function TaskHistory({ userId }: TaskHistoryProps) {
    const firestore = useFirestore();
    const { user: currentUser } = useUser();

    const [tasks, setTasks] = useState<CompletedTask[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);
    // Per-row inline detail expansion (currently unused: row clicks open the detail dialog)
    const [expandedTaskId] = useState<string | null>(null);
    const [selectedTask, setSelectedTask] = useState<CompletedTask | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);

    const loadHistory = async () => {
        if (!firestore || !currentUser || loaded) return;

        setLoading(true);
        setError(null);

        try {
            // Fetch completed tasks for this user
            const tasksRef = collection(firestore, 'tasks');
            const q = query(
                tasksRef,
                where('assigneeId', '==', userId),
                where('status', '==', 'completed'),
                orderBy('completedAt', 'desc'),
                limit(100)
            );

            const snapshot = await getDocs(q);

            // Collect unique assigner IDs
            const assignerIds = new Set<string>();
            const rawTasks: any[] = [];

            snapshot.docs.forEach(doc => {
                const data = doc.data();
                rawTasks.push({ id: doc.id, ...data });
                if (data.assignerId) assignerIds.add(data.assignerId);
            });

            // Fetch assigner info in parallel
            const { doc: docRef, getDoc } = await import('firebase/firestore');
            const assignerInfo: Record<string, { name: string; photoURL?: string }> = {};

            await Promise.all(Array.from(assignerIds).map(async (uid) => {
                try {
                    const userDoc = await getDoc(docRef(firestore, 'users', uid));
                    if (userDoc.exists()) {
                        const userData = userDoc.data();
                        assignerInfo[uid] = {
                            name: userData?.displayName || userData?.email || uid,
                            photoURL: userData?.photoURL || userData?.profileImageUrl,
                        };
                    } else {
                        assignerInfo[uid] = { name: uid };
                    }
                } catch {
                    assignerInfo[uid] = { name: uid };
                }
            }));

            // Normalize tasks
            const normalized: CompletedTask[] = rawTasks.map(t => {
                const completedAt = t.completedAt?.toDate?.() || (t.completedAt?.seconds ? new Date(t.completedAt.seconds * 1000) : null);
                const deadline = t.deadline?.toDate?.() || (t.deadline?.seconds ? new Date(t.deadline.seconds * 1000) : null);
                const wasOnTime = completedAt && deadline ? completedAt <= deadline : undefined;

                return {
                    id: t.id,
                    title: t.title,
                    description: t.description,
                    completedAt,
                    deadline,
                    hoursWorked: t.hoursWorked,
                    report: t.report,
                    points: t.points,
                    workflowId: t.workflowId,
                    workflowTitle: t.workflowTitle,
                    assignerId: t.assignerId,
                    assignerName: t.assignerId ? assignerInfo[t.assignerId]?.name : undefined,
                    assignerPhoto: t.assignerId ? assignerInfo[t.assignerId]?.photoURL : undefined,
                    wasOnTime,
                };
            });

            setTasks(normalized);
            setLoaded(true);
            setExpanded(true);
        } catch (err) {
            console.error('[TaskHistory] Error loading history:', err);
            setError('Failed to load task history');
        } finally {
            setLoading(false);
        }
    };

    const toggleExpand = () => {
        if (!loaded) {
            loadHistory();
        } else {
            setExpanded(!expanded);
        }
    };

    return (
        <Card className="mt-8 border-none shadow-none bg-transparent">
            <CardHeader className="px-0 pt-0">
                <div className="flex items-center justify-between">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-xl font-black tracking-tight uppercase text-slate-400">
                            <History className="h-5 w-5" />
                            Mission Archives
                        </CardTitle>
                        <CardDescription className="text-sm font-medium">
                            Completed missions and historical records.
                        </CardDescription>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={toggleExpand}
                        className="border-slate-700 hover:bg-slate-800"
                    >
                        {loading ? (
                            <>Loading...</>
                        ) : expanded ? (
                            <>
                                <ChevronUp className="h-4 w-4 mr-1" />
                                Hide
                            </>
                        ) : (
                            <>
                                <ChevronDown className="h-4 w-4 mr-1" />
                                {loaded ? `Show (${tasks.length})` : 'Load History'}
                            </>
                        )}
                    </Button>
                </div>
            </CardHeader>

            {expanded && (
                <CardContent className="px-0">
                    {loading ? (
                        <div className="space-y-4">
                            <Skeleton className="h-24 w-full" />
                            <Skeleton className="h-24 w-full" />
                            <Skeleton className="h-24 w-full" />
                        </div>
                    ) : error ? (
                        <div className="p-6 border-2 border-red-500/20 bg-red-500/5 rounded-xl text-center">
                            <p className="text-red-400">{error}</p>
                            <Button variant="ghost" size="sm" onClick={loadHistory} className="mt-2">
                                Retry
                            </Button>
                        </div>
                    ) : tasks.length === 0 ? (
                        <div className="p-8 border-2 border-dashed border-slate-700 rounded-xl text-center">
                            <Trophy className="h-12 w-12 text-slate-600 mx-auto mb-3" />
                            <p className="text-slate-400 font-medium">No completed missions yet</p>
                            <p className="text-sm text-slate-500">Complete your first mission to see it here!</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {tasks.map(task => (
                                <div
                                    key={task.id}
                                    className="bg-gradient-to-br from-green-900/10 to-slate-900/50 border border-green-500/20 rounded-xl overflow-hidden hover:border-green-500/40 transition-colors"
                                >
                                    {/* Main Row */}
                                    <div
                                        className="p-4 cursor-pointer group"
                                        onClick={() => {
                                            setSelectedTask(task);
                                            setDialogOpen(true);
                                        }}
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0 group-hover:scale-110 transition-transform" />
                                                    <h4 className="font-bold text-white group-hover:text-primary transition-colors truncate">{task.title}</h4>
                                                    {task.wasOnTime !== undefined && (
                                                        <Badge
                                                            className={`text-[10px] ${task.wasOnTime
                                                                ? 'bg-green-500/20 text-green-400 border-green-500/40'
                                                                : 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                                                                }`}
                                                        >
                                                            {task.wasOnTime ? 'On Time' : 'Late'}
                                                        </Badge>
                                                    )}
                                                </div>

                                                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                                                    {task.completedAt && (
                                                        <span className="flex items-center gap-1">
                                                            <Calendar className="h-3 w-3" />
                                                            {format(task.completedAt, 'MMM d, yyyy')}
                                                        </span>
                                                    )}
                                                    {task.hoursWorked !== undefined && task.hoursWorked > 0 && (
                                                        <span className="flex items-center gap-1">
                                                            <Clock className="h-3 w-3" />
                                                            {task.hoursWorked}h logged
                                                        </span>
                                                    )}
                                                    {task.points !== undefined && task.points > 0 && (
                                                        <span className="flex items-center gap-1 text-primary">
                                                            <Trophy className="h-3 w-3" />
                                                            +{task.points} pts
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Assigner */}
                                            {task.assignerId && (
                                                <Link
                                                    href={`/profile/unified?uid=${task.assignerId}`}
                                                    onClick={e => e.stopPropagation()}
                                                    className="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-800/50 transition-colors"
                                                >
                                                    <Avatar className="h-6 w-6">
                                                        {task.assignerPhoto && <AvatarImage src={task.assignerPhoto} />}
                                                        <AvatarFallback className="text-[10px] bg-violet-600">
                                                            {task.assignerName?.charAt(0) || '?'}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    <span className="text-xs text-slate-400 hidden sm:block">
                                                        {task.assignerName || 'Unknown'}
                                                    </span>
                                                </Link>
                                            )}

                                            <div className="h-8 w-8 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700 group-hover:border-primary/50 group-hover:bg-primary/10 transition-all">
                                                <ExternalLink className="h-4 w-4 text-slate-500 group-hover:text-primary" />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Expanded Detail */}
                                    {expandedTaskId === task.id && (
                                        <div className="px-4 pb-4 pt-2 border-t border-slate-700/50">
                                            {task.workflowTitle && (
                                                <div className="flex items-center gap-2 text-xs text-slate-400 mb-3">
                                                    <Target className="h-3 w-3" />
                                                    Part of: <span className="text-white font-medium">{task.workflowTitle}</span>
                                                </div>
                                            )}

                                            {task.report && (
                                                <div className="bg-slate-800/50 rounded-lg p-3 mb-3">
                                                    <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                                                        <FileText className="h-3 w-3" />
                                                        Completion Report
                                                    </div>
                                                    <p className="text-sm text-slate-300 whitespace-pre-wrap">
                                                        {task.report}
                                                    </p>
                                                </div>
                                            )}

                                            {task.description && (
                                                <p className="text-sm text-slate-400">{task.description}</p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            )}

            <TaskDetailDialog
                task={selectedTask ? {
                    id: selectedTask.id,
                    title: selectedTask.title,
                    description: selectedTask.description || '',
                    status: 'completed',
                    priority: 'medium',
                    assigneeId: userId,
                    assigneeName: 'You',
                    creatorId: selectedTask.assignerId || undefined,
                    creatorName: selectedTask.assignerName || 'Unknown',
                    creatorPhoto: selectedTask.assignerPhoto,
                    deadline: selectedTask.deadline?.toISOString() || null,
                    createdAt: null,
                    completedAt: selectedTask.completedAt?.toISOString() || null,
                    isOverdue: false,
                    hoursWorked: selectedTask.hoursWorked,
                    report: selectedTask.report,
                    workflowId: selectedTask.workflowId,
                    workflowTitle: selectedTask.workflowTitle,
                } : null}
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onTaskUpdated={() => {
                    setLoaded(false);
                    loadHistory();
                }}
                isManager={false}
            />
        </Card>
    );
}
