/**
 * suspension.ts - Strike 2 suspension enforcement (spec E.4.8).
 *
 * A suspended member can still sign in, read their case, submit a
 * defence in another case, and request Founder review. What is
 * suspended is PRIVILEGES: task acceptance/submission/approval, workflow
 * step actions, delegation, and event registration. This helper is wired
 * ONLY into those privilege paths - never into login, profile reads,
 * defence submission, or Founder-review requests.
 */
import { DisciplineError } from './case-service';
import { supaGetDoc } from '@/lib/server/supa-roles-seam';

export interface SuspensionState {
    suspended: boolean;
    until: string | null;
    caseId: string | null;
}

function toMillis(value: any): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const t = new Date(value).getTime();
        return Number.isNaN(t) ? null : t;
    }
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    return null;
}

export function getSuspensionFromUserData(userData: Record<string, any> | null | undefined, now: Date): SuspensionState {
    if (!userData) return { suspended: false, until: null, caseId: null };
    const untilMs = toMillis(userData.privilegesSuspendedUntil);
    if (untilMs === null) return { suspended: false, until: null, caseId: null };
    return {
        suspended: untilMs > now.getTime(),
        until: new Date(untilMs).toISOString(),
        caseId: (userData.suspensionCaseId as string) || null,
    };
}

/** Throws DisciplineError { code: 'SUSPENDED', status: 403 } when suspended. */
export function assertNotSuspended(userData: Record<string, any> | null | undefined, now: Date): void {
    const state = getSuspensionFromUserData(userData, now);
    if (state.suspended) {
        const err = new DisciplineError(
            'SUSPENDED',
            `Privileges are suspended until ${state.until} (case ${state.caseId}).`,
            403,
        );
        (err as any).suspendedUntil = state.until;
        (err as any).caseId = state.caseId;
        throw err;
    }
}

function isTransientFirestoreError(error: any): boolean {
    if (!error) return false;
    const code = (error as any).code;
    if (typeof code === 'number' && [4, 8, 10, 14].includes(code)) return true;
    const haystack = `${typeof code === 'string' ? code : ''} ${typeof (error as any).status === 'string' ? (error as any).status : ''} ${error?.message ?? ''}`.toUpperCase();
    return (
        haystack.includes('RESOURCE_EXHAUSTED') ||
        haystack.includes('RESOURCE-EXHAUSTED') ||
        haystack.includes('DEADLINE_EXCEEDED') ||
        haystack.includes('DEADLINE-EXCEEDED') ||
        haystack.includes('UNAVAILABLE') ||
        haystack.includes('ABORTED')
    );
}

export interface SuspensionReadOptions {
    /**
     * Opt-in seam-first read (quota census leg L4). Users are a
     * Supabase-PRIMARY surface, but several callers of this reader sit
     * inside other programs' pinned parity contracts (the events
     * routes assert their exact adapter-call profile), so the seam
     * read is enabled per call site, never globally. Call sites opt in
     * when their own surface has cut over; the default path below is
     * byte-identical to the pre-seam reader.
     */
    seamFirst?: boolean;
}

export async function getSuspensionState(
    db: any,
    uid: string,
    now: Date,
    opts?: SuspensionReadOptions,
): Promise<SuspensionState> {
    if (!opts?.seamFirst) {
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) return { suspended: false, until: null, caseId: null };
        return getSuspensionFromUserData(snap.data(), now);
    }
    // Seam-first (opted-in call sites): read the state from the users
    // seam copy. supaGetDoc never throws; null means the seam cannot
    // answer (flag OFF / adapter unavailable / adapter error), in
    // which case the legacy Firestore read runs — the Firestore doc
    // is the mirror of the same store. A TRANSIENT failure on that
    // fallback fails soft with a loud log: suspension is a deny-list
    // whose authoritative state lives on the primary store, and an
    // unreachable mirror leg must not 500 the opted-in path during a
    // Firestore read outage (the state itself is untouched and
    // re-evaluated on the next call). Non-transient errors throw.
    const seam = await supaGetDoc('users', uid);
    if (seam !== null) {
        return getSuspensionFromUserData(seam.exists ? seam.data : null, now);
    }
    try {
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) return { suspended: false, until: null, caseId: null };
        return getSuspensionFromUserData(snap.data(), now);
    } catch (err) {
        if (isTransientFirestoreError(err)) {
            console.error(
                `[discipline] Suspension state for ${uid} unreadable (transient Firestore failure, users seam unavailable); failing soft:`,
                err,
            );
            return { suspended: false, until: null, caseId: null };
        }
        throw err;
    }
}

/**
 * Route helper: returns a 403 payload when the actor is suspended, else
 * null. Routes return NextResponse.json(payload.body, {status: 403}).
 */
export async function suspensionBlock(
    db: any,
    uid: string,
    now: Date,
    opts?: SuspensionReadOptions,
): Promise<{ error: 'SUSPENDED'; suspendedUntil: string | null; caseId: string | null } | null> {
    const state = await getSuspensionState(db, uid, now, opts);
    if (!state.suspended) return null;
    return { error: 'SUSPENDED', suspendedUntil: state.until, caseId: state.caseId };
}

/**
 * Delegation guard (E.4.8): the delegate route must reject a BANNED
 * delegate target (the audit found this check missing). Returns the
 * first banned target uid, or null.
 */
export async function findBannedDelegateTarget(db: any, targetUids: string[]): Promise<string | null> {
    for (const uid of targetUids) {
        const snap = await db.collection('users').doc(uid).get();
        if (snap.exists && (snap.data() || {}).isBanned === true) return uid;
    }
    return null;
}
