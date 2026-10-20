/**
 * Proof submission drawer: pure helpers shared by the member-facing drawer,
 * the admin review surfaces, and their tests.
 *
 * No em dashes anywhere in this file; user-facing text follows the house rule.
 *
 * The state transitions stay server-side and are NOT duplicated here:
 *  - POST /api/tasks/attach-upload reuses shouldAutoTransitionOnProofUpload
 *    (src/lib/server/bug4-proof-guards.ts) to flip pending/in-progress tasks
 *    to submitted-for-review under conservative conditions.
 *  - PATCH /api/tasks stamps submittedBy/submittedAt and fans out to the
 *    validator chain whenever the status moves to submitted-for-review.
 *  - The overdue crons skip tasks with non-empty deliverableFiles
 *    (splitProofSkippedDocs), which is what pauses the overdue SLA while a
 *    submission waits for review.
 */

export const MAX_PROOF_BYTES = 50 * 1024 * 1024;
export const MAX_PROOF_MB = 50;

/** File types the proof drawer accepts: images, PDF documents, videos. */
export const PROOF_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const PROOF_PDF_EXTS = ['.pdf'];
export const PROOF_VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.m4v'];
export const PROOF_ACCEPTED_EXTS = [
  ...PROOF_IMAGE_EXTS,
  ...PROOF_PDF_EXTS,
  ...PROOF_VIDEO_EXTS,
];

/** Accept attribute value for the file input and drop zone. */
export const PROOF_ACCEPT_MIME =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,video/mp4,video/quicktime,video/webm,video/x-m4v';

export function extOfFileName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

/**
 * Validate one proof file before upload. Returns a human-readable error, or
 * null when the file is accepted. Proof submissions accept images, PDFs, and
 * videos up to 50MB.
 */
export function validateProofFile(
  fileName: string,
  sizeBytes: number,
  maxBytes: number = MAX_PROOF_BYTES,
): string | null {
  const ext = extOfFileName(fileName);
  if (!PROOF_ACCEPTED_EXTS.includes(ext)) {
    return `"${fileName}" is not an accepted type. Upload an image (PNG, JPG, WebP, GIF), a PDF, or a video (MP4, MOV, WebM) instead.`;
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return `"${fileName}" is empty. Pick a file that has content.`;
  }
  if (sizeBytes > maxBytes) {
    const capMb = Math.round(maxBytes / (1024 * 1024));
    return `"${fileName}" is over the ${capMb}MB limit. Compress it or split it up and try again.`;
  }
  return null;
}

export type ProofPreviewKind = 'image' | 'video' | 'pdf' | 'other';

/**
 * Decide how to preview a deliverable file inline: images render as <img>,
 * videos as <video>, PDFs as <iframe>, everything else falls back to a link.
 */
export function proofPreviewKind(
  fileName: string,
  contentType?: string | null,
): ProofPreviewKind {
  if (contentType && typeof contentType === 'string') {
    const lower = contentType.toLowerCase();
    if (lower.startsWith('image/')) return 'image';
    if (lower.startsWith('video/')) return 'video';
    if (lower === 'application/pdf' || lower.endsWith('/pdf')) return 'pdf';
  }
  const ext = extOfFileName(fileName || '');
  if (PROOF_IMAGE_EXTS.includes(ext)) return 'image';
  if (PROOF_VIDEO_EXTS.includes(ext)) return 'video';
  if (PROOF_PDF_EXTS.includes(ext)) return 'pdf';
  return 'other';
}

/**
 * All assignee ids on a task: the multi-assignee array when present,
 * otherwise the legacy single assigneeId.
 */
export function assigneeIdsOf(task: {
  assigneeIds?: unknown;
  assigneeId?: unknown;
}): string[] {
  const ids = task.assigneeIds;
  if (Array.isArray(ids)) {
    return ids
      .map(String)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const single = task.assigneeId;
  if (typeof single === 'string' && single.trim().length > 0) {
    return [single.trim()];
  }
  return [];
}

export interface AssigneeSubmissionState {
  assigneeId: string;
  /** True when this assignee has proof on the task or submitted it. */
  submitted: boolean;
  /** What marks them as submitted: 'submit' (submittedBy) or 'upload' (uploadedBy on a deliverable file). */
  via: 'submit' | 'upload' | null;
}

/**
 * Per-assignee submission check-ins for a task: an assignee counts as
 * submitted when they are the recorded submitter (submittedBy) or when at
 * least one deliverable file carries their uid as uploadedBy. Used by the
 * co-assignee presence row in the drawer.
 */
export function assigneeSubmissionStates(
  task: {
    assigneeIds?: unknown;
    assigneeId?: unknown;
    submittedBy?: unknown;
    deliverableFiles?: unknown;
  },
): AssigneeSubmissionState[] {
  const ids = assigneeIdsOf(task);
  const submitter = typeof task.submittedBy === 'string' ? task.submittedBy : null;
  const files = Array.isArray(task.deliverableFiles) ? task.deliverableFiles : [];
  const uploadedBy = new Set<string>();
  for (const f of files) {
    if (f && typeof (f as Record<string, unknown>).uploadedBy === 'string') {
      uploadedBy.add((f as Record<string, unknown>).uploadedBy as string);
    }
  }
  return ids.map((id) => {
    if (submitter === id) return { assigneeId: id, submitted: true, via: 'submit' };
    if (uploadedBy.has(id)) return { assigneeId: id, submitted: true, via: 'upload' };
    return { assigneeId: id, submitted: false, via: null };
  });
}

/**
 * Count how many deliverable files on the task have a usable URL. Mirrors
 * the guard the submit endpoints use: files without a URL do not count.
 */
export function countSubmittableFiles(task: { deliverableFiles?: unknown }): number {
  const files = Array.isArray(task.deliverableFiles) ? task.deliverableFiles : [];
  return files.filter(
    (f) =>
      f &&
      typeof (f as Record<string, unknown>).downloadUrl === 'string' &&
      ((f as Record<string, unknown>).downloadUrl as string).length > 0,
  ).length;
}

/**
 * A task may be sent for review when it has notes (the work report) and at
 * least one attached proof file. The server enforces the report requirement
 * too (PATCH /api/tasks returns 400); the client mirrors it so the button
 * can explain what is missing.
 */
export function submissionReadiness(task: { deliverableFiles?: unknown }, notes: string): {
  notesDone: boolean;
  filesDone: boolean;
  ready: boolean;
  missingHint: string | null;
} {
  const notesDone = typeof notes === 'string' && notes.trim().length > 0;
  const filesDone = countSubmittableFiles(task) > 0;
  const missingHint =
    !notesDone && !filesDone
      ? 'To submit: write your submission notes and attach at least one proof file.'
      : !filesDone
        ? 'To submit: attach at least one proof file.'
        : !notesDone
          ? 'To submit: write your submission notes.'
          : null;
  return { notesDone, filesDone, ready: notesDone && filesDone, missingHint };
}
