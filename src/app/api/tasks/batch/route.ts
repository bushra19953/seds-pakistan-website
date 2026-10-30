
import { NextRequest, NextResponse } from "next/server";
import { getDb, admin } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import { resolveAdminTasksSupaAdapter, mirrorBatchTaskDeletes, commitBatchTaskDeletesPrimary, isAdminTasksSupaPrimary } from "@/lib/supa/seam-admin-tasks";
import { supaGetDoc } from "@/lib/server/supa-roles-seam";
import {
    flushPendingUsersPrimaryOps,
    identityPrimaryFlagOn,
    type PendingUsersPrimaryOp,
} from "@/lib/server/supa-identity-primary";

export async function DELETE(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
        }

        // 1. Authenticate
        const authResult = await verifyAuthentication(request);
        if (!authResult.authenticated || !authResult.user) {
            return NextResponse.json({ error: authResult.error || 'Unauthorized' }, { status: 401 });
        }
        const decoded = authResult.user.user;

        // 2. Permission Check (Admins only)
        const claims: any = decoded || {};
        let canManage = !!(
            (claims.permissions && claims.permissions.manageTasks === true) ||
            claims.manageTasks === true ||
            claims.canManageTasks === true
        );

        if (!canManage) {
            // Census 05, leg L1: the roles/{uid} read goes through the
            // seam first (roles is Supabase-PRIMARY); the Firestore
            // fallback is caught — its failure no longer 500s the
            // batch before the permission decision, which
            // hasServerPermissionForUser makes from its own seam-first
            // bundle. (The role value itself is not consumed here,
            // exactly as before.)
            try {
                const supaRole = await supaGetDoc('roles', claims.uid);
                if (supaRole === null) {
                    await db.collection('roles').doc(claims.uid).get();
                }
            } catch (roleErr) {
                console.error('[api/tasks/batch] Caller role read failed on both stores; continuing to the permission check', roleErr);
            }
            canManage = await hasServerPermissionForUser(db, claims.uid, 'canManageTasks');
        }

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
        }

        // 3. Parse Body
        const body = await request.json();
        const { taskIds } = body;
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            return NextResponse.json({ error: 'Invalid request: taskIds must be an array' }, { status: 400 });
        }

        // 4. Processing
        // We need to read them to update stats. Limit to 500 for Firestore batch size logic simplicity for now.
        if (taskIds.length > 500) {
            return NextResponse.json({ error: 'Batch size limit exceeded (max 500)' }, { status: 400 });
        }

        const tasksRef = db.collection('tasks');
        // We cannot use 'where in' for > 30 items usually. So we read by ID or just loop.
        // Iterating reads is safer for arbitrarily large lists than 'in' queries.

        // Aggregation for stats
        const assigneeDecrements: Record<string, number> = {};
        const completedDecrements: Record<string, number> = {};
        const batch = db.batch();
        let deleteCount = 0;
        const deletedIds: string[] = [];

        // Read all tasks to be deleted. This getAll is BOUNDED by
        // construction: it fetches only the request's explicit ids,
        // and the 500-id cap above is enforced before this point
        // (census 05 #7 — the read is a capped point-get fan-out, not
        // a scan). The before-images deliberately come from Firestore
        // in BOTH modes: in dual-write it is the first-written store,
        // and under primacy it still holds every committed doc, so
        // stats decrements are computed from the same images the old
        // code used. (An adapter before-image read was tried and
        // reverted in train 2: with the adapter merely present, a
        // lagging mirror would silently skip live docs.)
        const refs = taskIds.map(id => tasksRef.doc(id));
        const snapshots = await db.getAll(...refs);

        for (const snap of snapshots) {
            if (!snap.exists) continue;
            const data = snap.data();
            batch.delete(snap.ref);
            deleteCount++;
            deletedIds.push(snap.id);

            // Stats Logic
            if (data?.assigneeId) {
                const uid = data.assigneeId;
                assigneeDecrements[uid] = (assigneeDecrements[uid] || 0) + 1;
                if (data.status === 'completed') {
                    completedDecrements[uid] = (completedDecrements[uid] || 0) + 1;
                }
            }
        }

        // Apply User Updates
        for (const [uid, count] of Object.entries(assigneeDecrements)) {
            const userRef = db.collection('users').doc(uid);
            const updates: any = {
                tasksAssignedCount: admin.firestore.FieldValue.increment(-count)
            };
            if (completedDecrements[uid]) {
                updates.tasksCompletedCount = admin.firestore.FieldValue.increment(-completedDecrements[uid]);
            }
            batch.set(userRef, updates, { merge: true });
        }

        // Supabase write primacy (cutover, SUPA_PRIMARY=tasks): the
        // adapter deletes + counter adjustments commit FIRST and a
        // task-delete failure throws (the request fails; the Firestore
        // batch below never runs). The Firestore batch then commits as
        // the post-commit mirror, best-effort. Primacy inactive: exactly
        // the pre-cutover flow — Firestore batch commit first, then the
        // best-effort seam mirror (never throws; a null adapter skips).
        const adapter = await resolveAdminTasksSupaAdapter();
        if (adapter && isAdminTasksSupaPrimary()) {
            await commitBatchTaskDeletesPrimary(adapter, deletedIds, assigneeDecrements, completedDecrements);
            try {
                await batch.commit();
            } catch (mirrorError) {
                console.warn('Batch Delete Firestore mirror failed after primary commit (non-blocking):', mirrorError);
            }
        } else if (await identityPrimaryFlagOn('users')) {
            // WRITE PRIMACY (identity full build, G-USER-5, U-41 +
            // H-01): the tasks-token RMW mirror becomes the PRIMARY
            // leg when USERS is write-primary (the seam's flag check
            // now also consults isSupaPrimary('users')) — the counter
            // decrements land on the adapter FIRST via the same RMW
            // payloads, the Firestore batch commits as the reverse
            // mirror, and the tasks-token post-commit mirror is stood
            // down for these rows (exactly one primary writer).
            const ops: PendingUsersPrimaryOp[] = [];
            for (const [uid, count] of Object.entries(assigneeDecrements)) {
                const payload: Record<string, unknown> = {
                    tasksAssignedCount: admin.firestore.FieldValue.increment(-count),
                };
                if (completedDecrements[uid]) {
                    payload.tasksCompletedCount = admin.firestore.FieldValue.increment(-completedDecrements[uid]);
                }
                ops.push({ uid, payload });
            }
            await flushPendingUsersPrimaryOps(ops);
            try {
                await batch.commit();
            } catch (mirrorError) {
                console.warn('Batch Delete Firestore reverse mirror failed after users-primary commit (non-blocking):', mirrorError);
            }
        } else {
            await batch.commit();
            try {
                if (adapter) {
                    await mirrorBatchTaskDeletes(adapter, deletedIds, assigneeDecrements, completedDecrements);
                }
            } catch (mirrorError) {
                console.warn('Batch Delete mirror failed (Firestore result stands):', mirrorError);
            }
        }

        return NextResponse.json({ ok: true, deletedCount: deleteCount });

    } catch (error: any) {
        console.error('Batch Delete Error:', error);
        return NextResponse.json({ error: error.message || 'Batch delete failed' }, { status: 500 });
    }
}
