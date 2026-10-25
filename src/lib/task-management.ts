/**
 * Task management CRUD operations for SEDS Pakistan website
 */

import { collection, doc, getDoc, getDocs, query, where, Timestamp, increment } from 'firebase/firestore';
;
import { Firestore } from 'firebase/firestore';
;
import { Task, TaskStatus } from './task-types';
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';
import { getAuth } from 'firebase/auth';

/**
 * Supabase migration (tasks cluster, group 3): the data-fetching helpers
 * below first try their seam-backed server endpoints
 * (GET /api/tasks/all, GET /api/tasks/by-user), which serve Supabase reads
 * through src/lib/supa/seam-admin-tasks.ts when the 'tasks' surface flag
 * is ON. This file is a CLIENT module: it holds no adapter reference and
 * no Supabase credentials.
 *
 * While the flag is OFF the endpoints answer 404 and every helper falls
 * back to the exact Firestore code path below — same queries, same
 * shapes. Any endpoint error, non-OK response, or missing signed-in
 * user also falls back silently.
 */
const TASK_TIMESTAMP_FIELDS = [
  'createdAt', 'updatedAt', 'deadline', 'individualDeadline',
  'completedAt', 'submittedAt', 'approvedAt', 'rejectedAt',
  'acceptedAt', 'startedAt', 'availabilityConfirmedAt',
] as const;

function reviveApiTask(raw: any): Task {
  const out: any = { ...raw };
  // The seam endpoint serializes Firestore Timestamps as ISO strings;
  // revive them as Dates so consumers see a native date type (the
  // Firestore path returns Timestamp objects — see the timestamp census
  // in supa-rebase-notes/tasks-3.md).
  for (const field of TASK_TIMESTAMP_FIELDS) {
    if (typeof out[field] === 'string') {
      const d = new Date(out[field]);
      if (!Number.isNaN(d.getTime())) out[field] = d;
    }
  }
  return out as Task;
}

async function fetchTasksViaApi(path: string): Promise<Task[] | null> {
  try {
    const currentUser = getAuth().currentUser;
    if (!currentUser) return null;
    const token = await currentUser.getIdToken();
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (!Array.isArray(json?.tasks)) return null;
    return json.tasks.map(reviveApiTask);
  } catch {
    return null;
  }
}


/**
 * Create a new task
 */
export async function createTask(
  firestore: Firestore,
  taskData: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const tasksRef = collection(firestore, 'tasks');
  const docRef = await addDoc(tasksRef, {
    ...taskData,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now()
  });
  return docRef.id;
}

/**
 * Get a single task by ID
 */
export async function getTask(
  firestore: Firestore,
  taskId: string
): Promise<Task | null> {
  const taskRef = doc(firestore, 'tasks', taskId);
  const taskSnap = await getDoc(taskRef);
  
  if (!taskSnap.exists()) {
    return null;
  }
  
  return {
    id: taskSnap.id,
    ...taskSnap.data()
  } as Task;
}

/**
 * Get all tasks
 *
 * BOUNDEDNESS (supa migration, group 3): today's Firestore path is an
 * UNBOUNDED full-collection getDocs — preserved unchanged as the
 * fallback. The optional `limit` is accepted and forwarded to the
 * seam-backed endpoint (which is bounded server-side) when supplied;
 * existing callers that pass nothing keep today's call semantics on the
 * Firestore path. Flagged as a boundedness risk in
 * supa-rebase-notes/tasks-3.md for the merge planner.
 */
export async function getAllTasks(
  firestore: Firestore,
  options?: { limit?: number }
): Promise<Task[]> {
  const viaApi = await fetchTasksViaApi(
    options?.limit ? `/api/tasks/all?limit=${Math.floor(options.limit)}` : '/api/tasks/all'
  );
  if (viaApi) return viaApi;

  const tasksRef = collection(firestore, 'tasks');
  const snapshot = await getDocs(tasksRef);

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })) as Task[];
}

/**
 * Update an existing task
 * Note: Points and badge awarding are handled server-side via the /api/tasks endpoint
 * upon admin-approved completion. This client helper applies document updates only.
 */
export async function updateTask(
  firestore: Firestore,
  taskId: string,
  updates: Partial<Omit<Task, 'id' | 'createdAt'>>
): Promise<void> {
  const taskRef = doc(firestore, 'tasks', taskId);
  // Normalize status to supported values; map legacy 'overdue' to 'in-progress'
  const safeUpdates: any = { ...updates };
  if (typeof safeUpdates.status === 'string') {
    const s = String(safeUpdates.status).toLowerCase();
    const allowed: TaskStatus[] = ['pending', 'in-progress', 'submitted-for-review', 'completed'];
    safeUpdates.status = (allowed as string[]).includes(s) ? s : 'in-progress';
  }

  // Update the task document (no awarding here)
  await updateDoc(taskRef, {
    ...safeUpdates,
    updatedAt: Timestamp.now()
  });
  // Important: Use the authenticated API PATCH to mark tasks as 'completed' so
  // the server can award points and badges atomically and securely.
}

/**
 * Delete a task
 */
export async function deleteTask(
  firestore: Firestore,
  taskId: string
): Promise<void> {
  const taskRef = doc(firestore, 'tasks', taskId);
  await deleteDoc(taskRef);
}

/**
 * Get tasks assigned to a specific user
 */
export async function getUserTasks(
  firestore: Firestore,
  userId: string
): Promise<Task[]> {
  const viaApi = await fetchTasksViaApi(
    `/api/tasks/by-user?userId=${encodeURIComponent(userId)}&mode=assigned`
  );
  if (viaApi) return viaApi;

  const tasksRef = collection(firestore, 'tasks');
  // Union both assignment forms so array-form co-assignees see their tasks.
  const [s1, s2] = await Promise.all([
    getDocs(query(tasksRef, where('assigneeId', '==', userId))),
    getDocs(query(tasksRef, where('assigneeIds', 'array-contains', userId))),
  ]);
  const seen = new Set<string>();
  return [...s1.docs, ...s2.docs]
    .filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; })
    .map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Task[];
}

/**
 * Get tasks created by a specific user
 */
export async function getTasksCreatedBy(
  firestore: Firestore,
  userId: string
): Promise<Task[]> {
  const viaApi = await fetchTasksViaApi(
    `/api/tasks/by-user?userId=${encodeURIComponent(userId)}&mode=created`
  );
  if (viaApi) return viaApi;

  const tasksRef = collection(firestore, 'tasks');
  const q = query(tasksRef, where('assignerId', '==', userId));
  const snapshot = await getDocs(q);
  
  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })) as Task[];
}

/**
 * Calculate workflow deadlines with intelligent distribution
 * Phase 1 Enhancement: Intelligent deadline calculation with proper validation
 */
export interface WorkflowDeadlineCalculation {
  isValid: boolean;
  error?: string;
  individualDeadlines?: Date[]; // Optional for error cases
  totalBufferTime?: number; // Optional for error cases
  perStepTime?: number; // Optional for error cases
  warnings?: string[];
}

export function calculateWorkflowDeadlines(
  finalDeadline: Date,
  stepCount: number,
  options?: {
    minBufferPercentage?: number; // Minimum buffer as percentage of total time
    minTimePerStep?: number; // Minimum time per step in milliseconds
    bufferDistribution?: 'even' | 'front-loaded' | 'back-loaded';
  }
): WorkflowDeadlineCalculation {
  const now = new Date();
  const {
    minBufferPercentage = 0.1, // 10% buffer by default
    minTimePerStep = 60 * 60 * 1000, // 1 hour minimum per step
    bufferDistribution = 'even'
  } = options || {};

  // Validation checks
  if (finalDeadline <= now) {
    return {
      isValid: false,
      error: 'Final deadline must be set to a future date.'
    };
  }

  if (stepCount <= 0) {
    return {
      isValid: false,
      error: 'Workflow must have at least one step.'
    };
  }

  const totalTime = finalDeadline.getTime() - now.getTime();
  const minBufferTime = Math.floor(totalTime * minBufferPercentage);
  const workingTime = totalTime - minBufferTime;

  if (workingTime <= 0) {
    return {
      isValid: false,
      error: 'Insufficient time allocated. Please extend the deadline or reduce the number of steps.'
    };
  }

  const baseTimePerStep = Math.floor(workingTime / stepCount);

  if (baseTimePerStep < minTimePerStep) {
    const minDeadline = new Date(now.getTime() + (minTimePerStep * stepCount) / (1 - minBufferPercentage));
    return {
      isValid: false,
      error: `Each step would have less than ${Math.floor(minTimePerStep / (60 * 1000))} minutes. Minimum deadline should be: ${minDeadline.toLocaleDateString()} ${minDeadline.toLocaleTimeString()}`,
    };
  }

  // Calculate individual deadlines with buffer distribution
  const individualDeadlines: Date[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < stepCount; i++) {
    let stepTime: number;

    switch (bufferDistribution) {
      case 'front-loaded':
        // Front-load work with more time at the beginning
        const frontLoadedFactor = 1 - (i / stepCount) * 0.4; // Decreasing factor
        stepTime = baseTimePerStep * frontLoadedFactor;
        if (i > stepCount * 0.6) {
          warnings.push(`Step ${i + 1} has reduced time allocation due to front-loaded distribution.`);
        }
        break;
      
      case 'back-loaded':
        // Back-load work with more time at the end
        const backLoadedFactor = 0.6 + (i / stepCount) * 0.4; // Increasing factor
        stepTime = baseTimePerStep * backLoadedFactor;
        warnings.push(`Step ${i + 1} has increased time allocation due to back-loaded distribution.`);
        break;
      
      default: // 'even'
        stepTime = baseTimePerStep;
        break;
    }

    // Add cumulative time with buffer consideration
    const cumulativeTime = stepTime * (i + 1);
    const bufferTime = Math.floor(minBufferTime * (i + 1) / stepCount);
    const totalStepTime = cumulativeTime + bufferTime;
    
    individualDeadlines.push(new Date(now.getTime() + totalStepTime));
  }

  // Add warning for very short deadlines
  if (totalTime < 24 * 60 * 60 * 1000) { // Less than 24 hours
    warnings.push('Workflow deadline is less than 24 hours. Consider allowing more time for coordination.');
  }

  // Add warning for many steps
  if (stepCount > 10) {
    warnings.push(`Large number of steps (${stepCount}). Consider breaking this into smaller workflows.`);
  }

  return {
    isValid: true,
    individualDeadlines,
    totalBufferTime: minBufferTime,
    perStepTime: baseTimePerStep,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Record an assignee's availability confirmation on a task document.
 * Writes a nested confirmation payload plus a top-level timestamp for cheap
 * staleness queries, following the same Firestore patterns as the other
 * helpers in this file. The task's availability/location fields are owned by
 * the types worker (C4); this helper only writes the confirmation values it
 * is given and updates updatedAt.
 */
export interface AvailabilityConfirmationInput {
  taskId: string;
  userId: string; // The assignee confirming their availability
  confirmed?: boolean; // Defaults to true when omitted
  note?: string; // Optional note from the assignee
  availableDate?: string; // Optional ISO date string for when they are available
}

export async function recordAvailabilityConfirmation(
  firestore: Firestore,
  input: AvailabilityConfirmationInput
): Promise<void> {
  const taskRef = doc(firestore, 'tasks', input.taskId);
  const confirmed = input.confirmed ?? true;
  const confirmation = {
    confirmed,
    confirmedBy: input.userId,
    confirmedAt: Timestamp.now(),
    ...(input.note ? { note: input.note } : {}),
    ...(input.availableDate ? { availableDate: input.availableDate } : {})
  };
  await updateDoc(taskRef, {
    availabilityConfirmedAt: Timestamp.now(),
    availabilityConfirmation: confirmation,
    updatedAt: Timestamp.now()
  });
}

/**
 * A Firestore Timestamp or a JS Date. Used to read availability fields without
 * depending on the exact Task type shape owned by another worker.
 */
type TimestampLike = Timestamp | Date | string | number | null | undefined;

/**
 * True when the availability confirmation is older than maxAgeDays, or when
 * there is no confirmation at all. A missing timestamp means the availability
 * was never recorded, which is always stale. Pure: no side effects.
 */
export function isAvailabilityStale(
  confirmedAt: TimestampLike,
  maxAgeDays: number
): boolean {
  if (!confirmedAt || maxAgeDays <= 0) {
    return true;
  }
  const confirmedDate: Date =
    confirmedAt instanceof Timestamp
      ? confirmedAt.toDate()
      : confirmedAt instanceof Date
        ? confirmedAt
        : new Date(confirmedAt);
  if (Number.isNaN(confirmedDate.getTime())) {
    return true;
  }
  const ageMs = Date.now() - confirmedDate.getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Minimal structural shape for checking whether a task needs on-site presence.
 * Reads the fields owned by the types worker (C4) defensively: an explicit
 * boolean flag wins, then a normalized location requirement string, then a
 * non-empty venue/location value. Pure: no side effects.
 */
export interface LocationFieldsLike {
  requiresOnSite?: boolean;
  locationRequirement?: string;
  location?: string | null;
  venue?: string | null;
}

export function requiresOnSite(task: LocationFieldsLike): boolean {
  if (task.requiresOnSite === true) {
    return true;
  }
  const requirement = String(task.locationRequirement || '').trim().toLowerCase();
  if (requirement === 'on-site' || requirement === 'onsite' || requirement === 'in-person') {
    return true;
  }
  const venue = String(task.venue || '').trim();
  const location = String(task.location || '').trim();
  if ((venue || location) && requirement !== 'remote' && requirement !== 'online') {
    return true;
  }
  return false;
}
