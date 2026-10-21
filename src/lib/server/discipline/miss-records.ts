/**
 * miss-records.ts - deadline miss records + the referral drafter
 * (spec E.6.2-E.6.3).
 *
 * A miss record is a FACT, not a sanction: it has no consequence fields
 * by design (no warning id, no points, no strike). The check-deadlines
 * cron writes them; the pattern evaluator turns a threshold-crossing
 * pattern into ONE referral draft attributed to a HUMAN initiator
 * (option (i): the cron creates the draft record; a case exists only
 * when a human confirms it by setting a real constitutional ground).
 * 'system' as an initiator is FORBIDDEN: a draft attributed to nobody
 * accountable is exactly the auto-sanction machinery being retired.
 */
import { ActorContext, notifyUser, resolveActorOffices } from './adapters';
import { OFFICE_ROLE_KEYS } from './adapters';
import { createCase } from './case-service';
import { getDisciplineSettings } from './settings';

export type MissRecordStatus = 'recorded' | 'attached_to_draft' | 'attached_to_case' | 'dismissed_pattern';

export interface MissRecord {
    missId: string;
    taskId: string;
    subjectUid: string;
    subjectNameSnapshot: string | null;
    taskTitleSnapshot: string | null;
    dueAt: string | null;
    detectedAt: string;
    source: 'check_deadlines_cron';
    status: MissRecordStatus;
    draftCaseId: string | null;
    evaluatedInWindowAt: string | null;
}

export function missRecordId(taskId: string, subjectUid: string): string {
    return `miss_${taskId}_${subjectUid}`;
}

/**
 * Write one miss record. Idempotent: the deterministic doc id means a
 * second detection of the same miss returns created: false and never
 * duplicates.
 */
export async function recordMiss(
    db: any,
    input: {
        taskId: string;
        subjectUid: string;
        subjectNameSnapshot?: string | null;
        taskTitleSnapshot?: string | null;
        dueAt?: string | null;
    },
    now: Date,
): Promise<{ missId: string; created: boolean }> {
    const id = missRecordId(input.taskId, input.subjectUid);
    const ref = db.collection('deadline_miss_records').doc(id);
    const existing = await ref.get();
    if (existing.exists) return { missId: id, created: false };
    const record: MissRecord = {
        missId: id,
        taskId: input.taskId,
        subjectUid: input.subjectUid,
        subjectNameSnapshot: input.subjectNameSnapshot ?? null,
        taskTitleSnapshot: input.taskTitleSnapshot ?? null,
        dueAt: input.dueAt ?? null,
        detectedAt: now.toISOString(),
        source: 'check_deadlines_cron',
        status: 'recorded',
        draftCaseId: null,
        evaluatedInWindowAt: null,
    };
    await ref.set(record);
    return { missId: id, created: true };
}

async function firstHolderOf(db: any, keys: string[]): Promise<string | null> {
    for (const key of keys) {
        const snap = await db.collection('roles').where('role', '==', key).limit(1).get();
        if (!snap.empty) return snap.docs[0].id;
    }
    return null;
}

async function chapterPresidentOf(db: any, chapterId: string | null): Promise<string | null> {
    if (!chapterId) return null;
    for (const key of OFFICE_ROLE_KEYS.chapter_president) {
        const snap = await db.collection('roles').where('role', '==', key).get();
        for (const d of snap.docs) {
            const userSnap = await db.collection('users').doc(d.id).get();
            if (userSnap.exists && (userSnap.data() || {}).chapterId === chapterId) return d.id;
        }
    }
    return null;
}

/**
 * Resolve the human initiator for a referral draft, in spec order:
 * the assigner of the most recent missed task, else the chapter
 * president of the subject's chapter, else the Membership Director.
 * Returns null when nobody can be named (caller sends the NGS digest
 * instead of creating a draft). NEVER returns 'system'.
 */
export async function resolveReferralInitiator(
    db: any,
    subjectUid: string,
    mostRecentTaskId: string,
): Promise<string | null> {
    const taskSnap = await db.collection('tasks').doc(mostRecentTaskId).get();
    if (taskSnap.exists) {
        const task = taskSnap.data() || {};
        const assigner = task.assignedBy || task.createdBy || null;
        if (assigner && assigner !== subjectUid && assigner !== 'system') return String(assigner);
    }
    const subjectSnap = await db.collection('users').doc(subjectUid).get();
    const chapterId = subjectSnap.exists ? (subjectSnap.data() || {}).chapterId || null : null;
    const cp = await chapterPresidentOf(db, chapterId);
    if (cp && cp !== subjectUid) return cp;
    const md = await firstHolderOf(db, OFFICE_ROLE_KEYS.membership_director);
    if (md && md !== subjectUid) return md;
    return null;
}

export interface ReferralEvaluation {
    draftsCreated: number;
    draftCaseIds: string[];
    digestsSent: number;
}

/**
 * Pattern evaluation, run at the END of each check-deadlines run
 * (E.6.3). For each subject with >= referralMissThreshold 'recorded'
 * misses inside the window and no open referral draft, create exactly
 * ONE draft. Subjects are NEVER notified of drafts.
 */
export async function evaluateReferralPatterns(db: any, now: Date): Promise<ReferralEvaluation> {
    const settings = await getDisciplineSettings(db);
    const windowStart = new Date(now.getTime() - settings.referralWindowDays * 24 * 60 * 60 * 1000).toISOString();
    const snap = await db.collection('deadline_miss_records').where('status', '==', 'recorded').get();
    const bySubject = new Map<string, Array<{ id: string; data: any }>>();
    snap.forEach((d: any) => {
        const data = d.data() || {};
        if (data.detectedAt && data.detectedAt >= windowStart) {
            const list = bySubject.get(data.subjectUid) || [];
            list.push({ id: d.id, data });
            bySubject.set(data.subjectUid, list);
        }
    });

    let draftsCreated = 0;
    const draftCaseIds: string[] = [];
    let digestsSent = 0;

    for (const [subjectUid, misses] of bySubject) {
        if (misses.length < settings.referralMissThreshold) continue;
        // One open draft per subject: never stack referrals.
        const openDrafts = await db
            .collection('disciplinary_cases')
            .where('subjectUid', '==', subjectUid)
            .where('status', '==', 'notice_draft')
            .where('initiationSource', '==', 'cron_referral')
            .get();
        if (!openDrafts.empty) continue;

        misses.sort((a, b) => String(b.data.detectedAt).localeCompare(String(a.data.detectedAt)));
        const mostRecent = misses[0];
        const initiatorUid = await resolveReferralInitiator(db, subjectUid, mostRecent.data.taskId);
        if (!initiatorUid) {
            // No accountable human could be named: NO draft. The NGS
            // gets a digest notification instead.
            const ngsHolder = await firstHolderOf(db, OFFICE_ROLE_KEYS.ngs);
            if (ngsHolder) {
                await notifyUser(ngsHolder, {
                    type: 'discipline_referral_digest',
                    title: 'Referral pattern with no attributable initiator',
                    body: `${misses.length} missed deadlines in ${settings.referralWindowDays} days for one member, but no assigner, chapter president, or Membership Director could be named as initiator. Review manually.`,
                    link: '/admin/discipline',
                });
                digestsSent++;
            }
            continue;
        }

        const initiator = await resolveActorOffices(db, initiatorUid);
        const actor: ActorContext = {
            uid: initiatorUid,
            offices: initiator.offices,
            roleKey: initiator.roleKey,
            chapterId: initiator.chapterId,
        };
        const drafterNote = `Pattern referral: ${misses.length} missed deadlines in ${settings.referralWindowDays} days. A human initiator must set the constitutional ground or dismiss.`;
        const created = await createCase(db, {
            subjectUid,
            constitutionalGround: null,
            proposedStrike: null,
            initiationSource: 'cron_referral',
            linkedMissRecordIds: misses.map((m) => m.id),
            linkedTaskIds: Array.from(new Set(misses.map((m) => m.data.taskId))),
            drafterNote,
            evidenceRefs: misses.map((m) => ({
                kind: 'task' as const,
                ref: m.data.taskId,
                label: m.data.taskTitleSnapshot || m.data.taskId,
                addedByUid: initiatorUid,
                addedAt: now.toISOString(),
            })),
        }, actor, now);

        for (const m of misses) {
            await db.collection('deadline_miss_records').doc(m.id).update({
                status: 'attached_to_draft',
                draftCaseId: created.caseId,
                evaluatedInWindowAt: now.toISOString(),
            });
        }
        draftsCreated++;
        draftCaseIds.push(created.caseId);
    }
    return { draftsCreated, draftCaseIds, digestsSent };
}
