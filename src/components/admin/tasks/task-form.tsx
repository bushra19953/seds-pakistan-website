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
import { useFirestore, useUser } from "@/firebase";
import { useCollection } from "@/firebase/firestore/use-collection";
import { useMemoFirebase } from "@/lib/use-memo-firebase";
import { useToast } from "@/hooks/use-toast";
import { Sparkles } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import MultiSelectUserCombobox from "@/components/admin/multi-select-user-combobox";
import UserSelectionCombobox from "@/components/admin/user-selection-combobox";
import { calculateWorkflowDeadlines } from "@/lib/workflow-utils";
import { HOUSE_POINTS_DEFAULTS, WORKFLOW_MIN_DEADLINE_HOURS } from "@/lib/task-form-rules";
import { canReviewTasks, resolveCanonicalRole, getRoleDisplayName } from "@/lib/roles";
import { StepRolePicker } from "@/components/admin/tasks/step-role-picker";
import { isCustomRoleSlug, customRoleTitle } from "@/lib/custom-roles";
import { getCustomRoleDefinitionSync } from "@/lib/custom-role-sync";
import { useCustomRoleDefinitions } from "@/components/roles/custom-role-registry";
import { normalizeToCanonical } from "@/lib/role-catalog";

/**
 * Display label for a step role, used for the assignee filter strip
 * (Custom Roles consumers, D4): catalog/legacy roles resolve to their
 * catalog title and custom slugs to their definition title
 * (contracts 4.5), so the strip never prints a raw custom slug.
 * Free-text working titles return undefined: the strip then shows the
 * typed text itself, which is honest (it is a working title).
 */
function stepRoleFilterLabel(role: string | undefined): string | undefined {
  if (!role) return undefined;
  if (isCustomRoleSlug(role)) {
    return customRoleTitle(getCustomRoleDefinitionSync(role), role);
  }
  return normalizeToCanonical(role) ? getRoleDisplayName(role) : undefined;
}

// Reviewer gate (spec 6.1): only users who pass canReviewTasks are offered
// as reviewers. The role is read from the option itself (the combobox already
// overlays roles/ onto users/); no extra fetches. resolveCanonicalRole keeps
// already-canonical tokens (e.g. chapter_president) eligible.
const isReviewerEligible = (u: { role?: string }) =>
  canReviewTasks(resolveCanonicalRole(u.role));

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

/**
 * Title for a step parsed from a description line (F3): the line's own
 * first clause, not the literal "Step N" the parser used to file.
 * Falls back when the text carries nothing title-like.
 */
function deriveStepTitle(text: string, fallback: string): string {
  const cleaned = String(text || '').trim();
  if (!cleaned) return fallback;
  const firstClause = cleaned.split(/\s+[—–-]\s+|\.\s+|:\s+/)[0]?.trim() ?? '';
  const candidate = firstClause.length >= 3 ? firstClause : cleaned;
  return candidate.length > 80 ? `${candidate.slice(0, 77)}…` : candidate;
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
  chapterId?: string | null; // optional chapter context for AI and storage; null = explicitly cleared
  reviewerId?: string | null; // optional reviewer assigned to verify the task; null = explicitly cleared
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
  // Assignment safety: field-work guardrails. The /api/tasks server enforces
  // requiresOnSitePresence + locationRequired + availabilityConfirmed together.
  requiresOnSitePresence?: boolean; // task must be done in person
  locationRequired?: string; // named place; required by the server when requiresOnSitePresence is true
  availabilityConfirmed?: boolean; // admin explicitly checked assignee availability before assigning
  availabilityNote?: string; // optional note about how/when availability was checked
  resolutionNote?: string; // admin note recorded when the task is approved/completed
};
export type WorkflowStep = {
  title: string;
  description: string;
  estimatedDuration?: number; // Estimated minutes for this step; weights its deadline
  isLimitingStep?: boolean; // Bottleneck step: its own duration is reserved first in deadline weighting
  role?: string;
  assigneeId?: string;
  assigneeIds?: string[]; // Co-assignees (first entry = assigneeId)
  points?: number; // Per-step points (defaults to basePoints / steps if unset)
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
  // Per-step assignment safety (matches the /api/workflows step schema):
  // locationRequirement 'on-site' means the step must be done in person.
  locationRequirement?: 'on-site' | 'remote' | 'either';
  locationNote?: string; // where the step must be done (only used when on-site)
  availabilityStatus?: 'confirmed' | 'unknown' | 'unavailable'; // assignee availability check for this step
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
  onSubmitWithPlan?: (values: TaskFormValues, steps: WorkflowStep[], removedStepIds?: string[]) => void;
  onCancel?: () => void;
  submitLabel?: string;
  initialWorkflowSteps?: WorkflowStep[];
  /** Pre-selected user for context-aware assignment (e.g., from profile view) */
  preSelectedAssignee?: { id: string; name: string } | null;
  /** True when the dialog edits an existing task. Create-only guards (fresh
   * availability confirmation, untouched-step validations) are skipped. */
  editMode?: boolean;
};

// Helper: convert an ISO datetime to an input[type="datetime-local"] string in
// the browser's local time. Exported for the admin tasks page so dialog
// prefills render true local wall clock instead of raw UTC.
export function toDatetimeLocal(iso?: string): string {
  if (!iso || typeof iso !== 'string') return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

export function TaskForm({ initialValues, onSubmit, onSubmitWithPlan, onCancel, submitLabel = "Save Task", initialWorkflowSteps, preSelectedAssignee, editMode = false }: TaskFormProps) {
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  // Populate the custom-role registry (and re-render when it lands) so
  // step-role filter labels resolve definition titles (consumers D4).
  useCustomRoleDefinitions();

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
    // Points policy (F6): penalty/bonus start EMPTY. The house defaults
    // show as placeholders and are filed at submit when the fields are
    // left untouched, so a default is never silently indistinguishable
    // from a deliberate choice. A typed value, including 0, wins.
    penaltyPoints: typeof (initialValues as any)?.penaltyPoints === 'number' ? (initialValues as any).penaltyPoints : undefined,
    workflowBonusPoints: typeof (initialValues as any)?.workflowBonusPoints === 'number' ? (initialValues as any).workflowBonusPoints : undefined,
    chapterId: initialValues?.chapterId ?? "",
    projectId: initialValues?.projectId ?? "",
    status: initialValues?.status ?? 'pending',
    deadline: initialValues?.deadline ?? "",
    report: initialValues?.report ?? "",
    resources: initialValues?.resources ?? [],
    guidance: initialValues?.guidance ?? undefined,
    reviewerId: initialValues?.reviewerId ?? "",
    requiresOnSitePresence: initialValues?.requiresOnSitePresence === true,
    locationRequired: initialValues?.locationRequired ?? "",
    availabilityConfirmed: initialValues?.availabilityConfirmed === true,
    availabilityNote: initialValues?.availabilityNote ?? "",
    resolutionNote: (initialValues as any)?.resolutionNote ?? "",
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
  // Ids of persisted workflow steps the admin removed in this dialog session.
  // Forwarded with the plan so the server deletes exactly those step docs.
  const removedStepIdsRef = React.useRef<string[]>([]);
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
      // Changing the assignee list voids any earlier availability confirmation:
      // the admin must re-confirm for the new set of assignees.
      return sameUidArray(prev, ids) ? v : { ...v, assigneeIds: ids, availabilityConfirmed: false };
    });
    // Cascade: drop step assignees that are no longer main assignees so the
    // admin visibly re-picks them instead of submitting a stale selection.
    setWorkflowSteps((prev) => prev.map((s) => (s.assigneeId && !ids.includes(s.assigneeId) ? { ...s, assigneeId: undefined } : s)));
  }, []);

  // Memoize workflow step assignee change handler to prevent unnecessary re-renders
  const handleWorkflowStepAssigneeChange = React.useCallback((stepIndex: number) => (uid: string | null) => {
    stepsDirtyRef.current = true;
    setWorkflowSteps((prev) => prev.map((s, i) => i === stepIndex ? { ...s, assigneeId: uid || undefined } : s));
    // A step assignee change also voids the task-level availability confirmation.
    setValues((v) => ({ ...v, availabilityConfirmed: false }));
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // toDatetimeLocal is defined at module scope (shared with the admin tasks page).



  // Ids of steps hydrated from persisted task docs (edit mode: the admin
  // tasks page loads the workflow's real step docs into this form). Their
  // stored individualDeadline values are authoritative: the auto-split
  // recompute below must never overwrite them. Before this guard existed,
  // merely opening a workflow in the edit dialog re-split every step's
  // deadline between now and the dialog's deadline field, and saving the
  // dialog (even for an unrelated description edit) wrote the re-split
  // values over the stored ones (Pod 1B, 2026-10-27: six hand-set
  // deadlines silently reverted to staggered plan values). Steps built
  // in this form (creation) have no persisted doc id and still get the
  // calculated split exactly as before. Whole-workflow deadline moves
  // go through PATCH /api/workflows/[id] (Missions tab, Deadline button).
  const persistedStepIdsRef = React.useRef<ReadonlySet<string>>(new Set());

  const recomputeDeadlines = React.useCallback((steps: WorkflowStep[]) => {
    const final = (() => {
      // The base arrives from a datetime-local input (local wall clock). Route
      // it through toDatetimeLocal so a full UTC ISO string is converted to
      // local wall clock first, instead of being silently reinterpreted and
      // shifting every derived step deadline.
      const val = toDatetimeLocal(deadlineInputValue || '');
      if (!val) return null;
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    })();
    if (!final || steps.length === 0) return steps;
    try {
      const arr = calculateWorkflowDeadlines(final, steps);
      return steps.map((s, i) => (
        s.id && persistedStepIdsRef.current.has(s.id)
          ? s
          : { ...s, individualDeadlineIso: toDatetimeLocal(new Date(arr[i]).toISOString()) }
      ));
    } catch { return steps; }
  }, [deadlineInputValue, toDatetimeLocal]);

  // Recompute also when a step's duration or limiting flag changes, so the
  // weighted split reaches each step's individualDeadlineIso. The key only
  // covers timing fields, so the recompute (which writes deadlines) cannot
  // retrigger itself.
  const stepTimingKey = workflowSteps
    .map((s) => `${s.estimatedDuration ?? ''}:${s.isLimitingStep ? 1 : 0}`)
    .join('|');

  React.useEffect(() => {
    setWorkflowSteps((prev) => recomputeDeadlines(prev));
  }, [deadlineInputValue, recomputeDeadlines, stepTimingKey]);

  // Handle initial workflow steps from props
  React.useEffect(() => {
    if (Array.isArray(initialWorkflowSteps) && initialWorkflowSteps.length > 0) {
      // These steps come from persisted task docs; record their ids so the
      // deadline recompute above never re-splits their stored deadlines.
      persistedStepIdsRef.current = new Set(
        initialWorkflowSteps
          .map((s) => s.id)
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
      );
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
      const removed = prev[index];
      const removedId = typeof removed?.id === 'string' ? removed.id.trim() : '';
      if (removedId && !removedStepIdsRef.current.includes(removedId)) {
        removedStepIdsRef.current.push(removedId);
      }
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

  // Fetch users to validate AI-suggested assignee UIDs against known users.
  // The AI team registry itself is built server-side; this read is only a client-side guard.
  // Item 6: loaded through the sanitised picker API instead of a client
  // list of the users collection (no longer listable by every signed-in
  // account under the Batch 1 rules). The availability check below only
  // needs uid, displayName and the vacation flag, all in the API's
  // allowlist; coveringOfficerId is not exposed, so the vacation detail
  // line falls back to its generic wording.
  const [users, setUsers] = React.useState<DocumentData[]>([]);
  const [usersLoading, setUsersLoading] = React.useState(true);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!user) {
          setUsersLoading(false);
          return;
        }
        const idToken = await user.getIdToken();
        const res = await fetch('/api/users/picker?limit=1000', {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) throw new Error(`Picker request failed (${res.status})`);
        const json = await res.json();
        if (!cancelled) {
          setUsers(
            (json.users || []).map((row: any) => ({
              id: row.uid,
              uid: row.uid,
              displayName: row.displayName,
              chapterId: row.chapterId,
              role: row.role,
              isOnVacation: row.isOnVacation,
            }))
          );
        }
      } catch (e) {
        console.warn('[TaskForm] picker fetch failed', e);
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

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

  // Assignee availability check. Builds a lookup over the already-fetched
  // users collection (keyed by uid and doc id) and resolves one row per
  // selected assignee:
  // - vacation: the user doc carries isOnVacation/vacationMode -> warn loudly.
  // - unknown: a user doc exists but records nothing about availability.
  // - no-record: the uid resolves to no user doc at all.
  // User docs carry no "last known location" field, so everything that is
  // not a vacation flag is treated as unknown and the admin must confirm by
  // hand before assigning.
  const userLookup = React.useMemo(() => {
    const map = new Map<string, DocumentData>();
    (Array.isArray(users) ? users : []).forEach((u: any) => {
      const uidKey = String(u?.uid || u?.id || '');
      if (uidKey && !map.has(uidKey)) map.set(uidKey, u);
      const idKey = String(u?.id || '');
      if (idKey && idKey !== uidKey && !map.has(idKey)) map.set(idKey, u);
    });
    return map;
  }, [users]);

  type AssigneeAvailability = {
    uid: string;
    name: string;
    state: 'vacation' | 'unknown' | 'no-record';
    detail: string;
  };
  const assigneeAvailability: AssigneeAvailability[] = React.useMemo(() => {
    return (values.assigneeIds ?? []).map((uid) => {
      const u = userLookup.get(uid);
      const name = String((u as any)?.displayName || (u as any)?.email || uid);
      if (!u) {
        return {
          uid,
          name,
          state: 'no-record' as const,
          detail: 'No user record found for this assignee. Check the selection before assigning.',
        };
      }
      if ((u as any).isOnVacation || (u as any).vacationMode) {
        const cover = String((u as any).coveringOfficerId || '');
        return {
          uid,
          name,
          state: 'vacation' as const,
          detail: cover
            ? `On approved leave. A covering officer is on record: ${cover}. Do not assign until a cover is arranged.`
            : 'On approved leave. Do not assign until they are back or a cover is arranged.',
        };
      }
      return {
        uid,
        name,
        state: 'unknown' as const,
        detail: 'No approved leave on record for this person. Leave is all this panel knows; it does not confirm availability.',
      };
    });
  }, [userLookup, values.assigneeIds]);

  const riskyAssignees = assigneeAvailability.filter((a) => a.state === 'vacation' || a.state === 'no-record').length;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    // Phase 1 Enhancement: Workflow deadline validation
    if (workflowSteps.length > 0) {
      if (!values.deadline) {
        toast({ title: 'Error', description: 'Overall deadline is required for workflows', variant: 'destructive' });
        return;
      }

      // The 24-hour minimum lead (F1): this rule used to exist only in
      // the page's create handler, invisible here. The missing-items
      // list already shows it; this is the submit-time backstop, using
      // the same shared constant.
      const deadlineMs = new Date(values.deadline).getTime();
      if (!isNaN(deadlineMs) && deadlineMs - Date.now() < WORKFLOW_MIN_DEADLINE_HOURS * 3600_000) {
        toast({
          title: 'Deadline too soon',
          description: `Workflow deadline must be at least ${WORKFLOW_MIN_DEADLINE_HOURS} hours from now, so every step gets a fair slice of time.`,
          variant: 'destructive',
        });
        return;
      }

      // Validate each step has an assignee (primary assigneeId or co-assignees).
      // In edit mode the loaded steps may carry assignees the admin never
      // touched, so these checks only run when steps were actually changed in
      // this session (create mode always checks).
      if (!editMode || stepsDirtyRef.current) {
        const stepsWithoutAssignee = workflowSteps.filter((s, i) => !s.assigneeId && !(s.assigneeIds?.length));
        if (stepsWithoutAssignee.length > 0) {
          toast({
            title: 'Error',
            description: `${stepsWithoutAssignee.length} step(s) are missing assignees. Each step must have an assignee.`,
            variant: 'destructive'
          });
          return;
        }

        // Enforce per-step assignees (primary + co-assignees) are a subset of the main assignees
        const outOfScopeSteps = workflowSteps.filter((s) => {
          const stepAssignees = [s.assigneeId, ...(s.assigneeIds ?? [])].filter(Boolean) as string[];
          return stepAssignees.some((id) => !values.assigneeIds.includes(id));
        });
        if (outOfScopeSteps.length > 0) {
          toast({
            title: 'Error',
            description: `${outOfScopeSteps.length} step(s) are assigned to users who are not task assignees. Add them as assignees or reassign the steps.`,
            variant: 'destructive'
          });
          return;
        }
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

    // Assignment safety gate, narrowed to the actual server rule (F5):
    // POST /api/tasks enforces the availability confirmation ONLY when
    // the task requires on-site presence (with a named location). The
    // old client gate demanded the confirmation for EVERY create with
    // assignees, blocking remote work the server would have accepted.
    if (values.requiresOnSitePresence === true) {
      if (!String(values.locationRequired || '').trim()) {
        toast({
          title: 'Location required',
          description: 'This task must be done in person. Name the exact place (building, room, campus) before assigning.',
          variant: 'destructive',
        });
        return;
      }
      if (values.availabilityConfirmed !== true) {
        toast({
          title: 'Availability not confirmed',
          description: 'On-site work cannot be assigned blind. Confirm each assignee is actually available, then tick the confirmation box.',
          variant: 'destructive',
        });
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const payload: TaskFormValues = {
        ...values,
        // Points policy (F6): an untouched penalty/bonus field files the
        // house default from the shared constant; a deliberate value,
        // including 0, is filed exactly as entered.
        penaltyPoints: typeof values.penaltyPoints === 'number' ? values.penaltyPoints : HOUSE_POINTS_DEFAULTS.penalty,
        workflowBonusPoints: typeof values.workflowBonusPoints === 'number' ? values.workflowBonusPoints : HOUSE_POINTS_DEFAULTS.bonus,
        // normalize empty badge to undefined
        completionBadgeId: values.completionBadgeId ? values.completionBadgeId : undefined,
        // A cleared chapter or reviewer is an explicit null, not an absent
        // value. undefined is dropped by JSON and treated as "leave
        // untouched" by the update path, which is why clearing these fields
        // left the stored value stale.
        chapterId: values.chapterId ? values.chapterId : null,
        reviewerId: values.reviewerId ? values.reviewerId : null,
      };
      // Route to the plan submitter when steps remain, or when steps were
      // removed in this session (covers deleting every step: the server must
      // still delete the removed step docs).
      const removedStepIds = removedStepIdsRef.current;
      const hasPlanActivity =
        (Array.isArray(workflowSteps) && workflowSteps.length > 0) || removedStepIds.length > 0;
      if (hasPlanActivity && typeof onSubmitWithPlan === 'function') {
        await onSubmitWithPlan(payload, workflowSteps, removedStepIds);
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
          const arr = calculateWorkflowDeadlines(finalDeadline, steps);
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
        // Prefer plural assigneeUids from the AI (doer first, co-assignees after),
        // fall back to singular assigneeUid. Keep assigneeId as the primary doer
        // for backward-compatible readers, and store the full set in assigneeIds.
        const rawUids: string[] = Array.isArray(w?.assigneeUids) && w.assigneeUids.length > 0
          ? w.assigneeUids
          : (typeof w?.assigneeUid === 'string' ? [w.assigneeUid] : []);
        const trimmedUids = rawUids
          .map((u: any) => (typeof u === 'string' ? u.trim() : ''))
          .filter((u: string) => u !== '');
        const validUids = trimmedUids.filter((u: string) => validUidSet.has(u));
        const droppedNow = trimmedUids.filter((u: string) => !validUidSet.has(u));
        if (droppedNow.length > 0) droppedUids.push(...droppedNow);
        const uidOk = validUids.length > 0;
        const rawUid = uidOk ? validUids[0] : '';
        return {
          title: String(w?.title || `Step ${i + 1}`),
          description: String(w?.description || ''),
          role: w?.role || undefined,
          assigneeId: uidOk ? rawUid : undefined,
          assigneeIds: uidOk ? validUids : undefined,
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
        // New assignees void any earlier availability confirmation.
        if (applyAiAssignees) { patch.assigneeIds = suggestedUids; patch.availabilityConfirmed = false; }
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
      if (/^Step\s+\d+[.:]/i.test(trimmed)) {
        stepIndex += 1;
        const after = trimmed.replace(/^Step\s+\d+[.:]?\s*/i, '');
        wf.push({ title: deriveStepTitle(after, `Step ${stepIndex}`), description: after || trimmed, id: `wfstep_${Date.now()}_${stepIndex}` });
      }
    }
    const finalDeadline = (() => {
      const val = deadlineInputValue || ''; if (!val) return null; const d = new Date(val); return isNaN(d.getTime()) ? null : d;
    })();
    const withDeadlines = (base: WorkflowStep[]) => {
      if (!finalDeadline || base.length === 0) return base;
      try {
        const arr = calculateWorkflowDeadlines(finalDeadline, base);
        return base.map((s, i) => ({ ...s, individualDeadlineIso: toDatetimeLocal(new Date(arr[i]).toISOString()) }));
      } catch { return base; }
    };
    if (!wf.length && values.description?.trim()) {
      const fallback = lines.filter((l) => l.trim().length).map((l, i) => ({ title: deriveStepTitle(l, `Step ${i + 1}`), description: l.trim(), id: `wfstep_${Date.now()}_${i}` }));
      setWorkflowSteps(withDeadlines(fallback));
    } else {
      setWorkflowSteps(withDeadlines(wf));
    }
    setAiMessage(`Workflow parsed with ${wf.length || lines.filter((l) => l.trim().length).length} step(s).`);
    setPlanGenerated(true);
  }, [values.description]);

  // F1: the submit button's conditions, as a visible list. The button
  // disables on exactly these items, so what is missing is never a
  // guessing game (audit P1: the button "may be disabled for reasons
  // that never appear on screen"). Explicit checks, not falsiness:
  // a deliberate 0 in a points field is a real value.
  const missingItems: string[] = [];
  if (!values.title.trim()) missingItems.push('Title');
  if (!values.description.trim()) missingItems.push('Description');
  if (typeof values.points !== 'number') missingItems.push('Base points');
  if (!values.deadline) missingItems.push('Deadline');
  if (workflowSteps.length > 0) {
    workflowSteps.forEach((s, i) => {
      if (!s.title?.trim()) missingItems.push(`Step ${i + 1} title`);
      if (!s.assigneeId && !(s.assigneeIds?.length)) missingItems.push(`Step ${i + 1} assignee`);
    });
    if (values.deadline) {
      const dl = new Date(values.deadline).getTime();
      if (!isNaN(dl) && dl - Date.now() < WORKFLOW_MIN_DEADLINE_HOURS * 3600_000) {
        missingItems.push(`Workflow deadline at least ${WORKFLOW_MIN_DEADLINE_HOURS} hours from now`);
      }
    }
  }
  if (values.requiresOnSitePresence === true) {
    if (!String(values.locationRequired || '').trim()) missingItems.push('On-site location');
    if (!editMode && values.availabilityConfirmed !== true) {
      missingItems.push('Availability confirmation (required for in-person tasks)');
    }
  }
  const houseDefaultsApply =
    typeof values.penaltyPoints !== 'number' || typeof values.workflowBonusPoints !== 'number';

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
              onChange={(e) => setValues((v) => ({ ...v, penaltyPoints: e.target.value === '' ? undefined : Number(e.target.value) }))}
              placeholder={`House default: ${HOUSE_POINTS_DEFAULTS.penalty}`}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-bonus" className="text-xs font-bold uppercase tracking-wider text-emerald-500">Workflow Bonus</Label>
            <Input
              id="task-bonus"
              type="number"
              className="h-9 border-emerald-500/20"
              value={typeof (values as any).workflowBonusPoints === 'number' ? (values as any).workflowBonusPoints : ''}
              onChange={(e) => setValues((v) => ({ ...v, workflowBonusPoints: e.target.value === '' ? undefined : Number(e.target.value) }))}
              placeholder={`House default: ${HOUSE_POINTS_DEFAULTS.bonus}`}
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
            {planGenerated ? 'Steps Parsed ✓' : 'Parse steps from description'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Plain text parsing, not AI: one step per description line that starts with “Step 1:”, “Step 2:”, and so on (a period works too, as in “Step 1.”).
        </p>
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
        <Label className="text-sm mt-2" htmlFor="task-guidance-estimated">Estimated Time (minutes)</Label>
        <Input
          id="task-guidance-estimated"
          type="number"
          min={0}
          value={typeof (values as any).guidance?.estimatedTime === 'number' ? (values as any).guidance.estimatedTime : ''}
          onChange={(e) => setValues((v) => ({
            ...v,
            guidance: {
              ...(v as any).guidance,
              description: (v as any).guidance?.description || '',
              steps: (v as any).guidance?.steps || [],
              estimatedTime: e.target.value === '' ? undefined : Number(e.target.value),
            }
          }))}
          placeholder="e.g. 120"
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

      {/* Admin resolution note: recorded when the task is approved/completed */}
      {(values.status === 'completed' || values.status === 'approved') && (
        <div className="grid gap-2">
          <Label htmlFor="task-resolution-note">Admin resolution note</Label>
          <Textarea
            id="task-resolution-note"
            rows={3}
            maxLength={2000}
            placeholder="What was decided, and why. Stored with the approval record."
            value={(values as any).resolutionNote ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, resolutionNote: e.target.value }))}
          />
          <div className="text-xs text-muted-foreground">Saved with the approval stamps when you submit.</div>
        </div>
      )}

      {/* Final Workflow Deadline */}
      <div className="grid gap-2">
        <Label htmlFor="task-deadline">Deadline *</Label>
        <Input
          id="task-deadline"
          type="datetime-local"
          value={deadlineInputValue}
          min={workflowSteps.length > 0 ? toDatetimeLocal(new Date(Date.now() + WORKFLOW_MIN_DEADLINE_HOURS * 3600_000).toISOString()) : undefined}
          onChange={(e) => { dirtyFieldsRef.current.add('deadline'); setDeadlineInputValue(e.target.value); }}
          placeholder="Select deadline"
        />
        {workflowSteps.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Workflow deadlines must be at least {WORKFLOW_MIN_DEADLINE_HOURS} hours from now, so every step gets a fair slice of time.
          </p>
        )}
      </div>

      {/* Assignees via MultiSelectUserCombobox */}
      <div className="grid gap-2">
        <Label>Assignees</Label>
        <MultiSelectUserCombobox
          value={values.assigneeIds}
          onChange={handleAssigneeChange}
          label="Select assignees"
          chapterId={chapterSelectValue !== 'none' ? chapterSelectValue : undefined}
          canonicalLabels
        />
        <div className="text-xs text-muted-foreground">{values.assigneeIds.length} user(s) selected</div>
        {values.assigneeIds.length > 0 && (
          <div className="rounded-md border p-3 grid gap-2 bg-muted/20">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Leave status
            </div>
            <div className="text-xs text-muted-foreground">
              Shows approved leave only. No leave recorded does not mean a person is available; availability is what the confirmation box below is for.
            </div>
            {usersLoading ? (
              <div className="text-xs text-muted-foreground">Loading leave data...</div>
            ) : (
              assigneeAvailability.map((a) => (
                <div
                  key={a.uid}
                  className={
                    a.state === 'vacation'
                      ? 'rounded border border-red-500/40 bg-red-500/10 p-2'
                      : a.state === 'no-record'
                        ? 'rounded border border-amber-500/40 bg-amber-500/10 p-2'
                        : 'rounded border border-slate-500/30 bg-slate-500/10 p-2'
                  }
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{a.name}</span>
                    <span
                      className={
                        a.state === 'vacation'
                          ? 'text-[10px] font-bold uppercase tracking-wider text-red-500'
                          : a.state === 'no-record'
                            ? 'text-[10px] font-bold uppercase tracking-wider text-amber-500'
                            : 'text-[10px] font-bold uppercase tracking-wider text-slate-400'
                      }
                    >
                      {a.state === 'vacation' ? 'On approved leave' : a.state === 'no-record' ? 'No record' : 'No leave recorded'}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{a.detail}</div>
                </div>
              ))
            )}
            {riskyAssignees > 0 && (
              <div className="text-xs text-red-400 font-medium">
                {riskyAssignees} of {assigneeAvailability.length} assignee(s) need attention before you assign.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Assignment Safety: on-site flag + explicit availability confirmation */}
      <div className="grid gap-3 border rounded-md p-3">
        <Label className="text-base font-semibold">Assignment Safety</Label>
        <div className="flex items-start gap-2">
          <Checkbox
            id="task-requires-on-site"
            checked={values.requiresOnSitePresence === true}
            onCheckedChange={(checked) => {
              const on = checked === true;
              setValues((v) => ({
                ...v,
                requiresOnSitePresence: on,
                // Clearing the on-site flag drops the location; unchecking must
                // also void the confirmation so the admin re-confirms the change.
                ...(on ? {} : { locationRequired: '' }),
                availabilityConfirmed: false,
              }));
            }}
          />
          <div className="grid gap-1">
            <Label htmlFor="task-requires-on-site" className="font-medium cursor-pointer">
              This task must be done in person
            </Label>
            <p className="text-xs text-muted-foreground">
              Tick this only for field work that needs someone physically on site, like campus visits, booth duty, or in-person deliveries.
            </p>
          </div>
        </div>
        {values.requiresOnSitePresence === true && (
          <div className="grid gap-1.5">
            <Label htmlFor="task-location-required">Where exactly? *</Label>
            <Input
              id="task-location-required"
              value={values.locationRequired ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, locationRequired: e.target.value }))}
              placeholder="e.g. IST BIC Room 131, Islamabad campus"
            />
            <p className="text-xs text-muted-foreground">
              Required for in-person tasks. Be specific: building, room, campus.
            </p>
          </div>
        )}
        <div className="flex items-start gap-2">
          <Checkbox
            id="task-availability-confirmed"
            checked={values.availabilityConfirmed === true}
            disabled={values.assigneeIds.length === 0}
            onCheckedChange={(checked) => setValues((v) => ({ ...v, availabilityConfirmed: checked === true }))}
          />
          <div className="grid gap-1">
            <Label htmlFor="task-availability-confirmed" className="font-medium cursor-pointer">
              I checked that every assignee is available for this task
            </Label>
            <p className="text-xs text-muted-foreground">
              {values.requiresOnSitePresence === true
                ? 'Required for in-person tasks. Confirm with each person that they can do the work on time, and that they will be on site.'
                : 'Tick this once you have checked with each person. Optional for remote tasks; required for in-person ones.'}
            </p>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="task-availability-note">Availability note (optional)</Label>
          <Input
            id="task-availability-note"
            value={values.availabilityNote ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, availabilityNote: e.target.value }))}
            placeholder="e.g. Confirmed with each assignee on WhatsApp today"
          />
        </div>
      </div>

      {/* Reviewer (optional): user who verifies the completed task */}
      <div className="grid gap-2">
        <Label>Reviewer (optional)</Label>
        <div onMouseDownCapture={(e) => e.stopPropagation()}>
          <UserSelectionCombobox
            selectedUid={values.reviewerId || null}
            onSelect={(uid) => setValues((v) => ({ ...v, reviewerId: uid }))}
            placeholder="Select a reviewer"
            chapterId={chapterSelectValue !== 'none' ? chapterSelectValue : undefined}
            showAllToggle={false}
            filterFn={isReviewerEligible}
            canonicalLabels
          />
        </div>
        {values.reviewerId && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline w-fit"
            onClick={() => setValues((v) => ({ ...v, reviewerId: "" }))}
          >
            Clear reviewer
          </button>
        )}
      </div>
      <div className="grid gap-2 border rounded-md p-3">
        <Label>Workflow Plan (optional)</Label>
        {workflowSteps.length === 0 ? (
          <div className="grid gap-2">
            <div className="text-sm text-muted-foreground">Parse steps from the description, generate them with AI, or add the first step yourself. Assign a user for each step, then click Create Task.</div>
            <div>
              <Button type="button" variant="secondary" onClick={addStep}>Add first step</Button>
            </div>
          </div>
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
                          className="text-sm min-h-[96px] resize-y"
                          rows={4}
                        />
                      </div>
                      {/* Editable Step Role */}
                      <div className="grid gap-1">
                        <Label className="text-xs" htmlFor={`step-role-${idx}`}>Role</Label>
                        <StepRolePicker
                          id={`step-role-${idx}`}
                          value={step.role || ''}
                          chapterId={chapterSelectValue !== 'none' ? chapterSelectValue : undefined}
                          onChange={(nextRole) => {
                            stepsDirtyRef.current = true;
                            setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, role: nextRole } : s));
                          }}
                        />
                      </div>
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
                            const deadlines = calculateWorkflowDeadlines(finalDeadline, workflowSteps);
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
                      <div className="grid gap-1">
                        <Label className="text-xs" htmlFor={`step-duration-${idx}`}>Estimated Duration (minutes, optional)</Label>
                        <Input
                          id={`step-duration-${idx}`}
                          type="number"
                          min={1}
                          value={step.estimatedDuration ?? ''}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const parsed = raw === '' ? undefined : Number(raw);
                            stepsDirtyRef.current = true;
                            setWorkflowSteps((prev) => prev.map((s, i) => i === idx
                              ? { ...s, estimatedDuration: typeof parsed === 'number' && isFinite(parsed) && parsed > 0 ? parsed : undefined }
                              : s));
                          }}
                          placeholder="Weights this step's deadline when set"
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex items-start gap-2" onMouseDownCapture={(e) => e.stopPropagation()}>
                        <Checkbox
                          id={`step-limiting-${idx}`}
                          checked={Boolean(step.isLimitingStep)}
                          onCheckedChange={(checked) => {
                            const on = checked === true;
                            stepsDirtyRef.current = true;
                            // One limiting step per workflow: checking this
                            // step clears the flag on every other step.
                            setWorkflowSteps((prev) => prev.map((s, i) => {
                              if (i === idx) return { ...s, isLimitingStep: on };
                              return on && s.isLimitingStep ? { ...s, isLimitingStep: false } : s;
                            }));
                          }}
                        />
                        <Label htmlFor={`step-limiting-${idx}`} className="text-xs font-medium cursor-pointer">
                          Limiting step (bottleneck: scheduled around its duration)
                        </Label>
                      </div>
                      <div className="grid gap-1" onMouseDownCapture={(e) => e.stopPropagation()}>
                        <Label className="text-xs">Assignee</Label>
                        <UserSelectionCombobox
                          selectedUid={step.assigneeId || null}
                          onSelect={handleWorkflowStepAssigneeChange(idx)}
                          placeholder="Select a user"
                          preferredRole={step.role}
                          preferredRoleLabel={stepRoleFilterLabel(step.role)}
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
                        <Label className="text-xs">Co-assignees (optional)</Label>
                        <MultiSelectUserCombobox
                          value={step.assigneeIds || []}
                          onChange={(uids) => {
                            stepsDirtyRef.current = true;
                            setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, assigneeIds: uids } : s));
                            // The assignee set changed, so void the task-level availability confirmation.
                            setValues((v) => ({ ...v, availabilityConfirmed: false }));
                          }}
                          label="Select co-assignees"
                          placeholder="Search co-assignees by name, email, or role..."
                          chapterId={chapterSelectValue !== 'none' ? chapterSelectValue : undefined}
                          canonicalLabels
                        />
                      </div>

                      {/* Per-step assignment safety: on-site flag, location, availability */}
                      <div className="grid gap-2 border-t pt-2 mt-1">
                        <div className="flex items-start gap-2" onMouseDownCapture={(e) => e.stopPropagation()}>
                          <Checkbox
                            id={`step-on-site-${idx}`}
                            checked={step.locationRequirement === 'on-site'}
                            onCheckedChange={(checked) => {
                              const on = checked === true;
                              stepsDirtyRef.current = true;
                              setWorkflowSteps((prev) => prev.map((s, i) => i === idx
                                ? { ...s, locationRequirement: on ? 'on-site' : 'either', ...(on ? {} : { locationNote: undefined }) }
                                : s));
                              setValues((v) => ({ ...v, availabilityConfirmed: false }));
                            }}
                          />
                          <Label htmlFor={`step-on-site-${idx}`} className="text-xs font-medium cursor-pointer">
                            This step must be done on-site
                          </Label>
                        </div>
                        {step.locationRequirement === 'on-site' && (
                          <div className="grid gap-1">
                            <Label className="text-xs" htmlFor={`step-location-${idx}`}>On-site location</Label>
                            <Input
                              id={`step-location-${idx}`}
                              value={step.locationNote || ''}
                              onMouseDown={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                stepsDirtyRef.current = true;
                                setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, locationNote: e.target.value } : s));
                              }}
                              placeholder="e.g. IST BIC Room 131"
                              className="h-8 text-sm"
                            />
                          </div>
                        )}
                        <div className="grid gap-1" onMouseDownCapture={(e) => e.stopPropagation()}>
                          <Label className="text-xs">Assignee availability for this step</Label>
                          <Select
                            value={step.availabilityStatus || 'unknown'}
                            onValueChange={(val: 'confirmed' | 'unknown' | 'unavailable') => {
                              stepsDirtyRef.current = true;
                              setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, availabilityStatus: val } : s));
                              setValues((v) => ({ ...v, availabilityConfirmed: false }));
                            }}
                          >
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue placeholder="Unknown" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="unknown">Unknown (not yet checked)</SelectItem>
                              <SelectItem value="confirmed">Confirmed available</SelectItem>
                              <SelectItem value="unavailable">Not available</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
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
                      <div className="grid gap-1">
                        <Label className="text-xs" htmlFor={`step-points-${idx}`}>Points</Label>
                        <Input
                          id={`step-points-${idx}`}
                          type="number"
                          min={0}
                          value={typeof step.points === 'number' ? step.points : ''}
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const val = e.target.value === '' ? undefined : Number(e.target.value);
                            stepsDirtyRef.current = true;
                            setWorkflowSteps((prev) => prev.map((s, i) => i === idx ? { ...s, points: val } : s));
                          }}
                          placeholder="e.g. 25"
                          className="h-8 text-sm"
                        />
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

      {/* Still needed (F1): the exact list the submit button checks. */}
      {(missingItems.length > 0 || houseDefaultsApply) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 grid gap-1" aria-live="polite">
          {missingItems.length > 0 && (
            <>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Still needed before you can create
              </div>
              <ul className="list-disc pl-5 text-sm">
                {missingItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {houseDefaultsApply && (
            <div className="text-xs text-muted-foreground">
              Points defaults: untouched penalty/bonus fields file the house defaults
              (penalty {HOUSE_POINTS_DEFAULTS.penalty}, bonus {HOUSE_POINTS_DEFAULTS.bonus}).
              Type 0 for no penalty or no bonus.
            </div>
          )}
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
          disabled={isSubmitting || missingItems.length > 0}
          title={missingItems.length > 0 ? `Still needed: ${missingItems.join(', ')}` : undefined}
        >
          {isSubmitting && <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          {submitLabel}
        </Button>
      </div>
    </form >
  );
}

export default TaskForm;

// Drag listeners live ONLY on the grip handle (audit P4): the whole
// card used to carry them, so drags started from any control inside
// the step (inputs, selects, buttons) on an 8px move.
const StepDragHandleContext = React.createContext<{ attributes?: any; listeners?: any }>({});

function GripHandle() {
  const { attributes, listeners } = React.useContext(StepDragHandleContext);
  return (
    <span
      {...attributes}
      {...listeners}
      role="button"
      aria-label="Drag to reorder step"
      className="cursor-grab touch-none inline-flex"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" className="opacity-60">
        <circle cx="9" cy="6" r="1.5" />
        <circle cx="15" cy="6" r="1.5" />
        <circle cx="9" cy="12" r="1.5" />
        <circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="18" r="1.5" />
        <circle cx="15" cy="18" r="1.5" />
      </svg>
    </span>
  );
}

function SortableStepCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  } as React.CSSProperties;
  return (
    <div ref={setNodeRef} style={style}>
      <StepDragHandleContext.Provider value={{ attributes, listeners }}>
        {children}
      </StepDragHandleContext.Provider>
    </div>
  );
}
