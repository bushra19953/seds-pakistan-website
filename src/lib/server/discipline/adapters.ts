/**
 * adapters.ts - discipline substrate adapters (Phase 2, Section E).
 *
 * Thin ADAPTER-marked adapters over substrate pieces that are parallel
 * builds (Phase 1 authoritative role store + single write path, Phase 2
 * Section 0.3/0.4/0.5 helpers). Each adapter implements the specced
 * interface against what exists in the repo TODAY so the discipline
 * workstream composes; when the substrate lands, only this file changes.
 *
 * Founder identity is a UID equality check (FOUNDER_UID), never a role
 * check (Section 0.3 contract).
 */
import { Timestamp } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import { notificationService } from '@/lib/server/notification-service';

export type Office =
    | 'founder'
    | 'ngs'
    | 'audit_chair'
    | 'membership_director'
    | 'chapter_president'
    | 'nec'
    | 'president';

export interface ActorContext {
    uid: string;
    offices: Office[];
    roleKey: string | null;
    chapterId: string | null;
}

export function isFounderUid(uid: string | null | undefined): boolean {
    return !!uid && uid === FOUNDER_UID;
}

// ADAPTER: office mapping spans Phase 1 canonical keys and legacy tokens
// until the Phase 1 taxonomy lands. Canonical keys (national_general_
// secretary, national_audit_compliance_chair, national_membership_
// director) do not exist in src/lib/roles.ts yet; the legacy store maps
// those offices onto national_vp_* tokens today (e.g. LEGACY_ROLE_MAP
// sends general_secretary -> national_vp_operations and
// hr_or_membership_director -> national_vp_membership). 'nec' is the
// National Executive Council: any national_vp_* holder or the national
// president, until Phase 1 bodies exist as data. superadmin and
// chief_technology_officer deliberately map to NO office: the platform
// role grants no disciplinary power (spec E.4.3).
export const OFFICE_ROLE_KEYS: Record<Office, string[]> = {
    founder: [],
    ngs: ['national_general_secretary', 'national_vp_operations', 'general_secretary'],
    audit_chair: ['national_audit_compliance_chair'],
    membership_director: ['national_membership_director', 'national_vp_membership'],
    chapter_president: ['chapter_president'],
    nec: [
        'president_national',
        'national_vp_operations',
        'national_vp_engineering',
        'national_vp_marketing',
        'national_vp_finance',
        'national_vp_membership',
    ],
    president: ['president_national'],
};

export function officesForRoleKey(roleKey: string | null | undefined): Office[] {
    if (!roleKey) return [];
    const offices: Office[] = [];
    (Object.keys(OFFICE_ROLE_KEYS) as Office[]).forEach((office) => {
        if (OFFICE_ROLE_KEYS[office].includes(roleKey)) offices.push(office);
    });
    return offices;
}

/**
 * Resolve an actor's disciplinary offices from the authoritative store
 * roles/{uid} (falling back to the users/{uid} mirror, which the repo's
 * own demotion-staleness lesson says can diverge).
 */
export async function resolveActorOffices(db: any, uid: string): Promise<ActorContext> {
    let roleKey: string | null = null;
    let chapterId: string | null = null;
    try {
        const roleSnap = await db.collection('roles').doc(uid).get();
        if (roleSnap.exists) {
            const d = roleSnap.data() || {};
            roleKey = (d.role as string) || null;
            chapterId = (d.chapterId as string) || null;
        }
    } catch {
        /* fall through to the users mirror */
    }
    try {
        const userSnap = await db.collection('users').doc(uid).get();
        if (userSnap.exists) {
            const d = userSnap.data() || {};
            if (!roleKey) roleKey = (d.role as string) || null;
            if (!chapterId) chapterId = (d.chapterId as string) || null;
        }
    } catch {
        /* actor resolves with whatever was found */
    }
    const offices = officesForRoleKey(roleKey);
    if (isFounderUid(uid) && !offices.includes('founder')) offices.unshift('founder');
    return { uid, offices, roleKey, chapterId };
}

export class GovernanceAuditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GovernanceAuditError';
    }
}

export interface GovernanceAuditEntry {
    action: string;
    actorUid: string;
    actorRole?: string | null;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
}

/**
 * Section 0.5 writer: writes the audit_logs entry and THROWS on failure,
 * so a governance action whose audit fails does not commit. Pass
 * opts.tx to write inside the caller's Firestore transaction.
 * Returns the audit doc id (or the generated ref id in a transaction).
 */
export async function writeGovernanceAuditOrThrow(
    target: any,
    entry: GovernanceAuditEntry,
    opts?: { tx?: any },
): Promise<string> {
    try {
        const ref = target.collection('audit_logs').doc();
        const row = {
            action: entry.action,
            actorUid: entry.actorUid,
            actorRole: entry.actorRole ?? null,
            targetType: entry.targetType,
            targetId: entry.targetId,
            details: entry.details ?? {},
            createdAt: Timestamp.now(),
            source: 'discipline',
        };
        if (opts?.tx) {
            opts.tx.set(ref, row);
        } else {
            await ref.set(row);
        }
        return ref.id;
    } catch (err: any) {
        throw new GovernanceAuditError(
            `Governance audit write failed for ${entry.action}: ${err?.message || String(err)}`,
        );
    }
}

/**
 * ADAPTER: Phase 1 single role-write path. Until it lands, this writes
 * BOTH stores (roles/{uid} canonical + users/{uid}.role mirror) in one
 * batch, per the repo demotion-staleness rule. Returns { ok:false,
 * pending:true } instead of throwing so reinstatement can record the
 * role restore as PENDING rather than failing the whole act (E.5).
 */
export async function restoreRoleViaWritePath(
    db: any,
    uid: string,
    roleKey: string,
): Promise<{ ok: boolean; pending?: boolean }> {
    try {
        const batch = db.batch();
        batch.set(
            db.collection('roles').doc(uid),
            { role: roleKey, updatedAt: Timestamp.now() },
            { merge: true },
        );
        batch.update(db.collection('users').doc(uid), {
            role: roleKey,
            updatedAt: Timestamp.now(),
        });
        await batch.commit();
        return { ok: true };
    } catch {
        return { ok: false, pending: true };
    }
}

/** Adapter over the repo notificationService (in-app + push + email). */
export async function notifyUser(
    uid: string,
    payload: { title: string; body: string; link?: string; type?: string },
): Promise<void> {
    try {
        await notificationService.send(
            uid,
            {
                type: payload.type || 'discipline',
                title: payload.title,
                body: payload.body,
                link: payload.link,
            },
            'P1',
        );
    } catch (err) {
        // Notifications are delivery, not the legal record; the case doc is.
        console.error('[discipline] notifyUser failed:', err);
    }
}

/** ADAPTER: task creation over the platform tasks collection. */
export async function createTaskForUser(
    db: any,
    assigneeUid: string,
    payload: { title: string; description?: string; link?: string },
): Promise<string> {
    const ref = db.collection('tasks').doc();
    await ref.set({
        title: payload.title,
        description: payload.description || '',
        link: payload.link || null,
        assigneeIds: [assigneeUid],
        createdBy: 'discipline-system',
        source: 'discipline',
        status: 'pending',
        createdAt: Timestamp.now(),
    });
    return ref.id;
}
