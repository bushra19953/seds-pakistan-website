/**
 * GET/PUT /api/admin/discipline-settings - the settings/discipline doc
 * (spec E.6.3, E.9), exposed for the Discipline Settings tab in
 * /admin/discipline.
 *
 * Before the discipline consolidation this doc had NO admin UI at all:
 * the cutover switches (shadowMode, cronReferralLive) and the registry
 * variant could only be changed in the Firestore console. Reads use
 * getDisciplineSettings so the response always carries the fail-safe
 * defaults. Writes are validated field by field and merged, so a
 * partial body can never blank a switch.
 *
 * Gates mirror the screens this API serves: any admin may read
 * (canAccessAdmin, the /admin/discipline nav gate); writes require
 * canManageUsers, the gate the retired /admin/warning-settings page
 * used for the warning policy it sat beside.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
    DEFAULT_DISCIPLINE_SETTINGS,
    getDisciplineSettings,
    type DisciplineSettings,
} from '@/lib/server/discipline/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function callerRole(auth: any): string {
    return (auth.user as any).role || '';
}

export async function GET(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (!(await hasServerPermissionForUser(getDb()!, (auth.user as any).userId, 'canAccessAdmin'))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const settings = await getDisciplineSettings(db);
        return NextResponse.json({ success: true, settings });
    } catch (err: any) {
        console.error('[api/admin/discipline-settings GET]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}

function validate(body: any): { ok: true; value: DisciplineSettings } | { ok: false; message: string } {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Body must be an object' };
    const { shadowMode, cronReferralLive, referralWindowDays, referralMissThreshold, warningRegistryVariant } = body;
    if (typeof shadowMode !== 'boolean') return { ok: false, message: 'shadowMode must be a boolean' };
    if (typeof cronReferralLive !== 'boolean') return { ok: false, message: 'cronReferralLive must be a boolean' };
    if (!Number.isInteger(referralWindowDays) || referralWindowDays < 1 || referralWindowDays > 365) {
        return { ok: false, message: 'referralWindowDays must be an integer between 1 and 365' };
    }
    if (!Number.isInteger(referralMissThreshold) || referralMissThreshold < 1 || referralMissThreshold > 20) {
        return { ok: false, message: 'referralMissThreshold must be an integer between 1 and 20' };
    }
    if (warningRegistryVariant !== 'retired' && warningRegistryVariant !== 'internal') {
        return { ok: false, message: "warningRegistryVariant must be 'retired' or 'internal'" };
    }
    return {
        ok: true,
        value: { shadowMode, cronReferralLive, referralWindowDays, referralMissThreshold, warningRegistryVariant },
    };
}

export async function PUT(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (!(await hasServerPermissionForUser(getDb()!, (auth.user as any).userId, 'canManageUsers'))) {
            return NextResponse.json({ error: 'Forbidden: Insufficient permissions to manage discipline settings' }, { status: 403 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const body = await req.json().catch(() => null);
        const checked = validate(body);
        if (!checked.ok) {
            return NextResponse.json({ error: 'Bad request', message: checked.message }, { status: 400 });
        }

        const uid = String((auth.user as any).userId || (auth.user as any).uid || '');
        await db
            .collection('settings')
            .doc('discipline')
            .set(
                {
                    ...checked.value,
                    updatedAt: new Date().toISOString(),
                    updatedBy: uid,
                },
                { merge: true },
            );

        return NextResponse.json({ success: true, settings: checked.value, defaults: DEFAULT_DISCIPLINE_SETTINGS });
    } catch (err: any) {
        console.error('[api/admin/discipline-settings PUT]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
