/**
 * Instruction retention policy for SEDS Pakistan.
 *
 * Instruction briefs must never be auto-deleted or lost while the task they
 * belong to is incomplete (unlike WhatsApp disappearing messages, briefs stay
 * until the work is done). This module is pure policy: it decides what is
 * protected, what may be archived, and how version history is read. It has no
 * Firestore calls and no side effects; callers apply the returned decisions
 * through their own storage layer.
 */

import type { TaskStatus } from './task-types';

/** A task status including the cancelled terminal state. */
export type TaskLifecycleStatus = TaskStatus | 'cancelled';

/**
 * One saved revision of a task's instruction brief. The latest revision is
 * the one the assignee works from; older revisions are kept as history.
 */
export interface InstructionVersion {
  /** 1-based, monotonically increasing within the task. */
  version: number;
  /** The full brief text for this revision. */
  body: string;
  /** When this revision was published. */
  createdAt: Date;
  /** UID of the person who published the revision. */
  createdBy?: string;
  /** True for the revision the assignee is currently working from. */
  isCurrent: boolean;
}

/**
 * True when the brief for a task must be retained and never auto-deleted or
 * auto-archived. Briefs are protected for every task that is not finished:
 * only tasks in a terminal state (completed or cancelled) release the hold.
 */
export function isInstructionProtected(taskStatus: TaskLifecycleStatus): boolean {
  return taskStatus !== 'completed' && taskStatus !== 'cancelled';
}

/**
 * Input for pruneEligibleInstructions.
 */
export interface PruneEligibleInput {
  taskStatus: TaskLifecycleStatus;
  /** All known revisions of the brief, in any order. */
  versions: readonly InstructionVersion[];
}

/**
 * Returns the revisions that may be archived to cheaper storage.
 *
 * Rules:
 * - The current version of an incomplete task is NEVER eligible; it is what
 *   the assignee works from and is protected by isInstructionProtected.
 * - Older, superseded revisions of an incomplete task ARE eligible for
 *   archiving (history is preserved, not deleted).
 * - Once the task is complete or cancelled, every revision, including the
 *   current one, may be archived. Nothing is deleted by this function;
 *   archiving keeps the record, it just moves it out of the hot path.
 *
 * Returns eligible revisions ordered oldest-first by version number.
 */
export function pruneEligibleInstructions(input: PruneEligibleInput): InstructionVersion[] {
  const versions = [...input.versions];
  const protectedStatus = isInstructionProtected(input.taskStatus);
  const eligible = versions.filter(
    (v) => !protectedStatus || !v.isCurrent
  );
  eligible.sort((a, b) => a.version - b.version);
  return eligible;
}

/**
 * The revision the assignee is currently working from, or undefined when the
 * task has no brief revisions at all.
 */
export function getCurrentInstructionVersion(
  versions: readonly InstructionVersion[]
): InstructionVersion | undefined {
  return versions.find((v) => v.isCurrent);
}

/**
 * A specific revision by its version number, or undefined when absent.
 */
export function getInstructionVersion(
  versions: readonly InstructionVersion[],
  version: number
): InstructionVersion | undefined {
  return versions.find((v) => v.version === version);
}

/**
 * The next version number to assign when publishing a new revision: one more
 * than the highest existing version, or 1 when there are none.
 */
export function getNextInstructionVersionNumber(
  versions: readonly InstructionVersion[]
): number {
  let max = 0;
  for (const v of versions) {
    if (Number.isFinite(v.version) && v.version > max) max = v.version;
  }
  return max + 1;
}

/**
 * All revisions ordered oldest-first by version number, without mutating the
 * input.
 */
export function sortInstructionVersionsChronologically(
  versions: readonly InstructionVersion[]
): InstructionVersion[] {
  return [...versions].sort((a, b) => a.version - b.version);
}

/**
 * Superseded revisions: every revision that is not the current one,
 * oldest-first. Empty when the task has a single current revision or none.
 */
export function getSupersededInstructionVersions(
  versions: readonly InstructionVersion[]
): InstructionVersion[] {
  return sortInstructionVersionsChronologically(versions.filter((v) => !v.isCurrent));
}

/**
 * Builds the next revision object for a new brief publication. The previous
 * current revision is left untouched in the input; callers flip its isCurrent
 * flag in their own storage write.
 */
export function buildNextInstructionVersion(params: {
  body: string;
  createdBy: string;
  existingVersions: readonly InstructionVersion[];
}): InstructionVersion {
  return {
    version: getNextInstructionVersionNumber(params.existingVersions),
    body: params.body,
    createdAt: new Date(),
    createdBy: params.createdBy,
    isCurrent: true,
  };
}
