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
    Trophy, Target, FileText, ExternalLink, ScrollText, Eye
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
    instructionVersions?: InstructionVersion[];
}

// One published version of the task's instruction brief.
// Written by the instruction-delivery writer; this file only reads it.
interface InstructionVersion {
    version: number;
    publishedAt: Date | null;
    viewedAt: Date | null;
    publishedByName?: string;
}

/**
 * Accepts a Firestore Timestamp, JS Date, ISO string, or epoch millis/seconds
 * and returns a Date, or null when the value is missing or unparseable.
 */
function toDateSafe(value: any): Date | null {
    if (!value) return null;
    if (value?.toDate && typeof value.toDate === 'function') {
        try { return value.toDate(); } catch { return null; }
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
        const d = new Date(value < 1e12 ? value * 1000 : value); // seconds or millis
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string') {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value?.seconds === 'number') {
        const d = new Date(value.seconds * 1000);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

/**
 * Reads instruction brief versions from a raw task doc, defensively:
 * accepts `instructionVersions`, `instructionHistory`, or `briefVersions`,
 * and entry shapes `{version|v, publishedAt|published, viewedAt|viewed}`.
 * Returns versions sorted oldest to newest. Empty array when none exist.
 */
function normalizeInstructionVersions(raw: any): InstructionVersion[] {
    const source = raw.instructionVersions ?? raw.instructionHistory ?? raw.briefVersions;
    if (!Array.isArray(source)) return [];
    const versions: InstructionVersion[] = [];
    source.forEach((entry: any, index: number) => {
        if (!entry || typeof entry !== 'object') return;
        const version = typeof entry.version === 'number' ? entry.version
            : typeof entry.v === 'number' ? entry.v
            : index + 1;
        const publishedAt = toDateSafe(entry.publishedAt ?? entry.published ?? entry.createdAt);
        const viewedAt = toDateSafe(entry.viewedAt ?? entry.viewed ?? entry.readAt);
        if (publishedAt === null && typeof entry.version !== 'number' && typeof entry.v !== 'number') {
            return; // entry has no usable content
        }
        versions.push({
            version,
            publishedAt,
            viewedAt,
            publishedByName: typeof entry.publishedByName === 'string' ? entry.publishedByName : undefined,
        });
    });
    versions.sort((a, b) => {
        if (a.version !== b.version) return a.version - b.version;
        const at = a.publishedAt?.getTime() ?? 0;
        const bt = b.publishedAt?.getTime() ?? 0;
        return at - bt;
    });
    return versions;
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
    // Which task's instruction history subsection is open (collapsed by default)
    const [instructionOpenFor, setInstructionOpenFor] = useState<string | null>(null);

    const toggleInstructionHistory = (taskId: string) => {
        setInstructionOpenFor(prev => (prev === taskId ? null : taskId));
    };

    const loadHistory = async () => {
        if (!firestore || !currentUser || loaded) return;

        setLoading(true);
        setError(null);

        try {
            // Fetch completed tasks for this user (both assignment forms)
            const tasksRef = collection(firestore, 'tasks');
            // History holds every finished task: the canonical
            // 'completed' plus the legacy 'approved' spelling older
            // approval paths stamped (both carry completedAt when the
            // canonical transaction wrote them).
            const q = query(
                tasksRef,
                where('assigneeId', '==', userId),
                where('status', 'in', ['completed', 'approved']),
                orderBy('completedAt', 'desc'),
                limit(100)
            );
            const qArr = query(
                tasksRef,
                where('assigneeIds', 'array-contains', userId),
                where('status', 'in', ['completed', 'approved']),
                orderBy('completedAt', 'desc'),
                limit(100)
            );

            const [snapshot, snapshotArr] = await Promise.all([getDocs(q), getDocs(qArr)]);
            const seen = new Set<string>();
            const allDocs = [...snapshot.docs, ...snapshotArr.docs].filter(d => {
                if (seen.has(d.id)) return false;
                seen.add(d.id);
                return true;
            });

            // Collect unique assigner IDs
            const assignerIds = new Set<string>();
            const rawTasks: any[] = [];

            allDocs.forEach(doc => {
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
                            name: userData?.displayName || uid,
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
                    instructionVersions: normalizeInstructionVersions(t),
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
                        <CardTitle className="flex items-center gap-2 text-xl font-black tracking-tight uppercase text-muted-foreground">
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
                        className="border-slate-700 hover:bg-muted"
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
                            <p className="text-muted-foreground font-medium">No completed missions yet</p>
                            <p className="text-sm text-muted-foreground">Complete your first mission to see it here!</p>
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
                                                    <h4 className="font-bold text-foreground group-hover:text-primary transition-colors truncate">{task.title}</h4>
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

                                                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
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
                                                    className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/50 transition-colors"
                                                >
                                                    <Avatar className="h-6 w-6">
                                                        {task.assignerPhoto && <AvatarImage src={task.assignerPhoto} />}
                                                        <AvatarFallback className="text-[10px] bg-violet-600">
                                                            {task.assignerName?.charAt(0) || '?'}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    <span className="text-xs text-muted-foreground hidden sm:block">
                                                        {task.assignerName || 'Unknown'}
                                                    </span>
                                                </Link>
                                            )}

                                            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center border border-slate-700 group-hover:border-primary/50 group-hover:bg-primary/10 transition-all">
                                                <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Instruction history (compact, collapsed by default; hidden when no versions) */}
                                    {task.instructionVersions && task.instructionVersions.length > 0 && (
                                        <div className="px-4 pb-3 border-t border-slate-700/50">
                                            <button
                                                type="button"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    toggleInstructionHistory(task.id);
                                                }}
                                                className="flex w-full items-center gap-2 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                                                aria-expanded={instructionOpenFor === task.id}
                                            >
                                                <ScrollText className="h-3.5 w-3.5 text-sky-400" />
                                                <span>
                                                    Instruction history ({task.instructionVersions.length} version{task.instructionVersions.length === 1 ? '' : 's'})
                                                </span>
                                                <span className="ml-auto">
                                                    {instructionOpenFor === task.id ? (
                                                        <ChevronUp className="h-3.5 w-3.5" />
                                                    ) : (
                                                        <ChevronDown className="h-3.5 w-3.5" />
                                                    )}
                                                </span>
                                            </button>

                                            {instructionOpenFor === task.id && (
                                                <ol className="space-y-2 pt-1">
                                                    {task.instructionVersions.map((entry, idx) => (
                                                        <li
                                                            key={`${entry.version}-${idx}`}
                                                            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs"
                                                        >
                                                            <Badge className="text-[10px] bg-sky-500/20 text-sky-300 border-sky-500/40">
                                                                v{entry.version}
                                                            </Badge>
                                                            <span className="text-muted-foreground">
                                                                Published{' '}
                                                                {entry.publishedAt
                                                                    ? format(entry.publishedAt, 'MMM d, yyyy h:mm a')
                                                                    : 'date not recorded'}
                                                                {entry.publishedByName && ` by ${entry.publishedByName}`}
                                                            </span>
                                                            {entry.viewedAt ? (
                                                                <span className="flex items-center gap-1 text-green-400">
                                                                    <Eye className="h-3 w-3" />
                                                                    Viewed {format(entry.viewedAt, 'MMM d, yyyy h:mm a')}
                                                                </span>
                                                            ) : (
                                                                <span className="text-muted-foreground/70 italic">
                                                                    Not viewed yet
                                                                </span>
                                                            )}
                                                        </li>
                                                    ))}
                                                </ol>
                                            )}
                                        </div>
                                    )}

                                    {/* Expanded Detail */}
                                    {expandedTaskId === task.id && (
                                        <div className="px-4 pb-4 pt-2 border-t border-slate-700/50">
                                            {task.workflowTitle && (
                                                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                                                    <Target className="h-3 w-3" />
                                                    Part of: <span className="text-foreground font-medium">{task.workflowTitle}</span>
                                                </div>
                                            )}

                                            {task.report && (
                                                <div className="bg-muted/50 rounded-lg p-3 mb-3">
                                                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                                                        <FileText className="h-3 w-3" />
                                                        Completion Report
                                                    </div>
                                                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                                                        {task.report}
                                                    </p>
                                                </div>
                                            )}

                                            {task.description && (
                                                <p className="text-sm text-muted-foreground">{task.description}</p>
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
