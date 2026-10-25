
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
import { useFirestore } from '@/firebase';
import { getCustomRoleDefinitions } from '@/lib/role-definitions';
import { getAllProjectsCached } from '@/lib/projects-cached';
import { isCustomRoleSlug } from '@/lib/custom-roles';
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
import { isStepWorkDone } from '@/lib/workflow-progress';
import { taskToWorkflowPDFData, type TaskPDFAssignee } from '@/lib/task-pdf-adapter';
import { format } from 'date-fns';
import { Task } from '@/lib/task-types';
import type { TaskStatus } from '@/lib/task-types';
import SubmissionApprovalDrawer from '@/components/admin/tasks/submission-approval-drawer';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
// Uses persistent layout at app/admin/layout.tsx
import { collection, query, where, orderBy, getDocs, doc, getDoc } from 'firebase/firestore';
import { toDate } from '@/lib/date-utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, ListChecks, Rocket } from 'lucide-react';

const MissionsTab = dynamic(() => import('@/components/admin/workflows/missions-tab').then(mod => mod.MissionsTab), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>
});

const TASK_TABS = ['tasks', 'missions'] as const;
type TasksTab = (typeof TASK_TABS)[number];

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

// Mirrors urlToBase64 in src/components/admin/workflows/missions-tab.tsx
// (it is local to that component, so it is replicated here rather than imported).
async function urlToBase64(url: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return undefined;

    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Error converting URL to Base64:', error);
    return undefined;
  }
}

// Type imports for TaskForm
import type { TaskFormValues, WorkflowStep } from '@/components/admin/tasks/task-form';
import { toDatetimeLocal } from '@/components/admin/tasks/task-form';

import { useAuthorization } from '@/hooks/use-authorization';

function AdminTasksPageInner() {
  const { user, isLoading: userLoading } = useUserContext();
  const { isAuthorized: canManageTasks, isLoading: authLoading } = useAuthorization('canManageTasks');
  const { isAuthorized: canManageSettings } = useAuthorization('canManageSiteSettings');
  
  const router = useRouter();
  const searchParams = useSearchParams();
  const firestore = useFirestore();

  // URL-driven tabs, following the /admin/store ?tab= pattern: the retired
  // /admin/workflows page redirects to ?tab=missions; keep the tab in sync
  // if the param changes while mounted, and write the tab back to the URL
  // (preserving other params such as projectId/taskId) when it changes.
  const tabParam = searchParams.get('tab');
  const paramTab: TasksTab = (TASK_TABS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as TasksTab)
    : 'tasks';
  const [activeTab, setActiveTab] = useState<TasksTab>(paramTab);
  useEffect(() => {
    setActiveTab(paramTab);
  }, [paramTab]);
  const handleTabChange = (value: string) => {
    const next = value as TasksTab;
    setActiveTab(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'tasks') params.delete('tab');
    else params.set('tab', next);
    const qs = params.toString();
    router.replace(qs ? `/admin/tasks?${qs}` : '/admin/tasks', { scroll: false });
  };
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
  const [exportingPdfTaskId, setExportingPdfTaskId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  // Task currently shown in the read-only submission viewer (null = closed)
  const [viewSubmissionTask, setViewSubmissionTask] = useState<Task | null>(null);
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

  // Effective deadline for the edit dialog: the per-step individual deadline
  // wins when present, else the task deadline. Matches the table display.
  const normalizedEditingDeadline = useMemo<string>(() => {
    const eff: any = (editingTask as any)?.individualDeadline || (editingTask as any)?.deadline;
    if (!eff) return '';
    const d = eff instanceof Date ? eff : new Date(eff);
    return isNaN(d.getTime()) ? '' : toDatetimeLocal(d.toISOString());
  }, [editingTask]);

  // READ-BURN P1: this page used to one-shot the FULL users, roles,
  // badges and projects collections on every load (~510 reads before
  // the task list itself). The support data now comes from bounded
  // sources, with the same shapes for every consumer below:
  // - users + roles: GET /api/users/picker — the sanitised picker API
  //   both user comboboxes already use. It is bounded by its limit cap
  //   (server-side) and returns the roles-first role per user, so the
  //   separate full roles read is gone: userRoles is derived from the
  //   picker rows. The picker never returns email/whatsapp; the one
  //   surface that needs contact fields (the workflow PDF export)
  //   fetches the single user doc on demand, per assignee.
  // - badges: the page fetched the collection but never used it (the
  //   badge selector lives in TaskForm, which loads its own). Removed.
  // - projects: module-cached fetch (getAllProjectsCached, the
  //   role-definitions.ts pattern), so repeat mounts in a session pay
  //   the small projects read once per TTL window, not per load.
  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const fetchPickerUsers = async () => {
      setUsersLoading(true);
      try {
        const idToken = await user.getIdToken();
        const res = await fetch('/api/users/picker?limit=1000', {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
        const json = await res.json();
        if (cancelled) return;
        const rows = (json.users || []).map((row: any) => ({
          id: String(row.uid),
          displayName: (row.displayName || '').toString(),
          photoURL: row.photoURL || null,
          chapterId: row.chapterId || null,
          role: row.role ? String(row.role) : undefined,
        }));
        setUsers(rows);
      } catch (err) {
        console.error('Failed to load picker users:', err);
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    };
    fetchPickerUsers();
    // Same refresh signal the user comboboxes honour.
    const handleUsersUpdated = () => { if (!cancelled) fetchPickerUsers(); };
    window.addEventListener('users-updated', handleUsersUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('users-updated', handleUsersUpdated);
    };
  }, [user]);

  // Roles for role visibility, derived from the picker's roles-first
  // role per user (no separate roles collection read).
  const userRoles = useMemo(
    () => users.filter((u) => u.role).map((u) => ({ id: u.id as string, role: u.role as string })),
    [users]
  );
  const rolesLoading = usersLoading;

  // Create a map of user roles for easy lookup
  const userRolesMap = userRoles.reduce((acc, roleDoc) => {
    acc[roleDoc.id] = roleDoc.role;
    return acc;
  }, {} as Record<string, string>);

  // Fetch projects for project selection and progress (module-cached)
  const [projects, setProjects] = useState<any[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getAllProjectsCached(firestore)
      .then((list) => { if (!cancelled) setProjects(list as any[]); })
      .catch((err) => console.error('Failed to load projects:', err))
      .finally(() => { if (!cancelled) setProjectsLoading(false); });
    return () => { cancelled = true; };
  }, [firestore]);


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

  // Runs the deadline checker on demand and reports what it actually did.
  // The API returns one of:
  //  - { success: true, processed, warningsIssued, blacklistsTriggered } when it acted
  //  - { message } when it ran but took no action (nothing overdue, already processed, or auto-issue disabled)
  //  - { error } on failure
  const handleCheckDeadlines = async () => {
    if (!confirm('Run instant deadline check? This will issue warnings to all users with overdue tasks.')) return;
    setIsCheckingDeadlines(true);
    try {
      if (!user) throw new Error('Not authenticated. Sign in again and retry.');
      const idToken = await user.getIdToken();
      const res = await fetch('/api/cron/check-deadlines', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${idToken}` },
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`The deadline check did not return a readable response (HTTP ${res.status}). Try again.`);
      }
      if (!res.ok) {
        const apiError = typeof data?.error === 'string' && data.error ? data.error : null;
        throw new Error(apiError || `The deadline check failed with HTTP ${res.status}. Try again.`);
      }

      // Success path: the API acted on overdue tasks. Report the real numbers.
      if (data && data.success === true) {
        const checked = Number(data.processed) || 0;
        const warned = Number(data.warningsIssued) || 0;
        const blacklisted = Number(data.blacklistsTriggered) || 0;
        toast({
          title: 'Deadline Check Complete',
          description: (
            <div className="mt-1 space-y-1 text-sm">
              <p>Checked {checked} active task{checked === 1 ? '' : 's'}.</p>
              <p>Warnings issued: {warned}. Blacklisted: {blacklisted}.</p>
              <p className="text-muted-foreground">Tasks that were not overdue, were already processed, or had no assignees were skipped automatically.</p>
            </div>
          ),
        });
        return;
      }

      // The API ran but took no action. Say so plainly instead of reporting success.
      const message = typeof data?.message === 'string' ? data.message : '';
      if (/disabled/i.test(message)) {
        toast({
          title: 'Deadline Check Skipped',
          description: 'Auto-issue on deadline miss is disabled in the warning settings, so the check ran but took no action. Nothing was warned or blacklisted.',
        });
      } else if (/already been processed/i.test(message)) {
        const skippedMatch = /All (\d+) currently overdue/i.exec(message);
        const skippedCount = skippedMatch ? skippedMatch[1] : 'the';
        toast({
          title: 'Deadline Check Complete',
          description: `Checked the overdue list: ${skippedCount} task${skippedCount === '1' ? ' was' : 's were'} already processed and penalized before, so they were skipped. No new warnings were issued.`,
        });
      } else {
        // 'No overdue tasks found.' or any other no-action message
        toast({
          title: 'Deadline Check Complete',
          description: message
            ? `${message} Nothing needed a warning.`
            : 'The check ran and found nothing to warn. No warnings were issued.',
        });
      }
    } catch (e: any) {
      const detail = e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.';
      toast({ variant: 'destructive', title: 'Deadline Check Failed', description: detail });
    } finally {
      setIsCheckingDeadlines(false);
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
        // Local-wall-clock conversion (toDatetimeLocal) then renders correctly
        // in the datetime-local input.
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

        // Normalize the per-step individual deadline too: the dialog edits the
        // effective deadline (individualDeadline when present, else deadline).
        const indDeadlineTs: any = (task as any).individualDeadline;
        const indDeadlineDate: Date | null = indDeadlineTs && typeof indDeadlineTs.toDate === 'function'
          ? indDeadlineTs.toDate()
          : (indDeadlineTs ? new Date(indDeadlineTs) : null);

        const normalizedTask: any = {
          ...task,
          deadline: isNaN(deadlineDate.getTime()) ? new Date() : deadlineDate,
          individualDeadline: indDeadlineDate && !isNaN(indDeadlineDate.getTime()) ? indDeadlineDate : null,
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
          assigneeIds: Array.isArray((normalizedTask as any).assigneeIds) && (normalizedTask as any).assigneeIds.length
            ? (normalizedTask as any).assigneeIds.map(String)
            : [normalizedTask.assigneeId].filter(Boolean), // Preserve existing co-assignees when editing
          // Prefill the effective deadline (individualDeadline when the task has
          // one, else deadline) so the dialog matches the table.
          deadline: toDatetimeLocal(((normalizedTask.individualDeadline as Date) || (normalizedTask.deadline as Date)).toISOString()),
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
              const indLocal = indDate && !isNaN(indDate.getTime()) ? toDatetimeLocal(indDate.toISOString()) : '';

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
                assigneeIds: Array.isArray(data?.assigneeIds) && data.assigneeIds.length
                  ? data.assigneeIds.map(String)
                  : (data?.assigneeId ? [String(data.assigneeId)] : []),
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

  const confirmBulkDelete = async () => {
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
      setBulkDeleteConfirmOpen(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
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

  const handleUpdateWorkflowSteps = async (vals: TaskFormValues, steps: WorkflowStep[], removedStepIds: string[] = []) => {
    try {
      if (!user) throw new Error('User not authenticated');
      const idToken = await user.getIdToken(true);

      // Save the edited task's own fields first (title, points, guidance, etc.)
      if (editingTask?.id) {
        const taskUpdates: any = {
          title: vals.title,
          description: vals.description,
          // Persist the full assignee array so co-assignees are never dropped
          // when editing a workflow step (assigneeId stays primary for compat).
          assigneeId: vals.assigneeIds[0],
          assigneeIds: [...vals.assigneeIds],
          points: vals.points,
          projectId: vals.projectId || undefined,
          resources: Array.isArray(vals.resources) ? [...vals.resources] : [],
        };
        if (typeof (vals as any).penaltyPoints === 'number') taskUpdates.penaltyPoints = (vals as any).penaltyPoints;
        if (typeof (vals as any).workflowBonusPoints === 'number') taskUpdates.workflowBonusPoints = (vals as any).workflowBonusPoints;
        if ((vals as any).guidance) taskUpdates.guidance = (vals as any).guidance;
        // chapterId arrives as string or null (null = explicitly cleared in
        // the dialog); forward it so clears persist instead of going stale.
        taskUpdates.chapterId = (vals as any).chapterId || null;
        // reviewerId arrives as string or null; forward it too (it was absent
        // here before, so a cleared reviewer on a workflow edit never persisted).
        taskUpdates.reviewerId = (vals as any).reviewerId || null;
        if ((vals as any).finalWorkflowCompletionBadgeId) taskUpdates.finalWorkflowCompletionBadgeId = (vals as any).finalWorkflowCompletionBadgeId;
        // Persist workflow step edits (title, description, assignee, deadline,
        // resources) in the same PATCH call. The server writes them to the tasks
        // collection, mirroring the create flow's per-step task docs, so step
        // assignees and newly added steps are actually saved.
        taskUpdates.steps = steps.map((s, i) => {
          const stepPayload: any = {
            title: s.title?.trim() || `${vals.title || 'Workflow Task'} · Step ${i + 1}`,
            description: s.description || '',
            role: s.role ?? undefined,
            assigneeId: s.assigneeId,
            // Persist per-step co-assignees so they survive workflow edits.
            assigneeIds: Array.isArray((s as any).assigneeIds) ? [...(s as any).assigneeIds] : undefined,
            // Persist per-step points so edited steps keep their own points.
            points: (s as any).points ?? undefined,
            individualDeadline: (s as any).individualDeadlineIso
              ? new Date((s as any).individualDeadlineIso).toISOString()
              : undefined,
            stepSpecificBadgeId: (s as any).stepSpecificBadgeId || undefined,
            estimatedDuration: (s as any).estimatedDuration ?? undefined,
            isLimitingStep: (s as any).isLimitingStep ?? undefined,
            resources: Array.isArray((s as any).resources) ? [...(s as any).resources] : undefined,
          };
          if (typeof s.id === 'string' && s.id.trim().length > 0) stepPayload.id = s.id;
          return stepPayload;
        });
        // Forward ids of steps the admin removed in the dialog. The server
        // deletes exactly those step docs; without this, removed steps stay
        // in Firestore and reappear on the next edit.
        if (Array.isArray(removedStepIds) && removedStepIds.length > 0) {
          taskUpdates.removedStepIds = [...removedStepIds];
        }
        // Write the dialog deadline back to the effective field it was read
        // from: individualDeadline when the task has one, else deadline.
        if (vals.deadline) {
          const deadlineField = editingTask?.individualDeadline ? 'individualDeadline' : 'deadline';
          taskUpdates[deadlineField] = new Date(vals.deadline).toISOString();
        }
        if (vals.status) taskUpdates.status = vals.status;
        // Forward the admin resolution note so the server can record it
        // with the approval stamps.
        const updateResolutionNote = typeof (vals as any).resolutionNote === 'string' ? (vals as any).resolutionNote.trim() : '';
        if (updateResolutionNote) taskUpdates.resolutionNote = updateResolutionNote;
        const taskRes = await fetch('/api/tasks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify({ taskId: editingTask.id, updates: taskUpdates })
        });
        if (!taskRes.ok) {
          const err = await taskRes.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(err.error || 'Failed to update task fields');
        }
      }

      toast({ title: 'Task Updated', description: 'Task fields and workflow steps updated successfully.' });
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
      chapterId,
      penaltyPoints,
      workflowBonusPoints,
      guidance,
      resources,
      reviewerId,
      resolutionNote,
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
        // Update existing task: persist the FULL assignee array so co-assignees
        // are never silently dropped (assigneeId stays as the primary for compat).
        // The dialog edits the effective deadline (individualDeadline when the
        // task has one, else deadline), so write it back to the same field the
        // table reads.
        const deadlineField = editingTask.individualDeadline ? 'individualDeadline' : 'deadline';
        const updates: any = {
          title,
          description,
          assigneeId: assigneeIds[0],
          assigneeIds: [...assigneeIds],
          // Send deadline as ISO string; server converts to timestamp
          [deadlineField]: new Date(deadline).toISOString(),
          status,
          report,
          points,
          projectId: projectId || undefined,
          completionBadgeId: completionBadgeId || undefined,
          chapterId: chapterId || null,
          penaltyPoints: typeof penaltyPoints === 'number' ? penaltyPoints : undefined,
          workflowBonusPoints: typeof workflowBonusPoints === 'number' ? workflowBonusPoints : undefined,
          guidance: guidance || undefined,
          resources: Array.isArray(resources) ? [...resources] : [],
          reviewerId: reviewerId || null,
          resolutionNote: resolutionNote?.trim() ? resolutionNote.trim() : undefined,
        };

        // Optimistically update the task in local state
        setTasks((prev) => prev.map((t) => t.id === editingTask.id ? {
          ...t,
          title: updates.title,
          description: updates.description,
          assigneeId: updates.assigneeId,
          assigneeIds: updates.assigneeIds,
          [deadlineField]: new Date(deadline),
          status: updates.status,
          report: updates.report,
          points: updates.points,
          projectId: updates.projectId || undefined,
          completionBadgeId: updates.completionBadgeId || undefined,
          chapterId: updates.chapterId || undefined,
          penaltyPoints: updates.penaltyPoints,
          workflowBonusPoints: updates.workflowBonusPoints,
          guidance: updates.guidance,
          resources: updates.resources,
          reviewerId: updates.reviewerId,
          resolutionNote: updates.resolutionNote,
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
        // Single shared task doc for the whole team (Bug 3): one POST with
        // the full assigneeIds array. The server creates one doc, fans out
        // per-assignee notifications and counters, and mirrors the primary
        // assignee onto the legacy singular fields.
        // Optimistically add the task to local state before the API call
        const now = new Date();
        const optimisticTask = {
          id: `temp-${Date.now()}`,
          title,
          description,
          assignerId: user?.uid || 'unknown',
          assigneeId: assigneeIds[0],
          assigneeIds: [...assigneeIds],
          deadline: new Date(deadline),
          status,
          report,
          points,
          projectId: projectId || undefined,
          completionBadgeId: completionBadgeId || undefined,
          chapterId: chapterId || undefined,
          penaltyPoints: typeof penaltyPoints === 'number' ? penaltyPoints : undefined,
          workflowBonusPoints: typeof workflowBonusPoints === 'number' ? workflowBonusPoints : undefined,
          guidance: guidance || undefined,
          resources: Array.isArray(resources) ? [...resources] : [],
          reviewerId: reviewerId || undefined,
          createdAt: now,
        } as any;
        setTasks((prev) => [optimisticTask, ...prev]);

        if (!user) throw new Error("User not authenticated");
        const idToken = await user.getIdToken(true);
        const payload: any = {
          title,
          description,
          // assignerId is inferred server-side from token, but include for clarity
          assignerId: user.uid,
          assigneeIds: [...assigneeIds],
          // Send ISO string for server normalization
          deadline: new Date(deadline).toISOString(),
          status,
          report,
          points: typeof points === 'number' ? points : 0,
          projectId: projectId || undefined,
          completionBadgeId: completionBadgeId || undefined,
          chapterId: chapterId || undefined,
          penaltyPoints: typeof penaltyPoints === 'number' ? penaltyPoints : undefined,
          workflowBonusPoints: typeof workflowBonusPoints === 'number' ? workflowBonusPoints : undefined,
          guidance: guidance || undefined,
          resources: Array.isArray(resources) ? [...resources] : [],
          reviewerId: reviewerId || undefined,
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
          // Revert the optimistic addition
          setTasks(previousTasks);
          setIsDialogOpen(true);
          const msg = err.details
            ? (typeof err.details === 'object' && err.details.fieldErrors
              ? JSON.stringify(err.details.fieldErrors)
              : JSON.stringify(err.details))
            : (err.error || 'Failed to create task');
          throw new Error(msg);
        }

        const createdData = await res.json();
        if (createdData?.deduped) {
          console.log('Task create deduplicated, reused task', createdData?.created?.[0]?.id);
        }
        toast({
          title: "Task Created",
          description: assigneeIds.length > 1
            ? `Task assigned to ${assigneeIds.length} team members.`
            : "Task assigned successfully.",
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
          assigneeIds: (s as any).assigneeIds ?? undefined, // Pass co-assignees so the API persists the full assignee list
          points: (s as any).points ?? undefined, // Pass explicit points if they exist
          workflowPriority: (s as any).workflowPriority ?? undefined, // Pass explicit priority
          stepSpecificBadgeId: (s as any).stepSpecificBadgeId || undefined,
          estimatedDuration: (s as any).estimatedDuration ?? undefined,
          isLimitingStep: (s as any).isLimitingStep ?? undefined,
          individualDeadline: (s as any).individualDeadlineIso ? new Date((s as any).individualDeadlineIso).toISOString() : undefined,
          resources: Array.isArray((s as any).resources) ? [...(s as any).resources] : [], // Deep copy
          reason: (s as any).reason || undefined, // Persist AI rationale so assignees can see why they were picked
          aiSelected: (s as any).aiSelected ?? undefined, // Persist AI-selected flag for UI highlighting
        })),
        projectId: values.projectId ?? undefined,
        chapterId: values.chapterId ?? undefined,
        finalWorkflowCompletionBadgeId: (values as any).finalWorkflowCompletionBadgeId || undefined,
        basePoints: typeof values.points === 'number' ? values.points : undefined,
        penaltyPoints: typeof (values as any).penaltyPoints === 'number' ? (values as any).penaltyPoints : undefined,
        workflowBonusPoints: typeof (values as any).workflowBonusPoints === 'number' ? (values as any).workflowBonusPoints : undefined,
        guidance: (values as any).guidance || undefined,
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
        chapterId: values.chapterId || undefined,
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
      router.push('/admin/tasks?tab=missions');
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
      // Note: The API tries to filter server-side; if an index is missing it
      // degrades to a bounded, possibly less-filtered page (never the whole
      // collection). This client-side check ensures the UI is always correct.
      const statusMatch = statusFilter === 'all' || tStatus === statusFilter;

      return projectMatch && statusMatch;
    });
  }, [tasks, viewProjectId, statusFilter]);

  // Export a standalone task as a one-step workflow PDF via the task adapter.
  // Mirrors handleExportPDF in src/components/admin/workflows/missions-tab.tsx.
  const handleExportTaskPDF = async (task: Task) => {
    setExportingPdfTaskId(task.id);
    try {
      const primaryId = (task as any).assigneeId ? String((task as any).assigneeId) : undefined;
      const rawIds: string[] = Array.isArray((task as any).assigneeIds) && (task as any).assigneeIds.length
        ? (task as any).assigneeIds.map(String)
        : (primaryId ? [primaryId] : []);
      // Primary first, then co-assignees, deduped.
      const orderedIds = Array.from(new Set([
        ...(primaryId ? [primaryId] : []),
        ...rawIds.filter((id: string) => id && id !== primaryId),
      ]));

      // Resolve chapter names from chapterId: user docs store chapterId
      // (a slug), not chapterName, so mirror the server-side join in
      // GET /api/workflows. The chapters collection is tiny; fetch it once.
      const chapterNames: Record<string, string> = {};
      try {
        const chapSnap = await getDocs(collection(firestore, 'chapters'));
        chapSnap.forEach((d) => {
          const nm = (d.data() as any)?.name;
          if (nm) chapterNames[d.id] = String(nm);
        });
      } catch {
        // leave empty; fallbacks below still apply
      }
      const resolveChapter = (u: any): string | undefined => {
        if (u?.chapterName) return String(u.chapterName);
        const cid = u?.chapterId ? String(u.chapterId) : undefined;
        return cid ? chapterNames[cid] || undefined : undefined;
      };

      // The page-level usersMap now comes from the sanitised picker
      // API, which never returns email / whatsapp. The PDF personnel
      // blocks carry those contact fields, so enrich each assignee of
      // THIS task with its single user doc on demand (one read per
      // assignee, export-time only) instead of holding the full users
      // collection in page state. Picker-resolved fields (roles-first
      // role, displayName, photo, chapter) win where present; the doc
      // supplies the contact fields.
      const enrichUser = async (uid: string): Promise<any> => {
        const base: any = usersMap[uid] || { id: uid };
        if (base.email) return base;
        try {
          const snap = await getDoc(doc(firestore, 'users', uid));
          if (snap.exists()) {
            const full = snap.data() as any;
            return {
              ...full,
              id: uid,
              displayName: base.displayName || full.displayName || full.name,
              photoURL: base.photoURL ?? full.photoURL ?? null,
              role: base.role || full.role,
              chapterId: base.chapterId || full.chapterId || full.chapter,
            };
          }
        } catch {
          // fall through to the picker row
        }
        return base;
      };
      const enrichedUsers: Record<string, any> = {};
      await Promise.all(orderedIds.map(async (uid) => {
        enrichedUsers[uid] = await enrichUser(uid);
      }));

      const assignees: TaskPDFAssignee[] = await Promise.all(
        orderedIds.map(async (uid) => {
          const u: any = enrichedUsers[uid];
          // Pass the RAW role key through: the exporter canonicalizes it
          // with canonicalRoleTitle(). The old USER_ROLES lookup only knew
          // two keys (superadmin, president_national), so every real member
          // role key mapped to undefined and no role line was drawn.
          // users/{uid}.role is the primary store; roles/{uid}.role is the
          // fallback (same precedence as the workflows GET API path).
          const rawRole = (u?.role as string | undefined) || userRolesMap[uid] || undefined;
          // Every assignee's photo is converted so co-assignees render a
          // full personnel block (avatar, phone, email, their own QR) in
          // the personnel section of the task PDF.
          const photoBase64 = u?.photoURL ? await urlToBase64(String(u.photoURL)) : undefined;
          return {
            id: uid,
            name: u?.displayName || u?.email || uid,
            email: u?.email || undefined,
            whatsapp: u?.whatsapp || u?.whatsappNumber || undefined,
            chapterName: resolveChapter(u),
            role: rawRole || null,
            photoBase64,
          };
        })
      );

      const primaryUser: any = primaryId ? enrichedUsers[primaryId] : undefined;
      const taskChapterId = (task as any).chapterId ? String((task as any).chapterId) : undefined;
      const chapterName: string | undefined =
        resolveChapter(primaryUser) ||
        (taskChapterId ? chapterNames[taskChapterId] : undefined) ||
        taskChapterId;

      const pdfData = taskToWorkflowPDFData({
        task: task as unknown as Record<string, any>,
        assignees,
        chapterName,
      });
      // Custom-role titles for the PDF personnel rows (Custom Roles
      // consumers Surface 3; contracts 4.2 client adapter): resolve the
      // assignees' custom slugs to their definition names; catalog roles
      // keep the exporter's canonical titles.
      let roleTitles: Record<string, string> | undefined;
      const customSlugs = new Set(
        assignees
          .map((a) => a.role)
          .filter((r): r is string => !!r && isCustomRoleSlug(r)),
      );
      if (customSlugs.size > 0) {
        const defs = await getCustomRoleDefinitions(firestore);
        const map: Record<string, string> = {};
        for (const def of defs) {
          if (customSlugs.has(def.slug)) map[def.slug] = def.name;
        }
        if (Object.keys(map).length > 0) roleTitles = map;
      }
      const { exportWorkflowAsPDF } = await import('@/lib/workflow-pdf-export');
      // QR codes included: the cover QR points at /missions/<taskId>, which
      // renders the standalone task as a one-step mission (public missions API
      // falls back to single-task lookup), and the per-person QRs point at
      // each assignee's unified profile with ?task=<taskId>, same as
      // workflow PDFs.
      await exportWorkflowAsPDF(pdfData, undefined, { documentKind: 'task', roleTitles });
    } catch (e: any) {
      console.error('PDF export error:', e);
      toast({ variant: 'destructive', title: 'PDF Error', description: e?.message || 'Failed to export PDF.' });
    } finally {
      setExportingPdfTaskId(null);
    }
  };


  return (
    <AuthorizationGate permission="canManageTasks">
      <>
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-glow mb-2">Task Management</h1>
        <p className="text-muted-foreground">Manage all tasks and assignments</p>
      </div>
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList className="grid w-full max-w-md grid-cols-2 h-12 p-1 bg-card/50 border border-white/5 rounded-xl">
          <TabsTrigger value="tasks" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-foreground">
            <ListChecks className="h-5 w-5" />
            <span className="font-bold">Tasks</span>
          </TabsTrigger>
          <TabsTrigger value="missions" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-foreground">
            <Rocket className="h-5 w-5" />
            <span className="font-bold">Missions</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="space-y-8">
      <div className="mb-8 flex items-center gap-4">
        <Button onClick={handleCreateTask}>Create New Task</Button>
        {/* Settings and advanced tools only visible to authorized personnel */}
        {canManageSettings && (
          <>
            <Button variant="outline" onClick={() => setIsSettingsOpen(true)}>Settings</Button>
            <Button variant="outline" onClick={() => router.push('/admin/discipline?tab=register')}>Defaulters</Button>
            <Button
              variant="secondary"
              disabled={isCheckingDeadlines}
              onClick={handleCheckDeadlines}
              aria-busy={isCheckingDeadlines}
            >
              {isCheckingDeadlines ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Checking deadlines...
                </span>
              ) : (
                'Check Deadlines'
              )}
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
                  const done = projTasks.filter((t: any) => isStepWorkDone(t.status)).length;
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
                    <TableHead>Files</TableHead>
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
                    const coAssigneeIds = (Array.isArray((task as any).assigneeIds) ? (task as any).assigneeIds : [])
                      .map(String).filter((id: string) => id && id !== task.assigneeId);
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
                            <div>{assigneeName}{coAssigneeIds.length > 0 && (
                              <span className="ml-1 text-xs text-muted-foreground">+{coAssigneeIds.length}</span>
                            )}</div>
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
                            const n = Array.isArray((task as any).deliverableFiles)
                              ? (task as any).deliverableFiles.length
                              : 0;
                            return n > 0 ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-sky-100 text-sky-800 border border-sky-200 whitespace-nowrap">
                                {n} file{n === 1 ? '' : 's'}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
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
                            <Button variant="destructive" size="sm" onClick={() => setTaskToDelete(task.id)}>
                              Delete
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={exportingPdfTaskId === task.id}
                              onClick={() => handleExportTaskPDF(task)}
                            >
                              {exportingPdfTaskId === task.id ? 'Exporting...' : 'Export PDF'}
                            </Button>
                            {!['completed', 'approved', 'submitted-for-review'].includes(task.status) && (
                              <Button
                                size="sm"
                                className="bg-emerald-600 hover:bg-emerald-700 text-foreground"
                                onClick={() => {
                                  if (!confirm('Mark this task as completed? Points and any badge will be awarded as usual.')) return;
                                  approveTask(task.id);
                                }}
                              >
                                Mark Completed
                              </Button>
                            )}
                            {task.status === 'submitted-for-review' && (
                              <>
                                <Button variant="outline" size="sm" onClick={() => setViewSubmissionTask(task)}>
                                  View Submission
                                </Button>
                                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-foreground" onClick={() => approveTask(task.id)}>
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
        </TabsContent>

        <TabsContent value="missions" className="space-y-6">
          <MissionsTab />
        </TabsContent>
      </Tabs>

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
                chapterId: (editingTask as any).chapterId || '',
                penaltyPoints: typeof (editingTask as any).penaltyPoints === 'number' ? (editingTask as any).penaltyPoints : 5,
                workflowBonusPoints: typeof (editingTask as any).workflowBonusPoints === 'number' ? (editingTask as any).workflowBonusPoints : 10,
                guidance: (editingTask as any).guidance || undefined,
                resources: (editingTask as any).resources ?? [],
                reviewerId: (editingTask as any).reviewerId,
                projectId: editingTask.projectId || undefined,
                status: normalizedStatus,
                deadline: normalizedEditingDeadline,
                report: editingTask.report || '',
                // Edit mode: the assignees are already set, so the form must
                // not re-demand a fresh availability confirmation to save.
                availabilityConfirmed: true,
                resolutionNote: (editingTask as any).resolutionNote || '',
              } : formData}
              editMode={!!editingTask}
              initialWorkflowSteps={editingTask ? editingWorkflowSteps : undefined}
              onCancel={() => setIsDialogOpen(false)}
              submitLabel={editingTask ? 'Update Task' : 'Create Task'}
              onSubmit={(values) => handleSaveTask(values)}
              onSubmitWithPlan={(vals, steps, removedStepIds) => editingTask
                ? handleUpdateWorkflowSteps(vals, steps, removedStepIds)
                // Create mode with every step removed: fall back to a plain
                // task create, matching the old no-steps behavior.
                : (steps.length > 0 ? handleCreateWorkflow(vals, steps) : handleSaveTask(vals))}
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

      {/* Approval drawer for submitted-for-review tasks. Slide-in drawer
         with inline media previews and one-click approve (WS6). */}
      <SubmissionApprovalDrawer
        task={viewSubmissionTask}
        usersMap={usersMap as any}
        onClose={() => setViewSubmissionTask(null)}
        onApprove={approveTask}
        onRequestRevisions={requestRevisions}
      />

      {/* Delete Task Confirmation */}
      <AlertDialog open={taskToDelete !== null} onOpenChange={(open) => { if (!open) setTaskToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the task. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (taskToDelete) { handleDeleteTask(taskToDelete); setTaskToDelete(null); } }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Confirmation */}
      <AlertDialog open={bulkDeleteConfirmOpen} onOpenChange={setBulkDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedTaskIds.size} tasks?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected tasks. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmBulkDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Floating Action Bar */}
      {selectedTaskIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-popover border shadow-lg rounded-full px-6 py-3 flex items-center gap-4 animate-in slide-in-from-bottom-5 fade-in z-50">
          <span className="text-sm font-medium">{selectedTaskIds.size} selected</span>
          <div className="h-4 w-px bg-border" />
          <Button
            variant="destructive"
            size="sm"
            disabled={isBulkDeleting}
            onClick={() => setBulkDeleteConfirmOpen(true)}
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
