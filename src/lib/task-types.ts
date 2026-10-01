/**
 * Task management data types for SEDS Pakistan website
 */

export interface Task {
  id: string;
  title: string;
  description: string;
  assignerId: string;
  assigneeId: string;
  // Optional association to a project for counters and dashboards
  projectId?: string | null;
  // Optional workflow metadata for chained multi-role subtasks
  workflowId?: string | null;
  workflowTitle?: string | null;
  workflowParticipantIds?: string[];
  sequenceIndex?: number; // 1-based order within a workflow
  dependsOnTaskId?: string | null; // previous task in the chain
  role?: string | null; // intended role for the assignee
  releasedAt?: Date | null; // when this task becomes available to assignee
  deadline: Date;
  individualDeadline?: Date | null;
  isCurrentStep?: boolean;

  // Phase 3 Enhancement: Enhanced workflow data model
  workflowPriority?: 'low' | 'medium' | 'high' | 'critical'; // Step importance level
  workflowTags?: string[]; // Categorization tags for workflow steps
  estimatedDuration?: number; // Estimated time in minutes for this step
  workflowMetadata?: Record<string, any>; // Extensible metadata for workflow-specific data

  // Sub-task delegation hierarchy
  parentTaskId?: string | null; // Links to parent task for roll-up
  isSubTask?: boolean; // Flag for UI filtering
  subTaskCount?: number; // Cached count of child tasks
  subTaskCompletedCount?: number; // Cached count of completed children

  status: TaskStatus;
  report?: string;
  points: number;
  penaltyPoints?: number; // Points deducted on deadline miss
  hoursWorked?: number; // NEW: tracked hours by assignee
  completedAt?: Date;
  completionBadgeId?: string | null;
  createdAt: Date;
  updatedAt: Date;

  // Delegation: original assignee can delegate work and split their points
  delegation?: TaskDelegation | null;

  // Workflow bonus points (awarded to all participants on completion)
  workflowBonusPoints?: number;

  // Task guidance for assignees
  guidance?: {
    description: string;   // "How to complete this task"
    steps: string[];       // Step-by-step instructions
    estimatedTime?: number; // Estimated minutes to complete
  };

  // NEW: Link-based resources/logistics (No server storage required)
  resources?: {
    type: 'link' | 'drive' | 'github' | 'doc' | 'video' | 'other';
    url: string;
    title: string;
  }[];
}

// Explicit TaskStatus type used across client and server.
// Verification Workflow states:
// - 'pending': Task assigned but not started
// - 'in-progress': Assignee is actively working
// - 'submitted-for-review': Assignee submitted work; awaiting admin verification
// - 'completed': Admin-approved completion
export type TaskStatus = 'pending' | 'in-progress' | 'submitted-for-review' | 'completed' | 'overdue';

// Chat-like mediation messages between assigner and assignee
export interface MediationMessage {
  id?: string;
  taskId: string;
  workflowId?: string | null; // Phase 3: Link messages to workflows for context
  senderId: string; // assigner or assignee
  message: string;
  createdAt: Date;
}

export interface EnhancedMediationMessage {
  id?: string;
  taskId?: string | null;
  workflowId: string;
  senderId: string;
  message: string;
  createdAt: Date | any;
  workflowContext?: {
    workflowTitle?: string | null;
    currentStep?: number | null;
    taskTitle?: string | null;
  } | null;
}

// Phase 3 Enhancement: Workflow-specific data structures
export interface WorkflowProgress {
  workflowId: string;
  totalSteps: number;
  completedSteps: number;
  currentStepIndex: number;
  progressPercentage: number;
  isCompleted: boolean;
  estimatedTimeRemaining?: number; // in minutes
}

export interface WorkflowAnalytics {
  workflowId: string;
  totalDuration: number; // planned duration in minutes
  actualDuration?: number; // actual time taken when completed
  onTimeCompletionRate: number; // percentage
  averageStepDuration: number; // average time per step
  participantCount: number;
  efficiencyScore: number; // 0-100 based on completion time vs estimated
}

export interface WorkflowReassignmentRequest {
  workflowId: string;
  stepIndex: number;
  newAssigneeId: string;
  reason?: string;
  reassignedBy: string; // admin who reassigned
}

/**
 * Task Delegation — Points-as-Currency Model
 *
 * When an assignee delegates a task, they must split their points with the delegatee.
 * The original point allocation is a fixed pie: pointsKept + pointsShared = task.points
 *
 * Rules:
 * - Only the current assignee can delegate
 * - Must share at least 1 point (no free delegation)
 * - Delegatee must accept before the task is "theirs"
 * - Chain delegation is not allowed (delegatee cannot re-delegate)
 * - On completion, points are awarded according to the split
 * - Original assignee retains accountability (shows on their profile too)
 */
export interface TaskDelegation {
  delegatedTo: string;       // UID of person receiving the work
  delegatedToName?: string;  // Display name (denormalized)
  delegatedBy: string;       // UID of original assignee who delegated
  delegatedByName?: string;  // Display name (denormalized)
  pointsKept: number;        // Points retained by the delegator
  pointsShared: number;      // Points given to the delegatee
  reason?: string;           // Why they're delegating
  status: DelegationStatus;
  delegatedAt: Date;
  respondedAt?: Date;        // When delegatee accepted/rejected
}

export type DelegationStatus = 'pending' | 'accepted' | 'rejected';
