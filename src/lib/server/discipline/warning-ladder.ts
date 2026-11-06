/**
 * warning-ladder.ts - the founder-approved warning sunset ladder
 * (Founder decision 2026-11-06, second-brain Orders 47/48 Item A).
 *
 * The ladder REPLACES the flat warning expiry (one configured
 * expirationDays window for every warning) wherever a warning's expiry
 * is COMPUTED rather than recorded:
 *
 *   Warning 1 - lapses after 30 consecutive days with no new default.
 *   Warning 2 - issued while Warning 1 is active; lapses after 60
 *               consecutive clean days.
 *   Warning 3 - never expires (permanent; the blacklist tier).
 *
 * "No new default" is the operative phrase: warnings issued while a
 * previous warning is still running form a CHAIN. A chain member never
 * lapses on its own while the chain is open - the chain lapses as a
 * whole when its latest member's sunset passes with no newer warning.
 * A warning issued after the previous chain has fully lapsed starts a
 * new chain at level 1.
 *
 * Scope, deliberately narrow:
 *   - A warning doc carrying a stored expiresAt keeps it: that value
 *     was a recorded decision on the doc and is never recomputed here.
 *     The ladder supplies the expiry only where the flat
 *     createdAt + expirationDays fallback used to (docs with no stored
 *     expiresAt), in /api/cron/clear-probation and
 *     /api/public/warning-registry, which now share this module instead
 *     of their two private copies of the fallback.
 *   - Formal warnings written by applyCaseDecision (kind
 *     'formal_warning') are NOT ladder warnings: they are permanent
 *     strike records governed by the discipline case system and are
 *     excluded from chains entirely.
 *   - Revoked and already-archived (probation_cleared) warnings do not
 *     count: chains are built over the member's LIVE warnings only. An
 *     open chain's members are all live by construction (they lapse
 *     together), so the live set is sufficient to place every live
 *     warning in its chain.
 *
 * Warning 2 also carries the ladder's privilege restriction: while a
 * member's current ladder level is 2 or higher, they may not be
 * assigned a new leadership role (enforced in role-writes.ts via
 * getMemberWarningLevel below).
 */

export const WARNING_SUNSET_DAYS: Record<1 | 2, number> = {
    1: 30,
    2: 60,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WarningLike {
    id?: string;
    kind?: unknown;
    createdAt?: unknown;
    issuedAt?: unknown;
    expiresAt?: unknown;
    isPermanent?: unknown;
    isActive?: unknown;
    status?: unknown;
    revokedAt?: unknown;
    revokedBy?: unknown;
    [key: string]: unknown;
}

type MillisLike =
    | { toMillis?: () => number; toDate?: () => Date; seconds?: number; nanoseconds?: number }
    | Date
    | string
    | number
    | null
    | undefined;

/** Same tolerant timestamp coercion the warning consumers already use. */
export function warningTimeToMillis(val: MillisLike): number {
    if (val === null || val === undefined) return 0;
    const v: any = val;
    if (typeof v.toMillis === 'function') {
        try {
            const ms = v.toMillis();
            return Number.isFinite(ms) ? ms : 0;
        } catch {
            return 0;
        }
    }
    if (typeof v.toDate === 'function') {
        try {
            const ms = v.toDate().getTime();
            return Number.isFinite(ms) ? ms : 0;
        } catch {
            return 0;
        }
    }
    if (typeof v === 'object' && typeof v.seconds === 'number') {
        return v.seconds * 1000 + (v.nanoseconds || 0) / 1000000;
    }
    if (v instanceof Date) {
        const ms = v.getTime();
        return Number.isFinite(ms) ? ms : 0;
    }
    if (typeof v === 'string' || typeof v === 'number') {
        const ms = new Date(v).getTime();
        return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
}

function warningCreatedMillis(w: WarningLike): number {
    return warningTimeToMillis(w.createdAt as MillisLike) || warningTimeToMillis(w.issuedAt as MillisLike);
}

function isRevoked(w: WarningLike): boolean {
    return w.revokedAt != null || w.revokedBy != null || w.status === 'revoked';
}

/**
 * The warnings that participate in ladder chains: live (not archived,
 * not revoked), not formal case warnings, with a derivable issuance
 * instant. Sorted by issuance, oldest first.
 */
export function countableWarnings(warnings: WarningLike[]): Array<{ warning: WarningLike; createdMs: number }> {
    return (Array.isArray(warnings) ? warnings : [])
        .filter((w) => w && typeof w === 'object')
        .filter((w) => w.kind !== 'formal_warning')
        .filter((w) => !isRevoked(w))
        .filter((w) => w.isActive !== false && w.status !== 'probation_cleared')
        .map((warning) => ({ warning, createdMs: warningCreatedMillis(warning) }))
        .filter((e) => e.createdMs > 0)
        .sort((a, b) => a.createdMs - b.createdMs);
}

export interface WarningChain {
    /** Members in issuance order; members[i] is ladder level i + 1. */
    members: Array<{ warning: WarningLike; createdMs: number; level: number }>;
    /** When the whole chain lapses; Infinity when it never does. */
    expiresMs: number;
}

/**
 * Group live warnings into chains. A warning joins the open chain when
 * it was issued at or before the chain's current expiry; otherwise it
 * opens a new chain at level 1. Adding a member extends the chain
 * expiry to that member's own sunset (issuance + 30/60 days), and a
 * level-3 member (or an explicitly permanent warning) makes the chain
 * permanent.
 */
export function buildWarningChains(warnings: WarningLike[]): WarningChain[] {
    const entries = countableWarnings(warnings);
    const chains: WarningChain[] = [];
    for (const entry of entries) {
        const open = chains[chains.length - 1];
        if (open && entry.createdMs <= open.expiresMs) {
            const level = open.members.length + 1;
            open.members.push({ warning: entry.warning, createdMs: entry.createdMs, level });
            open.expiresMs =
                entry.warning.isPermanent === true || level >= 3
                    ? Number.POSITIVE_INFINITY
                    : entry.createdMs + WARNING_SUNSET_DAYS[level as 1 | 2] * DAY_MS;
        } else {
            const permanent = entry.warning.isPermanent === true;
            chains.push({
                members: [{ warning: entry.warning, createdMs: entry.createdMs, level: 1 }],
                expiresMs: permanent
                    ? Number.POSITIVE_INFINITY
                    : entry.createdMs + WARNING_SUNSET_DAYS[1] * DAY_MS,
            });
        }
    }
    return chains;
}

/**
 * Ladder expiry per warning doc id, for consumers that resolve expiry
 * warning-by-warning (clear-probation, the public registry). Only
 * warnings the ladder can place appear in the map; a warning absent
 * from the map keeps the consumer's legacy fallback. An expiry of
 * Infinity means the warning never lapses under the ladder.
 */
export function ladderExpiryMap(warnings: WarningLike[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const chain of buildWarningChains(warnings)) {
        for (const member of chain.members) {
            const id = member.warning.id;
            if (typeof id === 'string' && id) map.set(id, chain.expiresMs);
        }
    }
    return map;
}

/**
 * The member's current ladder level: the length of the chain that is
 * still open at `nowMs` (0 when every chain has lapsed). Chains are
 * sequential and non-overlapping, so at most one chain is open at any
 * instant: the last one, if it has started and not yet lapsed.
 */
export function currentWarningLevel(warnings: WarningLike[], nowMs: number): number {
    const chains = buildWarningChains(warnings);
    if (chains.length === 0) return 0;
    const last = chains[chains.length - 1];
    if (last.members[0].createdMs > nowMs) return 0;
    return nowMs < last.expiresMs ? last.members.length : 0;
}

/**
 * DB-backed level lookup for enforcement points (role assignment).
 * Reads the member's warnings subcollection once and applies the pure
 * ladder. Read failures answer 0 (unrestricted): an enforcement gate
 * must never lock role assignment platform-wide because a read failed,
 * and the ladder state is recomputed on every call.
 */
export async function getMemberWarningLevel(db: any, uid: string, now: Date): Promise<number> {
    try {
        const snap = await db.collection('users').doc(uid).collection('warnings').get();
        const warnings: WarningLike[] = [];
        snap.forEach((d: any) => warnings.push({ id: d.id, ...(d.data() || {}) }));
        return currentWarningLevel(warnings, now.getTime());
    } catch {
        return 0;
    }
}
