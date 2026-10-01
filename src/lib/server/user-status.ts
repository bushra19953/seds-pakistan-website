import { getDb } from '@/lib/server/firebase-admin';

export interface UserStatusValidationResult {
    isValid: boolean;
    isOnVacation: boolean;
    isBanned: boolean;
    coveringOfficerId?: string | null;
    error?: string;
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
            return { isValid: false, isOnVacation: false, isBanned: false, error: 'Database connection failed' };
        }

        const doc = await db.collection('users').doc(uid).get();
        if (!doc.exists) {
            return { isValid: false, isOnVacation: false, isBanned: false, error: 'User does not exist' };
        }

        const data = doc.data()!;

        if (data.isBanned) {
            return { isValid: false, isOnVacation: false, isBanned: true, error: 'User is banned' };
        }

        if (data.isOnVacation || data.vacationMode) {
            return {
                isValid: false,
                isOnVacation: true,
                isBanned: false,
                coveringOfficerId: data.coveringOfficerId,
                error: 'User is currently on vacation'
            };
        }

        return { isValid: true, isOnVacation: false, isBanned: false, coveringOfficerId: data.coveringOfficerId };
    } catch (error: any) {
        return { isValid: false, isOnVacation: false, isBanned: false, error: error.message };
    }
}
