/**
 * POST /api/admin/site-settings/mirror — fire-and-forget Supabase mirror
 * for the site-wide settings editor (settings/siteWide -> fs_settings).
 *
 * The editor writes Firestore directly from the client, so its mirror
 * crosses here. Firestore stays primary: this route only mirrors an
 * already-succeeded write, and a mirror failure still returns 200
 * { mirrored: false } — invisible to the component, which ignores the
 * result entirely. Auth posture matches the other /api/admin settings
 * routes: authenticated + canManageUsers (the discipline-settings PUT
 * gate).
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { mirrorSettingsDoc } from '@/lib/server/settings-mirror';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (
      !(await hasServerPermissionForUser(
        getDb()!,
        (auth.user as any).userId,
        'canManageUsers',
      ))
    ) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions to manage site settings' },
        { status: 403 },
      );
    }
    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const body = await req.json().catch(() => null);
    if (!body || body.doc !== 'siteWide') {
      return NextResponse.json(
        { error: 'Bad request', message: "doc must be 'siteWide'" },
        { status: 400 },
      );
    }
    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json(
        { error: 'Bad request', message: 'payload must be an object' },
        { status: 400 },
      );
    }

    const mirrored = await mirrorSettingsDoc(
      'settings',
      'siteWide',
      payload as Record<string, unknown>,
    ).catch(() => false);
    return NextResponse.json({ success: true, mirrored });
  } catch (err: any) {
    console.error('[api/admin/site-settings/mirror POST]', err);
    return NextResponse.json(
      { error: 'INTERNAL', message: err?.message || 'Internal error' },
      { status: 500 },
    );
  }
}
