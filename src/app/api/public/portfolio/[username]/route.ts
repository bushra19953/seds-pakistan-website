/**
 * WS3 — GET /api/public/portfolio/[username]
 *
 * Public member portfolio for /u/:username. Sanitised by construction:
 * - Only members who opted into the public directory are resolvable
 *   (shared-field decision: `publicDirectoryOptIn` boolean on users/{uid},
 *   default false, executives default true). The field is only checked on
 *   this server route; clients can never bypass it.
 * - The response carries a sanitised profile, public telemetry aggregates
 *   (counts only), a proof-free mission timeline, and sanitised
 *   certificates. Never warnings, never contact fields.
 *
 * Username resolution order:
 * 1. users where username == <slug>
 * 2. users doc id == <raw username> (supports /u/<uid>)
 * 3. best-effort slug-of-displayName scan (bounded, 500 docs)
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import {
  buildMissionTimeline,
  computeTelemetry,
  resolvePublicDirectoryOptIn,
  sanitizeCertificateForVault,
  sanitizePublicProfile,
  slugifyUsername,
  toPublicTimeline,
  usernameForUser,
  type AnyRecord,
} from '@/lib/profile-hub/telemetry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_SLUG_SCAN = 500;

export async function resolvePortfolioUser(
  db: any,
  rawUsername: string,
): Promise<{ uid: string; data: AnyRecord } | null> {
  const slug = slugifyUsername(rawUsername);
  if (!slug) return null;

  // 1. Canonical: explicit username field.
  const byUsername = await db.collection('users').where('username', '==', slug).limit(1).get();
  if (!byUsername.empty) {
    const doc = byUsername.docs[0];
    return { uid: doc.id, data: (doc.data() as AnyRecord) || {} };
  }

  // 2. UID fallback: /u/<uid> keeps working for users without a username yet.
  const byUid = await db.collection('users').doc(rawUsername).get();
  if (byUid.exists) {
    return { uid: byUid.id, data: (byUid.data() as AnyRecord) || {} };
  }

  // 3. Display-name slug scan (bounded). Handles users created before
  // usernames existed; ambiguous slugs resolve to the most recently updated.
  const scan = await db.collection('users').orderBy('updatedAt', 'desc').limit(MAX_SLUG_SCAN).get();
  for (const doc of scan.docs) {
    const data = (doc.data() as AnyRecord) || {};
    if (usernameForUser(data) === slug) return { uid: doc.id, data };
  }
  return null;
}

function docToTask(doc: { id: string; data: () => any }): AnyRecord {
  const data = doc.data() || {};
  return { id: doc.id, ...data };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const { username } = await params;
  if (!username) return NextResponse.json({ error: 'Username is required' }, { status: 400 });

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 500 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 500 });

  try {
    const resolved = await resolvePortfolioUser(db, decodeURIComponent(username));
    if (!resolved) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Privacy gate: non-opted-in members do not exist to this route.
    if (!resolvePublicDirectoryOptIn(resolved.data)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const [s1, s2] = await Promise.all([
      db.collection('tasks').where('assigneeId', '==', resolved.uid).limit(200).get(),
      db.collection('tasks').where('assigneeIds', 'array-contains', resolved.uid).limit(200).get(),
    ]);
    const seen = new Set<string>();
    const tasks: AnyRecord[] = [];
    for (const snap of [s1, s2]) {
      for (const d of snap.docs) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        tasks.push(docToTask(d));
      }
    }
    const telemetry = computeTelemetry({ tasks, counters: resolved.data });
    const timeline = toPublicTimeline(buildMissionTimeline(tasks));

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_BASE_URL || '';
    let certificates: AnyRecord[] = [];
    try {
      const certSnap = await db
        .collection('certificates')
        .where('userId', '==', resolved.uid)
        .limit(100)
        .get();
      certificates = certSnap.docs.map((d: any) =>
        sanitizeCertificateForVault({ id: d.id, ...(d.data() || {}) }, baseUrl),
      );
    } catch (e) {
      console.warn('[public-portfolio:route] certificates fetch failed:', e instanceof Error ? e.message : e);
    }

    // Skill labels for display; failures degrade to raw skill ids.
    const profile = sanitizePublicProfile(resolved.data, resolved.uid);
    const skillNames: Record<string, string> = {};
    if (profile.skillIds.length > 0) {
      try {
        const chunks: string[][] = [];
        for (let i = 0; i < profile.skillIds.length; i += 10) {
          chunks.push(profile.skillIds.slice(i, i + 10));
        }
        const snaps = await Promise.all(
          chunks.map((chunk) =>
            db.collection('skills').where('__name__', 'in', chunk).get(),
          ),
        );
        for (const snap of snaps) {
          for (const d of snap.docs) {
            const data = d.data() || {};
            skillNames[d.id] = String(data.name || data.slug || d.id);
          }
        }
      } catch (e) {
        console.warn('[public-portfolio:route] skills fetch failed:', e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json(
      {
        profile,
        skillNames,
        telemetry: {
          tasksAssigned: telemetry.tasksAssigned,
          tasksCompleted: telemetry.tasksCompleted,
          onTimeRate: telemetry.onTimeRate,
          loggedHours: telemetry.loggedHours,
          totalPoints: telemetry.totalPoints,
          qualityIndex: telemetry.qualityIndex,
          qualityIndexBasis: telemetry.qualityIndexBasis,
        },
        missionTimeline: timeline,
        certificates,
      },
      { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' } },
    );
  } catch (error) {
    console.error('[public-portfolio:route] error:', error);
    return NextResponse.json({ error: 'Failed to load portfolio' }, { status: 500 });
  }
}
