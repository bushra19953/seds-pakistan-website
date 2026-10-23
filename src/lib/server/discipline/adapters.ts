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
import { assignRole } from '@/lib/server/role-writes';
import type { CatalogRoleKey } from '@/lib/role-catalog';

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
 * Restore a member's pre-sanction role through the Phase 1 single
 * role-write path (role-writes.assignRole) - converted from the
 * original stand-in, which hand-wrote BOTH stores in one batch despite
 * this function's name (and never wrote the mirror's displayRole, so
 * restored members kept a stale display role). The write now carries
 * roleHistory, audit_logs and the authority_refresh signal, and the
 * mirror's effective role is recomputed by role-writes.
 *
 * The non-throwing contract is preserved exactly (E.5): any failure -
 * including assignRole refusing a snapshot that no longer validates
 * (non-catalog token, or an R5/R4 snapshot restored by a non-founder
 * actor) - returns { ok:false, pending:true } so reinstatement can
 * record the restore as PENDING rather than failing the whole act.
 * Fail-closed is deliberate: a stale snapshot must not bypass the
 * write path's validation.
 */
export async function restoreRoleViaWritePath(
    db: any,
    uid: string,
    roleKey: string,
    opts: { actorUid: string; reason: string },
): Promise<{ ok: boolean; pending?: boolean }> {
    try {
        // Preserve additionalRoles: assignRole replaces the set, where
        // the old adapter's merge write left it intact.
        const roleSnap = await db.collection('roles').doc(uid).get();
        const existing = roleSnap.exists ? roleSnap.data() : null;
        const additionalRoles = Array.isArray(existing?.additionalRoles)
            ? existing.additionalRoles
            : [];
        await assignRole(db, {
            uid,
            role: roleKey as CatalogRoleKey,
            additionalRoles,
            actorUid: opts.actorUid,
            reason: opts.reason,
            // 'warning_demotion' is this adapter's intended source (the
            // demotion/restore pair shares it in RoleWriteSource).
            // chapterId is omitted on purpose: role-writes preserves
            // the stored chapterId when none is sent.
            source: 'warning_demotion',
        });
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
