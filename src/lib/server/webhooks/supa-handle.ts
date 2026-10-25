/**
 * Webhooks group (G5) seam — the ONLY module in this group that imports
 * the cluster foundation handle (src/lib/server/supa-db-handle.ts).
 *
 * The firestore webhook handlers in src/app/api/webhooks/firestore/route.ts
 * all receive their `db` as a parameter, so migration is a single
 * db-acquisition choice at the route's POST entry:
 *
 *   flag 'webhooks' ON  + Supabase configured -> the adapter-backed
 *     Firestore-shaped handle (all handler reads/writes land in the
 *     fs_* tables, subcollections via parent_path, batches and the
 *     task-reward runTransaction through the handle's emulation — see
 *     the transaction contract in supa-db-handle.ts).
 *   otherwise -> the real Firestore db from getDb(), byte-identical
 *     to the pre-migration behaviour (including the 503 when getDb()
 *     returns null).
 *
 * NOT data, never routed through this seam (plan C-G5-2 / C-G5-4):
 * Firebase Auth custom-claims calls (getAuth().getUser /
 * setCustomUserClaims) and FCM (getMessaging()) keep hitting the real
 * APIs regardless of the flag; only their users/{uid} Firestore reads
 * travel through whichever db this module returns.
 */
import { getDb } from '../firebase-admin';
import { supaDbHandleFor, type SupaDbHandle } from '../supa-db-handle';

/** Migration flag surface for this group (plan §2). */
export const WEBHOOKS_SUPA_SURFACE = 'webhooks';

/**
 * The db the firestore webhook route passes to its handlers: the shared
 * Supa handle when the 'webhooks' surface is ON, else the real
 * Firestore db (possibly null, which the route maps to 503 exactly as
 * before).
 */
export function getWebhooksDb(): SupaDbHandle | ReturnType<typeof getDb> {
  return supaDbHandleFor(WEBHOOKS_SUPA_SURFACE) ?? getDb();
}
