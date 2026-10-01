import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasPermissionForRole } from '@/config/permissions.config';

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

        return NextResponse.json({ id: newUserRef.id, ...body });

    } catch (e) {
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user || !hasPermissionForRole(auth.user.role as any, 'canManageUsers')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        const { userId } = await request.json();
        if (!userId) return NextResponse.json({ error: 'ID required' }, { status: 400 });

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB failed');

        // Check for reports
        const reports = await db.collection('users').where('managerId', '==', userId).limit(1).get();
        if (!reports.empty) {
            // Block deletion if has reports? Or cascade null?
            // Prompt says: "cascade-null manager_id on reports or block"
            // Let's safe block for now, or cascade null. Proposing cascade null for smoother UX.

            // Actually, let's just nullify their managerId in a batch
            const batch = db.batch();
            const allReports = await db.collection('users').where('managerId', '==', userId).get();
            allReports.docs.forEach(doc => {
                batch.update(doc.ref, { managerId: null });
            });
            await batch.commit();
        }

        await db.collection('users').doc(userId).delete();
        return NextResponse.json({ success: true });

    } catch (e) {
        return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
    }
}
