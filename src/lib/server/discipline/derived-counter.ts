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
import { disciplineData } from './supa-seam';
import {
    identityPrimaryFlagOn,
    primaryIdentityUpdate,
} from '../supa-identity-primary';

export async function computeDerivedWarningCount(db: any, uid: string): Promise<number> {
    // Supa path (surface 'discipline'): the adapter has no projection,
    // so full case docs are fetched and the projection is dropped
    // client-side (plan G1); the counting predicate below is applied
    // identically. Adapter error falls back to the Firestore query.
    if (disciplineData.enabled()) {
        try {
            const docs = await disciplineData.listCasesBySubject(uid);
            let count = 0;
            for (const c of docs) {
                const decided = c.status === 'sanction_applied' || c.status === 'closed';
                const hasStrike = c.strikeNumber !== null && c.strikeNumber !== undefined;
                const revoked = c.founderReview && c.founderReview.outcome === 'revoke_sanction';
                if (decided && hasStrike && !revoked) count++;
            }
            return count;
        } catch {
            // fall through to the Firestore path
        }
    }
    // Projection: the counter below reads only status, strikeNumber and
    // founderReview from each case doc; every other field is dropped at
    // the server so full case records (narratives included) never cross
    // the wire for a pure count.
    const snap = await db
        .collection('disciplinary_cases')
        .where('subjectUid', '==', uid)
        .select('status', 'strikeNumber', 'founderReview')
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
    // Projection: this pass reads only subjectUid from each case doc.
    // (Supa path: full docs via the seam, subjectUid read client-side;
    // the per-user user-doc read/write below stays on the caller's db
    // handle - users is a foreign collection, plan G1.)
    const uids = new Set<string>();
    let casesFromSupa = false;
    if (disciplineData.enabled()) {
        try {
            const docs = await disciplineData.listCases();
            for (const c of docs) {
                if (c.subjectUid) uids.add(c.subjectUid as string);
            }
            casesFromSupa = true;
        } catch {
            // fall through to the Firestore scan
        }
    }
    if (!casesFromSupa) {
        const casesSnap = await db
            .collection('disciplinary_cases')
            .select('subjectUid')
            .get();
        casesSnap.forEach((doc: any) => {
            const c = doc.data() || {};
            if (c.subjectUid) uids.add(c.subjectUid);
        });
    }
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
            // PRIMACY (G-USER-4, U-20b): under isSupaPrimary('users')
            // the correction lands on the adapter first; the Firestore
            // update becomes the reverse mirror (best-effort — this is
            // a drift-correction sweep, its next run re-derives).
            if (await identityPrimaryFlagOn('users')) {
                await primaryIdentityUpdate('users', 'users', uid, { warningCount: derived });
                try {
                    await userRef.update({ warningCount: derived });
                } catch (mirrorErr) {
                    console.error('[derived-counter] Firestore reverse mirror (warningCount reconcile) failed after Supa primary commit:', mirrorErr);
                }
            } else {
                await userRef.update({ warningCount: derived });
            }
            drift.push({ uid, stored, derived });
        }
    }
    return drift;
}
