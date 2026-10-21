/**
 * derived-counter.ts - warningCount becomes DERIVED (spec E.4.7).
 *
 * warningCount(subject) = number of disciplinary_cases for the subject
 * with status in (sanction_applied, closed) AND strikeNumber != null AND
 * NOT founderReview.outcome == 'revoke_sanction' on that case.
 *
 * Legacy warnings (users/{uid}/warnings docs with no caseId) NEVER
 * count: the strike count is a count of decided cases, full stop
 * (E.4.7, Z-12). The stored field remains as a write-through cache for
 * the ~10 legacy readers; a reconciliation pass logs drift as a
 * governance audit entry and corrects it.
 */
import { writeGovernanceAuditOrThrow } from './adapters';

export async function computeDerivedWarningCount(db: any, uid: string): Promise<number> {
    const snap = await db
        .collection('disciplinary_cases')
        .where('subjectUid', '==', uid)
        .get();
    let count = 0;
    snap.forEach((doc: any) => {
        const c = doc.data() || {};
        const decided = c.status === 'sanction_applied' || c.status === 'closed';
        const hasStrike = c.strikeNumber !== null && c.strikeNumber !== undefined;
        const revoked = c.founderReview && c.founderReview.outcome === 'revoke_sanction';
        if (decided && hasStrike && !revoked) count++;
    });
    return count;
}

/** Write-through cache update, for use inside a transaction. */
export function writeDerivedWarningCount(tx: any, userRef: any, count: number): void {
    tx.update(userRef, { warningCount: count });
}

/**
 * Nightly reconciliation (E.4.7(b)): recompute for every user WITH a
 * case; on drift, write a 'warning_count_drift' governance audit entry
 * naming the user and both values, then correct the field. Returns the
 * drift list.
 */
export async function reconcileWarningCounts(
    db: any,
    now: Date,
): Promise<Array<{ uid: string; stored: number; derived: number }>> {
    const casesSnap = await db.collection('disciplinary_cases').get();
    const uids = new Set<string>();
    casesSnap.forEach((doc: any) => {
        const c = doc.data() || {};
        if (c.subjectUid) uids.add(c.subjectUid);
    });
    const drift: Array<{ uid: string; stored: number; derived: number }> = [];
    for (const uid of Array.from(uids)) {
        const derived = await computeDerivedWarningCount(db, uid);
        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) continue;
        const stored = Number((userSnap.data() || {}).warningCount || 0);
        if (stored !== derived) {
            await writeGovernanceAuditOrThrow(db, {
                action: 'warning_count_drift',
                actorUid: 'system',
                actorRole: 'system',
                targetType: 'user',
                targetId: uid,
                details: { stored, derived, at: now.toISOString() },
            });
            await userRef.update({ warningCount: derived });
            drift.push({ uid, stored, derived });
        }
    }
    return drift;
}
