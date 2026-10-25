'use server';

/**
 * Payment-methods settings read (Cluster M, Group 4).
 *
 * Returns the raw settings/payment_methods document data — the same
 * shape the client readers used to get from snap.data() — or null when
 * the document does not exist. Each consumer keeps its own existing
 * merge behavior (checkout sets the raw data; certificate-settings
 * merges it over its DEFAULT_METHODS_SETTINGS).
 *
 * Read source: Supabase via src/lib/supa/store-settings.ts when the
 * 'store-settings' surface flag is ON and the adapter answers; otherwise
 * the current Firestore document read, performed server-side with the
 * Admin SDK. Flag OFF / unconfigured / adapter error is therefore
 * byte-identical to today's client read.
 *
 * Writes: none here. payment_methods changes go through the finance
 * approvals flow (destination_change) — manual list, finance cluster.
 */

import { getDb } from '@/lib/server/firebase-admin';
import { readPaymentMethodsViaSupa } from '@/lib/supa/store-settings';

export async function getPaymentMethodsSettings(): Promise<Record<string, unknown> | null> {
    const supa = await readPaymentMethodsViaSupa();
    if (supa.status === 'ok') {
        return supa.data;
    }
    try {
        const db = await getDb();
        if (!db) return null;
        const snap = await db.collection('settings').doc('payment_methods').get();
        return snap.exists ? ((snap.data() as Record<string, unknown>) ?? null) : null;
    } catch (error) {
        console.error('Error fetching payment methods settings:', error);
        return null;
    }
}
