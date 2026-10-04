/**
 * Task management CRUD operations for SEDS Pakistan website
 */

import { collection, doc, getDoc, getDocs, query, where, Timestamp, increment } from 'firebase/firestore';
;
import { Firestore } from 'firebase/firestore';
;
import { Task, TaskStatus } from './task-types';
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';


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
 */
export async function getAllTasks(
  firestore: Firestore
): Promise<Task[]> {
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
