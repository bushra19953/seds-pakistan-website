/**
 * Skills -> Supabase seam (Cluster G, merge-plan step 8).
 *
 * Every Supabase touch for the `skills` collection — and for the two
 * foreign arrays this cluster only CONSUMES (`users.skillIds`, owned by
 * cluster B; `events.grantedSkillIds`, owned by cluster L/events) — lives
 * here. Consumers:
 *   src/app/api/skills/route.ts            (admin list + create/update/delete)
 *   src/app/api/skills/assign-bulk/route.ts (grant path: bulk-assign to users)
 *   src/app/api/skills/migrate-legacy/route.ts (legacy seed/upsert)
 *
 * NOT consumers (inventoried, deliberately left on Firestore):
 *   src/app/api/public/skills/route.ts + src/app/api/public/skills-users/route.ts
 *     — the public skills reads belong to step 6 (public-misc), building in
 *     parallel on another branch; wiring them here would collide.
 *   src/app/api/admin/universal-review/route.ts — its skills grant half
 *     (find-by-slug + arrayUnion onto users.skillIds) is owned by the
 *     gamification/tasks orbit (clusters Q/T), not cluster G. The generic
 *     mirror helper `mirrorUserSkillGrants` below is the seam it can call
 *     at its own step; this cluster does not edit that file.
 *   Client-direct writes in the admin UI (status toggle in
 *     src/app/admin/skills/page.tsx, create/edit in
 *     register-capability-modal.tsx) and the client events feed in
 *     capability-detail-panel.tsx — the adapter is server-only and no
 *     client seam / route-through-API ruling exists for them (same
 *     disposition as the chapters cluster's client reads). They stay
 *     Firestore-primary with NO mirror; see the build report's flip note.
 *   Events files (src/lib/supa-events/**, event routes) — grantedSkillIds
 *     is read here through the adapter only; events files are never edited.
 *
 * Behavior contract (the landed seam pattern, cf. blog-supa):
 * - Gate: useSupa('skills') && getSupaClient() (SUPA_SURFACES env, default
 *   OFF). Flag OFF, client unconfigured, or ANY adapter error on a read =>
 *   the read helpers return null and callers fall back to Firestore,
 *   byte-identical to the pre-migration code.
 * - Flag ON: the admin GET is served from fs_skills, with holder/grant
 *   counts aggregated from fs_users.skillIds / fs_events.grantedSkillIds
 *   in SQL-land (adapter listDocs) instead of the Firestore full scans —
 *   same response shape, same counts.
 * - Writes stay Firestore-primary. The mirror* helpers copy a completed
 *   Firestore write into Supabase best-effort — they never throw, so a
 *   mirror failure can never fail a request Firestore already served.
 * - Grant mirrors (assign-bulk, delete-detach) are read-modify-write on
 *   the fs_users row's skillIds array: the adapter has no arrayUnion
 *   primitive, so the helper reads the mirrored user doc, computes the
 *   union/difference exactly as FieldValue.arrayUnion/arrayRemove would,
 *   and updateDocs it back. If the user row is absent from fs_users the
 *   mirror is skipped (never invent a partial user doc).
 */
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
import type { SupaDoc } from '@/lib/supa';

export const SKILLS_SUPA_SURFACE = 'skills';
export const SKILLS_COLLECTION = 'skills';
export const USERS_COLLECTION = 'users';
export const EVENTS_COLLECTION = 'events';

export function skillsSupaEnabled(): boolean {
  try {
    return useSupa(SKILLS_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

/** A SupaDoc as the plain data record the route serializers consume. */
export function supaDocData(doc: SupaDoc): Record<string, any> {
  const { id: _id, ...data } = doc as Record<string, any>;
  return data;
}

/* ------------------------------------------------------------------ reads */
/* Read helpers return null on disabled/error: "unavailable — use Firestore". */

/**
 * The admin skills list, honoring the route's three query modes:
 * explicit ids (max 10, as the route slices), one slug, or the full list.
 */
export async function supaListSkillsAdmin(opts: {
  ids?: string[];
  slug?: string;
}): Promise<Record<string, any>[] | null> {
  if (!skillsSupaEnabled()) return null;
  try {
    const adapter = getSupaAdapter();
    let docs: SupaDoc[];
    if (opts.ids !== undefined) {
      // The route's ids mode: an empty parsed list yields an empty result,
      // exactly like the Firestore path (items stays [] when no ids parse).
      const found = await Promise.all(
        opts.ids.map((id) => adapter.getDoc(SKILLS_COLLECTION, id)),
      );
      docs = found.filter((d): d is SupaDoc => d !== null);
    } else if (opts.slug) {
      docs = await adapter.listDocs(SKILLS_COLLECTION, {
        where: [['slug', '==', opts.slug]],
      });
    } else {
      docs = await adapter.listDocs(SKILLS_COLLECTION);
    }
    return docs.map((d) => ({ id: d.id, ...supaDocData(d) }));
  } catch (e: any) {
    console.error('[skills-supa] list failed, falling back to Firestore:', e?.message || e);
    return null;
  }
}

export interface SkillGrantCounts {
  userCounts: Record<string, number>;
  eventCounts: Record<string, number>;
}

/**
 * assignedUserCount / linkedEventCount for every skill, aggregated from
 * fs_users.skillIds and fs_events.grantedSkillIds — the exact in-memory
 * aggregation the Firestore path performs over its full scans, moved to
 * the mirrored tables. Returns null on disabled/error (caller falls back
 * to the Firestore aggregation, which itself defaults counts to 0 on
 * failure — parity preserved either way).
 */
export async function supaSkillGrantCounts(): Promise<SkillGrantCounts | null> {
  if (!skillsSupaEnabled()) return null;
  try {
    const adapter = getSupaAdapter();
    const [users, events] = await Promise.all([
      adapter.listDocs(USERS_COLLECTION),
      adapter.listDocs(EVENTS_COLLECTION),
    ]);
    const userCounts: Record<string, number> = {};
    for (const doc of users) {
      const skillIds = (doc as Record<string, any>).skillIds || [];
      if (Array.isArray(skillIds)) {
        skillIds.forEach((id: string) => {
          userCounts[id] = (userCounts[id] || 0) + 1;
        });
      }
    }
    const eventCounts: Record<string, number> = {};
    for (const doc of events) {
      const grantedSkillIds = (doc as Record<string, any>).grantedSkillIds || [];
      if (Array.isArray(grantedSkillIds)) {
        grantedSkillIds.forEach((id: string) => {
          eventCounts[id] = (eventCounts[id] || 0) + 1;
        });
      }
    }
    return { userCounts, eventCounts };
  } catch (e: any) {
    console.error('[skills-supa] grant counts failed, falling back to Firestore:', e?.message || e);
    return null;
  }
}

/** Users holding a skill (the DELETE route's holder lookup). */
export async function supaListSkillHolders(
  skillId: string,
): Promise<Record<string, any>[] | null> {
  if (!skillsSupaEnabled()) return null;
  try {
    const docs = await getSupaAdapter().listDocs(USERS_COLLECTION, {
      where: [['skillIds', 'array-contains', skillId]],
    });
    return docs.map((d) => ({ id: d.id, ...supaDocData(d) }));
  } catch (e: any) {
    console.error('[skills-supa] holder list failed, falling back to Firestore:', e?.message || e);
    return null;
  }
}

/** One skill by slug (migrate-legacy's existence probe). */
export async function supaFindSkillBySlug(
  slug: string,
): Promise<Record<string, any> | null | undefined> {
  if (!skillsSupaEnabled()) return undefined;
  try {
    const docs = await getSupaAdapter().listDocs(SKILLS_COLLECTION, {
      where: [['slug', '==', slug]],
      limit: 1,
    });
    return docs[0] ? { id: docs[0].id, ...supaDocData(docs[0]) } : null;
  } catch (e: any) {
    console.error('[skills-supa] find-by-slug failed, falling back to Firestore:', e?.message || e);
    return undefined;
  }
}

/* ----------------------------------------------------------------- mirrors */
/* Mirror helpers are best-effort: no-op when disabled, never throw. */

/** Mirror of a Firestore skills create (setDoc without merge). */
export async function mirrorSkillCreate(
  id: string,
  data: Record<string, any>,
): Promise<void> {
  if (!skillsSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(SKILLS_COLLECTION, id, data);
  } catch (e: any) {
    console.error('[skills-supa] mirror create failed:', e?.message || e);
  }
}

/** Mirror of a Firestore skills upsert (setDoc with merge). */
export async function mirrorSkillUpsert(
  id: string,
  data: Record<string, any>,
): Promise<void> {
  if (!skillsSupaEnabled()) return;
  try {
    await getSupaAdapter().setDoc(SKILLS_COLLECTION, id, data, { merge: true });
  } catch (e: any) {
    console.error('[skills-supa] mirror upsert failed:', e?.message || e);
  }
}

/**
 * Mirror of a Firestore skills update — identical semantics to
 * mirrorSkillUpsert today (the route's PATCH writes via set merge), kept
 * as a distinctly named helper so call sites read like their Firestore op.
 */
export async function mirrorSkillUpdate(
  id: string,
  data: Record<string, any>,
): Promise<void> {
  return mirrorSkillUpsert(id, data);
}

/** Mirror of a Firestore skills delete. */
export async function mirrorSkillDelete(id: string): Promise<void> {
  if (!skillsSupaEnabled()) return;
  try {
    await getSupaAdapter().deleteDoc(SKILLS_COLLECTION, id);
  } catch (e: any) {
    console.error('[skills-supa] mirror delete failed:', e?.message || e);
  }
}

/**
 * Mirror of FieldValue.arrayUnion(skillIds) onto one users doc — the
 * grant path shared by assign-bulk and any future events/universal-review
 * grant caller. Read-modify-write against the mirrored fs_users row;
 * skips silently when the row is absent. Never throws.
 */
export async function mirrorUserSkillGrants(
  uid: string,
  skillIds: string[],
): Promise<void> {
  if (!skillsSupaEnabled() || skillIds.length === 0) return;
  try {
    const adapter = getSupaAdapter();
    const doc = await adapter.getDoc(USERS_COLLECTION, uid);
    if (!doc) return;
    const current = Array.isArray((doc as Record<string, any>).skillIds)
      ? ((doc as Record<string, any>).skillIds as string[])
      : [];
    const next = Array.from(new Set([...current, ...skillIds]));
    if (next.length === current.length) return;
    await adapter.updateDoc(USERS_COLLECTION, uid, { skillIds: next });
  } catch (e: any) {
    console.error('[skills-supa] mirror user grant failed:', e?.message || e);
  }
}

/**
 * Mirror of FieldValue.arrayRemove(skillId) from one users doc — the
 * skill-delete detach path. Never throws.
 */
export async function mirrorUserSkillRevoke(
  uid: string,
  skillId: string,
): Promise<void> {
  if (!skillsSupaEnabled()) return;
  try {
    const adapter = getSupaAdapter();
    const doc = await adapter.getDoc(USERS_COLLECTION, uid);
    if (!doc) return;
    const current = Array.isArray((doc as Record<string, any>).skillIds)
      ? ((doc as Record<string, any>).skillIds as string[])
      : [];
    if (!current.includes(skillId)) return;
    await adapter.updateDoc(USERS_COLLECTION, uid, {
      skillIds: current.filter((s) => s !== skillId),
    });
  } catch (e: any) {
    console.error('[skills-supa] mirror user revoke failed:', e?.message || e);
  }
}
