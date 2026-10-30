import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasSufficientRole } from '@/lib/roles';
import { resolvePublicDirectoryOptIn } from '@/lib/privacy';
import { bustIdentity } from '@/lib/server/identity-cache';
import {
  identityPrimaryFlagOn,
  primaryIdentitySet,
  primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';
import { buildNameSearchKeywords } from '@/lib/name-search-keywords';
import { getIdentityBundleViaBackend, useSupaIdentity } from '@/lib/server/identity-backend';
import {
  tryGetProfileUser,
  tryListUsersByManagerIds,
  tryGetUsersByIds,
  tryListProjectsForUser,
  tryListCertificatesForUser,
  tryListActiveChapters,
  tryGetSkillsByIds,
} from '@/lib/supa-seams/profile';
import { listDocsViaSeam } from '@/lib/supa/seam-tasks-lists';
import { listBadgeDefinitionsFromSupa } from '@/lib/supa/gamification';
import { getUserContact, resolveUserEmail, resolveUserEmails, setUserContact, stripContactFields } from '@/lib/server/user-contact';

// Supabase seam helpers (src/lib/supa-seams/profile.ts is the ONLY
// Supabase-aware module for this surface). Each helper returns the
// Firestore result when the 'profile' flag is OFF, no adapter is
// configured, or the adapter errors -- so the Firestore code paths
// below remain the exact fallback behaviour. The requester roles doc
// is NOT read through this seam: it is an authorization input and
// rides the identity bundle (src/lib/server/identity-backend) per
// the merge coordinator's step-3 precedence ruling — see the
// rolePromise below.
// RBT2 (census 19): the section legs below are seam-first too, each
// through its OWN collection seam/flag (projects / certificates /
// chapters / skills via the profile seam helpers, tasks +
// reporting_relationships via the tasks lists seam, badges via the
// gamification seam's definitions list filtered in memory). A seam
// miss (flag OFF / unconfigured / error) runs the Firestore leg
// byte-identically. HELD on Firestore: the warnings subcollection
// (no fs_group_warnings landing table exists).
async function loadProfileUserSnap(db: any, userId: string) {
  const supa = await tryGetProfileUser(userId);
  if (supa.status === 'ok') return supa.value;
  return db.collection('users').doc(userId).get();
}

async function loadUsersByManagerIds(db: any, chunk: string[]): Promise<any> {
  const supa = await tryListUsersByManagerIds(chunk);
  if (supa.status === 'ok') return supa.value;
  return db.collection('users').where('managerId', 'in', chunk).get();
}

async function loadUsersByIds(db: any, chunk: string[]): Promise<any> {
  const supa = await tryGetUsersByIds(chunk);
  if (supa.status === 'ok') return supa.value;
  return db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get();
}

// RBT2: per-section seam-first loaders. Each returns a docs array in
// the Firestore shape the processors below already consume
// ({ id, data() }[]); the Firestore leg is the exact pre-RBT2 query.

async function loadProjectDocs(db: any, userId: string): Promise<any[]> {
  const supa = await tryListProjectsForUser(userId);
  if (supa.status === 'ok') return supa.value.docs;
  // Try new schema first
  const s1 = await db.collection('projects').where('teamMemberIds', 'array-contains', userId).limit(5).get();
  if (!s1.empty) return s1.docs;
  // Fallback
  const s2 = await db.collection('projects').where('team', 'array-contains', userId).limit(5).get();
  return s2.docs;
}

async function loadCertificateDocs(db: any, userId: string): Promise<any[]> {
  const supa = await tryListCertificatesForUser(userId);
  if (supa.status === 'ok') return supa.value.docs;
  const snap = await db.collection('certificates').where('userId', '==', userId).limit(100).get();
  return snap.docs;
}

async function loadTaskDocs(db: any, userId: string): Promise<any[]> {
  // Union both assignment forms: a co-assignee on the array form must
  // see their tasks even when the singular form has other tasks.
  // Seam-first via the tasks lists seam; if either leg misses, BOTH
  // legs run on Firestore so the union semantics stay atomic.
  const [seamS1, seamS2] = await Promise.all([
    listDocsViaSeam('tasks', { where: [['assigneeId', '==', userId]], limit: 100 }),
    listDocsViaSeam('tasks', { where: [['assigneeIds', 'array-contains', userId]], limit: 100 }),
  ]);
  let rawDocs: any[];
  if (seamS1 && seamS2) {
    rawDocs = [...seamS1.docs, ...seamS2.docs];
  } else {
    const s1 = await db.collection('tasks').where('assigneeId', '==', userId).limit(100).get();
    const s2 = await db.collection('tasks').where('assigneeIds', 'array-contains', userId).limit(100).get();
    rawDocs = [...s1.docs, ...s2.docs];
  }
  const seen = new Set<string>();
  return rawDocs.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

async function loadChapterDocs(db: any): Promise<any[]> {
  const supa = await tryListActiveChapters();
  if (supa.status === 'ok') return supa.value.docs;
  const snap = await db.collection('chapters').where('isActive', '==', true).limit(100).get();
  return snap.docs;
}

// reporting_relationships for one manager chunk (inline MyTeam leg).
// Seam-first via the tasks lists seam (the pattern hierarchy.ts and
// the tasks team route already use); the Firestore fallback is now
// BOUNDED at 500 rows per chunk of <=10 managers -- the entire org
// is ~250 users, so no real chunk can reach the bound.
async function loadRelationshipDocs(db: any, chunk: string[]): Promise<any[]> {
  const seam = await listDocsViaSeam('reporting_relationships', { where: [['managerId', 'in', chunk]] });
  if (seam) return seam.docs;
  const snap = await db.collection('reporting_relationships').where('managerId', 'in', chunk).limit(500).get();
  return snap.docs;
}

// Cache configuration
const CACHE_DURATION = 60; // 60 seconds
const profileCache = new Map<string, { data: any; timestamp: number }>();

interface ProfileData {
  profile: any;
  projects: any[];
  badges: any[];
  skills: any[];
  chapter: any;
  certificates: any[];
  warnings: any[];
  tasks: any[];
  myTeam: any[];
  sectionStatuses: Record<string, { success: boolean; error?: string; errorCode?: string; note?: string }>;
}

// Claimed skill IDs that have no matching doc in the `skills` collection
// (orphans) used to vanish silently from profile responses. They are now
// returned with a humanized label and `unlinked: true` so a user's claimed
// skills never disappear without a trace.
function humanizeSkillId(skillId: string): string {
  return String(skillId)
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildSkillEntries(
  skillIds: string[],
  skillDocs: { id: string; data: () => any }[]
): { id: string; name: string; slug: string; category: string; unlinked?: boolean }[] {
  const byId = new Map<string, { id: string; name: string; slug: string; category: string }>();
  for (const doc of skillDocs) {
    byId.set(doc.id, {
      id: doc.id,
      name: doc.data()?.name || doc.id,
      slug: doc.data()?.slug || doc.id,
      category: doc.data()?.category || ''
    });
  }
  const orphans: string[] = [];
  const entries = skillIds.map((id) => {
    const linked = byId.get(id);
    if (linked) return linked;
    orphans.push(id);
    return {
      id,
      name: humanizeSkillId(id),
      slug: id,
      category: '',
      unlinked: true as const
    };
  });
  if (orphans.length > 0) {
    console.warn(
      '[profile:route] Skill IDs with no matching doc in the skills collection, shown as unlinked: ' +
      orphans.join(', ')
    );
  }
  return entries;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const startTime = Date.now();

  try {
    // ... logic ...
    const { userId } = await params;
    if (!userId) return NextResponse.json({ error: 'User ID is required' }, { status: 400 });

    const initOk = ensureAdminInitialized();
    if (!initOk) return NextResponse.json({ error: 'Firebase Admin init failed' }, { status: 500 });

    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    // Sectioned fetch: 'core' renders the profile shell fast (profile, projects,
    // chapters, badges, skills). 'extended' loads heavier sections (certificates,
    // warnings, tasks, myTeam) in the background. No param = everything.
    const sections = new URL(request.url).searchParams.get('sections');
    const wantCore = sections !== 'extended';
    const wantExtended = sections !== 'core';
    const cacheKey = `${userId}:${sections || 'all'}`;

    // Check cache
    const cached = profileCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION * 1000) {
      console.log(`[profile:route] Serving cached profile for ${cacheKey}`);
      return NextResponse.json(cached.data);
    }

    // Optionally authenticate the requester (GET is allowed without auth for public profiles)
    const authResult = await verifyAuthentication(request).catch(() => ({ authenticated: false } as { authenticated: false }));
    const requesterUid: string | null = authResult.authenticated && authResult.user ? authResult.user.userId : null;
    const isDevelopment = process.env.NODE_ENV === 'development';

    console.log(`[profile:route] Starting PARALLEL fetch for user: ${userId}`);

    const result: ProfileData = {
      profile: null,
      projects: [],
      badges: [],
      skills: [],
      chapter: null,
      certificates: [],
      warnings: [],
      tasks: [],
      myTeam: [],
      sectionStatuses: {}
    };

    // -------------------------------------------------------------------------
    // 1. Kick off all independent requests in parallel
    // -------------------------------------------------------------------------

    // A. User Profile (needed for Badges later)
    const profilePromise = wantCore
      ? loadProfileUserSnap(db, userId).then(snap => ({ type: 'profile', snap }))
      : Promise.resolve(null);

    // B. Requester Role (for permissions)
    // Identity migration (M, IDENTITY_DEPENDENCY_MAP.md 5.1): flag ON,
    // the caller's own roles/{requesterUid} read is served from the
    // identity bundle via identity-backend (Supa, with the dispatcher's
    // internal Firestore fallback on Supa throw). Field-consumption
    // audit: downstream consumes ONLY snap.exists and
    // snap.data()?.role (the requesterRoleForProfile computation
    // below) - both inside the bundle roles projection (exists, role).
    // The shim keeps the { type: 'role', snap } shape so downstream
    // code is unchanged in both flag states; a backend throw lands in
    // the same catch as today's Firestore throw (snap null -> member).
    // Flag OFF: the direct Firestore get, byte-identical to before.
    const rolePromise = (wantCore && requesterUid)
      ? (useSupaIdentity()
        ? getIdentityBundleViaBackend(requesterUid)
          .then(bundle => ({
            type: 'role',
            snap: {
              exists: !!bundle.roles?.exists,
              data: () => (bundle.roles?.exists ? { role: bundle.roles.role } : undefined),
            } as any,
          }))
          .catch(() => ({ type: 'role', snap: null as any }))
        : db.collection('roles').doc(requesterUid).get().then(snap => ({ type: 'role', snap })).catch(() => ({ type: 'role', snap: null as any })))
      : Promise.resolve({ type: 'role', snap: null as any });

    // C. Projects (RBT2: seam-first via loadProjectDocs)
    const projectsPromise = wantCore ? (async () => {
      try {
        const docs = await loadProjectDocs(db, userId);
        return { type: 'projects', docs };
      } catch (e) {
        console.error('Project fetch error:', e);
        return { type: 'projects', error: e };
      }
    })() : Promise.resolve(null);

    // D. Certificates (RBT2: seam-first via loadCertificateDocs)
    const certsPromise = wantExtended
      ? loadCertificateDocs(db, userId)
        .then(docs => ({ type: 'certificates', docs }))
        .catch(e => ({ type: 'certificates', error: e }))
      : Promise.resolve(null);

    // E. Warnings (bounded with limit(50) and deliberately NO orderBy:
    // this subcollection holds two shapes — legacy UserWarning docs carry
    // createdAt, but discipline formal warnings (apply-decision strike1)
    // carry issuedAt instead, and a Firestore orderBy silently excludes
    // docs missing the field. limit() alone keeps today's default order
    // and the full set for any realistic warning count; the section
    // catch below is unchanged)
    const warningsPromise = wantExtended
      ? db.collection('users').doc(userId).collection('warnings').limit(50).get()
        .then(snap => ({ type: 'warnings', docs: snap.docs }))
        .catch(e => ({ type: 'warnings', error: e }))
      : Promise.resolve(null);

    // F. Tasks (RBT2: seam-first via loadTaskDocs, union preserved)
    const tasksPromise = wantExtended ? (async () => {
      try {
        const docs = await loadTaskDocs(db, userId);
        return { type: 'tasks', docs };
      } catch (e) { return { type: 'tasks', error: e }; }
    })() : Promise.resolve(null);

    // G. Chapters (RBT2: seam-first via loadChapterDocs)
    const chaptersPromise = wantCore
      ? loadChapterDocs(db)
        .then(docs => ({ type: 'chapters', docs }))
        .catch(e => ({ type: 'chapters', error: e }))
      : Promise.resolve(null);

    // H. MyTeam (Direct Reports) - Optimized BFS with strict limits
    const myTeamPromise = wantExtended ? (async () => {
      const startTime = Date.now();
      const MAX_TIMEOUT_MS = 3000; // 3 second timeout for this operation
      const MAX_RESULTS = 50; // Cap at 50 team members for performance
      const MAX_DEPTH = 3; // Reduced from 10 - covers direct reports + 2 more levels

      try {
        const reports: any[] = [];
        const visited = new Set<string>();
        visited.add(userId);
        let currentLevel = [userId];
        let depth = 0;

        while (currentLevel.length > 0 && depth < MAX_DEPTH) {
          // Check timeout
          if (Date.now() - startTime > MAX_TIMEOUT_MS) {
            console.warn(`[MyTeam] Timeout after ${Date.now() - startTime}ms at depth ${depth}`);
            break;
          }

          // Check max results
          if (reports.length >= MAX_RESULTS) {
            console.log(`[MyTeam] Hit max results limit (${MAX_RESULTS}) at depth ${depth}`);
            break;
          }

          const chunks: string[][] = [];
          for (let i = 0; i < currentLevel.length; i += 10) {
            chunks.push(currentLevel.slice(i, i + 10));
          }

          const results = await Promise.all(chunks.map(async (chunk) => {
            const [relDocs, legacySnap] = await Promise.all([
              loadRelationshipDocs(db, chunk),
              loadUsersByManagerIds(db, chunk)
            ]);
            return { relDocs, legacySnap };
          }));

          const subMap = new Map<string, { type: string, managerId: string }>();
          results.forEach(({ relDocs, legacySnap }) => {
            relDocs.forEach(doc => {
              const subId = doc.data().subordinateId;
              if (subId && !visited.has(subId)) {
                visited.add(subId);
                subMap.set(subId, { type: doc.data().type || 'direct', managerId: doc.data().managerId });
              }
            });
            legacySnap.docs.forEach((doc: any) => {
              if (!visited.has(doc.id) && !subMap.has(doc.id)) {
                visited.add(doc.id);
                subMap.set(doc.id, { type: 'direct', managerId: doc.data().managerId });
              }
            });
          });

          if (subMap.size === 0) break;

          // Only take what we need to stay under limit
          const subIds = Array.from(subMap.keys()).slice(0, MAX_RESULTS - reports.length);
          const subChunks: string[][] = [];
          for (let i = 0; i < subIds.length; i += 10) {
            subChunks.push(subIds.slice(i, i + 10));
          }

          const userSnaps = await Promise.all(subChunks.map(chunk =>
            loadUsersByIds(db, chunk)
          ));

          const nextLevel: string[] = [];
          userSnaps.forEach(snap => {
            snap.docs.forEach((doc: any) => {
              const rel = subMap.get(doc.id);
              if (rel && reports.length < MAX_RESULTS) {
                const d = doc.data();
                reports.push({
                  id: doc.id,
                  displayName: d.displayName || 'Unknown',
                  email: null,
                  photoURL: d.photoURL || null,
                  role: d.displayRole || d.role || 'member',
                  depth,
                  isDirectReport: depth === 0 && rel.type === 'direct',
                  relationType: rel.type
                });
                nextLevel.push(doc.id);
              }
            });
          });

          currentLevel = nextLevel;
          depth++;
        }

        reports.sort((a, b) => {
          if (a.isDirectReport !== b.isDirectReport) return a.isDirectReport ? -1 : 1;
          if (a.depth !== b.depth) return a.depth - b.depth;
          return (a.displayName || '').localeCompare(b.displayName || '');
        });

        console.log(`[MyTeam] Fetched ${reports.length} reports in ${Date.now() - startTime}ms (depth: ${depth})`);
        return { type: 'myTeam', reports };
      } catch (e) {
        console.error('[MyTeam inline fetch] Error:', e);
        return { type: 'myTeam', error: e };
      }
    })() : Promise.resolve(null);


    // -------------------------------------------------------------------------
    // 2. Await Independent Promises with Timing
    // -------------------------------------------------------------------------
    const timingStart = Date.now();

    // Wrap each promise with timing
    const withTiming = async (name: string, promise: Promise<any>) => {
      const start = Date.now();
      const result = await promise;
      console.log(`[profile:timing] ${name}: ${Date.now() - start}ms`);
      return result;
    };

    const [
      profileRes,
      roleRes,
      projectsRes,
      certsRes,
      warningsRes,
      tasksRes,
      chaptersRes,
      myTeamRes
    ] = await Promise.all([
      withTiming('profile', profilePromise),
      withTiming('role', rolePromise),
      withTiming('projects', projectsPromise),
      withTiming('certificates', certsPromise),
      withTiming('warnings', warningsPromise),
      withTiming('tasks', tasksPromise),
      withTiming('chapters', chaptersPromise),
      withTiming('myTeam', myTeamPromise)
    ]);

    console.log(`[profile:timing] Total parallel fetch: ${Date.now() - timingStart}ms`);

    // Permission check for sensitive fields (computed once, reused below)
    const isProfileOwner = isDevelopment || (requesterUid === userId);
    const requesterRoleForProfile = (roleRes.snap && roleRes.snap.exists) ? (roleRes.snap.data()?.role || 'member') : 'member';
    const isProfileAdmin = hasSufficientRole(requesterRoleForProfile as any, 'president_chapter' as any);

    // Reports contact serialization: emails come from the gated contact
    // store and are exposed only to the profile owner or an admin.
    if (wantExtended && Array.isArray((myTeamRes as any)?.reports) && (myTeamRes as any).reports.length > 0) {
      if (isProfileOwner || isProfileAdmin) {
        try {
          const reportEmails = await resolveUserEmails(db, (myTeamRes as any).reports.map((r: any) => r.id));
          for (const r of (myTeamRes as any).reports) r.email = reportEmails.get(r.id) ?? null;
        } catch { /* reports keep email: null on resolution failure */ }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Process Profile & Role (Standard Logic)
    // -------------------------------------------------------------------------
    if (wantCore && profileRes && profileRes.snap && profileRes.snap.exists) {
      const data = stripContactFields(profileRes.snap.data());
      const profileOwnerRole = data?.displayRole || 'member';

      const baseProfile = {
        uid: userId,
        displayName: data?.displayName || '',
        bio: data?.bio || '',
        githubUrl: data?.githubUrl || '',
        linkedinUrl: data?.linkedinUrl || '',
        university: data?.university || '',
        fieldOfStudy: data?.fieldOfStudy || '',
        photoURL: data?.photoURL || null,
        bannerURL: data?.bannerURL || null,
        points: data?.points || 0,
        badges: Array.isArray(data?.badges) ? data.badges.filter((b: any) => typeof b === 'string').slice(0, 100) : [],
        skillIds: Array.isArray(data?.skillIds) ? data.skillIds.filter((s: any) => typeof s === 'string').slice(0, 30) : [],
        chapterId: data?.chapterId || undefined,
        tasksAssignedCount: data?.tasksAssignedCount || 0,
        tasksCompletedOnTimeCount: data?.tasksCompletedOnTimeCount || 0,
        totalHoursWorked: data?.totalHoursWorked || 0,
        termsAccepted: !!data?.termsAccepted || !!data?.agreedToTermsAt || !!data?.termsAgreementTimestamp,
        termsAcceptedAt: data?.termsAcceptedAt || data?.agreedToTermsAt || data?.termsAgreementTimestamp || null,
        agreedToToTermsVersion: data?.agreedToTermsVersion || null,
        eventsAttended: Array.isArray(data?.eventsAttended) ? data.eventsAttended : [],
        role: profileOwnerRole,
        // WS3: explicit username slug for /u/:username (null until set).
        username: typeof data?.username === 'string' ? data.username : null,
        // Privacy shielding (spec section 5): effective public directory
        // opt-in (explicit flag, else role-based default). Not PII, safe to
        // expose to any viewer; the public hub reads this exact field name.
        publicDirectoryOptIn: resolvePublicDirectoryOptIn({
          publicDirectoryOptIn: data?.publicDirectoryOptIn,
          role: data?.role,
          displayRole: data?.displayRole,
        }),
      } as any;

      if (isProfileOwner || isProfileAdmin) {
        baseProfile.email = (await resolveUserEmail(db, userId)) || '';
        const ownContact = await getUserContact(db, userId);
        baseProfile.whatsappNumber = ownContact?.whatsappNumber ?? ownContact?.whatsapp ?? '';
      }

      result.profile = baseProfile;
      result.sectionStatuses.profile = { success: true };
    } else {
      result.sectionStatuses.profile = { success: false, error: 'User not found', errorCode: 'profile_not_found' };
    }

    // -------------------------------------------------------------------------
    // 4. Process Aux Data
    // -------------------------------------------------------------------------

    // Projects
    if (wantCore && (projectsRes as any)?.error) {
      result.sectionStatuses.projects = { success: false, error: String((projectsRes as any).error) };
    } else {
      result.projects = ((projectsRes as any)?.docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
      result.sectionStatuses.projects = { success: true };
    }

    // Certificates
    if (wantExtended && (certsRes as any)?.error) {
      result.sectionStatuses.certificates = { success: false, error: String((certsRes as any).error) };
    } else {
      result.certificates = ((certsRes as any)?.docs || []).map((d: any) => ({
        id: d.id, ...d.data(), issueDate: d.data()?.issueDate?.toDate?.() || null
      }));
      result.sectionStatuses.certificates = { success: true };
    }

    // Warnings: disciplinary records are only visible to the owner or admins.
    if (wantExtended && (warningsRes as any)?.error) {
      result.sectionStatuses.warnings = { success: false, error: String((warningsRes as any).error) };
    } else if (wantExtended && !(isProfileOwner || isProfileAdmin)) {
      result.warnings = [];
      result.sectionStatuses.warnings = { success: true };
    } else {
      const now = Date.now();
      result.warnings = ((warningsRes as any)?.docs || [])
        .map((d: any) => ({
          id: d.id, ...d.data(),
          expiresAt: d.data()?.expiresAt?.toDate?.() || null,
          createdAt: d.data()?.createdAt?.toDate?.() || null
        }))
        .filter((w: any) => !w.expiresAt || w.expiresAt.getTime() > now);
      result.sectionStatuses.warnings = { success: true };
    }

    // Tasks
    if (wantExtended && (tasksRes as any)?.error) {
      result.sectionStatuses.tasks = { success: false, error: String((tasksRes as any).error) };
    } else {
      result.tasks = ((tasksRes as any)?.docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
      result.sectionStatuses.tasks = { success: true };
    }

    // Chapters
    if (wantCore && (chaptersRes as any)?.error) {
      result.sectionStatuses.chapter = { success: false, error: String((chaptersRes as any).error) };
    } else {
      const chapters = ((chaptersRes as any)?.docs || []).map((d: any) => ({ id: d.id, name: d.data()?.name || '' }));
      let chapterName = null;
      if (result.profile?.chapterId) {
        chapterName = chapters.find((c: any) => c.id === result.profile?.chapterId)?.name || null;
      }
      result.chapter = {
        id: result.profile?.chapterId,
        name: chapterName,
        allChapters: chapters
      };
      result.sectionStatuses.chapter = { success: true };
    }

    // MyTeam
    if (wantExtended && (myTeamRes as any)?.error) {
      result.sectionStatuses.myTeam = { success: false, error: String((myTeamRes as any).error) };
    } else {
      result.myTeam = (myTeamRes as any)?.reports || [];
      result.sectionStatuses.myTeam = { success: true };
    }

    // -------------------------------------------------------------------------
    // 5. Dependent Request: Badges and Skills (Needs Profile)
    // -------------------------------------------------------------------------
    const dependentPromises = [];

    if (wantCore && result.profile?.badges?.length > 0) {
      const badgeSlugs = result.profile.badges.slice(0, 10);
      dependentPromises.push(
        (async () => {
          // RBT2 (also census 09 item 2): the gamification seam's
          // badge-definitions list (11 defs) filtered in memory
          // replaces the Firestore `slug in [...]` query. A seam miss
          // runs the Firestore query byte-identically.
          const defs = await listBadgeDefinitionsFromSupa();
          if (defs) {
            const wanted = new Set(badgeSlugs);
            result.badges = defs
              .filter((d: any) => wanted.has(d?.slug))
              .map((d: any) => ({ slug: d.slug, name: d.name, imageUrl: d.imageUrl }));
            result.sectionStatuses.badges = { success: true };
            return;
          }
          const badgesSnap = await db.collection('badges').where('slug', 'in', badgeSlugs).get();
          result.badges = badgesSnap.docs.map((doc: any) => ({
            slug: doc.data()?.slug,
            name: doc.data()?.name,
            imageUrl: doc.data()?.imageUrl
          }));
          result.sectionStatuses.badges = { success: true };
        })()
          .catch((e) => {
            console.error('Badges fetch error:', e);
            result.sectionStatuses.badges = { success: false, error: 'Failed to fetch badges' };
          })
      );
    } else {
      result.sectionStatuses.badges = { success: true };
    }

    if (wantCore && result.profile?.skillIds?.length > 0) {
      const skillIds = result.profile.skillIds.slice(0, 30);
      dependentPromises.push(
        (async () => {
          // RBT2: seam-first via tryGetSkillsByIds (surface 'skills').
          const supa = await tryGetSkillsByIds(skillIds);
          if (supa.status === 'ok') {
            result.skills = buildSkillEntries(skillIds, supa.value.docs);
            result.sectionStatuses.skills = { success: true };
            return;
          }
          const skillsSnap = await db.collection('skills').where(admin.firestore.FieldPath.documentId(), 'in', skillIds).get();
          result.skills = buildSkillEntries(skillIds, skillsSnap.docs);
          result.sectionStatuses.skills = { success: true };
        })()
          .catch((e) => {
            console.error('Skills fetch error:', e);
            result.sectionStatuses.skills = { success: false, error: 'Failed to fetch skills' };
          })
      );
    } else {
      result.sectionStatuses.skills = { success: true };
    }

    await Promise.all(dependentPromises);

    // -------------------------------------------------------------------------
    // 6. Finish
    // -------------------------------------------------------------------------
    profileCache.set(cacheKey, { data: result, timestamp: Date.now() });

    console.log(`[profile:route] Completed [${sections || 'all'}] in ${Date.now() - startTime}ms`);

    // Add cache headers for browser caching
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, max-age=30, stale-while-revalidate=60',
      }
    });

  } catch (error) {
    console.error('[profile:route] Critical error:', error);
    return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 });
  }
}

// Clean up cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of profileCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 1000) {
      profileCache.delete(key);
    }
  }
}, 30000);

// KEEP PATCH METHOD AS IS (It was fine, generally single-write)

// Display names are interpolated verbatim into AI prompts elsewhere in the
// app, so they are capped in length and stripped of control characters on
// write to block prompt-injection text smuggled through profile edits.
const DISPLAY_NAME_MAX_LENGTH = 60;

function sanitizeDisplayName(raw: string): string {
  return raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params;
    const authResult = await verifyAuthentication(request);
    if (!authResult.authenticated) {
      return NextResponse.json({ error: authResult.error || 'Unauthorized' }, { status: 401 });
    }
    const requesterUid = authResult.user!.userId;
    const requesterRole = authResult.user!.role || 'member';
    if (!userId) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }
    const isOwner = requesterUid === userId;
    const isAdmin = hasSufficientRole(requesterRole as any, 'superadmin' as any);
    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const payload = await request.json().catch(() => ({}));
    const allowed: Record<string, any> = {};
    const fields = [
      'displayName',
      'bio',
      'githubUrl',
      'linkedinUrl',
      'university',
      'fieldOfStudy',
      'chapterId',
      'photoURL',
      'bannerURL',
      'username',
      'publicDirectoryOptIn'
    ];
    for (const key of fields) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        const v = payload[key];
        if (typeof v === 'string') {
          if (key === 'displayName') {
            const clean = sanitizeDisplayName(v);
            if (clean === '') {
              allowed[key] = null;
            } else if (clean.length > DISPLAY_NAME_MAX_LENGTH) {
              return NextResponse.json(
                { error: 'displayName must be 60 characters or fewer' },
                { status: 400 }
              );
            } else {
              allowed[key] = clean;
            }
          } else if (key === 'username') {
            // WS3 public portfolio: username slug, 3-40 chars, lowercase-dash.
            const slug = String(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (slug && !/^[a-z0-9-]{3,40}$/.test(slug)) {
              return NextResponse.json({ error: 'username must be 3-40 characters of a-z, 0-9 and -' }, { status: 400 });
            }
            allowed[key] = slug === '' ? null : slug;
          } else {
            allowed[key] = v.trim() === '' ? null : v;
          }
        } else if (key === 'publicDirectoryOptIn') {
          // WS3 shared-field decision: boolean flag, Privacy workstream may
          // later surface it in their UI; the server route is the write path.
          if (typeof v !== 'boolean') {
            return NextResponse.json({ error: 'publicDirectoryOptIn must be a boolean' }, { status: 400 });
          }
          allowed[key] = v;
        } else if (v === null) {
          allowed[key] = null;
        }
      }
    }
    // Privacy shielding (spec section 5): public directory opt-in flag.
    if (typeof payload.publicDirectoryOptIn === 'boolean') {
      allowed.publicDirectoryOptIn = payload.publicDirectoryOptIn;
    }
    // Name-search keywords index (directory option (c)): whenever a
    // displayName write lands here (owner profile edit or admin edit -
    // both ride this PATCH), the index is rebuilt in the same write.
    // A cleared name (null) clears the index with it.
    if (Object.prototype.hasOwnProperty.call(allowed, 'displayName')) {
      allowed.nameSearchKeywords = buildNameSearchKeywords(
        typeof allowed.displayName === 'string' ? allowed.displayName : '',
      );
    }
    allowed.updatedAt = Timestamp.now();
    const db = getDb();
    if (!db || typeof db.collection !== 'function') {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }
    // Contact fields leave the user-doc write path entirely: a
    // whatsappNumber/whatsapp payload value goes to the gated contact
    // record via the doorway, never to the public user document.
    const contactWhatsapp = typeof payload.whatsappNumber === 'string' ? payload.whatsappNumber
      : typeof payload.whatsapp === 'string' ? payload.whatsapp : undefined;
    if (contactWhatsapp !== undefined) {
      await setUserContact(db, userId, { whatsappNumber: contactWhatsapp });
    }
    for (const k of ['email', 'email_lowercase', 'whatsapp', 'whatsappNumber', 'phone', 'phoneNumber', 'contactNumber', 'cnic', 'address']) delete allowed[k];
    // WRITE PRIMACY (G-USER-1, U-05): adapter set primary (loud)
    // under isSupaPrimary('users'); Firestore set demoted to
    // best-effort reverse mirror. Non-primary: byte-identical.
    if (await identityPrimaryFlagOn('users')) {
      await primaryIdentitySet('users', 'users', userId, allowed, { merge: true });
      try {
        await db.collection('users').doc(userId).set(allowed, { merge: true });
      } catch (mirrorErr) {
        console.error('[profile] Firestore reverse mirror failed after Supa primary commit:', mirrorErr);
      }
    } else {
      await db.collection('users').doc(userId).set(allowed, { merge: true });
    }
    // Read-Burn A (§2.5 W17): the allowlist includes chapterId, an
    // identity-projection field; bust the identity cache alongside
    // the profileCache bust below.
    bustIdentity(userId);
    try {
      for (const key of profileCache.keys()) {
        if (key === userId || key.startsWith(`${userId}:`)) profileCache.delete(key);
      }
    } catch { }
    const snap = await db.collection('users').doc(userId).get();
    const data = snap.data() || {};
    const patchContact = await getUserContact(db, userId);
    const updatedRole = data?.displayRole || 'member';

    const response = {
      profile: {
        uid: userId,
        email: (await resolveUserEmail(db, userId)) || '',
        displayName: data.displayName || '',
        bio: data.bio || '',
        githubUrl: data.githubUrl || '',
        linkedinUrl: data.linkedinUrl || '',
        whatsappNumber: patchContact?.whatsappNumber ?? patchContact?.whatsapp ?? '',
        university: data.university || '',
        fieldOfStudy: data.fieldOfStudy || '',
        photoURL: data.photoURL || null,
        bannerURL: data.bannerURL || null,
        points: data.points || 0,
        badges: Array.isArray(data.badges) ? data.badges.filter((b: any) => typeof b === 'string').slice(0, 100) : [],
        chapterId: data.chapterId || undefined,
        tasksAssignedCount: data.tasksAssignedCount || 0,
        tasksCompletedOnTimeCount: data.tasksCompletedOnTimeCount || 0,
        totalHoursWorked: data.totalHoursWorked || 0,
        eventsAttended: Array.isArray(data.eventsAttended) ? data.eventsAttended : [],
        role: updatedRole,
        publicDirectoryOptIn: resolvePublicDirectoryOptIn({
          publicDirectoryOptIn: data.publicDirectoryOptIn,
          role: data.role,
          displayRole: data.displayRole,
        }),
      }
    };
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Update failed' }, { status: 500 });
  }
}
