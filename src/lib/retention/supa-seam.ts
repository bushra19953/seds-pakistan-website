/**
 * supa-seam.ts - the ONE Supabase seam for erasure + consent-gate
 * reads (CLUSTER_COMPLIANCE_PLAN.md G3). Surface:
 * useSupa('erasure-consent') (one surface for the group; consent
 * WRITES belong to the governance cluster and are not here).
 *
 * Gate rule (plan §0.2): consumers consult this seam only when
 * `useSupa('erasure-consent') && getSupaClient()`; an adapter error
 * falls back to the Firestore path byte-for-byte. Flag OFF / client
 * null = indistinguishable from the pre-migration tree.
 *
 * Wrap list (plan G3): erasure_requests get/list + (via the deps
 * facade below) set/update for the REQUEST LIFECYCLE only;
 * consent_requests reads are deliberately NOT wrapped (ruling G3-1:
 * they flip last, gated on the governance cluster's mirror);
 * governance_settings/phase2 and settings/consent_config gets.
 *
 * Classification parity (plan §5): the getters return null on a
 * missing doc so callers classify supa-absent exactly like
 * Firestore-absent ('missing', never 'doc'). Adapter errors throw;
 * every caller's existing try/catch turns them into the same
 * missing/default outcome the Firestore error path produces.
 */
import { randomUUID } from 'node:crypto';
import { getSupaAdapter, getSupaClient, useSupa, type SupaDoc } from '@/lib/supa';

export const ERASURE_CONSENT_SURFACE = 'erasure-consent';

export function retentionSupaEnabled(): boolean {
    return useSupa(ERASURE_CONSENT_SURFACE) && getSupaClient() !== null;
}

/** The seam's single date converter (plan §0.3). See discipline seam for the contract. */
export function toDateValue(v: unknown): Date | null {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    if (typeof v === 'string') {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'number') {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.toDate === 'function') {
            const d = (o.toDate as () => Date)();
            return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
        }
        const seconds = typeof o.seconds === 'number' ? o.seconds : typeof o._seconds === 'number' ? o._seconds : null;
        if (seconds !== null) {
            const nanos = typeof o.nanoseconds === 'number' ? o.nanoseconds : typeof o._nanoseconds === 'number' ? o._nanoseconds : 0;
            return new Date(seconds * 1000 + Math.floor(nanos / 1e6));
        }
    }
    return null;
}

function splitDoc(doc: SupaDoc): { id: string; data: Record<string, any> } {
    const { id, ...data } = doc as Record<string, any>;
    return { id: String(id), data };
}

export const retentionConsentData = {
    enabled: retentionSupaEnabled,
    toDateValue,

    /** governance_settings/phase2 raw data, or null when the doc is absent. */
    async getGovernanceSettingsRaw(): Promise<Record<string, any> | null> {
        const doc = await getSupaAdapter().getDoc('governance_settings', 'phase2');
        return doc ? splitDoc(doc).data : null;
    },

    /** settings/consent_config raw data, or null when the doc is absent (never widens isConsentDecider). */
    async getConsentConfigRaw(): Promise<Record<string, any> | null> {
        const doc = await getSupaAdapter().getDoc('settings', 'consent_config');
        return doc ? splitDoc(doc).data : null;
    },

    /** Admin erasure queue: newest first, bounded (mirrors the Firestore orderBy/limit exactly). */
    async listErasureRequests(limit = 50): Promise<Array<Record<string, any>>> {
        const docs = await getSupaAdapter().listDocs('erasure_requests', {
            orderBy: { field: 'requestedAt', direction: 'desc' },
            limit,
        });
        return docs as Array<Record<string, any>>;
    },
};

/**
 * Firestore-shaped db facade over the adapter, serving the
 * erasure_requests collection ONLY - the db half of
 * createErasureDepsSupa(). erasure.ts changes zero lines (plan G3
 * key design point): requestErasure uses where().where().get() and
 * add(); withdrawErasure uses doc().get()/update(). Per ruling G3-2
 * the EXECUTE path never runs on these deps (the execute route keeps
 * createErasureDeps), so any other collection throws instead of
 * silently half-migrating the platform's only irreversible flow.
 */
export function createSupaErasureDb() {
    const COLLECTION = 'erasure_requests';
    function assertCollection(name: string): void {
        if (name !== COLLECTION) {
            throw new Error(
                `createErasureDepsSupa serves ${COLLECTION} only; execute-path collections stay on Firestore deps (plan G3 ruling 2)`,
            );
        }
    }
    function docRef(id: string) {
        return {
            id,
            async get() {
                const doc = await getSupaAdapter().getDoc(COLLECTION, id);
                return {
                    exists: doc !== null,
                    id,
                    data: () => (doc ? splitDoc(doc).data : undefined),
                };
            },
            async update(data: Record<string, any>) {
                await getSupaAdapter().updateDoc(COLLECTION, id, data);
            },
            async set(data: Record<string, any>, opts?: { merge?: boolean }) {
                await getSupaAdapter().setDoc(COLLECTION, id, data, opts);
            },
        };
    }
    function query(filters: Array<[string, string, unknown]>) {
        return {
            where(field: string, op: string, value: unknown) {
                return query([...filters, [field, op, value]]);
            },
            async get() {
                const docs = await getSupaAdapter().listDocs(
                    COLLECTION,
                    { where: filters as Array<[string, '==', unknown]> },
                );
                const rows = docs.map((d) => {
                    const { id, data } = splitDoc(d);
                    return { id, data: () => data, ref: docRef(id) };
                });
                return {
                    docs: rows,
                    empty: rows.length === 0,
                    size: rows.length,
                    forEach: (cb: (doc: (typeof rows)[number]) => void) => rows.forEach(cb),
                };
            },
        };
    }
    return {
        collection(name: string) {
            assertCollection(name);
            return {
                where: (field: string, op: string, value: unknown) => query([[field, op, value]]),
                doc: (id: string) => docRef(id),
                async add(data: Record<string, any>) {
                    // Firestore .add() auto-id: the supa deps generate
                    // the id and use setDoc, preserving the {id} return
                    // shape (plan G3, erasure.ts:62).
                    const id = randomUUID();
                    await getSupaAdapter().setDoc(COLLECTION, id, data);
                    return { id };
                },
            };
        },
    };
}
