import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import {
  projectsSupaServerEnabled,
  selectProjectList,
  supaFindProjectBySlugOrId,
  supaListProjects,
  supaSetProject,
  type ProjectListSelection,
} from '@/lib/projects-supa';

/**
 * GET /api/projects — the projects read for client callers, served
 * from fs_projects through the Supabase adapter
 * (src/lib/projects-supa.ts bridge over src/lib/supa).
 *
 * Contract (assumed by the seam's client fetchers):
 *   list:   200 { projects: ProjectSupaDoc[] }
 *   single: 200 { project: ProjectSupaDoc | null }   (?slugOrId=)
 *
 * Gating: the route serves only when the server flag names the
 * projects surface (SUPA_SURFACES via useSupa('projects'));
 * otherwise 404, and every client falls back to its Firestore
 * path — so flag OFF is byte-identical to the pre-migration app.
 * Adapter failures surface as 503, which clients likewise treat as
 * "fall back", never as an empty list.
 *
 * Viewer resolution mirrors the client queries it replaces: no
 * credentials -> the guest viewer (the status/published filter the
 * public page and useProjects apply for signed-out visitors, via
 * the seam's selectProjectList); a valid token -> the member viewer
 * (unfiltered, exactly what the signed-in client queries return).
 * A presented token that fails verification is a 401, not a silent
 * downgrade — the client asked for a signed-in read and must fall
 * back rather than render a narrowed set as if it were complete.
 * (firestore.rules allow read/list on projects to everyone; the
 * guest filter is the client code's behavior contract, replicated
 * here, not a security boundary. The single-doc read applies no
 * viewer filter, exactly like getProjectBySlugOrId.)
 *
 * Query params (list): published=1, featured=1,
 * featuredOnRecruitment=1, featuredOnSponsorship=1, category=<c>,
 * limit=<n> — the seam's ProjectListSelection fields.
 */

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!projectsSupaServerEnabled()) {
    return NextResponse.json(
      { error: 'Projects Supabase surface is not enabled' },
      { status: 404 },
    );
  }

  let viewer: 'guest' | 'member' = 'guest';
  const presentedCredentials =
    req.headers.get('authorization') !== null ||
    req.cookies.get('__session') !== undefined;
  if (presentedCredentials) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    viewer = 'member';
  }

  const params = req.nextUrl.searchParams;

  try {
    const slugOrId = params.get('slugOrId');
    if (slugOrId) {
      const project = await supaFindProjectBySlugOrId(slugOrId);
      return NextResponse.json({ project });
    }

    const selection: ProjectListSelection = { viewer };
    if (params.get('published') === '1') selection.publishedOnly = true;
    if (params.get('featured') === '1') selection.featuredOnly = true;
    if (params.get('featuredOnRecruitment') === '1') {
      selection.featuredOnRecruitment = true;
    }
    if (params.get('featuredOnSponsorship') === '1') {
      selection.featuredOnSponsorship = true;
    }
    const category = params.get('category');
    if (category) selection.category = category;
    const limitRaw = params.get('limit');
    if (limitRaw !== null) {
      const limitCount = Number.parseInt(limitRaw, 10);
      if (Number.isFinite(limitCount) && limitCount > 0) {
        selection.limit = limitCount;
      }
    }

    const docs = await supaListProjects();
    const projects = selectProjectList(docs, selection);
    return NextResponse.json({ projects });
  } catch (err) {
    console.error('[api/projects] Supabase read failed:', err);
    return NextResponse.json(
      { error: 'Projects read unavailable' },
      { status: 503 },
    );
  }
}

/**
 * POST /api/projects — WS10 primary-write route for the public
 * project-create flow (src/lib/client-actions.ts addProjectClient,
 * previously a client addDoc through firestore-wrapper + a
 * best-effort mirror route call).
 *
 * Unlike GET, this write is NOT flag-gated: Firestore is the primary
 * writer in both flag states (the projects surface is not flipped),
 * and the mirror runs best-effort only when the surface is enabled —
 * the exact posture mirrorProjectCreateBestEffort had. Gate: any
 * verified session (the Firestore rules posture the client write
 * relied on: a signed-in user creating a project).
 * Body: { data, timestampFields? } — timestampFields names the
 * client's serverTimestamp() fields (created_at / updated_at).
 */
export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, any>)
      : null;
  if (!data || typeof data.title !== 'string' || typeof data.slug !== 'string') {
    return NextResponse.json({ error: 'Invalid project data' }, { status: 400 });
  }
  const timestampFields: string[] = Array.isArray(body.timestampFields)
    ? body.timestampFields.filter((f: unknown): f is string => typeof f === 'string')
    : [];
  const nowIso = new Date().toISOString();
  const firestoreData: Record<string, any> = { ...data };
  const mirrorData: Record<string, any> = { ...data };
  for (const field of timestampFields) {
    firestoreData[field] = FieldValue.serverTimestamp();
    mirrorData[field] = nowIso;
  }

  const docRef = await db.collection('projects').add(firestoreData);

  if (projectsSupaServerEnabled()) {
    try {
      await supaSetProject(docRef.id, mirrorData);
    } catch (err) {
      console.error('[api/projects] mirror failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, id: docRef.id }, { status: 201 });
}
