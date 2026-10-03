
'use client';

import { useState, useEffect, Suspense, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUserContext } from '@/firebase/user-provider';
import { hasSufficientRole, USER_ROLES } from '@/lib/roles';
import { hasPermission } from '@/config/permissions';
import {
  createTask,
  getAllTasks,
  updateTask,
  deleteTask,
  getTask
} from '@/lib/task-management';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useFirestore, useCollection } from '@/firebase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { format } from 'date-fns';
import { Task } from '@/lib/task-types';
import type { TaskStatus } from '@/lib/task-types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog';
// Uses persistent layout at app/admin/layout.tsx
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { toDate } from '@/lib/date-utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

const TaskForm = dynamic(() => import('@/components/admin/tasks/task-form').then(mod => mod.default), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>
});

const MultiSelectUserCombobox = dynamic(() => import('@/components/admin/multi-select-user-combobox'), {
  ssr: false,
  loading: () => <Skeleton className="h-10 w-full" />
});

const UserSelectionCombobox = dynamic(() => import('@/components/admin/user-selection-combobox'), {
  ssr: false,
  loading: () => <Skeleton className="h-10 w-full" />
});

// Type imports for TaskForm
import type { TaskFormValues, WorkflowStep } from '@/components/admin/tasks/task-form';

import { useAuthorization } from '@/hooks/use-authorization';

function AdminTasksPageInner() {
  const { user, isLoading: userLoading } = useUserContext();
  const { isAuthorized: canManageTasks, isLoading: authLoading } = useAuthorization('canManageTasks');
  const { isAuthorized: canManageSettings } = useAuthorization('canManageSiteSettings');
  
  const router = useRouter();
  const searchParams = useSearchParams();
  const firestore = useFirestore();
  const { showToast: toast } = useEnhancedToast();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState<number>(100);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isEditingLoading, setIsEditingLoading] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isCheckingDeadlines, setIsCheckingDeadlines] = useState(false); // NEW
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [modelSelectValue, setModelSelectValue] = useState<string>('gemini-2.5-flash');
  const [customModelInput, setCustomModelInput] = useState<string>('');
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  // Architectural note: We separate UI-only Select state from core data state.
  // - viewProjectSelectValue drives the Select UI for the global project filter.
  // - viewProjectId is the core state that the table and progress overview use for filtering.
  // All synchronization from the UI value to the core state happens inside useEffect.
  const [viewProjectId, setViewProjectId] = useState<string>('all'); // core filter state: 'all' | 'none' | projectId
  const [viewProjectSelectValue, setViewProjectSelectValue] = useState<string>('all'); // UI-only value for the global filter Select

  // New global filters: Assignee and Status (replace the old Project filter UI)
  const [assigneeFilterUid, setAssigneeFilterUid] = useState<string>(''); // empty = All assignees
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');

  // Task form local state
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    assigneeIds: [] as string[], // Changed to array for batch assignment
    deadline: '',
    status: 'pending' as TaskStatus,
    report: '',
    points: 10,
    projectId: '',
    completionBadgeId: ''
  });

  // FIX-1: CRITICAL - Remove taskFormInitialValues useMemo that was causing infinite renders
  // TaskForm will handle its own initial values directly
  // This eliminates the circular dependency: formData -> taskFormInitialValues -> TaskForm -> re-render -> formData

  // Architectural note: For all shadcn/ui Selects in the form, we control them with
  // UI-only local state and then synchronize into the main form state via useEffect.
  // This cleanly separates render logic (controlled inputs) from side effects (state mutations),
  // eliminating any possibility of re-render loops caused by inline state updates inside render.
  const [projectSelectValue, setProjectSelectValue] = useState<string>('none');
  const [statusSelectValue, setStatusSelectValue] = useState<TaskStatus>('pending');
  const [badgeSelectValue, setBadgeSelectValue] = useState<string>('none');
  const [editingWorkflowSteps, setEditingWorkflowSteps] = useState<WorkflowStep[]>([]);

  const allowedStatuses: TaskStatus[] = ['pending', 'in-progress', 'submitted-for-review', 'completed'];
  const normalizedStatus = useMemo<TaskStatus>(() => {
    const s = String(editingTask?.status || '').toLowerCase();
    return (allowedStatuses as unknown as string[]).includes(s) ? (s as TaskStatus) : 'in-progress';
  }, [editingTask]);

  // Fetch users for the assignee dropdown
  const usersCollectionRef = useMemoFirebase(() => collection(firestore, 'users'), [firestore]);
  const { data: users, loading: usersLoading } = useCollection(usersCollectionRef);

  // Fetch roles for role visibility
  const rolesCollectionRef = useMemoFirebase(() => collection(firestore, 'roles'), [firestore]);
  const { data: userRoles, loading: rolesLoading } = useCollection(rolesCollectionRef);

  // Fetch badges for optional completion award
  const badgesCollectionRef = useMemoFirebase(() => collection(firestore, 'badges'), [firestore]);
  const { data: badges, loading: badgesLoading } = useCollection(badgesCollectionRef);

  // Fetch projects for project selection and progress
  const projectsCollectionRef = useMemoFirebase(() => collection(firestore, 'projects'), [firestore]);
  const { data: projects, loading: projectsLoading } = useCollection(projectsCollectionRef);

  // Create a map of user roles for easy lookup
  const userRolesMap = userRoles?.reduce((acc, roleDoc) => {
    acc[roleDoc.id] = roleDoc.role;
    return acc;
  }, {} as Record<string, string>) || {};


  useEffect(() => {
    if (!userLoading && !authLoading && user && canManageTasks) {
      fetchTasks();
    }
  }, [user, canManageTasks, userLoading, authLoading]);

  // Refetch whenever global filters change
  useEffect(() => {
    if (!userLoading && !authLoading && user && canManageTasks) {
      fetchTasks();
    }
  }, [statusFilter, assigneeFilterUid, userLoading, authLoading, user, canManageTasks]);

  // Sync the UI-only global filter Select with the URL query param (supports deep-linking).
  // IMPORTANT ARCHITECTURAL PATTERN: read the external source, update the UI state,
  // then synchronize to core filter state via a separate effect below.
  useEffect(() => {
    const paramVal = searchParams?.get('projectId');
    const nextVal = paramVal ? paramVal : 'all';
    setViewProjectSelectValue((prev) => (prev !== nextVal ? nextVal : prev));
  }, [searchParams]);



  // Initialize Settings - per-user AI key (localStorage) with server key as fallback
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const storedModel = window.localStorage.getItem('genai.model') || '';
      const storedKey = window.localStorage.getItem('gemini.apiKey') || '';
      setApiKeyInput(storedKey);
      
      const knownModels = ['gemini-2.5-pro', 'gemini-2.5-flash'];
      
      if (storedModel) {
        if (knownModels.includes(storedModel)) {
          setModelSelectValue(storedModel);
        } else {
          setModelSelectValue('custom');
          setCustomModelInput(storedModel);
        }
      }
    }
  }, []);

  // ARCHITECTURAL FIX: Synchronize UI-only global filter value into core filter state.
  // By doing this in useEffect (not inline during render), we avoid any possibility of
  // creating a state update loop tied to component rendering.
  useEffect(() => {
    setViewProjectId((prev) => (prev !== viewProjectSelectValue ? viewProjectSelectValue : prev));
  }, [viewProjectSelectValue]);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      setErrorMessage('');
      if (!user) {
        setErrorMessage('User not authenticated');
        throw new Error('User not authenticated');
      }
      const idToken = await user.getIdToken(true);
      const params = new URLSearchParams();
      params.set('status', statusFilter);
      if (assigneeFilterUid) params.set('assigneeId', assigneeFilterUid);
      // FIX: Pass server-side filter for projectId to ensure data accuracy & scalability
      if (viewProjectId && viewProjectId !== 'all' && viewProjectId !== 'none') {
        params.set('projectId', viewProjectId);
      }
      params.set('limit', String(pageSize));
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/tasks?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error', error_code: 'unknown' }));
        setErrorMessage(typeof err.error === 'string' ? err.error : 'Failed to fetch tasks');
        throw new Error(err.error || 'Failed to fetch tasks');
      }
      const data = await res.json();
      const fetchedTasks = (data?.items || []) as any[];
      const normalizedTasks = fetchedTasks.map((t: any) => ({
        ...t,
        deadline: toDate(t?.deadline),
        individualDeadline: toDate(t?.individualDeadline),
        createdAt: toDate(t?.createdAt),
        updatedAt: toDate(t?.updatedAt)
      }));
      setTasks(normalizedTasks as any);
      setNextCursor(data?.nextCursor || null);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage || "Failed to fetch tasks.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTask = () => {
    setEditingTask(null);
    setFormData({
      title: '',
      description: '',
      assigneeIds: [],
      deadline: '',
      status: 'pending',
      report: '',
      points: 10,
      projectId: '',
      completionBadgeId: ''
    });
    setIsDialogOpen(true);
    // Initialize UI-only Select states for a clean form experience
    setProjectSelectValue('none');
    setStatusSelectValue('pending');
    setBadgeSelectValue('none');
  };

  const handleEditTask = useCallback(async (taskId: string) => {
    try {
      setIsEditingLoading(true);
      setIsDialogOpen(true);
      const task = await getTask(firestore, taskId);
      if (task) {
        // Normalize potential Firestore Timestamp into native Date for edit flow.
        // This ensures `.toISOString()` works reliably for the datetime-local input.
        const deadlineTs: any = (task as any).deadline;
        const deadlineDate: Date = deadlineTs && typeof deadlineTs.toDate === 'function'
          ? deadlineTs.toDate()
          : (deadlineTs ? new Date(deadlineTs) : new Date());

        const createdAtTs: any = (task as any).createdAt;
        const createdAtDate: Date = createdAtTs && typeof createdAtTs.toDate === 'function'
          ? createdAtTs.toDate()
          : (createdAtTs ? new Date(createdAtTs) : new Date());

        const updatedAtTs: any = (task as any).updatedAt;
        const updatedAtDate: Date = updatedAtTs && typeof updatedAtTs.toDate === 'function'
          ? updatedAtTs.toDate()
          : (updatedAtTs ? new Date(updatedAtTs) : new Date());

        const normalizedTask: any = {
          ...task,
          deadline: isNaN(deadlineDate.getTime()) ? new Date() : deadlineDate,
          createdAt: isNaN(createdAtDate.getTime()) ? new Date() : createdAtDate,
          updatedAt: isNaN(updatedAtDate.getTime()) ? new Date() : updatedAtDate,
        };

        setEditingTask(normalizedTask as any);
        // Map legacy/unknown statuses to safe values for the new workflow
        const allowedStatuses: ('pending' | 'in-progress' | 'submitted-for-review' | 'completed')[] = ['pending', 'in-progress', 'submitted-for-review', 'completed'];
        const safeStatus: 'pending' | 'in-progress' | 'submitted-for-review' | 'completed' = allowedStatuses.includes(normalizedTask.status as any)
          ? (normalizedTask.status as 'pending' | 'in-progress' | 'submitted-for-review' | 'completed')
          : 'in-progress';
        setFormData({
          title: normalizedTask.title,
          description: normalizedTask.description,
          assigneeIds: [normalizedTask.assigneeId], // Convert single assignee to array for consistency
          deadline: (normalizedTask.deadline as Date).toISOString().slice(0, 16),
          status: safeStatus,
          report: normalizedTask.report || '',
          points: normalizedTask.points,
          projectId: (normalizedTask as any).projectId || '',
          completionBadgeId: (normalizedTask as any).completionBadgeId || ''
        });
        setIsDialogOpen(true);
        // Initialize UI-only Selects based on the loaded task
        setProjectSelectValue((normalizedTask as any).projectId ? String((normalizedTask as any).projectId) : 'none');
        setStatusSelectValue(safeStatus);
        setBadgeSelectValue((normalizedTask as any).completionBadgeId ? String((normalizedTask as any).completionBadgeId) : 'none');

        // Deep-fetch workflow steps for full visibility in edit modal
        if ((normalizedTask as any).workflowId) {
          const wfId = String((normalizedTask as any).workflowId);
          console.log('[AdminTasks] Fetching workflow steps for workflowId:', wfId);
          try {
            const q = query(collection(firestore, 'tasks'), where('workflowId', '==', wfId), orderBy('sequenceIndex', 'asc'));
            const snap = await getDocs(q);
            console.log('[AdminTasks] Workflow steps fetched:', snap.docs.length, 'steps');

            if (snap.docs.length === 0) {
              console.warn('[AdminTasks] No workflow steps found for workflowId:', wfId);
            }

            const steps: WorkflowStep[] = snap.docs.map((d, i) => {
              const data = d.data() as any;
              const ind = data?.individualDeadline;
              const indDate = ind && typeof ind?.toDate === 'function' ? ind.toDate() : (ind ? new Date(ind) : null);
              const indLocal = indDate && !isNaN(indDate.getTime()) ? indDate.toISOString().slice(0, 16) : '';

              console.log(`[AdminTasks] Step ${i}:`, {
                id: d.id,
                title: data?.title,
                sequenceIndex: data?.sequenceIndex,
                resourcesCount: data?.resources?.length || 0
              });

              return {
                id: d.id,
                title: String(data?.title || `Step ${i + 1}`),
                description: String(data?.description || ''),
                role: data?.role || undefined,
                assigneeId: data?.assigneeId || undefined,
                stepSpecificBadgeId: data?.stepSpecificBadgeId || undefined,
                individualDeadlineIso: indLocal,
                resources: Array.isArray(data?.resources) ? [...data.resources] : [], // Deep copy resources
              };
            });
            // Store in formData for TaskForm via prop
            setEditingWorkflowSteps(steps);
          } catch (queryError) {
            console.error('[AdminTasks] Failed to fetch workflow steps:', queryError);
            console.error('[AdminTasks] This may indicate a missing Firestore index for workflowId + sequenceIndex');
            toast({
              variant: "destructive",
              title: "Workflow Load Error",
              description: "Could not load all workflow steps. Some steps may be missing.",
            });
            setEditingWorkflowSteps([]);
          }
        } else {
          setEditingWorkflowSteps([]);
        }

      }
    } catch (error) {
      console.error('Error fetching task for edit:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch task for editing.",
      });
    }
    finally {
      setIsEditingLoading(false);
    }
  }, [firestore, toast]);

  // State and effect for deep-linking to a specific task via ?taskId= URL parameter
  // IMPORTANT: This must be defined AFTER handleEditTask to avoid TDZ errors in production builds
  const [hasOpenedInitialTask, setHasOpenedInitialTask] = useState(false);

  useEffect(() => {
    const urlTaskId = searchParams.get('taskId');
    if (urlTaskId && !loading && !hasOpenedInitialTask) {
      handleEditTask(urlTaskId);
      setHasOpenedInitialTask(true);
    }
  }, [searchParams, loading, hasOpenedInitialTask, handleEditTask]);

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Are you sure you want to delete this task?")) return;
    try {
      if (!user) throw new Error('User not authenticated');
      const idToken = await user.getIdToken(true);
      const res = await fetch('/api/tasks', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ taskId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to delete task');
      }
      toast({ title: "Task Deleted", description: "Task has been successfully deleted." });
      fetchTasks();
    } catch (error) {
      console.error('Error deleting task:', error);
      toast({ variant: "destructive", title: "Error", description: "Failed to delete task." });
    }
  };

  // Admin Verification Workflow Actions
  const approveTask = async (taskId: string) => {
    try {
      if (!user) throw new Error('User not authenticated');
      const idToken = await user.getIdToken(true);
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ taskId, updates: { status: 'completed' } }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to approve task');
      }

      const data = await res.json();
      toast({
        title: 'Task Approved',
        description: data.badgeAwarded
          ? 'Completion approved. Points and badge awarded.'
          : 'Completion approved.',
      });
      fetchTasks();
    } catch (error: any) {
      console.error('Error approving task:', error);
      toast({ variant: 'destructive', title: 'Error', description: error.message || 'Failed to approve task.' });
    }
  };

  const requestRevisions = async (taskId: string) => {
    try {
      if (!user) throw new Error('User not authenticated');
      const idToken = await user.getIdToken(true);
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ taskId, updates: { status: 'in-progress' } }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to request revisions');
      }

      toast({ title: 'Revisions Requested', description: 'Task moved back to In Progress.' });
      fetchTasks();
    } catch (error: any) {
      console.error('Error requesting revisions:', error);
      toast({ variant: 'destructive', title: 'Error', description: error.message || 'Failed to request revisions.' });
    }
  };

  const handleUpdateWorkflowSteps = async (steps: WorkflowStep[]) => {
    try {
      if (!user) throw new Error('User not authenticated');
      const idToken = await user.getIdToken(true);
      const changed = steps.filter((s) => typeof s.id === 'string' && (s.individualDeadlineIso || '').trim().length > 0);
      for (const s of changed) {
        const body = {
          taskId: s.id,
          updates: { individualDeadline: new Date(s.individualDeadlineIso as string).toISOString() }
        } as any;
        const res = await fetch('/api/tasks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(err.error || 'Failed to update step deadline');
        }
      }
      toast({ title: 'Workflow Updated', description: 'Step deadlines updated successfully.' });
      setIsDialogOpen(false);
      fetchTasks();
    } catch (e: any) {
      console.error('Error updating workflow steps:', e);
      toast({ variant: 'destructive', title: 'Error', description: e?.message || 'Failed to update workflow steps.' });
    }
  };

  const handleSaveTask = async (values: TaskFormValues) => {
    const {
      title,
      description,
      assigneeIds,
      deadline,
      status,
      report,
      points,
      projectId,
      completionBadgeId,
    } = values;

    if (!title || !description || assigneeIds.length === 0 || !deadline) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Title, description, at least one assignee, and deadline are required.",
      });
      return;
    }

    try {
      // Optimistic UI: close dialog immediately and apply local state updates
      const previousTasks = [...tasks];
      setIsDialogOpen(false);

      if (editingTask) {
        // Update existing task
        const updates: any = {
          title,
          description,
          assigneeId: assigneeIds[0], // For single edit, use first assignee
          // Send deadline as ISO string; server converts to timestamp
          deadline: new Date(deadline).toISOString(),
          status,
          report,
          points,
          projectId: projectId || undefined,
          completionBadgeId: completionBadgeId || undefined,
        };

        // Optimistically update the task in local state
        setTasks((prev) => prev.map((t) => t.id === editingTask.id ? {
          ...t,
          title: updates.title,
          description: updates.description,
          assigneeId: updates.assigneeId,
          deadline: new Date(deadline),
          status: updates.status,
          report: updates.report,
          points: updates.points,
          projectId: updates.projectId || undefined,
          completionBadgeId: updates.completionBadgeId || undefined,
          updatedAt: new Date(),
        } as any : t));

        if (!user) {
          throw new Error("User not authenticated");
        }

        const idToken = await user.getIdToken(true);
        const res = await fetch('/api/tasks', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({ taskId: editingTask.id, updates }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          console.error('Task update failed:', err);
          // Revert optimistic changes
          setTasks(previousTasks);
          setIsDialogOpen(true);
          const msg = err.details
            ? Object.values(err.details).flat().join(', ')
            : (err.error || 'Failed to update task');
          throw new Error(msg);
        }

        const data = await res.json();
        toast({
          title: "Task Updated",
          description: data.badgeAwarded
            ? "Task updated and badge awarded on completion."
            : "Task has been successfully updated.",
        });
      } else {
        // Create new tasks for each selected assignee (batch assignment)
        // Optimistically add tasks to local state before API call
        const now = new Date();
        const optimisticTasks = assigneeIds.map((assigneeId: string) => ({
          id: `temp-${Date.now()}-${assigneeId}`,
          title,
          description,
          assignerId: user?.uid || 'unknown',
          assigneeId,
          deadline: new Date(deadline),
          status,
          report,
          points,
          projectId: projectId || undefined,
          completionBadgeId: completionBadgeId || undefined,
          createdAt: now,
        } as any));
        setTasks((prev) => [...optimisticTasks, ...prev]);

        const promises = assigneeIds.map(async (assigneeId) => {
          if (!user) throw new Error("User not authenticated");

          const idToken = await user.getIdToken(true);
          const payload: any = {
            title,
            description,
            // assignerId is inferred server-side from token, but include for clarity
            assignerId: user.uid,
            assigneeId,
            // Send ISO string for server normalization
            deadline: new Date(deadline).toISOString(),
            status,
            report,
            points: typeof points === 'number' ? points : 0,
            projectId: projectId || undefined,
            completionBadgeId: completionBadgeId || undefined,
          };

          const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Unknown error' }));
            console.error('Task creation failed:', err);
            // Revert optimistic additions
            setTasks(previousTasks);
            setIsDialogOpen(true);
            const msg = err.details
              ? (typeof err.details === 'object' && err.details.fieldErrors
                ? JSON.stringify(err.details.fieldErrors)
                : JSON.stringify(err.details))
              : (err.error || 'Failed to create task');
            throw new Error(msg);
          }

          return res.json();
        });

        await Promise.all(promises);
        toast({
          title: "Tasks Created",
          description: `Successfully created ${assigneeIds.length} task(s).`,
        });
      }

      // Re-sync with server data to replace any optimistic entries
      fetchTasks();
    } catch (error) {
      console.error('Error saving task:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: `Failed to save task: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  // Create a workflow using server-authoritative API with single final deadline
  const handleCreateWorkflow = async (values: TaskFormValues, steps: WorkflowStep[]) => {
    try {
      if (!user) throw new Error('User not authenticated');
      if (!Array.isArray(steps) || steps.length === 0) throw new Error('No workflow steps to create');
      const deadlineIso = values.deadline ? new Date(values.deadline).toISOString() : new Date().toISOString();

      // Phase 1 Enhancement: Add deadline validation
      const now = new Date();
      const deadline = new Date(deadlineIso);
      const minBufferTime = 24 * 60 * 60 * 1000; // 24 hours minimum buffer

      if (deadline <= now) {
        throw new Error('Workflow deadline must be set to a future date. Please choose a deadline that is at least 1 hour from now.');
      }

      if (deadline.getTime() - now.getTime() < minBufferTime) {
        toast({
          variant: 'destructive',
          title: 'Deadline Too Soon',
          description: 'Workflow deadline must be at least 24 hours from now to allow proper step allocation.'
        });
        return;
      }

      const idToken = await user.getIdToken(true);
      const workflowId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Ensure each step has a title - if empty, use a fallback
      const stepsWithTitles = steps.map((s, i) => {
        const title = s.title?.trim() || `${values.title || 'Workflow Task'} · Step ${i + 1}`;
        return { ...s, title };
      });

      const payload = {
        workflowId,
        workflowTitle: values.title || 'Workflow',
        finalDeadline: deadlineIso,
        steps: stepsWithTitles.map((s, i) => ({
          title: s.title,
          description: s.description || values.description || '',
          role: s.role ?? undefined,
          assigneeId: s.assigneeId!,
          points: (s as any).points ?? undefined, // Pass explicit points if they exist
          workflowPriority: (s as any).workflowPriority ?? undefined, // Pass explicit priority
          stepSpecificBadgeId: (s as any).stepSpecificBadgeId || undefined,
          individualDeadline: (s as any).individualDeadlineIso ? new Date((s as any).individualDeadlineIso).toISOString() : undefined,
          resources: Array.isArray((s as any).resources) ? [...(s as any).resources] : [], // Deep copy
        })),
        projectId: values.projectId ?? undefined,
        finalWorkflowCompletionBadgeId: (values as any).finalWorkflowCompletionBadgeId || undefined,
        resources: Array.isArray(values.resources) ? [...values.resources] : [], // Deep copy
      };

      // Optimistic UI: Insert workflow tasks immediately using the same unique titles
      const optimisticTasks = stepsWithTitles.map((s, i) => ({
        id: `temp-wf-${Date.now()}-${i}`,
        title: s.title, 
        description: s.description || values.description || '',
        assignerId: user?.uid || 'unknown',
        assigneeId: s.assigneeId,
        deadline: s.individualDeadlineIso ? new Date(s.individualDeadlineIso) : new Date(deadlineIso),
        status: 'pending',
        report: undefined,
        points: values.points || 0,
        projectId: values.projectId || undefined,
        completionBadgeId: undefined,
        stepSpecificBadgeId: (s as any).stepSpecificBadgeId || undefined,
        workflowId, // Include workflowId for proper deduplication
        sequenceIndex: i,
        createdAt: now,
        isOptimistic: true,
      } as any));


      const previousTasks = tasks; // Snapshot for rollback
      setTasks((prev) => [...optimisticTasks, ...prev]);
      setIsDialogOpen(false); // Close dialog immediately for "Zero Latency" feel

      console.log('CRITICAL: Outgoing Workflow Payload:', JSON.stringify(payload, null, 2));

      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        const fe = err.issues?.fieldErrors;
        const ff = err.issues?.formErrors;
        const firstFieldMsg = fe && typeof fe === 'object' ? (Object.values(fe).find(a => Array.isArray(a) && a.length > 0) as any)?.[0] : undefined;
        const firstFormMsg = Array.isArray(ff) && ff.length > 0 ? ff[0] : undefined;
        const msg = firstFieldMsg || firstFormMsg || err.error;
        throw new Error(msg || 'Failed to create workflow');
      }

      toast({ title: 'Workflow Created', description: `${steps.length} step(s) created.` });
      setIsDialogOpen(false);
      router.push('/admin/workflows');
    } catch (error: any) {
      console.error('Error creating workflow:', error);
      toast({ variant: 'destructive', title: 'Error', description: error?.message || 'Failed to create workflow.' });
    }
  };

  // Legacy inline form handlers removed; TaskForm manages its own local UI state

  // OPTIMIZATION: Memoize lookups to prevent O(N*M) complexity during render
  const usersMap = useMemo(() => {
    return (users || []).reduce((acc, user) => {
      acc[user.id] = user;
      return acc;
    }, {} as Record<string, any>);
  }, [users]);

  const projectsMap = useMemo(() => {
    return (projects || []).reduce((acc, proj) => {
      acc[proj.id] = proj;
      return acc;
    }, {} as Record<string, any>);
  }, [projects]);

  const filteredTasks = useMemo(() => {
    return (tasks || []).filter((task) => {
      // Filter by Project
      const tProj = (task as any).projectId;
      const projectMatch = viewProjectId === 'all' || (viewProjectId === 'none' ? !tProj : tProj === viewProjectId);

      // Filter by Status (Client-side fallback)
      const tStatus = (task.status || 'pending').toLowerCase();
      // Only apply status filter if it's not 'all'
      // Note: The API tries to filter, but if an index is missing, it returns all tasks.
      // This client-side check ensures the UI is always correct.
      const statusMatch = statusFilter === 'all' || tStatus === statusFilter;

      return projectMatch && statusMatch;
    });
  }, [tasks, viewProjectId, statusFilter]);


  return (
    <AuthorizationGate permission="canManageTasks">
      <>
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-glow mb-2">Task Management</h1>
        <p className="text-muted-foreground">Manage all tasks and assignments</p>
      </div>
      <div className="mb-8 flex items-center gap-4">
        <Button onClick={handleCreateTask}>Create New Task</Button>
        {/* Settings and advanced tools only visible to authorized personnel */}
        {canManageSettings && (
          <>
            <Button variant="outline" onClick={() => setIsSettingsOpen(true)}>Settings</Button>
            <Button variant="outline" onClick={() => router.push('/admin/defaulters')}>Defaulters</Button>
            <Button
              variant="secondary"
              disabled={isCheckingDeadlines}
              onClick={async () => {
                if (!confirm('Run instant deadline check? This will issue warnings to all users with overdue tasks.')) return;
                setIsCheckingDeadlines(true);
                try {
                  if (!user) throw new Error("Not authenticated");
                  const idToken = await user.getIdToken();
                  // Call the Cron API manually
                  const res = await fetch('/api/cron/check-deadlines', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${idToken}` }
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || 'Check failed');
                  if (data.message) {
                    toast({ title: 'Deadline Check Complete', description: data.message });
                  } else {
                    toast({ title: 'Deadline Check Complete', description: `Processed ${data.processed || 0} tasks. Issued ${data.warningsIssued || 0} warnings and ${data.blacklistsTriggered || 0} bans.` });
                  }                } catch (e: any) {
                  toast({ variant: 'destructive', title: 'Check Failed', description: e.message });
                } finally {
                  setIsCheckingDeadlines(false);
                }
              }}
            >
              {isCheckingDeadlines ? 'Checking...' : 'Check Deadlines'}
            </Button>
          </>
        )}
        <div className="flex-1" />
        {/* New Global Filters */}
        <div className="min-w-[240px]">
          <Label className="mb-1 block">Filter by Status</Label>
          <Select
            value={statusFilter}
            onValueChange={(value: 'all' | TaskStatus) => setStatusFilter(value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="in-progress">In Progress</SelectItem>
              <SelectItem value="submitted-for-review">Submitted for Review</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[280px]">
          <Label className="mb-1 block">Filter by Assignee</Label>
          <UserSelectionCombobox
            selectedUid={assigneeFilterUid || null}
            onSelect={(uid) => setAssigneeFilterUid(uid)}
            placeholder="Select a user"
          />
        </div>
        <div className="min-w-[240px]">
          <Label className="mb-1 block">Filter by Project</Label>
          <Select
            value={viewProjectSelectValue}
            onValueChange={(value) => setViewProjectSelectValue(value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              <SelectItem value="none">No Project</SelectItem>
              {projects && projects.map((p: any) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.title || p.slug || p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="secondary"
          onClick={() => { setStatusFilter('all'); setAssigneeFilterUid(''); setCursor(null); setCursorStack([]); fetchTasks(); }}
        >
          Clear Filters
        </Button>
      </div>

      {/* Project Progress Overview (scoped by global filter) */}
      <Card className="bg-card/80 backdrop-blur-sm border-primary/20 mb-8">
        <CardHeader>
          <CardTitle>Project Progress</CardTitle>
          <CardDescription>Overview of tasks completed per project</CardDescription>
        </CardHeader>
        <CardContent>
          {projectsLoading ? (
            <p className="text-sm text-muted-foreground">Loading projects...</p>
          ) : (
            <div className="space-y-4">
              {viewProjectId === 'all' || viewProjectId === 'none' ? (
                <div className="flex flex-col items-center justify-center p-8 text-center bg-muted/20 rounded-lg border border-dashed">
                  <p className="text-muted-foreground mb-2">Select a project above to view specific progress statistics.</p>
                  <p className="text-xs text-muted-foreground/60">Global statistics require selecting a specific context.</p>
                </div>
              ) : (
                (() => {
                  const proj = projects?.find((p: any) => p.id === viewProjectId);
                  if (!proj) return <p className="text-sm text-muted-foreground">Project not found.</p>;

                  // Calculate stats only for the fetched tasks (Current View context)
                  // Note: True global stats would require a dedicated aggregation endpoint
                  const projTasks = (tasks || []).filter((t: any) => t.projectId === proj.id);
                  const total = projTasks.length;
                  const done = projTasks.filter((t: any) => t.status === 'completed').length;
                  const inProgress = projTasks.filter((t: any) => t.status === 'in-progress').length;
                  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

                  // Show a more detailed single-project card
                  return (
                    <div key={proj.id} className="space-y-4 animate-in fade-in zoom-in-95 duration-300">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                          <h3 className="text-lg font-bold">{proj.title || proj.slug || proj.id}</h3>
                          <p className="text-sm text-muted-foreground">Showing stats for {(tasks || []).length} most recent visible tasks</p>
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-green-500" /> {done} Completed</div>
                          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-blue-500" /> {inProgress} Active</div>
                          <div className="font-mono bg-muted px-2 py-1 rounded">{percent}%</div>
                        </div>
                      </div>
                      <Progress value={percent} className="h-3" />
                    </div>
                  );
                })()
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="outline"
          disabled={cursorStack.length === 0 || loading}
          onClick={() => {
            const prev = [...cursorStack];
            prev.pop();
            const newCursor = prev.length ? prev[prev.length - 1] : null;
            setCursorStack(prev);
            setCursor(newCursor);
            fetchTasks();
          }}
        >
          Previous Page
        </Button>
        <Button
          disabled={!nextCursor || loading}
          onClick={() => {
            if (nextCursor) {
              setCursorStack((s) => [...s, nextCursor]);
              setCursor(nextCursor);
              fetchTasks();
            }
          }}
        >
          Next Page
        </Button>
        <span className="text-sm text-muted-foreground">Page size: {pageSize}</span>
      </div>

      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle>All Tasks</CardTitle>
          <CardDescription>Manage tasks and assignments</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : errorMessage ? (
            <div className="text-center py-8">
              <p className="text-destructive">Error: {errorMessage}</p>
              <Button className="mt-4" onClick={fetchTasks}>Retry</Button>
            </div>
          ) : filteredTasks && filteredTasks.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">
                      <Checkbox
                        checked={filteredTasks.length > 0 && selectedTaskIds.size === filteredTasks.length}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedTaskIds(new Set(filteredTasks.map(t => t.id)));
                          } else {
                            setSelectedTaskIds(new Set());
                          }
                        }}
                        aria-label="Select all"
                      />
                    </TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Assignee</TableHead>
                    <TableHead>Team</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead>Points</TableHead>
                    <TableHead>Efficiency</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTasks.map((task) => {
                    // OPTIMIZATION: O(1) Lookup from Memoized Map
                    const assigneeUser = usersMap[task.assigneeId];
                    const assigneeName = assigneeUser?.displayName || assigneeUser?.email || task.assigneeId;
                    const assigneeRole = userRolesMap[task.assigneeId];
                    const assigneeRoleName = assigneeRole ? USER_ROLES[assigneeRole as keyof typeof USER_ROLES] : 'Unknown';

                    return (
                      <TableRow key={task.id} data-state={selectedTaskIds.has(task.id) && "selected"}>
                        <TableCell>
                          <Checkbox
                            checked={selectedTaskIds.has(task.id)}
                            onCheckedChange={(checked) => {
                              const newSet = new Set(selectedTaskIds);
                              if (checked) newSet.add(task.id);
                              else newSet.delete(task.id);
                              setSelectedTaskIds(newSet);
                            }}
                            aria-label="Select row"
                          />
                        </TableCell>
                        <TableCell className="font-medium max-w-xs truncate">
                          <div className="flex items-center gap-2">
                            <span className="truncate">{task.title}</span>
                            {task.status === 'submitted-for-review' && (
                              <span className="px-2 py-0.5 text-xs rounded bg-violet-100 text-violet-800 border border-violet-200">
                                Submitted for Review
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>
                            <div>{assigneeName}</div>
                            <div className="text-xs text-muted-foreground">{assigneeRoleName}</div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {task.workflowId ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex -space-x-2 cursor-help">
                                    {(task.workflowParticipantIds || []).slice(0, 3).map((uid, i) => (
                                      <Avatar key={`${task.id}-p-${i}`} className="h-6 w-6 border-2 border-background">
                                        <AvatarImage src={usersMap[uid]?.photoURL} />
                                        <AvatarFallback className="text-[10px]">
                                          {(usersMap[uid]?.displayName || usersMap[uid]?.email || uid).charAt(0).toUpperCase()}
                                        </AvatarFallback>
                                      </Avatar>
                                    ))}
                                    {(task.workflowParticipantIds || []).length > 3 && (
                                      <div className="h-6 w-6 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[10px]">
                                        +{(task.workflowParticipantIds || []).length - 3}
                                      </div>
                                    )}
                                    {(task.workflowParticipantIds || []).length === 0 && (
                                      <Badge variant="outline" className="text-[10px] h-5">No participants</Badge>
                                    )}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <div className="space-y-1">
                                    <p className="font-semibold text-xs text-primary mb-1">Workflow Team:</p>
                                    {(task.workflowParticipantIds || []).map(uid => (
                                      <p key={uid} className="text-[10px]">
                                        {usersMap[uid]?.displayName || usersMap[uid]?.email || uid}
                                      </p>
                                    ))}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            // OPTIMIZATION: O(1) Lookup
                            const proj = projectsMap[(task as any).projectId];
                            return proj ? (proj.title || proj.slug || proj.id) : ((task as any).projectId ? (task as any).projectId : '—');
                          })()}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            // Phase 6 Fix: Use robust date normalizer
                            const d = toDate(task.individualDeadline) || toDate(task.deadline);
                            const now = new Date();
                            const isOverdue = d && d < now;
                            const klass = task.status === 'completed'
                              ? 'bg-green-100 text-green-800'
                              : task.status === 'in-progress'
                                ? 'bg-blue-100 text-blue-800'
                                : (isOverdue && task.status !== 'submitted-for-review')
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-yellow-100 text-yellow-800';

                            // Display status label
                            let label = task.status;
                            if (isOverdue && task.status !== 'completed' && task.status !== 'submitted-for-review') label = 'overdue';

                            return (
                              <span className={`px-2 py-1 rounded-full text-xs ${klass}`}>
                                {label}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const d = toDate(task.individualDeadline) || toDate(task.deadline);
                            return d ? format(d, 'dd/MM/yyyy hh:mm a') : '—';
                          })()}
                        </TableCell>
                        <TableCell>{task.points}</TableCell>
                        <TableCell>
                          {(() => {
                            const assigned = (assigneeUser as any)?.tasksAssignedCount ?? 0;
                            const completed = (assigneeUser as any)?.tasksCompletedCount ?? 0;
                            const onTime = (assigneeUser as any)?.tasksCompletedOnTimeCount ?? 0;
                            const efficiency = assigned > 0 ? `${completed}/${assigned}` : '—';
                            // Cap at 100% — data inconsistency (onTime > completed) should not display impossible values
                            const onTimePct = completed > 0 ? Math.min(100, Math.round((onTime / completed) * 100)) : 0;
                            return assigned > 0 ? `${efficiency} • ${onTimePct}% on-time` : '—';
                          })()}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const c = toDate(task.createdAt);
                            return c ? format(c, 'dd/MM/yyyy hh:mm a') : '—';
                          })()}
                        </TableCell>
                        <TableCell>
                          <div className="flex space-x-2">
                            <Button variant="outline" size="sm" onClick={() => handleEditTask(task.id)}>
                              Edit
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => handleDeleteTask(task.id)}>
                              Delete
                            </Button>
                            {task.status === 'submitted-for-review' && (
                              <>
                                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => approveTask(task.id)}>
                                  Approve
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => requestRevisions(task.id)}>
                                  Request Revisions
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No tasks found.</p>
              <Button className="mt-4" onClick={handleCreateTask}>Create the first task</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Task Form Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="w-[95vw] sm:max-w-2xl md:max-w-3xl lg:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTask ? 'Edit Task' : 'Create New Task'}</DialogTitle>
            <DialogDescription>
              {editingTask ? 'Edit the task details below' : 'Fill in the details for the new task'}
            </DialogDescription>
          </DialogHeader>
          {isEditingLoading ? (
            <div className="flex items-center justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>
          ) : (
            <TaskForm
              key={editingTask ? editingTask.id : 'new-task-form'}
              initialValues={editingTask ? {
                title: editingTask.title,
                description: editingTask.description,
                assigneeIds: formData.assigneeIds,
                completionBadgeId: formData.completionBadgeId,
                points: editingTask.points,
                chapterId: '',
                projectId: editingTask.projectId || undefined,
                status: normalizedStatus,
                deadline: editingTask.deadline ? new Date(editingTask.deadline as any).toISOString().slice(0, 16) : '',
                report: editingTask.report || '',
              } : formData}
              initialWorkflowSteps={editingTask ? editingWorkflowSteps : undefined}
              onCancel={() => setIsDialogOpen(false)}
              submitLabel={editingTask ? 'Update Task' : 'Create Task'}
              onSubmit={(values) => handleSaveTask(values)}
              onSubmitWithPlan={(vals, steps) => editingTask ? handleUpdateWorkflowSteps(steps) : handleCreateWorkflow(vals, steps)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Settings Dialog for AI model preference */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="w-[95vw] sm:max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>AI Settings</DialogTitle>
            <DialogDescription>
              Your personal Gemini API key is used first for AI-powered task generation; the server key is the fallback. Your key is stored only in this browser.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-api-key">Your Gemini API Key</Label>
              <Input
                id="ai-api-key"
                type="password"
                placeholder="Paste your Gemini API key (optional)"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className="font-mono text-sm"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Optional. When empty, AI requests use the shared server key.
              </p>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <h4 className="font-medium text-blue-800 mb-2">How AI keys work</h4>
              <p className="text-sm text-blue-700">
                Your key above is sent with each AI request and never leaves your browser except to Google. If you do not set one, requests fall back to the server key (GEMINI_API_KEY).
              </p>
            </div>

            <div className="space-y-2">
              <Label>AI Model Preference</Label>
              <Select value={modelSelectValue} onValueChange={(v) => setModelSelectValue(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a Gemini model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gemini-2.5-pro">gemini-2.5-pro</SelectItem>
                  <SelectItem value="gemini-2.5-flash">gemini-2.5-flash</SelectItem>
                  <SelectItem value="custom">Custom Model...</SelectItem>
                </SelectContent>
              </Select>
              
              {modelSelectValue === 'custom' && (
                <div className="mt-2 pt-2 border-t border-dashed animate-in slide-in-from-top-2 duration-200">
                  <Label htmlFor="custom-model" className="text-xs text-amber-500 font-bold uppercase tracking-widest">Custom Model Name</Label>
                  <Input
                    id="custom-model"
                    placeholder="e.g. gemini-1.5-pro-002"
                    value={customModelInput}
                    onChange={(e) => setCustomModelInput(e.target.value)}
                    className="mt-1 font-mono text-sm"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1 italic">
                    Use specific model IDs from Google AI documentation.
                  </p>
                </div>
              )}
              
              <p className="text-xs text-muted-foreground mt-1">
                Preferred model for AI-powered task generation.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setIsSettingsOpen(false)}>Close</Button>
              <Button
                onClick={() => {
                  try {
                    if (typeof window !== 'undefined') {
                      const finalModel = modelSelectValue === 'custom' ? customModelInput.trim() : modelSelectValue.trim();
                      if (!finalModel) {
                        toast({ variant: 'destructive', title: 'Invalid Model', description: 'Please enter a custom model name.' });
                        return;
                      }
                      window.localStorage.setItem('genai.model', finalModel);
                      const trimmedKey = apiKeyInput.trim();
                      if (trimmedKey) {
                        window.localStorage.setItem('gemini.apiKey', trimmedKey);
                      } else {
                        window.localStorage.removeItem('gemini.apiKey');
                      }
                    }
                    toast({ title: 'Settings saved', description: 'Your AI settings have been saved locally.' });
                    setIsSettingsOpen(false);
                  } catch (err) {
                    console.error('Failed to save settings', err);
                    toast({ variant: 'destructive', title: 'Error', description: 'Failed to save settings.' });
                  }
                }}
              >Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Floating Action Bar */}
      {selectedTaskIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-popover border shadow-lg rounded-full px-6 py-3 flex items-center gap-4 animate-in slide-in-from-bottom-5 fade-in z-50">
          <span className="text-sm font-medium">{selectedTaskIds.size} selected</span>
          <div className="h-4 w-px bg-border" />
          <Button
            variant="destructive"
            size="sm"
            disabled={isBulkDeleting}
            onClick={async () => {
              if (!confirm(`Are you sure you want to delete ${selectedTaskIds.size} tasks?`)) return;
              setIsBulkDeleting(true);
              try {
                if (!user) throw new Error("Not authenticated");
                const idToken = await user.getIdToken();
                const res = await fetch('/api/tasks/batch', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                  body: JSON.stringify({ taskIds: Array.from(selectedTaskIds) })
                });
                if (!res.ok) throw new Error('Failed to delete tasks');
                const data = await res.json();
                toast({ title: 'Tasks Deleted', description: `Successfully deleted ${data.deletedCount} tasks.` });
                setSelectedTaskIds(new Set());
                fetchTasks(); // Refresh list
              } catch (e: any) {
                toast({ variant: 'destructive', title: 'Error', description: e.message });
              } finally {
                setIsBulkDeleting(false);
              }
            }}
          >
            {isBulkDeleting ? 'Deleting...' : 'Delete Selected'}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => setSelectedTaskIds(new Set())}>
            &times;
          </Button>
        </div>
      )}
      </>
    </AuthorizationGate>
  );
}

export default function AdminTasksPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>}>
      <AdminTasksPageInner />
    </Suspense>
  );
}
