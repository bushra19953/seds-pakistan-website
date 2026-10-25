/**
 * settings.ts - discipline operational settings (spec E.6.3, E.9).
 *
 * Stored in Firestore doc settings/discipline so the NGS/Founder can tune
 * the referral rule and flip cutover switches without a deploy. Every
 * field has a fail-safe default: shadowMode ON (decisions record,
 * sanctions do not apply), cronReferralLive OFF (the converted cron
 * detects and notifies but writes no miss records until enabled), and
 * the registry variant RETIRED (E.7 default).
 */
import { getDb } from '@/lib/server/firebase-admin';
import { disciplineData } from './supa-seam';

export interface DisciplineSettings {
    shadowMode: boolean;
    cronReferralLive: boolean;
    referralWindowDays: number;
    referralMissThreshold: number;
    warningRegistryVariant: 'retired' | 'internal';
}

export const DEFAULT_DISCIPLINE_SETTINGS: DisciplineSettings = {
    shadowMode: true,
    cronReferralLive: false,
    referralWindowDays: 28,
    referralMissThreshold: 3,
    warningRegistryVariant: 'retired',
};

export async function getDisciplineSettings(db?: any): Promise<DisciplineSettings> {
    try {
        // Supa path (surface 'discipline', read half per plan G1): a
        // supa-absent doc classifies exactly like a Firestore-absent
        // doc (defaults). Adapter error falls through to Firestore.
        if (disciplineData.enabled()) {
            try {
                const supaData = await disciplineData.getDisciplineSettingsDoc();
                if (!supaData) return { ...DEFAULT_DISCIPLINE_SETTINGS };
                return mapDisciplineSettings(supaData);
            } catch {
                // fall through to the Firestore path
            }
        }
        const database = db || getDb();
        if (!database) return { ...DEFAULT_DISCIPLINE_SETTINGS };
        const snap = await database.collection('settings').doc('discipline').get();
        if (!snap.exists) return { ...DEFAULT_DISCIPLINE_SETTINGS };
        const data = snap.data() || {};
        return mapDisciplineSettings(data);
    } catch {
        return { ...DEFAULT_DISCIPLINE_SETTINGS };
    }
}

function mapDisciplineSettings(data: Record<string, any>): DisciplineSettings {
    return {
        shadowMode: data.shadowMode !== false,
        cronReferralLive: data.cronReferralLive === true,
        referralWindowDays:
            typeof data.referralWindowDays === 'number' && data.referralWindowDays > 0
                ? data.referralWindowDays
                : DEFAULT_DISCIPLINE_SETTINGS.referralWindowDays,
        referralMissThreshold:
            typeof data.referralMissThreshold === 'number' && data.referralMissThreshold > 0
                ? data.referralMissThreshold
                : DEFAULT_DISCIPLINE_SETTINGS.referralMissThreshold,
        warningRegistryVariant:
            data.warningRegistryVariant === 'internal' ? 'internal' : 'retired',
    };
}
