import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasSufficientRole } from '@/lib/roles';

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
      ? db.collection('users').doc(userId).get().then(snap => ({ type: 'profile', snap }))
      : Promise.resolve(null);

    // B. Requester Role (for permissions)
    const rolePromise = (wantCore && requesterUid)
      ? db.collection('roles').doc(requesterUid).get().then(snap => ({ type: 'role', snap })).catch(() => ({ type: 'role', snap: null as any }))
      : Promise.resolve({ type: 'role', snap: null as any });

    // C. Projects
    const projectsPromise = wantCore ? (async () => {
      try {
        // Try new schema first
        const s1 = await db.collection('projects').where('teamMemberIds', 'array-contains', userId).limit(5).get();
        if (!s1.empty) return { type: 'projects', docs: s1.docs };
        // Fallback
        const s2 = await db.collection('projects').where('team', 'array-contains', userId).limit(5).get();
        return { type: 'projects', docs: s2.docs };
      } catch (e) {
        console.error('Project fetch error:', e);
        return { type: 'projects', error: e };
      }
    })() : Promise.resolve(null);

    // D. Certificates
    const certsPromise = wantExtended
      ? db.collection('certificates').where('userId', '==', userId).limit(100).get()
        .then(snap => ({ type: 'certificates', docs: snap.docs }))
        .catch(e => ({ type: 'certificates', error: e }))
      : Promise.resolve(null);

    // E. Warnings
    const warningsPromise = wantExtended
      ? db.collection('users').doc(userId).collection('warnings').get()
        .then(snap => ({ type: 'warnings', docs: snap.docs }))
        .catch(e => ({ type: 'warnings', error: e }))
      : Promise.resolve(null);

    // F. Tasks
    const tasksPromise = wantExtended ? (async () => {
      try {
        const s1 = await db.collection('tasks').where('assigneeId', '==', userId).limit(100).get();
        if (!s1.empty) return { type: 'tasks', docs: s1.docs };
        const s2 = await db.collection('tasks').where('assigneeIds', 'array-contains', userId).limit(100).get();
        return { type: 'tasks', docs: s2.docs };
      } catch (e) { return { type: 'tasks', error: e }; }
    })() : Promise.resolve(null);

    // G. Chapters
    const chaptersPromise = wantCore
      ? db.collection('chapters').where('isActive', '==', true).limit(100).get()
        .then(snap => ({ type: 'chapters', docs: snap.docs }))
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
            const [relSnap, legacySnap] = await Promise.all([
              db.collection('reporting_relationships').where('managerId', 'in', chunk).get(),
              db.collection('users').where('managerId', 'in', chunk).get()
            ]);
            return { relSnap, legacySnap };
          }));

          const subMap = new Map<string, { type: string, managerId: string }>();
          results.forEach(({ relSnap, legacySnap }) => {
            relSnap.docs.forEach(doc => {
              const subId = doc.data().subordinateId;
              if (subId && !visited.has(subId)) {
                visited.add(subId);
                subMap.set(subId, { type: doc.data().type || 'direct', managerId: doc.data().managerId });
              }
            });
            legacySnap.docs.forEach(doc => {
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
            db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get()
          ));

          const nextLevel: string[] = [];
          userSnaps.forEach(snap => {
            snap.docs.forEach(doc => {
              const rel = subMap.get(doc.id);
              if (rel && reports.length < MAX_RESULTS) {
                const d = doc.data();
                reports.push({
                  id: doc.id,
                  displayName: d.displayName || 'Unknown',
                  email: d.email || null,
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

    // -------------------------------------------------------------------------
    // 3. Process Profile & Role (Standard Logic)
    // -------------------------------------------------------------------------
    if (wantCore && profileRes && profileRes.snap && profileRes.snap.exists) {
      const data = profileRes.snap.data();
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
      } as any;

      if (isProfileOwner || isProfileAdmin) {
        baseProfile.email = data?.email || '';
        baseProfile.whatsappNumber = data?.whatsappNumber || '';
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
        db.collection('badges').where('slug', 'in', badgeSlugs).get()
          .then((badgesSnap) => {
            result.badges = badgesSnap.docs.map((doc: any) => ({
              slug: doc.data()?.slug,
              name: doc.data()?.name,
              imageUrl: doc.data()?.imageUrl
            }));
            result.sectionStatuses.badges = { success: true };
          })
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
        db.collection('skills').where(admin.firestore.FieldPath.documentId(), 'in', skillIds).get()
          .then((skillsSnap) => {
            result.skills = skillsSnap.docs.map((doc: any) => ({
              id: doc.id,
              name: doc.data()?.name || doc.id,
              slug: doc.data()?.slug || doc.id,
              category: doc.data()?.category || ''
            }));
            result.sectionStatuses.skills = { success: true };
          })
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
      'whatsappNumber',
      'university',
      'fieldOfStudy',
      'chapterId',
      'photoURL',
      'bannerURL'
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
          } else {
            allowed[key] = v.trim() === '' ? null : v;
          }
        } else if (v === null) {
          allowed[key] = null;
        }
      }
    }
    allowed.updatedAt = Timestamp.now();
    const db = getDb();
    if (!db || typeof db.collection !== 'function') {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }
    await db.collection('users').doc(userId).set(allowed, { merge: true });
    try {
      for (const key of profileCache.keys()) {
        if (key === userId || key.startsWith(`${userId}:`)) profileCache.delete(key);
      }
    } catch { }
    const snap = await db.collection('users').doc(userId).get();
    const data = snap.data() || {};
    const updatedRole = data?.displayRole || 'member';

    const response = {
      profile: {
        uid: userId,
        email: data.email || '',
        displayName: data.displayName || '',
        bio: data.bio || '',
        githubUrl: data.githubUrl || '',
        linkedinUrl: data.linkedinUrl || '',
        whatsappNumber: data.whatsappNumber || '',
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
      }
    };
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Update failed' }, { status: 500 });
  }
}
