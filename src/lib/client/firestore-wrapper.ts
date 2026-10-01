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

    // Fire & Forget: Webhooks shouldn't block client response
    fetch('/api/webhooks/firestore', {
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
  const collectionTrigger = isWebhookCollection(reference.path);
  let before = null;

  if (collectionTrigger) {
    try {
      const snap = await fsGetDoc(reference);
      before = snap.exists() ? snap.data() : null;
    } catch(e) {}
  }

  await fsSetDoc(reference, data, options as any);

  if (collectionTrigger) {
    const eventType = before ? 'update' : 'create';
    // To properly provide 'after', we must merge before and data based on options
    const after = options?.merge && before ? { ...before, ...data } : data;
    dispatchWebhook(collectionTrigger, reference.id, eventType, before, after);
  }
}

export async function updateDoc<T extends DocumentData>(reference: DocumentReference<T>, data: UpdateData<T>): Promise<void> {
  const collectionTrigger = isWebhookCollection(reference.path);
  let before = null;

  if (collectionTrigger) {
    try {
      const snap = await fsGetDoc(reference);
      before = snap.exists() ? snap.data() : null;
    } catch(e) {}
  }

  await fsUpdateDoc(reference as any, data as any);

  if (collectionTrigger) {
    const after = before ? { ...before, ...(data as any) } : data;
    dispatchWebhook(collectionTrigger, reference.id, 'update', before, after);
  }
}

export async function addDoc<T extends DocumentData>(reference: CollectionReference<T>, data: WithFieldValue<T>): Promise<DocumentReference<T>> {
  const newDocRef = await fsAddDoc(reference, data);
  const collectionTrigger = isWebhookCollection(reference.path);

  if (collectionTrigger) {
    dispatchWebhook(collectionTrigger, newDocRef.id, 'create', null, data);
  }
  return newDocRef;
}

export async function deleteDoc(reference: DocumentReference<any>): Promise<void> {
  const collectionTrigger = isWebhookCollection(reference.path);
  let before = null;

  if (collectionTrigger) {
    try {
      const snap = await fsGetDoc(reference);
      before = snap.exists() ? snap.data() : null;
    } catch(e) {}
  }

  await fsDeleteDoc(reference);

  if (collectionTrigger) {
    dispatchWebhook(collectionTrigger, reference.id, 'delete', before, null);
  }
}
