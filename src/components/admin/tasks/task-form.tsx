"use client";

// TaskForm (Refactored)
// ----------------------------------------------------------------------------
// A clean, modular task form that integrates:
// - MultiSelectUserCombobox for scalable assignee selection
// - A shadcn/ui Select for optional "Badge Awarded on Completion"
//
// State handling:
// - Parent controls submission; this component manages local inputs and
//   communicates selection changes via callbacks.
// - Assignee selection is controlled via `assigneeIds` string array.
// - Badge selection is controlled via `completionBadgeId` string (or empty for none).
//
// Data fetching:
// - Badges are fetched from Firestore using the existing `useCollection` API.
// ----------------------------------------------------------------------------

import * as React from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { collection, query, DocumentData } from "firebase/firestore";
import { useFirestore } from "@/firebase";
import { useCollection } from "@/firebase/firestore/use-collection";
import { useMemoFirebase } from "@/lib/use-memo-firebase";
import { useToast } from "@/hooks/use-toast";
import { Sparkles } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import MultiSelectUserCombobox from "@/components/admin/multi-select-user-combobox";
import UserSelectionCombobox from "@/components/admin/user-selection-combobox";
import { calculateWorkflowDeadlines } from "@/lib/workflow-utils";

/**
 * Normalize a URL by adding https:// if no protocol is present.
 * Handles common cases like "facebook.com" → "https://facebook.com"
 */
function normalizeUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  // Already has protocol
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Has other protocol (ftp, mailto, etc.) - leave as-is
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  // Add https:// to bare domains
  return `https://${trimmed}`;
}

// Order-sensitive uid array comparison (matches the combobox sync semantics).
function sameUidArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export type TaskFormValues = {
  title: string;
  description: string;
  assigneeIds: string[]; // array of user ids selected
  completionBadgeId?: string; // badge doc id or slug (string), optional
  finalWorkflowCompletionBadgeId?: string;
  points?: number;
  penaltyPoints?: number; // Points deducted on deadline miss
  workflowBonusPoints?: number; // Bonus points for workflow completion
  chapterId?: string; // optional chapter context for AI and storage
  // New fields required by admin form and API
  projectId?: string;
  status?: 'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue';
  deadline?: string; // HTML datetime-local string (ISO-like)
  report?: string;
  resources?: {
    type: 'link' | 'drive' | 'github' | 'doc' | 'video' | 'other';
    url: string;
    title: string;
  }[];
  // Task guidance for assignees
  guidance?: {
    description: string;
    steps: string[];
    estimatedTime?: number;
  };
};
export type WorkflowStep = {
  title: string;
  description: string;
  role?: string;
  assigneeId?: string;
  reason?: string; // AI rationale for selection
  aiSelected?: boolean; // Flag to highlight AI-suggested assignees
  stepSpecificBadgeId?: string;
  individualDeadlineIso?: string;
  id?: string;
  resources?: {
    type: 'link' | 'drive' | 'github' | 'doc' | 'video' | 'other';
    url: string;
    title: string;
  }[];
  // Step guidance for assignees
  guidance?: {
    description: string;
    steps: string[];
    estimatedTime?: number;
  };
};

export type BadgeDoc = {
  id: string; // Firestore doc id
  slug?: string;
  name: string;
  description?: string;
  imageUrl?: string;
  pointsRequired?: number;
  isActive?: boolean;
};

type TaskFormProps = {
  initialValues?: Partial<TaskFormValues>;
  onSubmit: (values: TaskFormValues) => void;
  onSubmitWithPlan?: (values: TaskFormValues, steps: WorkflowStep[]) => void;
  onCancel?: () => void;
  submitLabel?: string;
  initialWorkflowSteps?: WorkflowStep[];
  /** Pre-selected user for context-aware assignment (e.g., from profile view) */
  preSelectedAssignee?: { id: string; name: string } | null;
};

export function TaskForm({ initialValues, onSubmit, onSubmitWithPlan, onCancel, submitLabel = "Save Task", initialWorkflowSteps, preSelectedAssignee }: TaskFormProps) {
  const firestore = useFirestore();
  const { toast } = useToast();

  // Smart initialization: use preSelectedAssignee if provided, else initialValues
  const initialAssigneeIds = preSelectedAssignee
    ? [preSelectedAssignee.id]
    : (initialValues?.assigneeIds ?? []);

  const [values, setValues] = React.useState<TaskFormValues>({
    title: initialValues?.title ?? "",
    description: initialValues?.description ?? "",
    assigneeIds: initialAssigneeIds,
    completionBadgeId: initialValues?.completionBadgeId ?? "",
    finalWorkflowCompletionBadgeId: (initialValues as any)?.finalWorkflowCompletionBadgeId ?? "",
    points: typeof initialValues?.points === 'number' ? initialValues?.points : undefined,
    penaltyPoints: typeof (initialValues as any)?.penaltyPoints === 'number' ? (initialValues as any).penaltyPoints : 5,
    workflowBonusPoints: typeof (initialValues as any)?.workflowBonusPoints === 'number' ? (initialValues as any).workflowBonusPoints : 10,
    chapterId: initialValues?.chapterId ?? "",
    projectId: initialValues?.projectId ?? "",
    status: initialValues?.status ?? 'pending',
    deadline: initialValues?.deadline ?? "",
    report: initialValues?.report ?? "",
    resources: initialValues?.resources ?? [],
  });

  // Brain Dump for AI suggestions
  const [brainDump, setBrainDump] = React.useState<string>("");
  const [aiLoading, setAiLoading] = React.useState<boolean>(false);
  const [aiMessage, setAiMessage] = React.useState<string>("");
  const [workflowSteps, setWorkflowSteps] = React.useState<WorkflowStep[]>([]);
  const [planGenerated, setPlanGenerated] = React.useState<boolean>(false);
  const [apiKey, setApiKey] = React.useState<string>("");

  // Track hand edits so AI regeneration never clobbers them.
  const dirtyFieldsRef = React.useRef<Set<string>>(new Set());
  const stepsDirtyRef = React.useRef<boolean>(false);
  // Convergence guard for the assignee combobox. MultiSelectUserCombobox
  // keeps laggy internal state: when the parent sets its value
  // programmatically (AI applying picks), the combobox first echoes its
  // stale selection back through onChange, then re-adopts the new value.
  // Neither echo is a hand edit, so both are filtered in
  // handleAssigneeChange while this guard is armed.
  const aiAssigneeGuardRef = React.useRef<{ applied: string[]; prev: string[] } | null>(null);
  // Live mirror of the current main assignee ids. handleAssigneeChange and
  // generateWithAI both use useCallback with empty deps, so reading values
  // directly would see a stale closure; the ref is always current.
  const assigneeIdsRef = React.useRef<string[]>([]);
  React.useEffect(() => {
    assigneeIdsRef.current = values.assigneeIds ?? [];
  }, [values.assigneeIds]);
  // Tracks whether "Generate Suggestions" has run at least once.
  const [aiRanOnce, setAiRanOnce] = React.useState<boolean>(false);

  // Load from localStorage on mount and when window gains focus
  React.useEffect(() => {
    const refreshKey = () => {
      if (typeof window !== 'undefined') {
        const storedKey = window.localStorage.getItem('gemini.apiKey') || '';
        setApiKey(storedKey);
      }
    };

    refreshKey();
    window.addEventListener('focus', refreshKey);
    // Periodically refresh while open to catch changes from same-page modals
    const interval = setInterval(refreshKey, 2000);
    
    return () => {
      window.removeEventListener('focus', refreshKey);
      clearInterval(interval);
    };
  }, []);

  // ARCHITECTURAL FIX: Manage the Select's displayed value separately from the core form state.
  // - Using a non-empty sentinel value ("none") for the Select avoids shadcn's empty value crash.
  // - We then synchronize this UI value back into the form state via useEffect.
  // This prevents setState calls inside the render path and eliminates the possibility of
  // creating a re-render loop through onValueChange logic that maps sentinels.
  const [badgeSelectValue, setBadgeSelectValue] = React.useState<string>(
    initialValues?.completionBadgeId ? String(initialValues.completionBadgeId) : "none"
  );
  const [finalWorkflowBadgeSelectValue, setFinalWorkflowBadgeSelectValue] = React.useState<string>(
    (initialValues as any)?.finalWorkflowCompletionBadgeId ? String((initialValues as any).finalWorkflowCompletionBadgeId) : "none"
  );

  // Chapter selection UI-only state (optional)
  const [chapterSelectValue, setChapterSelectValue] = React.useState<string>(
    initialValues?.chapterId ? String(initialValues.chapterId) : "none"
  );

  // Project selection UI-only state
  const [projectSelectValue, setProjectSelectValue] = React.useState<string>(
    initialValues?.projectId ? String(initialValues.projectId) : "none"
  );

  // Status selection UI-only state
  const [statusSelectValue, setStatusSelectValue] = React.useState<
    'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue'
  >(
    initialValues?.status ?? 'pending'
  );

  // Deadline input (HTML datetime-local)
  const [deadlineInputValue, setDeadlineInputValue] = React.useState<string>(
    initialValues?.deadline ?? ""
  );

  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // ARCHITECTURAL FIX: Memoize the onChange callback to prevent infinite re-renders
  // This breaks the circular dependency where:
  // 1. TaskForm creates new onChange function on every render
  // 2. MultiSelectUserCombobox calls onChange in useEffect
  // 3. This triggers setValues in TaskForm, causing re-render
  // 4. Cycle repeats infinitely
  //
  // Echo filtering: right after the AI applies picks programmatically, the
  // combobox emits its stale pre-AI selection once (ignored below), then
  // re-emits the applied picks to confirm convergence (accepted as a no-op).
  // Only anything else counts as a genuine hand edit.
  const handleAssigneeChange = React.useCallback((ids: string[]) => {
    const guard = aiAssigneeGuardRef.current;
    if (guard) {
      if (sameUidArray(ids, guard.applied)) {
        aiAssigneeGuardRef.current = null;
        return;
      }
      if (sameUidArray(ids, guard.prev)) return; // stale echo: ignore
      aiAssigneeGuardRef.current = null; // genuine edit inside the window
    }
    dirtyFieldsRef.current.add('assigneeIds');
    setValues((v) => {
      const prev = v.assigneeIds ?? [];
      return sameUidArray(prev, ids) ? v : { ...v, assigneeIds: ids };
    });
    // Cascade: drop step assignees that are no longer main assignees so the
    // admin visibly re-picks them instead of submitting a stale selection.
    setWorkflowSteps((prev) => prev.map((s) => (s.assigneeId && !ids.includes(s.assigneeId) ? { ...s, assigneeId: undefined } : s)));
  }, []);

  // Memoize workflow step assignee change handler to prevent unnecessary re-renders
  const handleWorkflowStepAssigneeChange = React.useCallback((stepIndex: number) => (uid: string | null) => {
    stepsDirtyRef.current = true;
    setWorkflowSteps((prev) => prev.map((s, i) => i === stepIndex ? { ...s, assigneeId: uid || undefined } : s));
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Helper: convert ISO datetime to input[type="datetime-local"] string in local time
  const toDatetimeLocal = React.useCallback((iso?: string) => {
    if (!iso || typeof iso !== 'string') return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const pad = (n: number) => String(n).padStart(2, '0');
      const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return local;
    } catch {
      return '';
    }
  }, []);



  const recomputeDeadlines = React.useCallback((steps: WorkflowStep[]) => {
    const final = (() => { const val = deadlineInputValue || ''; if (!val) return null; const d = new Date(val); return isNaN(d.getTime()) ? null : d; })();
    if (!final || steps.length === 0) return steps;
    try {
      const arr = calculateWorkflowDeadlines(final, steps.length);
      return steps.map((s, i) => ({ ...s, individualDeadlineIso: toDatetimeLocal(new Date(arr[i]).toISOString()) }));
    } catch { return steps; }
  }, [deadlineInputValue, toDatetimeLocal]);

  React.useEffect(() => {
    setWorkflowSteps((prev) => recomputeDeadlines(prev));
  }, [deadlineInputValue, recomputeDeadlines]);

  // Handle initial workflow steps from props
  React.useEffect(() => {
    if (Array.isArray(initialWorkflowSteps) && initialWorkflowSteps.length > 0) {
      setWorkflowSteps(initialWorkflowSteps);
      setPlanGenerated(true);
    }
  }, [initialWorkflowSteps]);

  const onDragEnd = React.useCallback((event: any) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    stepsDirtyRef.current = true;
    setWorkflowSteps((prev) => {
      const oldIndex = prev.findIndex((s) => (s.id ?? String(prev.indexOf(s))) === active.id);
      const newIndex = prev.findIndex((s) => (s.id ?? String(prev.indexOf(s))) === over.id);
      const next = arrayMove(prev, oldIndex, newIndex);
      return recomputeDeadlines(next);
    });
  }, [recomputeDeadlines]);

  const addStep = React.useCallback(() => {
    stepsDirtyRef.current = true;
    setWorkflowSteps((prev) => {
      const id = `wfstep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const next = [...prev, { title: `New Step ${prev.length + 1}`, description: '', id }];
      return recomputeDeadlines(next);
    });
  }, [recomputeDeadlines]);

  const removeStepAt = React.useCallback((index: number) => {
    stepsDirtyRef.current = true;
    setWorkflowSteps((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return recomputeDeadlines(next);
    });
  }, [recomputeDeadlines]);

  React.useEffect(() => {
    setValues((prev) => {
      const next: Partial<TaskFormValues> = {};

      // Safely compute next values with proper change detection
      const nextBadge = badgeSelectValue === "none" ? "" : (badgeSelectValue || "");
      if (nextBadge !== (prev.completionBadgeId ?? "")) {
        next.completionBadgeId = nextBadge;
      }
      const nextFinalBadge = finalWorkflowBadgeSelectValue === "none" ? "" : (finalWorkflowBadgeSelectValue || "");
      if (nextFinalBadge !== (prev.finalWorkflowCompletionBadgeId ?? "")) {
        next.finalWorkflowCompletionBadgeId = nextFinalBadge;
      }

      const nextChapter = chapterSelectValue === "none" ? "" : (chapterSelectValue || "");
      if (nextChapter !== (prev.chapterId ?? "")) {
        next.chapterId = nextChapter;
      }

      const nextProject = projectSelectValue === "none" ? "" : (projectSelectValue || "");
      if (nextProject !== (prev.projectId ?? "")) {
        next.projectId = nextProject;
      }

      const nextStatus = statusSelectValue;
      if (nextStatus && nextStatus !== prev.status) {
        next.status = nextStatus;
      }

      const nextDeadline = deadlineInputValue || "";
      if (nextDeadline !== (prev.deadline ?? "")) {
        next.deadline = nextDeadline;
      }

      // Only update if there are actual changes
      const hasChanges = Object.keys(next).length > 0;
      return hasChanges ? { ...prev, ...next } : prev;
    });
  }, [badgeSelectValue, finalWorkflowBadgeSelectValue, chapterSelectValue, projectSelectValue, statusSelectValue, deadlineInputValue]);

  // Fetch badges to populate the dropdown (guard Firestore readiness)
  const badgesQuery = useMemoFirebase(() => {
    try {
      return query(collection(firestore, "badges"));
    } catch {
      return null;
    }
  }, [firestore]);
  const { data: badges, loading: badgesLoading, error: badgesError } = useCollection<DocumentData>(badgesQuery);

  // Fetch users to validate AI-suggested assignee UIDs against known users (guarded).
  // The AI team registry itself is built server-side; this read is only a client-side guard.
  const usersQuery = useMemoFirebase(() => {
    try {
      return query(collection(firestore, "users"));
    } catch {
      return null;
    }
  }, [firestore]);
  const { data: users, loading: usersLoading } = useCollection<DocumentData>(usersQuery);

  // Fetch chapters for optional context (guarded)
  const chaptersQuery = useMemoFirebase(() => {
    try {
      return query(collection(firestore, "chapters"));
    } catch {
      return null;
    }
  }, [firestore]);
  const { data: chapters, loading: chaptersLoading, error: chaptersError } = useCollection<DocumentData>(chaptersQuery);

  // Fetch projects for linking tasks to project counters (guarded)
  const projectsQuery = useMemoFirebase(() => {
    try {
      return query(collection(firestore, "projects"));
    } catch {
      return null;
    }
  }, [firestore]);
  const { data: projects, loading: projectsLoading, error: projectsError } = useCollection<DocumentData>(projectsQuery);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    // Phase 1 Enhancement: Workflow deadline validation
    if (workflowSteps.length > 0) {
      if (!values.deadline) {
        toast({ title: 'Error', description: 'Overall deadline is required for workflows', variant: 'destructive' });
        return;
      }

      // Validate each step has an assignee
      const stepsWithoutAssignee = workflowSteps.filter((s, i) => !s.assigneeId);
      if (stepsWithoutAssignee.length > 0) {
        toast({
          title: 'Error',
          description: `${stepsWithoutAssignee.length} step(s) are missing assignees. Each step must have an assignee.`,
          variant: 'destructive'
        });
        return;
      }

      // Enforce per-step assignees are a subset of the main assignees
      const outOfScopeSteps = workflowSteps.filter((s) => !!s.assigneeId && !values.assigneeIds.includes(s.assigneeId as string));
      if (outOfScopeSteps.length > 0) {
        toast({
          title: 'Error',
          description: `${outOfScopeSteps.length} step(s) are assigned to users who are not task assignees. Add them as assignees or reassign the steps.`,
          variant: 'destructive'
        });
        return;
      }

      // Log workflow data for debugging
      console.log('[TaskForm] Submitting workflow with', workflowSteps.length, 'steps');
      workflowSteps.forEach((s, i) => {
        console.log(`[TaskForm] Step ${i}:`, {
          title: s.title,
          assigneeId: s.assigneeId,
          resourcesCount: s.resources?.length || 0,
        });
      });
    }

    setIsSubmitting(true);
    try {
      const payload: TaskFormValues = {
        ...values,
        // normalize empty badge to undefined
        completionBadgeId: values.completionBadgeId ? values.completionBadgeId : undefined,
      };
      if (Array.isArray(workflowSteps) && workflowSteps.length > 0 && typeof onSubmitWithPlan === 'function') {
        await onSubmitWithPlan(payload, workflowSteps);
      } else {
        await onSubmit(payload);
      }
    } finally {
      setIsSubmitting(false);
    }
  };




  // Client-side Gemini call to generate task suggestion and autofill per-step deadlines
  const generateWithAI = async () => {
    try {
      setAiLoading(true);
      setAiMessage("");
      // The AI team registry is built server-side from Firestore on every
      // request, so the client no longer sends subordinates or roleDefinitions.

      // Prepare secure proxy call
      const { getAuth } = await import('firebase/auth');
      const auth = getAuth();
      const user = auth.currentUser;
      const token = user ? await user.getIdToken() : null;

      if (!token) {
        setAiMessage('You must be signed in to use AI features.');
        setAiLoading(false);
        return;
      }

      // Read stored API key and model from localStorage (set via Settings modal)
      const storedApiKey = typeof window !== 'undefined' ? (window.localStorage.getItem('gemini.apiKey') || '') : '';
      const storedModel = typeof window !== 'undefined' ? (window.localStorage.getItem('genai.model') || '') : '';

      const resp = await fetch('/api/ai-task-generator', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
          prompt: brainDump,
          totalPoints: values.points || 10, // Pass the set points, defaulting to 10 if empty
          chapterId: chapterSelectValue,
          // Pass stored API key so server-side proxy can use it as fallback
          apiKey: storedApiKey || undefined,
          model: storedModel || undefined,
        }),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `AI proxy error: ${resp.status}`);
      }

      const rawResp = await resp.json();
      // The proxy returns { success: true, orchestration: { missionTitle, steps } }
      const parsed = rawResp?.orchestration;
      
      if (!parsed || !parsed.missionTitle) {
        console.error('[TaskForm] Invalid AI response structure:', rawResp);
        throw new Error('AI did not return valid task data.');
      }

      // Extract recommended roles/steps from the orchestration
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
      
      // Build scaffolded description from steps
      const scaffoldDescription = steps.length
        ? steps.map((s: any, i: number) => `Step ${i + 1}. ${s.description || s.title}`).join('\n')
        : (parsed.description || '');

      // Only adopt a deadline the AI actually returned. The API does not
      // return one, so there is no +7 day fallback (it used to clobber
      // hand-set deadlines on every regeneration).
      const deadlineIso: string | undefined = parsed.deadline_iso || parsed.deadline;
      const deadlineLocal = deadlineIso ? toDatetimeLocal(deadlineIso) : '';

      // 1. Compute deadlines
      const finalDeadline = (() => {
        const val = deadlineLocal || '';
        if (!val) return null; const d = new Date(val); return isNaN(d.getTime()) ? null : d;
      })();
      
      const deadlinesIso = (() => {
        if (!finalDeadline || steps.length <= 0) return Array(steps.length).fill('');
        try {
          const arr = calculateWorkflowDeadlines(finalDeadline, steps.length);
          return arr.map((d) => toDatetimeLocal(new Date(d).toISOString()));
        } catch { return Array(steps.length).fill(''); }
      })();

      // 2. Prepare Workflow Steps with computed data. Guard every AI-picked UID
      // against the known users: accept only non-empty strings that resolve to
      // a real user, otherwise leave the step unassigned and report it.
      const validUidSet = new Set(
        (Array.isArray(users) ? users : [])
          .map((u: any) => String(u?.uid || u?.id || ''))
          .filter(Boolean)
      );
      const droppedUids: string[] = [];
      const wf: WorkflowStep[] = steps.map((w: any, i: number) => {
        const rawUid = typeof w?.assigneeUid === 'string' ? w.assigneeUid.trim() : '';
        const uidOk = rawUid !== '' && validUidSet.has(rawUid);
        if (!uidOk && rawUid !== '') droppedUids.push(rawUid);
        return {
          title: String(w?.title || `Step ${i + 1}`),
          description: String(w?.description || ''),
          role: w?.role || undefined,
          assigneeId: uidOk ? rawUid : undefined,
          reason: typeof w?.reason === 'string' ? w.reason : undefined,
          aiSelected: uidOk,
          points: typeof w?.points === 'number' ? w.points : 0,
          individualDeadlineIso: deadlinesIso[i] || '',
          id: `wfstep_${Date.now()}_${i}`,
        };
      });
      if (droppedUids.length > 0) {
        setAiMessage(`AI suggestions adjusted: removed ${droppedUids.length} invalid assignee pick(s) (${droppedUids.join(', ')}). Please pick replacements.`);
      }

      // 3. Extract unique suggested UIDs for the main task assignees
      const suggestedUids = Array.from(new Set(
        wf.map((s) => s.assigneeId).filter((uid) => !!uid)
      )) as string[];

      // 4. Atomic State Updates. Only fill fields the admin has not edited by
      // hand, so regenerating never clobbers corrections.
      const applyAiAssignees = !dirtyFieldsRef.current.has('assigneeIds') && suggestedUids.length > 0;
      if (applyAiAssignees) {
        // Arm the combobox convergence guard BEFORE setValues: the combobox
        // echoes its stale selection through onChange before adopting the
        // new value, and those echoes must not mark the field dirty.
        aiAssigneeGuardRef.current = { applied: suggestedUids, prev: assigneeIdsRef.current };
      }
      setValues((v) => {
        const patch: Partial<TaskFormValues> = {};
        if (!dirtyFieldsRef.current.has('title') && parsed.missionTitle) patch.title = parsed.missionTitle;
        if (!dirtyFieldsRef.current.has('description') && scaffoldDescription) patch.description = scaffoldDescription;
        if (!dirtyFieldsRef.current.has('points') && typeof parsed.points === 'number') patch.points = parsed.points;
        if (!dirtyFieldsRef.current.has('deadline') && deadlineLocal) patch.deadline = deadlineLocal;
        if (applyAiAssignees) patch.assigneeIds = suggestedUids;
        return Object.keys(patch).length > 0 ? { ...v, ...patch } : v;
      });

      if (deadlineLocal && !dirtyFieldsRef.current.has('deadline')) setDeadlineInputValue(deadlineLocal);
      if (!stepsDirtyRef.current) {
        setWorkflowSteps(wf);
      }
      setAiRanOnce(true);
    } catch (e: any) {
      console.error('[TaskForm] AI Error:', e);
      setAiMessage(e.message || 'AI generation failed');
    } finally {
      setAiLoading(false);
    }
  };

  const buildWorkflowFromDescription = React.useCallback(() => {
    const lines = String(values.description || '').split(/\r?\n/);
    const wf: WorkflowStep[] = [];
    let stepIndex = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^Step\s+\d+\./i.test(trimmed)) {
        stepIndex += 1;
        const after = trimmed.replace(/^Step\s+\d+\.?\s*/i, '');
        wf.push({ title: `Step ${stepIndex}`, description: after || trimmed, id: `wfstep_${Date.now()}_${stepIndex}` });
      }
    }
    const finalDeadline = (() => {
      const val = deadlineInputValue || ''; if (!val) return null; const d = new Date(val); return isNaN(d.getTime()) ? null : d;
    })();
    const withDeadlines = (base: WorkflowStep[]) => {
      if (!finalDeadline || base.length === 0) return base;
      try {
        const arr = calculateWorkflowDeadlines(finalDeadline, base.length);
        return base.map((s, i) => ({ ...s, individualDeadlineIso: toDatetimeLocal(new Date(arr[i]).toISOString()) }));
      } catch { return base; }
    };
    if (!wf.length && values.description?.trim()) {
      const fallback = lines.filter((l) => l.trim().length).map((l, i) => ({ title: `Step ${i + 1}`, description: l.trim(), id: `wfstep_${Date.now()}_${i}` }));
      setWorkflowSteps(withDeadlines(fallback));
    } else {
      setWorkflowSteps(withDeadlines(wf));
    }
    setAiMessage(`Workflow parsed with ${wf.length || lines.filter((l) => l.trim().length).length} step(s).`);
    setPlanGenerated(true);
  }, [values.description]);

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      {/* Brain Dump and AI Generation */}
      <div className="grid gap-2">
        <Label htmlFor="task-brain-dump">Brain Dump</Label>
        <Textarea
          id="task-brain-dump"
          value={brainDump}
          onChange={(e) => setBrainDump(e.target.value)}
          placeholder="Describe the task in free-form text"
          rows={4}
        />

        {/* AI Inputs: Points (required for AI distribution) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3 border rounded-lg bg-primary/5">
          <div className="grid gap-1.5">
            <Label htmlFor="task-points" className="text-xs font-bold uppercase tracking-wider">Base Points</Label>
            <Input
              id="task-points"
              type="number"
              className="h-9"
              value={typeof values.points === 'number' ? values.points : ''}
              onChange={(e) => { dirtyFieldsRef.current.add('points'); setValues((v) => ({ ...v, points: Number(e.target.value) })); }}
              placeholder="e.g. 50"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-penalty" className="text-xs font-bold uppercase tracking-wider text-amber-500">Deadline Penalty</Label>
            <Input
              id="task-penalty"
              type="number"
              className="h-9 border-amber-500/20"
              value={typeof (values as any).penaltyPoints === 'number' ? (values as any).penaltyPoints : ''}
              onChange={(e) => setValues((v) => ({ ...v, penaltyPoints: Number(e.target.value) || undefined }))}
              placeholder="Def: 5"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-bonus" className="text-xs font-bold uppercase tracking-wider text-emerald-500">Workflow Bonus</Label>
            <Input
              id="task-bonus"
              type="number"
              className="h-9 border-emerald-500/20"
              value={typeof (values as any).workflowBonusPoints === 'number' ? (values as any).workflowBonusPoints : ''}
              onChange={(e) => setValues((v) => ({ ...v, workflowBonusPoints: Number(e.target.value) || undefined }))}
              placeholder="Def: 10"
            />
          </div>
        </div>

        {/* Optional Chapter Selector for AI context */}
        <div className="grid gap-2">
          <Label>Chapter (optional)</Label>
          {chaptersLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select value={chapterSelectValue} onValueChange={(val) => setChapterSelectValue(val)}>
              <SelectTrigger>
                <SelectValue placeholder={"No chapter"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No chapter</SelectItem>
                {chaptersError && (
                  <SelectItem value="__error" disabled>
                    Failed to load chapters
                  </SelectItem>
                )}
                {Array.isArray(chapters) && chapters.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} {c.city ? `· ${c.city}` : ''} {c.country ? `· ${c.country}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button 
              type="button" 
              onClick={generateWithAI} 
              disabled={aiLoading || !brainDump.trim() || !values.points}
              className={!apiKey ? "opacity-50" : ""}
              title={aiRanOnce ? "Regenerating keeps fields you edited by hand" : undefined}
            >
              {aiLoading ? 'Generating…' : (aiRanOnce ? 'Regenerate Suggestions' : 'Generate Suggestions')}
            </Button>
            {aiRanOnce && !aiLoading && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => {
                  dirtyFieldsRef.current.clear();
                  stepsDirtyRef.current = false;
                  setAiRanOnce(false);
                  setAiMessage('Hand edits cleared. Regenerating will refill all fields.');
                }}
              >
                Clear my edits
              </Button>
            )}
            {!values.points && brainDump.trim() && (
              <span className="text-xs text-amber-500 font-medium animate-pulse">Set Points first to use AI</span>
            )}
            {aiMessage && <span className="text-sm text-muted-foreground">{aiMessage}</span>}
          </div>
          
          {!apiKey && (
            <p className="text-[10px] text-muted-foreground flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1.5 rounded w-fit">
              <span className="text-amber-500 font-bold">ⓘ</span>
              <span>No personal Gemini key — using the shared server key. Add your own in </span>
              <span className="text-primary font-bold">AI Settings</span>
              <span> for personal quota.</span>
            </p>
          )}
        </div>
      </div>
      {/* Title */}
      <div className="grid gap-2">
        <Label htmlFor="task-title">Title</Label>
        <Input
          id="task-title"
          value={values.title}
          onChange={(e) => { dirtyFieldsRef.current.add('title'); setValues((v) => ({ ...v, title: e.target.value })); }}
          placeholder="Enter task title"
        />
      </div>

      {/* Description */}
      <div className="grid gap-2">
        <Label htmlFor="task-desc">Description</Label>
        <Textarea
          id="task-desc"
          value={values.description}
          onChange={(e) => { dirtyFieldsRef.current.add('description'); setValues((v) => ({ ...v, description: e.target.value })); }}
          placeholder="Enter task description"
        />
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={buildWorkflowFromDescription} disabled={!values.description?.trim() || planGenerated}>
            {planGenerated ? 'Plan Generated ✓' : 'Generate Workflow Plan'}
          </Button>
        </div>
      </div>

      {/* Task Guidance */}
      <div className="grid gap-2 p-3 border rounded-lg bg-muted/30">
        <Label className="text-base font-semibold">Task Guidance (How to Complete)</Label>
        <p className="text-xs text-muted-foreground">Provide instructions to help assignees understand how to complete this task</p>
        <Textarea
          id="task-guidance-desc"
          value={(values as any).guidance?.description || ''}
          onChange={(e) => setValues((v) => ({
            ...v,
            guidance: { ...(v as any).guidance, description: e.target.value, steps: (v as any).guidance?.steps || [] }
          }))}
          placeholder="General guidance: What should the assignee know before starting?"
          rows={2}
        />
        <Label className="text-sm mt-2">Step-by-Step Instructions (one per line)</Label>
        <Textarea
          id="task-guidance-steps"
          value={(values as any).guidance?.steps?.join('\n') || ''}
          onChange={(e) => setValues((v) => ({
            ...v,
            guidance: {
              ...(v as any).guidance,
              description: (v as any).guidance?.description || '',
              steps: e.target.value.split('\n').filter((s: string) => s.trim())
            }
          }))}
          placeholder="Step 1: Do this first&#10;Step 2: Then do this&#10;Step 3: Finally, complete this"
          rows={3}
        />
      </div>

      {/* Team Badge (Workflow Completion) */}
      <div className="grid gap-2">
        <Label>Team Badge (Awarded to everyone upon workflow completion)</Label>
        {badgesLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <Select
            value={finalWorkflowBadgeSelectValue}
            onValueChange={(val) => setFinalWorkflowBadgeSelectValue(val)}
          >
            <SelectTrigger>
              <SelectValue placeholder={"No final badge"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No final badge</SelectItem>
              {badgesError && (
                <SelectItem value="__error" disabled>
                  Failed to load badges
                </SelectItem>
              )}
              {Array.isArray(badges) && badges
                .filter((b) => b?.id && String(b.id).trim() !== "")
                .map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name} {typeof b.pointsRequired === "number" ? `· ${b.pointsRequired} pts` : ""}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Project */}
      <div className="grid gap-2">
        <Label>Project</Label>
        {projectsLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <Select value={projectSelectValue} onValueChange={(val) => setProjectSelectValue(val)}>
            <SelectTrigger>
              <SelectValue placeholder={"No project"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No project</SelectItem>
              {projectsError && (
                <SelectItem value="__error" disabled>
                  Failed to load projects
                </SelectItem>
              )}
              {Array.isArray(projects) && projects
                .filter((p: any) => p?.id && String(p.id).trim() !== "")
                .map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title || p.slug || p.id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}
        <div className="text-xs text-muted-foreground">Linking a project updates project counters.</div>
      </div>

      {/* Status */}
      <div className="grid gap-2">
        <Label>Status</Label>
        <Select value={statusSelectValue} onValueChange={(val: 'pending' | 'in-progress' | 'submitted-for-review' | 'completed') => setStatusSelectValue(val)}>
          <SelectTrigger>
            <SelectValue placeholder={"Select status"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="in-progress">In Progress</SelectItem>
            <SelectItem value="submitted-for-review">Submitted for Review</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Final Workflow Deadline */}
      <div className="grid gap-2">
        <Label htmlFor="task-deadline">Deadline *</Label>
        <Input
          id="task-deadline"
          type="datetime-local"
          value={deadlineInputValue}
          onChange={(e) => { dirtyFieldsRef.current.add('deadline'); setDeadlineInputValue(e.target.value); }}
          placeholder="Select deadline"
        />
      </div>

      {/* Assignees via MultiSelectUserCombobox */}
      <div className="grid gap-2">
        <Label>Assignees</Label>
        <MultiSelectUserCombobox
          value={values.assigneeIds}
          onChange={handleAssigneeChange}
          chapterId={chapterSelectValue !== 'none' ? chapterSelectValue : undefined}
        />
        <div className="text-xs text-muted-foreground">{values.assigneeIds.length} user(s) selected</div>
      </div>
      <div className="grid gap-2 border rounded-md p-3">
        <Label>Workflow Plan (optional)</Label>
        {workflowSteps.length === 0 ? (
          <div className="text-sm text-muted-foreground">Use AI or the button above to parse a step-by-step workflow. Assign a user for each step, then click Create Task.</div>
        ) : (
          <div className="space-y-3">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={workflowSteps.map((s, i) => s.id ?? String(i))} strategy={verticalListSortingStrategy}>
                {workflowSteps.map((step, idx) => (
                  <SortableStepCard key={(step.id ?? String(idx))} id={(step.id ?? String(idx))}>
                    <div className="grid gap-2 border rounded p-2">
                      <div className="flex items-center justify-between">
                        <div className="font-medium flex items-center gap-2">
                          <GripHandle />
                          <span className="text-xs text-muted-foreground">Step {idx + 1}</span>
                        </div>
                        <button
                          type="button"
                          aria-label="Remove step"
                          className="text-xs text-destructive"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); removeStepAt(idx); }}
                        >Remove</button>
                      </div>
                      {/* Editable Step Title */}
                      <div className="grid gap-1">
                        <Label className="text-xs" htmlFor={`step-title-${idx}`}>Step Title</Label>
                        <Input
                          id={`step-title-${idx}`}
                          value={step.title}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            stepsDirtyRef.current = true;
                            setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, title: e.target.value } : s));
                          }}
                          placeholder="Enter step title"
                          className="h-8 text-sm font-medium"
                        />
                      </div>
                      {/* Editable Step Description */}
                      <div className="grid gap-1">
                        <Label className="text-xs" htmlFor={`step-description-${idx}`}>Step Description</Label>
                        <Textarea
                          id={`step-description-${idx}`}
                          value={step.description}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            stepsDirtyRef.current = true;
                            setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, description: e.target.value } : s));
                          }}
                          placeholder="Describe what the assignee should do in this step..."
                          className="text-sm min-h-[60px] resize-y"
                          rows={2}
                        />
                      </div>
                      {step.role && (
                        <div className="text-xs text-muted-foreground">Role: {step.role}</div>
                      )}
                      {(() => {
                        const iso = step.individualDeadlineIso || '';
                        if (iso) {
                          const d = new Date(iso);
                          if (!isNaN(d.getTime())) {
                            const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
                            return <div className="text-xs text-muted-foreground">Calculated Deadline: {label}</div>;
                          }
                        }
                        try {
                          const finalDeadlineIso = deadlineInputValue || '';
                          const finalDeadline = finalDeadlineIso ? new Date(finalDeadlineIso) : null;
                          if (finalDeadline && !isNaN(finalDeadline.getTime())) {
                            const deadlines = calculateWorkflowDeadlines(finalDeadline, workflowSteps.length);
                            const d = deadlines[idx];
                            const label = d ? `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}` : '';
                            return <div className="text-xs text-muted-foreground">Calculated Deadline: {label}</div>;
                          }
                        } catch { }
                        return null;
                      })()}
                      <div className="grid gap-1">
                        <Label className="text-xs" htmlFor={`step-deadline-${idx}`}>Override Deadline (optional)</Label>
                        <Input
                          id={`step-deadline-${idx}`}
                          type="datetime-local"
                          value={step.individualDeadlineIso || ''}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const val = e.target.value;
                            stepsDirtyRef.current = true;
                            setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, individualDeadlineIso: val } : s));
                          }}
                          placeholder="Use to override the calculated deadline"
                        />
                      </div>
                      <div className="grid gap-1" onMouseDownCapture={(e) => e.stopPropagation()}>
                        <Label className="text-xs">Assignee</Label>
                        <UserSelectionCombobox
                          selectedUid={step.assigneeId || null}
                          onSelect={handleWorkflowStepAssigneeChange(idx)}
                          placeholder="Select a user"
                          preferredRole={step.role}
                          chapterId={chapterSelectValue !== 'none' ? chapterSelectValue : undefined}
                          showAllToggle
                          restrictToIds={values.assigneeIds}
                        />
                        {step.reason && (
                          <div className="mt-1.5 p-2 rounded border border-blue-500/20 bg-blue-500/5 text-[10px] leading-tight text-blue-400 italic flex gap-1.5 items-start">
                            <Sparkles className="h-3 w-3 mt-0.5 shrink-0" />
                            <span>AI Rationale: {step.reason}</span>
                          </div>
                        )}
                        </div>

                      <div className="grid gap-1" onMouseDownCapture={(e) => e.stopPropagation()}>
                        <Label className="text-xs">Step Badge (Awarded to assignee upon completion)</Label>
                        {badgesLoading ? (
                          <Skeleton className="h-8 w-full" />
                        ) : (
                          <Select
                            value={step.stepSpecificBadgeId || 'none'}
                            onValueChange={(val) => {
                              stepsDirtyRef.current = true;
                              setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, stepSpecificBadgeId: (val === 'none' ? undefined : val) } : s));
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={"No badge"} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No badge</SelectItem>
                              {badgesError && (
                                <SelectItem value="__error" disabled>
                                  Failed to load badges
                                </SelectItem>
                              )}
                              {Array.isArray(badges) && badges
                                .filter((b) => b?.id && String(b.id).trim() !== "")
                                .map((b) => (
                                  <SelectItem key={b.id} value={b.id}>
                                    {b.name} {typeof b.pointsRequired === "number" ? `· ${b.pointsRequired} pts` : ""}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      {/* Step-Specific Resources */}
                      <div className="grid gap-2 border-t pt-2 mt-2">
                        <Label className="text-xs">Step Resources (Only for this assignee)</Label>
                        <div className="space-y-2">
                          {(step.resources || []).map((res, rIdx) => (
                            <div key={rIdx} className="flex gap-1 items-center">
                              <Input
                                className="h-7 text-xs flex-[2]"
                                placeholder="Title"
                                value={res.title}
                                onChange={(e) => {
                                  stepsDirtyRef.current = true;
                                  setWorkflowSteps(prev => prev.map((s, i) => {
                                    if (i !== idx) return s;
                                    const newRes = [...(s.resources || [])];
                                    newRes[rIdx] = { ...newRes[rIdx], title: e.target.value };
                                    return { ...s, resources: newRes };
                                  }));
                                }}
                              />
                              <Input
                                className="h-7 text-xs flex-[3]"
                                placeholder="URL (e.g., facebook.com)"
                                value={res.url}
                                onChange={(e) => {
                                  stepsDirtyRef.current = true;
                                  setWorkflowSteps(prev => prev.map((s, i) => {
                                    if (i !== idx) return s;
                                    const newRes = [...(s.resources || [])];
                                    newRes[rIdx] = { ...newRes[rIdx], url: e.target.value };
                                    return { ...s, resources: newRes };
                                  }));
                                }}
                                onBlur={(e) => {
                                  const normalized = normalizeUrl(e.target.value);
                                  if (normalized !== e.target.value) {
                                    setWorkflowSteps(prev => prev.map((s, i) => {
                                      if (i !== idx) return s;
                                      const newRes = [...(s.resources || [])];
                                      newRes[rIdx] = { ...newRes[rIdx], url: normalized };
                                      return { ...s, resources: newRes };
                                    }));
                                  }
                                }}
                              />
                              <select
                                className="h-7 text-xs border rounded bg-transparent w-[80px]"
                                value={res.type}
                                onChange={(e) => {
                                  stepsDirtyRef.current = true;
                                  setWorkflowSteps(prev => prev.map((s, i) => {
                                    if (i !== idx) return s;
                                    const newRes = [...(s.resources || [])];
                                    newRes[rIdx] = { ...newRes[rIdx], type: e.target.value as any };
                                    return { ...s, resources: newRes };
                                  }));
                                }}
                              >
                                <option value="link">Link</option>
                                <option value="drive">Drive</option>
                                <option value="github">GitHub</option>
                                <option value="doc">Doc</option>
                                <option value="video">Video</option>
                              </select>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive"
                                onClick={() => {
                                  stepsDirtyRef.current = true;
                                  setWorkflowSteps(prev => prev.map((s, i) => {
                                    if (i !== idx) return s;
                                    const newRes = [...(s.resources || [])];
                                    newRes.splice(rIdx, 1);
                                    return { ...s, resources: newRes };
                                  }));
                                }}
                              >
                                <span className="sr-only">Remove</span>
                                &times;
                              </Button>
                            </div>
                          ))}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs w-full"
                            onClick={() => {
                              stepsDirtyRef.current = true;
                              setWorkflowSteps(prev => prev.map((s, i) => {
                                if (i !== idx) return s;
                                return { ...s, resources: [...(s.resources || []), { title: '', url: '', type: 'link' }] };
                              }));
                            }}
                          >
                            + Add Private Resource
                          </Button>
                        </div>
                      </div>
                    </div>
                  </SortableStepCard>
                ))}
              </SortableContext>
            </DndContext>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="secondary" onClick={addStep}>Add New Step</Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2"></div>
      </div>



      {/* Resources & Logistics (New) */}
      <div className="grid gap-2 border rounded-md p-3">
        <Label>Resources & Logistics (Optional)</Label>
        <div className="space-y-3">
          {(values.resources || []).map((res, idx) => (
            <div key={idx} className="flex flex-col sm:flex-row gap-2 items-start sm:items-center border p-2 rounded bg-muted/10">
              <div className="grid gap-1 flex-1 w-full">
                <Label className="text-xs sr-only">Title</Label>
                <Input
                  placeholder="Resource Title (e.g. Design Doc)"
                  value={res.title}
                  onChange={(e) => {
                    const newRes = [...(values.resources || [])];
                    newRes[idx] = { ...newRes[idx], title: e.target.value };
                    setValues(v => ({ ...v, resources: newRes }));
                  }}
                />
              </div>
              <div className="grid gap-1 flex-[2] w-full">
                <Label className="text-xs sr-only">URL</Label>
                <Input
                  placeholder="URL (e.g., facebook.com)"
                  value={res.url}
                  onChange={(e) => {
                    const newRes = [...(values.resources || [])];
                    newRes[idx] = { ...newRes[idx], url: e.target.value };
                    setValues(v => ({ ...v, resources: newRes }));
                  }}
                  onBlur={(e) => {
                    const normalized = normalizeUrl(e.target.value);
                    if (normalized !== e.target.value) {
                      const newRes = [...(values.resources || [])];
                      newRes[idx] = { ...newRes[idx], url: normalized };
                      setValues(v => ({ ...v, resources: newRes }));
                    }
                  }}
                />
              </div>
              <div className="w-full sm:w-[140px]">
                <Select
                  value={res.type}
                  onValueChange={(val: any) => {
                    const newRes = [...(values.resources || [])];
                    newRes[idx] = { ...newRes[idx], type: val };
                    setValues(v => ({ ...v, resources: newRes }));
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="link">Link</SelectItem>
                    <SelectItem value="drive">Google Drive</SelectItem>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="doc">Document</SelectItem>
                    <SelectItem value="video">Video</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-destructive shrink-0"
                onClick={() => {
                  const newRes = [...(values.resources || [])];
                  newRes.splice(idx, 1);
                  setValues(v => ({ ...v, resources: newRes }));
                }}
              >
                <span className="sr-only">Remove</span>
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.7816 4.03157C12.0062 3.80702 12.0062 3.44295 11.7816 3.2184C11.5571 2.99385 11.193 2.99385 10.9685 3.2184L7.50005 6.68682L4.03164 3.2184C3.80708 2.99385 3.44301 2.99385 3.21846 3.2184C2.99391 3.44295 2.99391 3.80702 3.21846 4.03157L6.68688 7.49999L3.21846 10.9684C2.99391 11.1929 2.99391 11.557 3.21846 11.7816C3.44301 12.0061 3.80708 12.0061 4.03164 11.7816L7.50005 8.31316L10.9685 11.7816C11.193 12.0061 11.5571 12.0061 11.7816 11.7816C12.0062 11.557 12.0062 11.1929 11.7816 10.9684L8.31322 7.49999L11.7816 4.03157Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path></svg>
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setValues(v => ({
                ...v,
                resources: [...(v.resources || []), { title: '', url: '', type: 'link' }]
              }));
            }}
          >
            Add Resource / Link
          </Button>
        </div>
      </div>

      {/* Badge Awarded on Completion (Single Task Mode Only) */}
      {workflowSteps.length === 0 && (
        <div className="grid gap-2">
          <Label>Badge Awarded on Completion (optional)</Label>
          {badgesLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              // CONTROLLED SELECT: Use non-empty sentinel for "no badge" and avoid
              // calling setState during render. Changes are handled by onValueChange,
              // and the synchronization to form state is performed in the effect above.
              value={badgeSelectValue}
              onValueChange={(val) => setBadgeSelectValue(val)}
            >
              <SelectTrigger>
                <SelectValue placeholder={"No badge"} />
              </SelectTrigger>
              <SelectContent>
                {/* HOTFIX: Use non-empty value for 'No badge' to satisfy shadcn Select */}
                <SelectItem value="none">No badge</SelectItem>
                {badgesError && (
                  <SelectItem value="__error" disabled>
                    Failed to load badges
                  </SelectItem>
                )}
                {Array.isArray(badges) &&
                  // HOTFIX: defensively filter out any badge doc with empty id
                  badges
                    .filter((b) => b?.id && String(b.id).trim() !== "")
                    .map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name} {typeof b.pointsRequired === "number" ? `· ${b.pointsRequired} pts` : ""}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          )}
          <div className="text-xs text-muted-foreground">This badge is awarded to the assignee when they complete this single task.</div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-2 flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button 
          type="submit" 
          disabled={
            isSubmitting || 
            !values.title.trim() || 
            !values.description.trim() || 
            !values.points || 
            !(values as any).penaltyPoints || 
            !(values as any).workflowBonusPoints ||
            !values.deadline
          }
        >
          {isSubmitting && <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          {submitLabel}
        </Button>
      </div>
    </form >
  );
}

export default TaskForm;

function GripHandle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="opacity-60">
      <circle cx="9" cy="6" r="1.5" />
      <circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" />
      <circle cx="15" cy="18" r="1.5" />
    </svg>
  );
}

function SortableStepCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  } as React.CSSProperties;
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
