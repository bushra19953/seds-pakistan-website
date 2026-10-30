import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { useSupa } from '@/lib/supa';
import {
  getUsersSupaAdapter,
  supaListAllUsers,
} from '@/lib/supa-seams/users-directory';
import {
  buildPublicHierarchy,
  type PublicHierarchyPayload,
  type PublicHierarchySource,
  type RawHierarchyUser,
} from '@/lib/public-hierarchy';
import { normalizeRoleSlug } from '@/lib/role-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/hierarchy
 *
 * Public read-only feed for the hierarchy page (/hierarchy), added by
 * founder order 2026-10-30: the community area already publishes the
 * Leaderboard (/community) and the Warning Registry
 * (/warning-registry); this feed publishes the org chart beside them —
 * chapter by chapter, who holds which role, each name linked to the
 * member's public profile (/profile/unified/<uid>, the pattern both
 * older surfaces use).
 *
 * The projection is a whitelist enforced here, server-side, exactly
 * as /api/public/warning-registry enforces its own: the route reads
 * only displayName, photoURL, role, displayRole, chapterId,
 * memberStatus and publicDirectoryOptIn off each user record. Email,
 * phone and WhatsApp live behind the 2026-10-28 contact gating and
 * are never read into this route at all, so they cannot leak through
 * it. Role titles are resolved server-side from the role registry
 * (roleDefinitions) through the platform's one display function.
 * Custom-role GRANTS are read from the roles docs
 * (roles/{uid}.additionalRoles — the AUTHORITY dialog's write store,
 * where assignRole appends custom slugs while the primary stays the
 * catalog role); exactly that one field is whitelisted off each
 * roles doc, for the same reason: the user record's role field alone
 * cannot see a deputy appointee.
 *
 * Read path (no new pipeline): the users directory seam
 * (src/lib/supa-seams/users-directory) serves the full user set from
 * the Supabase mirror when the 'users' surface is flipped, and the
 * role registry + chapters come through the same adapter while the
 * 'roles' surface is flipped (roles is a flipped surface; users are
 * Supabase-primary). Any seam gap or adapter error falls back to ONE
 * Admin SDK Firestore read set (users + roleDefinitions + chapters +
 * roles, in parallel), the warning-registry pattern. The two stores
 * are never mixed inside one response, so a half-migrated read
 * cannot produce a half-true org chart.
 *
 * Read bound + caching: the full set is ~250 user docs, ~60 registry
 * docs, ~250 roles docs and a handful of chapters — small, but public. The built
 * payload is cached in-process for 5 minutes (the leaderboard badge-
 * definitions TTL doctrine; bypassed under NODE_ENV=test) and
 * successful responses carry the warning-registry cache header
 * (s-maxage=120, stale-while-revalidate=60), so repeat public views
 * do not re-bill the read set. Error responses are never cached.
 *
 * Failure behaviour is truthful (the loudness doctrine): when neither
 * store can serve, the route answers 500 and the page shows its
 * load-failed state with a retry — never a fake empty org chart. A
 * SUCCESSFUL read that finds no role-holders is a 200 with empty
 * sections, which the page renders as an honest empty state.
 */

const CACHE_CONTROL = 'public, s-maxage=120, stale-while-revalidate=60';
const PAYLOAD_CACHE_TTL_MS = 5 * 60 * 1000;

let payloadCache: { expiresAt: number; payload: PublicHierarchyPayload } | null =
  null;

/** The ONLY user fields this route may read. No contact data, ever. */
function pickUserFields(
  id: string,
  data: Record<string, unknown>
): RawHierarchyUser {
  return {
    id,
    displayName: data.displayName,
    photoURL: data.photoURL,
    role: data.role,
    displayRole: data.displayRole,
    chapterId: data.chapterId,
    memberStatus: data.memberStatus,
    publicDirectoryOptIn: data.publicDirectoryOptIn,
  };
}

/**
 * Grant arrays keyed by uid: the ONLY field read off roles docs.
 * roles/{uid}.additionalRoles is where the AUTHORITY dialog's write
 * path (POST /api/admin/roles/assign → assignRole) stores custom-role
 * grants; the raw value rides into the projection, which sanitises
 * it. Nothing else on a roles doc enters this route.
 */
function grantsMap(
  docs: Array<{ id: string; additionalRoles: unknown }>
): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const doc of docs) {
    if (doc.id) map.set(doc.id, doc.additionalRoles);
  }
  return map;
}

/** Registry docs keyed by normalised slug (doc id and stored slug). */
function definitionsMap(
  docs: Array<{ id: string; data: Record<string, unknown> }>
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const doc of docs) {
    const fromId = normalizeRoleSlug(doc.id);
    if (fromId && !map.has(fromId)) map.set(fromId, doc.data);
    const slugField = doc.data.slug;
    if (typeof slugField === 'string') {
      const fromSlug = normalizeRoleSlug(slugField);
      if (fromSlug && !map.has(fromSlug)) map.set(fromSlug, doc.data);
    }
  }
  return map;
}

async function loadFromSupa(): Promise<PublicHierarchySource | null> {
  try {
    if (!useSupa('roles')) return null;
    const adapter = getUsersSupaAdapter();
    if (!adapter) return null;
    const [users, defDocs, chapterDocs, roleDocs] = await Promise.all([
      supaListAllUsers(adapter),
      adapter.listDocs('roleDefinitions'),
      adapter.listDocs('chapters'),
      adapter.listDocs('roles'),
    ]);
    return {
      users: users.map((row) => pickUserFields(row.id, row.data)),
      chapters: chapterDocs.map((d: any) => ({
        id: String(d.id),
        name: d.name,
        title: d.title,
      })),
      roleDefinitions: definitionsMap(
        defDocs.map((d: any) => {
          const { id, ...data } = d as Record<string, unknown> & { id: unknown };
          return { id: String(id), data: data as Record<string, unknown> };
        })
      ),
      additionalRolesByUid: grantsMap(
        roleDocs.map((d: any) => ({
          id: String(d.id),
          additionalRoles: (d as Record<string, unknown>).additionalRoles,
        }))
      ),
    };
  } catch (e) {
    console.warn(
      '[api/public/hierarchy] Supabase read failed, falling back to Firestore:',
      e
    );
    return null;
  }
}

async function loadFromFirestore(): Promise<PublicHierarchySource> {
  if (!ensureAdminInitialized()) {
    throw new Error('Firebase Admin not initialized');
  }
  const db = getDb();
  if (!db) {
    throw new Error('Firestore not initialized');
  }
  const [usersSnap, defsSnap, chaptersSnap, rolesSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('roleDefinitions').get(),
    db.collection('chapters').get(),
    db.collection('roles').get(),
  ]);
  return {
    users: usersSnap.docs.map((d: any) =>
      pickUserFields(d.id, d.data() as Record<string, unknown>)
    ),
    chapters: chaptersSnap.docs.map((d: any) => {
      const data = d.data() as Record<string, unknown>;
      return { id: d.id, name: data.name, title: data.title };
    }),
    roleDefinitions: definitionsMap(
      defsSnap.docs.map((d: any) => ({
        id: d.id,
        data: d.data() as Record<string, unknown>,
      }))
    ),
    additionalRolesByUid: grantsMap(
      rolesSnap.docs.map((d: any) => {
        const data = d.data() as Record<string, unknown>;
        return { id: d.id, additionalRoles: data.additionalRoles };
      })
    ),
  };
}

export async function GET() {
  try {
    if (
      process.env.NODE_ENV !== 'test' &&
      payloadCache &&
      Date.now() <= payloadCache.expiresAt
    ) {
      return NextResponse.json(payloadCache.payload, {
        headers: { 'Cache-Control': CACHE_CONTROL },
      });
    }

    const source = (await loadFromSupa()) ?? (await loadFromFirestore());
    const payload = buildPublicHierarchy(source);

    if (process.env.NODE_ENV !== 'test') {
      payloadCache = { expiresAt: Date.now() + PAYLOAD_CACHE_TTL_MS, payload };
    }
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  } catch (e) {
    console.error('[api/public/hierarchy] Failed:', e);
    return NextResponse.json(
      { error: 'Failed to load the hierarchy.' },
      { status: 500 }
    );
  }
}
