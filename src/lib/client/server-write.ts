/**
 * server-write — client helper for the client-direct write elimination
 * (cutover workstream 10).
 *
 * Converted browser flows no longer write Firestore through the client
 * SDK / firestore-wrapper; they POST to a server route that performs
 * the primary Firestore write (Admin SDK) plus the surface's existing
 * Supabase mirror and any downstream effect the wrapper's webhook
 * dispatch used to trigger (each route owns its effects explicitly —
 * see the per-surface routes).
 *
 * Contract preserved for callers: resolves on success exactly like the
 * wrapper write did; rejects with an Error whose message is safe to
 * show in the caller's existing error toast. The caller's Firebase ID
 * token is sent as a Bearer token, the auth shape every admin route on
 * this tree already accepts.
 */
import { getAuth } from 'firebase/auth';
import { getFirebaseApp } from '@/firebase/provider';

export async function getCallerIdToken(): Promise<string | null> {
  try {
    const auth = getAuth(getFirebaseApp());
    return (await auth.currentUser?.getIdToken()) ?? null;
  } catch {
    return null;
  }
}

export interface ServerWriteResult {
  status: number;
  body: any;
}

export async function serverWrite(
  url: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<ServerWriteResult> {
  const token = await getCallerIdToken();
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (parsed && typeof parsed.error === 'string' && parsed.error) ||
        'Something went wrong while saving. Try again, and contact an admin if it keeps happening.',
    );
  }
  return { status: res.status, body: parsed };
}
