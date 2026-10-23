/**
 * POST /api/admin/founder-review - Founder review of a disciplinary
 * decision (spec E.5). Replaces "appeal" everywhere.
 *
 * Founder ONLY, by UID equality (isFounderUid) - never a role check: a
 * superadmin or president who is not the Founder UID gets 403.
 *
 * Actions: uphold | modify | revoke_sanction | reinstate. Every action
 * requires noticeText (the member is told, in words, what was decided
 * and why) and an internal reason. Effects run in one transaction per
 * action, with the governance audit row inside the transaction.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { FOUNDER_UID } from '@/lib/roles';
import {
    createTaskForUser,
    isFounderUid,
    notifyUser,
    restoreRoleViaWritePath,
    writeGovernanceAuditOrThrow,
} from '@/lib/server/discipline/adapters';
import {
    DisciplineError,
    FounderReview,
    getCase,
} from '@/lib/server/discipline/case-service';
import { applyReviewModification } from '@/lib/server/discipline/apply-decision';
import { computeDerivedWarningCount } from '@/lib/server/discipline/derived-counter';
import { bustIdentity } from '@/lib/server/identity-cache';
import { OFFICE_ROLE_KEYS } from '@/lib/server/discipline/adapters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function errorResponse(err: any) {
    if (err instanceof DisciplineError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[api/admin/founder-review]', err);
    return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
}

async function firstOfficeHolder(db: any, office: keyof typeof OFFICE_ROLE_KEYS): Promise<string | null> {
    for (const key of OFFICE_ROLE_KEYS[office] || []) {
        const snap = await db.collection('roles').where('role', '==', key).limit(1).get();
        if (!snap.empty) return snap.docs[0].id;
    }
    return null;
}

export async function POST(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const actorUid = auth.user.userId;
        // UID equality, NOT a role check (E.5, Section 0.3).
        if (!isFounderUid(actorUid)) {
            return NextResponse.json(
                { error: 'FOUNDER_ONLY', message: 'Founder review is exercised by the Founder personally.' },
                { status: 403 },
            );
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const body = await req.json();
        const { caseId, action, noticeText, reason } = body || {};
        if (!caseId || !['uphold', 'modify', 'revoke_sanction', 'reinstate'].includes(action)) {
            return NextResponse.json({ error: 'caseId and a valid action are required' }, { status: 400 });
        }
        if (!noticeText || !String(noticeText).trim()) {
            return NextResponse.json(
                { error: 'NOTICE_TEXT_REQUIRED', message: 'A review outcome without a member-facing notice is rejected.' },
                { status: 400 },
            );
        }
        if (!reason || !String(reason).trim()) {
            return NextResponse.json({ error: 'REASON_REQUIRED', message: 'An internal reason is mandatory.' }, { status: 400 });
        }

        const now = new Date();
        const iso = now.toISOString();
        const kase = await getCase(db, caseId);
        const founderActor = { uid: actorUid, offices: ['founder'] as any[], roleKey: 'founder', chapterId: null };
        const review: FounderReview = {
            outcome: action === 'uphold' ? 'upheld' : action,
            byUid: actorUid,
            at: iso,
            noticeText: String(noticeText),
            reason: String(reason),
        };
        const caseRef = db.collection('disciplinary_cases').doc(caseId);
        const userRef = db.collection('users').doc(kase.subjectUid);

        if (action === 'uphold') {
            await db.runTransaction(async (tx: any) => {
                tx.update(caseRef, { founderReview: review, updatedAt: iso });
                await writeGovernanceAuditOrThrow(db, {
                    action: 'discipline.founder_review_upheld',
                    actorUid,
                    actorRole: 'founder',
                    targetType: 'disciplinary_case',
                    targetId: caseId,
                    details: { caseNumber: kase.caseNumber },
                }, { tx });
            });
        } else if (action === 'modify') {
            if (!body.modifyPayload) {
                return NextResponse.json({ error: 'modifyPayload is required for modify' }, { status: 400 });
            }
            await applyReviewModification(db, caseId, body.modifyPayload, founderActor, now, review);
        } else if (action === 'revoke_sanction') {
            await db.runTransaction(async (tx: any) => {
                const userSnap = await tx.get(userRef);
                const userData = userSnap.exists ? userSnap.data() || {} : {};
                const userUpdate: Record<string, unknown> = {
                    privilegesSuspendedUntil: null,
                    suspendedFrom: null,
                    suspensionCaseId: null,
                };
                // Undo the ban only if THIS case's vote set it.
                if (userData.bannedBy && kase.boardVoteId && userData.bannedBy === `board:${kase.boardVoteId}`) {
                    userUpdate.isBanned = false;
                    userUpdate.bannedReason = '';
                    userUpdate.bannedAt = null;
                    userUpdate.bannedBy = null;
                }
                // Derived count after this review: the case stops counting
                // once the review is written, so subtract its contribution.
                let derived = await computeDerivedWarningCount(db, kase.subjectUid);
                const counted =
                    (kase.status === 'sanction_applied' || kase.status === 'closed') && kase.strikeNumber !== null;
                if (counted) derived = Math.max(0, derived - 1);
                userUpdate.warningCount = derived;
                tx.update(userRef, userUpdate);
                if (kase.sanctionApplied?.warningRecordId) {
                    const warningRef = userRef.collection('warnings').doc(kase.sanctionApplied.warningRecordId);
                    tx.update(warningRef, { status: 'revoked' });
                }
                tx.update(caseRef, { founderReview: review, updatedAt: iso });
                await writeGovernanceAuditOrThrow(db, {
                    action: 'discipline.founder_review_revoked',
                    actorUid,
                    actorRole: 'founder',
                    targetType: 'disciplinary_case',
                    targetId: caseId,
                    details: { caseNumber: kase.caseNumber },
                }, { tx });
            });
            // Read-Burn A (§2.5 W7): revoke_sanction may have cleared
            // users.isBanned in the transaction above; bust on commit.
            bustIdentity(kase.subjectUid);
        } else if (action === 'reinstate') {
            let roleRestorePending = false;
            await db.runTransaction(async (tx: any) => {
                const userSnap = await tx.get(userRef);
                const userData = userSnap.exists ? userSnap.data() || {} : {};
                const wasBoardBan = typeof userData.bannedBy === 'string' && userData.bannedBy.startsWith('board:');
                const userUpdate: Record<string, unknown> = {
                    isBanned: false,
                    bannedReason: '',
                    bannedAt: null,
                    bannedBy: null,
                    privilegesSuspendedUntil: null,
                    suspendedFrom: null,
                    suspensionCaseId: null,
                };
                // Reinstatement is the ONE place isBlacklisted is written
                // at all, and only to false, and only where the ban being
                // undone was a board ban from this system (E.5, Z-09).
                if (wasBoardBan) userUpdate.isBlacklisted = false;
                // Legacy threshold ban reinstated through a case: refund
                // points the retired path deducted, as a NEW compensating
                // entry (the points ledger is append-only).
                if (!wasBoardBan && userData.isBanned) {
                    const warningsSnap = await db.collection('users').doc(kase.subjectUid).collection('warnings').get();
                    let deducted = 0;
                    warningsSnap.forEach((d: any) => {
                        const w = d.data() || {};
                        deducted += Number(w.pointsDeducted || w.penaltyPoints || 0);
                    });
                    if (deducted > 0) {
                        const currentPoints = Number(userData.points || 0);
                        userUpdate.points = currentPoints + deducted;
                        const auditRef = db.collection('points_audit').doc();
                        tx.set(auditRef, {
                            userId: kase.subjectUid,
                            delta: deducted,
                            reason: 'discipline_reinstatement_refund',
                            caseId,
                            timestamp: Timestamp.fromDate(now),
                            actorId: actorUid,
                        });
                    }
                }
                userUpdate.warningCount = await computeDerivedWarningCount(db, kase.subjectUid);
                tx.update(userRef, userUpdate);
                tx.update(caseRef, { founderReview: review, updatedAt: iso });
                await writeGovernanceAuditOrThrow(db, {
                    action: 'discipline.founder_review_reinstated',
                    actorUid,
                    actorRole: 'founder',
                    targetType: 'disciplinary_case',
                    targetId: caseId,
                    details: { caseNumber: kase.caseNumber, wasBoardBan },
                }, { tx });
            });
            // Read-Burn A (§2.5 W7): reinstate cleared users.isBanned /
            // isBlacklisted in the transaction above; bust on commit.
            bustIdentity(kase.subjectUid);
            // Role restoration via the single write path (outside the tx:
            // if the seat is filled, membership is already restored and
            // the office restore is recorded PENDING with an NGS task -
            // the reinstatement itself does not fail, E.5).
            if (kase.subjectRoleSnapshot) {
                const restore = await restoreRoleViaWritePath(db, kase.subjectUid, kase.subjectRoleSnapshot, {
                    actorUid,
                    reason: `Founder review restore for case ${caseId}`,
                });
                if (!restore.ok) {
                    roleRestorePending = true;
                    await caseRef.update({ reinstatementRoleRestore: 'pending', updatedAt: iso });
                    const ngsHolder = await firstOfficeHolder(db, 'ngs');
                    await createTaskForUser(db, ngsHolder || FOUNDER_UID, {
                        title: `Complete role restoration for reinstated member (case ${kase.caseNumber})`,
                        description: `Reinstatement restored membership for ${kase.subjectUid}; restoring the pre-expulsion office (${kase.subjectRoleSnapshot}) is pending (seat may be filled).`,
                        link: `/admin/discipline/${caseId}`,
                    });
                } else {
                    await caseRef.update({ reinstatementRoleRestore: 'restored', updatedAt: iso });
                }
            }
            if (roleRestorePending) {
                // surfaced in the response below
            }
        }

        await notifyUser(kase.subjectUid, {
            type: 'founder_review',
            title: `Founder review - case ${kase.caseNumber}`,
            body: String(noticeText),
            link: `/profile/discipline/${caseId}`,
        });
        const updated = await getCase(db, caseId);
        return NextResponse.json({ success: true, case: updated });
    } catch (err: any) {
        return errorResponse(err);
    }
}
