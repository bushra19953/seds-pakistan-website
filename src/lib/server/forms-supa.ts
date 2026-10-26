/**
 * Forms + form responses -> Supabase seam (migration step 11, Cluster J).
 *
 * Consumers (new server routes added by this build — the forms surface
 * previously had NO server route at all; every read/write was a direct
 * browser Firestore call from the admin pages):
 *   src/app/api/forms/route.ts                    (GET list, POST create)
 *   src/app/api/forms/[formId]/responses/route.ts (GET list, POST append)
 *
 * Gate: useSupa('forms') && getSupaClient() (default OFF). Flag OFF,
 * client unconfigured, or ANY adapter error => the routes serve their
 * Firestore (Admin SDK) path with the same response shape.
 *
 * Collections:
 *  - `forms` — one writer in the base tree (the admin page itself).
 *    The routes mirror creates best-effort; the admin page's own
 *    client writes (create/update/delete) stay client-direct — the
 *    adapter is server-only, the same blocker the chapters seam
 *    records for its client reads.
 *  - `forms/{formId}/responses` — member-append subcollection. The
 *    base tree contains NO in-app writer for it (responses arrive
 *    out-of-band; the admin responses page only reads). The POST
 *    route in this build is the append write path: Firestore-primary
 *    add, then mirrorFormResponseAppend — appends mirror trivially
 *    because the doc id is known before either write lands.
 *    Adapter addressing: the subcollection path resolves to the
 *    fs_group_responses landing table, discriminated by parent_path
 *    (adapter resolveTarget), exactly like the migration kit.
 *
 * The Universal Inbox FORM_RESPONSE tab has NO data feed (known
 * defect, inventory §5.1) — flagged, not fixed here; this seam's
 * responses table is what a future fix would read.
 */
import { getSupaAdapter, getSupaClient, isSupaPrimary, useSupa } from '@/lib/supa';
import type { SupaDoc } from '@/lib/supa';

export const FORMS_SUPA_SURFACE = 'forms';
export const FORMS_COLLECTION = 'forms';

export function formsSupaEnabled(): boolean {
  try {
    return useSupa(FORMS_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export function formResponsesPath(formId: string): string {
  return `forms/${formId}/responses`;
}

export type FormsRead =
  | { status: 'fallback' }
  | { status: 'ok'; docs: SupaDoc[] };

export async function readFormsViaSupa(): Promise<FormsRead> {
  if (!formsSupaEnabled()) return { status: 'fallback' };
  try {
    const docs = await getSupaAdapter().listDocs(FORMS_COLLECTION);
    return { status: 'ok', docs };
  } catch (err) {
    console.error('[forms-supa] adapter list failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

export type FormRead =
  | { status: 'fallback' }
  | { status: 'ok'; doc: SupaDoc | null };

export async function readFormViaSupa(formId: string): Promise<FormRead> {
  if (!formsSupaEnabled()) return { status: 'fallback' };
  try {
    const doc = await getSupaAdapter().getDoc(FORMS_COLLECTION, formId);
    return { status: 'ok', doc };
  } catch (err) {
    console.error('[forms-supa] adapter get failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

export type FormResponsesRead =
  | { status: 'fallback' }
  | { status: 'ok'; docs: SupaDoc[] };

export async function readFormResponsesViaSupa(formId: string): Promise<FormResponsesRead> {
  if (!formsSupaEnabled()) return { status: 'fallback' };
  try {
    const docs = await getSupaAdapter().listDocs(formResponsesPath(formId));
    return { status: 'ok', docs };
  } catch (err) {
    console.error('[forms-supa] adapter responses list failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}

/* WRITE PRIMACY (cutover W4): isSupaPrimary('forms'). PrimaryFirst
 * helpers write the adapter FIRST and THROW on failure; callers then
 * run their Firestore write as the best-effort post-commit mirror.
 * OFF (default): return false, today's Firestore-first flow + mirror
 * runs byte-identically. Flip gates (w4-census.md): the admin page's
 * update/delete are client-direct on this base, and the
 * fs_group_responses table was not in the reconciled dump — verify
 * both before SUPA_PRIMARY=forms is set. */
export function formsSupaPrimary(): boolean {
  try {
    return isSupaPrimary(FORMS_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export async function setFormPrimaryFirst(id: string, data: Record<string, any>): Promise<boolean> {
  if (!formsSupaPrimary()) return false;
  await getSupaAdapter().setDoc(FORMS_COLLECTION, id, data);
  return true;
}

export async function setFormResponsePrimaryFirst(
  formId: string,
  responseId: string,
  data: Record<string, any>,
): Promise<boolean> {
  if (!formsSupaPrimary()) return false;
  await getSupaAdapter().setDoc(formResponsesPath(formId), responseId, data);
  return true;
}

/** Best-effort mirror of a Firestore form create — never throws. */
export async function mirrorFormCreate(id: string, data: Record<string, any>): Promise<void> {
  if (!formsSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(FORMS_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[forms-supa] mirror create failed:', e?.message || e);
  }
}

/** Best-effort mirror of a Firestore form update — never throws. (WS10) */
export async function mirrorFormUpdate(id: string, data: Record<string, any>): Promise<void> {
  if (!formsSupaEnabled()) return;
  try {
    await getSupaAdapter().updateDoc(FORMS_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[forms-supa] mirror update failed:', e?.message || e);
  }
}

/** Best-effort mirror of a Firestore form delete — never throws. (WS10) */
export async function mirrorFormDelete(id: string): Promise<void> {
  if (!formsSupaEnabled()) return;
  try {
    await getSupaAdapter().deleteDoc(FORMS_COLLECTION, id);
  } catch (e: any) {
    console.error('[forms-supa] mirror delete failed:', e?.message || e);
  }
}

/** Best-effort mirror of a member response append — never throws. */
export async function mirrorFormResponseAppend(
  formId: string,
  responseId: string,
  data: Record<string, any>,
): Promise<void> {
  if (!formsSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(formResponsesPath(formId), responseId, data);
  } catch (e: any) {
    console.error('[forms-supa] mirror response append failed:', e?.message || e);
  }
}
