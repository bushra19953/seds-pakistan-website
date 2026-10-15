"use client";

import * as React from "react";
import { useEffect } from "react";

/**
 * PostVacationSummaryModal
 *
 * Presentational modal shown ONLY after a successful return from leave.
 * It is driven entirely by props from its parent. It does not read
 * Firestore, does not call any API, and does not auto-detect a return
 * on page load. The parent decides when to open it, normally right
 * after POST /api/user/post-vacation succeeds.
 *
 * When `open` is false, this renders nothing.
 * When `open` is true, this renders the modal.
 */
export interface PostVacationSummaryModalProps {
  /** Controls visibility. Parent sets this to true only after a successful return. */
  open: boolean;
  /** Number of redirected tasks restored back to the returning member. */
  restoredCount: number;
  /** Number of held tasks cleared (leaveHold removed) on return. */
  heldClearedCount: number;
  /** Called when the user closes the modal (Close button, backdrop, or Escape). */
  onClose: () => void;
}

function taskWord(count: number): string {
  return count === 1 ? "task" : "tasks";
}

export function PostVacationSummaryModal({
  open,
  restoredCount,
  heldClearedCount,
  onClose,
}: PostVacationSummaryModalProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const safeRestoredCount = Math.max(0, Math.floor(restoredCount));
  const safeHeldClearedCount = Math.max(0, Math.floor(heldClearedCount));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      data-testid="post-vacation-summary-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="post-vacation-summary-title"
        className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="post-vacation-summary-title"
          className="text-lg font-semibold"
        >
          Welcome back
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your work is back. Your leave is closed and your tasks are yours
          again.
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          <li>
            <span className="font-medium">{safeRestoredCount}</span>{" "}
            {taskWord(safeRestoredCount)} restored to you.
          </li>
          <li>
            <span className="font-medium">{safeHeldClearedCount}</span>{" "}
            held {taskWord(safeHeldClearedCount)} cleared.
          </li>
        </ul>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default PostVacationSummaryModal;
