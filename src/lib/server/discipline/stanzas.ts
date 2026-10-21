/**
 * stanzas.ts - the discipline stanzas of the daily governance cron
 * (spec cross-workstream contract 1, E.4.8, E.3).
 *
 * The governance cron (Workstream D) is a parallel build; until it
 * lands, clear-probation hosts the suspension-lift stanza (wired by the
 * legacy-retirement work). These functions are exported pure of any
 * route so either host can call them.
 */
import { ActorContext, notifyUser, writeGovernanceAuditOrThrow } from './adapters';
import { expireStaleDrafts, getCase, transitionCase } from './case-service';
import { getSuspensionFromUserData } from './suspension';

const SYSTEM_ACTOR: ActorContext = { uid: 'system', offices: [], roleKey: 'system', chapterId: null };

/**
 * Suspension lift (E.4.8): when the term expires, clear
 * privilegesSuspendedUntil/suspendedFrom/suspensionCaseId in one update,
 * audit 'suspension_lifted', and notify the member. Automatic and
 * unconditional - a suspension is a fixed term, not a status to apply
 * out of. Early lift exists only via Founder review.
 */
export async function runSuspensionLifts(
    db: any,
    now: Date,
): Promise<{ lifted: number; uids: string[] }> {
    const snap = await db.collection('users').where('privilegesSuspendedUntil', '!=', null).get();
    const uids: string[] = [];
    for (const doc of snap.docs) {
        const data = doc.data() || {};
        const state = getSuspensionFromUserData(data, now);
        if (state.until && !state.suspended) {
            await doc.ref.update({
                privilegesSuspendedUntil: null,
                suspendedFrom: null,
                suspensionCaseId: null,
            });
            await writeGovernanceAuditOrThrow(db, {
                action: 'suspension_lifted',
                actorUid: 'system',
                actorRole: 'system',
                targetType: 'user',
                targetId: doc.id,
                details: { caseId: state.caseId, liftedAt: now.toISOString() },
            });
            await notifyUser(doc.id, {
                type: 'suspension_lifted',
                title: 'Suspension lifted',
                body: `Your suspension (case ${state.caseId}) has ended. Your privileges are restored.`,
                link: '/profile',
            });
            uids.push(doc.id);
        }
    }
    return { lifted: uids.length, uids };
}

/** Draft expiry stanza: delegates to the case service (E.3.1). */
export async function runDraftExpiry(db: any, now: Date): Promise<{ expired: number; caseIds: string[] }> {
    return expireStaleDrafts(db, now);
}

/**
 * Defence-window sweep: cases still in notice_issued whose defenceDueAt
 * has passed with no defence received move to defence_window_closed.
 * Absence of a defence is not an admission (E.3.3).
 */
export async function runDefenceWindowSweeps(
    db: any,
    now: Date,
): Promise<{ closed: number; caseIds: string[] }> {
    const snap = await db.collection('disciplinary_cases').where('status', '==', 'notice_issued').get();
    const caseIds: string[] = [];
    for (const doc of snap.docs) {
        const kase = await getCase(db, doc.id);
        if (kase.defenceDueAt && !kase.defenceReceivedAt && now.getTime() > new Date(kase.defenceDueAt).getTime()) {
            try {
                await transitionCase(db, doc.id, 'defence_window_closed', SYSTEM_ACTOR, {
                    systemActor: true,
                    note: 'Defence window closed with no defence received (not an admission).',
                }, now);
                caseIds.push(doc.id);
            } catch {
                /* one bad case must not abort the sweep */
            }
        }
    }
    return { closed: caseIds.length, caseIds };
}
