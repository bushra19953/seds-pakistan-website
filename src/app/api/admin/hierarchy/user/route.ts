import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasPermissionForRole } from '@/config/permissions.config';
import { syncDirectRelationship } from '@/lib/server/hierarchy';

export async function POST(request: NextRequest) {
    // CREATE USER
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        if (!hasPermissionForRole(auth.user.role as any, 'canManageUsers')) {
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

        // Create
        // Note: We are creating a minimal user shell. They will claim it on login (if using Firebase Auth) 
        // or we assume this is an invited user.
        const newUserRef = db.collection('users').doc(); // Auto-ID
        await newUserRef.set({
            email,
            displayName: displayName || email.split('@')[0],
            role: role || 'member',
            displayRole: role || 'member',
            chapterId,
            managerId: managerId || null,
            createdAt: new Date(),
            createdBy: auth.user.userId,
            status: 'active'
        });

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
