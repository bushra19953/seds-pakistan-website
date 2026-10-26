import {
  setDoc as fsSetDoc,
  updateDoc as fsUpdateDoc,
  addDoc as fsAddDoc,
  deleteDoc as fsDeleteDoc,
  getDoc as fsGetDoc,
  DocumentReference,
  CollectionReference,
  WithFieldValue,
  DocumentData,
  UpdateData
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { assertFirestoreDataEnabled } from '../firestore-kill-switch';

// ---------------------------------------------------------------------------
// STRUCTURED FIRESTORE ERRORS
// ---------------------------------------------------------------------------

/** The write operation that failed. Surfaced so UI can explain the context. */
export type FirestoreOp = 'set' | 'update' | 'add' | 'delete';

/**
 * Structured error thrown by every write in this wrapper.
 *
 * Carries:
 * - `code`: the raw Firestore/Firebase error code (e.g. "permission-denied")
 * - `path`: the document or collection path the write targeted
 * - `op`: which write operation failed
 * - `message`: a SAFE, human-readable message for the UI (no internals, no secrets)
 * - `cause`: the original Firebase error (for logging/debugging, never shown to users)
 *
 * UI layers (e.g. handleReapply) should catch this and display `error.message`,
 * and can branch on `error.code` for permission-specific handling.
 */
export class FirestoreWriteError extends Error {
  readonly code: string;
  readonly path: string;
  readonly op: FirestoreOp;

  constructor(op: FirestoreOp, path: string, code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'FirestoreWriteError';
    this.op = op;
    this.path = path;
    this.code = code;
    // Keep the original error for stack/debug context without exposing it in UI text.
    if (cause !== undefined) {
      (this as any).cause = cause;
    }
  }
}

/**
 * Map a raw Firebase error code to a safe human-readable message.
 * Messages deliberately avoid internals (rules, UIDs, collection internals).
 */
function messageForCode(code: string, op: FirestoreOp): string {
  switch (code) {
    case 'permission-denied':
      return 'You do not have permission to save this. If you think this is wrong, contact an admin.';
    case 'unavailable':
      return 'Could not reach the database. Check your internet connection and try again.';
    case 'not-found':
      return op === 'update' || op === 'delete'
        ? 'This item no longer exists. Refresh the page and try again.'
        : 'The requested data was not found.';
    case 'already-exists':
      return 'This already exists. Refresh the page and try again.';
    case 'resource-exhausted':
      return 'Too many requests right now. Wait a moment and try again.';
    case 'invalid-argument':
      return 'Something in the data was not accepted. Refresh and try again.';
    case 'cancelled':
      return 'The save was cancelled. Try again.';
    case 'deadline-exceeded':
      return 'The save took too long. Check your connection and try again.';
    case 'aborted':
      return 'The save was interrupted. Try again.';
    default:
      return 'Something went wrong while saving. Try again, and contact an admin if it keeps happening.';
  }
}

/**
 * Normalize any error thrown by a Firestore write into a FirestoreWriteError.
 * The original error is preserved on `cause` for logs; no payload data or
 * secrets are attached to the structured error or logged here.
 */
export function normalizeFirestoreWriteError(op: FirestoreOp, path: string, error: unknown): FirestoreWriteError {
  const raw = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof raw?.code === 'string' && raw.code ? raw.code : 'unknown';
  return new FirestoreWriteError(op, path, code, messageForCode(code, op), error);
}

/** True when the error is a FirestoreWriteError with a permission-denied code. */
export function isPermissionDeniedError(error: unknown): error is FirestoreWriteError {
  return error instanceof FirestoreWriteError && error.code === 'permission-denied';
}

/**
 * Identify if a collection path is meant to trigger our background webhooks.
 */
function isWebhookCollection(path: string): string | null {
  const triggers = [
    'tasks',
    'users',
    'roles',
    'positions',
    'leave_requests',
    'applications',
    'form_responses',
    'submissions'
  ];
  const parts = path.split('/');
  // Basic collections
  if (parts.length === 1 && triggers.includes(parts[0])) return parts[0];
  if (parts.length === 2 && triggers.includes(parts[0])) return parts[0];
  // Subcollection like users/{uid}/notifications
  if (parts.length === 3 && parts[0] === 'users' && parts[2] === 'notifications') return 'users/notifications';
  if (parts.length === 4 && parts[0] === 'users' && parts[2] === 'notifications') return 'users/notifications';
  
  return null;
}

/**
 * Dispatches the webhook to our Vercel Next.js background API.
 */
async function dispatchWebhook(collection: string, docId: string, eventType: 'create' | 'update' | 'delete', before: any = null, after: any = null) {
  try {
    const auth = getAuth();
    const token = await auth.currentUser?.getIdToken();

    // Fire & Forget: Webhooks shouldn't block client response.
    // Routed through the authenticated server proxy, which injects the
    // webhook secret server-side so it never reaches the browser.
    fetch('/api/webhooks/dispatch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        collection,
        docId,
        eventType,
        before,
        after
      })
    }).catch(console.error);
  } catch (error) {
    console.warn('Failed to dispatch background webhook', error);
  }
}

// ---------------------------------------------------------------------------
// WRAPPERS for Firebase SDK
// ---------------------------------------------------------------------------

export async function setDoc<T extends DocumentData>(reference: DocumentReference<T>, data: WithFieldValue<T>, options?: { merge?: boolean }): Promise<void> {
  assertFirestoreDataEnabled('client:wrapper:setDoc');
  const collectionTrigger = isWebhookCollection(reference.path);
  let before = null;

  if (collectionTrigger) {
    try {
      const snap = await fsGetDoc(reference);
      before = snap.exists() ? snap.data() : null;
    } catch(e) {}
  }

  try {
    await fsSetDoc(reference, data, options as any);
  } catch (error) {
    throw normalizeFirestoreWriteError('set', reference.path, error);
  }

  if (collectionTrigger) {
    const eventType = before ? 'update' : 'create';
    // To properly provide 'after', we must merge before and data based on options
    const after = options?.merge && before ? { ...before, ...data } : data;
    dispatchWebhook(collectionTrigger, reference.id, eventType, before, after);
  }
}

export async function updateDoc<T extends DocumentData>(reference: DocumentReference<T>, data: UpdateData<T>): Promise<void> {
  assertFirestoreDataEnabled('client:wrapper:updateDoc');
  const collectionTrigger = isWebhookCollection(reference.path);
  let before = null;

  if (collectionTrigger) {
    try {
      const snap = await fsGetDoc(reference);
      before = snap.exists() ? snap.data() : null;
    } catch(e) {}
  }

  try {
    await fsUpdateDoc(reference as any, data as any);
  } catch (error) {
    throw normalizeFirestoreWriteError('update', reference.path, error);
  }

  if (collectionTrigger) {
    const after = before ? { ...before, ...(data as any) } : data;
    dispatchWebhook(collectionTrigger, reference.id, 'update', before, after);
  }
}

export async function addDoc<T extends DocumentData>(reference: CollectionReference<T>, data: WithFieldValue<T>): Promise<DocumentReference<T>> {
  assertFirestoreDataEnabled('client:wrapper:addDoc');
  let newDocRef: DocumentReference<T>;
  try {
    newDocRef = await fsAddDoc(reference, data);
  } catch (error) {
    throw normalizeFirestoreWriteError('add', reference.path, error);
  }
  const collectionTrigger = isWebhookCollection(reference.path);

  if (collectionTrigger) {
    dispatchWebhook(collectionTrigger, newDocRef.id, 'create', null, data);
  }
  return newDocRef;
}

export async function deleteDoc(reference: DocumentReference<any>): Promise<void> {
  assertFirestoreDataEnabled('client:wrapper:deleteDoc');
  const collectionTrigger = isWebhookCollection(reference.path);
  let before = null;

  if (collectionTrigger) {
    try {
      const snap = await fsGetDoc(reference);
      before = snap.exists() ? snap.data() : null;
    } catch(e) {}
  }

  try {
    await fsDeleteDoc(reference);
  } catch (error) {
    throw normalizeFirestoreWriteError('delete', reference.path, error);
  }

  if (collectionTrigger) {
    dispatchWebhook(collectionTrigger, reference.id, 'delete', before, null);
  }
}
