import { getDb } from '@/lib/server/firebase-admin';
import { supaGetDoc } from '@/lib/server/supa-roles-seam';

export interface UserStatusValidationResult {
    isValid: boolean;
    isOnVacation: boolean;
    isBanned: boolean;
    coveringOfficerId?: string | null;
    vacationStartDate?: string | null;
    vacationEndDate?: string | null;
    leaveRequestId?: string | null;
    error?: string;
}

/**
 * Normalize a stored leave date to an ISO string, or null when absent.
 * Leave request dates are stored as strings. Firestore Timestamps and
 * Date objects are converted so callers always see a string or null.
 */
function toLeaveDateString(value: unknown): string | null {
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
        return (value as { toDate: () => Date }).toDate().toISOString();
    }
    return null;
}

/**
 * A centralized god-level helper to definitively check a user's operational status.
 * This ensures that if the UI cache is poisoned or bypassed by direct API calls,
 * the server still strictly enforces the 'Zero-Vacancy' blockade and recognizes bans.
 */
function statusFromUserData(data: Record<string, any>): UserStatusValidationResult {
    if (data.isBanned) {
        return { isValid: false, isOnVacation: false, isBanned: true, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: 'User is banned' };
    }

    if (data.isOnVacation || data.vacationMode) {
        return {
            isValid: false,
            isOnVacation: true,
            isBanned: false,
            coveringOfficerId: data.coveringOfficerId,
            vacationStartDate: toLeaveDateString(data.vacationStartDate),
            vacationEndDate: toLeaveDateString(data.vacationEndDate),
            leaveRequestId: typeof data.leaveRequestId === 'string' ? data.leaveRequestId : null,
            error: 'User is currently on vacation'
        };
    }

    return { isValid: true, isOnVacation: false, isBanned: false, coveringOfficerId: data.coveringOfficerId, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null };
}

/**
 * Per-request dedup cache for validateUserStatus: write flows that
 * validate the same uid once per step/assignee occurrence pass ONE
 * shared Map so each uid costs at most one read per request (census
 * 05, leg L3). The Map is caller-owned and request-scoped — no
 * cross-request staleness is introduced.
 */
export type UserStatusCache = Map<string, Promise<UserStatusValidationResult>>;

/**
 * Display-name companion read for the validation failure paths
 * (census 05, leg L3): when validateUserStatus rejects a user, the
 * write flows fetch the user's displayName for the error message.
 * That raw get used to propagate and turn a clean 403 into a 500
 * under quota. Seam-first like validateUserStatus, and the Firestore
 * fallback is CAUGHT: any failure resolves to null and the caller
 * falls back to the uid, so the validation verdict is always the
 * response the client sees.
 */
export async function resolveUserDisplayName(uid: string): Promise<string | null> {
    try {
        const seam = await supaGetDoc('users', uid);
        if (seam !== null) {
            const name = (seam.data as Record<string, any> | undefined)?.displayName;
            return typeof name === 'string' && name ? name : null;
        }
        const db = getDb();
        if (!db) return null;
        const doc = await db.collection('users').doc(uid).get();
        const name = doc.exists ? doc.data()?.displayName : null;
        return typeof name === 'string' && name ? name : null;
    } catch {
        return null;
    }
}

export async function validateUserStatus(uid: string, cache?: UserStatusCache): Promise<UserStatusValidationResult> {
    if (cache) {
        const hit = cache.get(uid);
        if (hit) return hit;
        const pending = validateUserStatusUncached(uid);
        cache.set(uid, pending);
        return pending;
    }
    return validateUserStatusUncached(uid);
}

async function validateUserStatusUncached(uid: string): Promise<UserStatusValidationResult> {
    try {
        // Users are a Supabase-PRIMARY surface (census 05, leg L3):
        // read the user doc through the seam first. supaGetDoc never
        // throws; null means the seam cannot answer (flag OFF /
        // adapter unavailable / adapter error), in which case the
        // legacy Firestore read below runs exactly as before.
        const seam = await supaGetDoc('users', uid);
        if (seam !== null) {
            if (!seam.exists) {
                return { isValid: false, isOnVacation: false, isBanned: false, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: 'User does not exist' };
            }
            return statusFromUserData((seam.data ?? {}) as Record<string, any>);
        }

        const db = getDb();
        if (!db) {
            return { isValid: false, isOnVacation: false, isBanned: false, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: 'Database connection failed' };
        }

        const doc = await db.collection('users').doc(uid).get();
        if (!doc.exists) {
            return { isValid: false, isOnVacation: false, isBanned: false, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: 'User does not exist' };
        }

        const data = doc.data()!;

        return statusFromUserData(data as Record<string, any>);
    } catch (error: any) {
        return { isValid: false, isOnVacation: false, isBanned: false, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: error.message };
    }
}
