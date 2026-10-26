import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { syncDirectRelationship } from '@/lib/server/hierarchy';
import {
    identityPrimaryFlagOn,
    primaryIdentitySet,
    primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';

import { isCatalogRoleKey, LEGACY_TO_CATALOG } from '@/lib/role-catalog';
import { buildNameSearchKeywords } from '@/lib/name-search-keywords';

type ShellRoleResolution =
    | { ok: true; roleKey: string }
    | { ok: false; error: string };

/**
 * Resolve the role a NEW shell user may be stored with (side-door item,
 * SEC-02). The stored value is ALWAYS the resolved key, never the
 * request value:
 *   - an exact catalog key stores itself;
 *   - an exact legacy token stores its canonical catalog key;
 *   - a custom_ slug is NEVER stored (contracts section 3.3, which
 *     overrode this item's plan on the point): a shell has no
 *     roles/{uid} grant record, so there is nothing for the resolver
 *     or the expiry sweep to honour - the stored role must be a
 *     catalog key or the omitted-role floor;
 *   - anything else is rejected (400), never silently floored: the
 *     only caller (add-person-modal) sends catalog keys, so a 400 can
 *     only fire on a crafted request or future UI drift, and flooring
 *     would hide both.
 * Matching is on the EXACT token: spellings that would only resolve
 * after slug normalisation (e.g. the junk token 'pakistan-president')
 * are not accepted. The reserved stems 'superadmin' / 'super_admin'
 * are refused outright, mirroring the roles/assign ban - they resolve
 * to chief_technology_officer in the legacy map and a shell must never
 * carry that key from a request body. 'founder_patron' is refused for
 * the opposite reason: it IS a catalog key, so without the explicit
 * refusal the catalog branch below would store it verbatim and mint a
 * second founder shell.
 */
async function resolveShellRole(
    requested: string,
): Promise<ShellRoleResolution> {
    if (requested === 'superadmin' || requested === 'super_admin' || requested === 'founder_patron') {
        return { ok: false, error: `Unknown role "${requested}".` };
    }
    if (isCatalogRoleKey(requested)) {
        return { ok: true, roleKey: requested };
    }
    const legacyTarget = (LEGACY_TO_CATALOG as Record<string, string>)[requested];
    if (legacyTarget) {
        return { ok: true, roleKey: legacyTarget };
    }
    return { ok: false, error: `Unknown role "${requested}".` };
}

export async function POST(request: NextRequest) {
    // CREATE USER
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (!(await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canManageUsers'))) {
            return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
        }

        const body = await request.json();
        const { email, displayName, role, chapterId, managerId } = body;

        if (!email) {
            return NextResponse.json({ error: 'Email is required' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB failed');

        // Uniqueness check
        const existing = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!existing.empty) {
            return NextResponse.json({ error: 'User with this email already exists' }, { status: 409 });
        }

        // Role validation (SEC-02): the stored role is the RESOLVED
        // key from resolveShellRole, never the verbatim request value.
        const requestedRole =
            typeof role === 'string' && role.trim() ? role.trim() : 'member';
        const resolved = await resolveShellRole(requestedRole);
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.error }, { status: 400 });
        }

        // Create
        // Note: We are creating a minimal user shell. They will claim it on login (if using Firebase Auth) 
        // or we assume this is an invited user.
        const newUserRef = db.collection('users').doc(); // Auto-ID
        const shellData = {
            email,
            displayName: displayName || email.split('@')[0],
            // Name-search keywords index (directory option (c)).
            nameSearchKeywords: buildNameSearchKeywords(displayName || email.split('@')[0]),
            role: resolved.roleKey,
            displayRole: resolved.roleKey,
            chapterId,
            managerId: managerId || null,
            createdAt: new Date(),
            createdBy: auth.user.userId,
            status: 'active'
        };
        // WRITE PRIMACY (G-USER-3, U-06): under isSupaPrimary('users')
        // the shell is created on the adapter FIRST under the SAME
        // generated id (auto-ID semantics preserved — the id is minted
        // by the Firestore doc() call above in both modes), so the
        // shell stays claimable by sign-in flows reading either store;
        // the Firestore set becomes the best-effort reverse mirror.
        if (await identityPrimaryFlagOn('users')) {
            await primaryIdentitySet('users', 'users', newUserRef.id, shellData, { merge: false });
            try {
                await newUserRef.set(shellData);
            } catch (mirrorErr) {
                console.error('[hierarchy/user] Firestore reverse mirror (shell) failed after Supa primary commit:', mirrorErr);
            }
        } else {
            await newUserRef.set(shellData);
        }

        // Mirror the legacy managerId into the canonical reporting_relationships
        // collection so the two stores cannot drift.
        if (managerId) {
            await syncDirectRelationship(newUserRef.id, managerId, auth.user.userId);
        }

        return NextResponse.json({ id: newUserRef.id, ...body });

    } catch (e) {
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    // D1 conversion (Workstream F, ws-f.md Section 2.5): member hard delete
    // is retired. The cascade this handler used to run (managerId nulling
    // on direct reports, mirrored into reporting_relationships) now lives
    // in departUser (src/lib/server/member-lifecycle.ts), which soft-deletes
    // instead: the user doc is retained with memberStatus 'departed'.
    void request;
    return NextResponse.json(
        { error: 'Member hard delete is retired. Use POST /api/admin/users/[uid]/depart.' },
        { status: 410 }
    );
}
