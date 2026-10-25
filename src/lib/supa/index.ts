/**
 * Firestore -> Supabase data-access layer (server-only).
 *
 *   import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
 *
 *   if (useSupa('announcements') && getSupaClient()) {
 *     const adapter = getSupaAdapter();
 *     const doc = await adapter.getDoc('announcements', id);
 *   }
 */
export { getSupaClient, resetSupaClientForTests } from './client';
export {
  createSupaAdapter,
  getSupaAdapter,
  tableForCollection,
  resolveTarget,
  firebaseUidForPath,
  SupaAdapterError,
  SupaUnavailableError,
  type SupaAdapter,
  type SupaDoc,
  type DocData,
  type WhereClause,
  type WhereOp,
  type OrderSpec,
  type ListOptions,
  type SupaLike,
} from './adapter';
export { useSupa, parseSupaSurfaces } from './flags';
