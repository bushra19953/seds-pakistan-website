/**
 * adapters-probation.ts - ADAPTER for Section D's probation-restore
 * machinery (spec E.6.5 cross-reference, D.10).
 *
 * When a probation period ends, the member's PRE-PROBATION role is
 * restored from the pending restore recorded at demotion time - the
 * role is NEVER recomputed from warning state (the retired
 * demoteUserForProbation recompute path is deleted, not rebuilt). The
 * restore itself goes through the single role write path adapter.
 *
 * ADAPTER: Section D owns the probation_restores collection in its
 * spec; until that crew lands, this processor consumes pending docs of
 * the specced shape { uid, roleToRestore, status: 'pending' } and is a
 * clean no-op when the collection does not exist.
 */
import { restoreRoleViaWritePath, writeGovernanceAuditOrThrow } from './adapters';

export async function processProbationRestores(
    db: any,
    now: Date,
): Promise<{ restored: number; pending: number; failed: number }> {
    let restored = 0;
    let pending = 0;
    let failed = 0;
    let snap: any;
    try {
        snap = await db.collection('probation_restores').where('status', '==', 'pending').get();
    } catch {
        return { restored: 0, pending: 0, failed: 0 };
    }
    if (!snap || snap.empty) return { restored: 0, pending: 0, failed: 0 };
    for (const doc of snap.docs) {
        const data = doc.data() || {};
        const uid = data.uid || doc.id;
        const roleToRestore = data.roleToRestore;
        if (!uid || !roleToRestore) {
            failed++;
            continue;
        }
        const dueAtMs = data.dueAt
            ? new Date(data.dueAt?.toDate ? data.dueAt.toDate() : data.dueAt).getTime()
            : 0;
        if (dueAtMs && dueAtMs > now.getTime()) {
            pending++;
            continue;
        }
        try {
            const result = await restoreRoleViaWritePath(db, uid, roleToRestore, {
                actorUid: 'system',
                reason: 'Probation period ended; restoring pre-probation role',
            });
            if (result.ok) {
                await doc.ref.update({ status: 'restored', restoredAt: now.toISOString() });
                await writeGovernanceAuditOrThrow(db, {
                    action: 'probation_role_restored',
                    actorUid: 'system',
                    actorRole: 'system',
                    targetType: 'user',
                    targetId: uid,
                    details: { roleToRestore },
                });
                restored++;
            } else {
                // Seat conflict etc.: leave pending for a human (E.5
                // pattern) instead of forcing the restore.
                pending++;
            }
        } catch {
            failed++;
        }
    }
    return { restored, pending, failed };
}
