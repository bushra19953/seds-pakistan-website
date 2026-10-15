import { getDb } from '@/lib/server/firebase-admin';

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
export async function validateUserStatus(uid: string): Promise<UserStatusValidationResult> {
    try {
        const db = getDb();
        if (!db) {
            return { isValid: false, isOnVacation: false, isBanned: false, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: 'Database connection failed' };
        }

        const doc = await db.collection('users').doc(uid).get();
        if (!doc.exists) {
            return { isValid: false, isOnVacation: false, isBanned: false, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: 'User does not exist' };
        }

        const data = doc.data()!;

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
    } catch (error: any) {
        return { isValid: false, isOnVacation: false, isBanned: false, vacationStartDate: null, vacationEndDate: null, leaveRequestId: null, error: error.message };
    }
}
