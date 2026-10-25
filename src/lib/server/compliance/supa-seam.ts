/**
 * supa-seam.ts - the ONE Supabase seam for compliance + probation
 * (CLUSTER_COMPLIANCE_PLAN.md G2). Surface: useSupa('compliance')
 * (probation rides the SAME surface; no second flag).
 *
 * Gate rule (plan §0.2): consumers consult this seam only when
 * `useSupa('compliance') && getSupaClient()`; an adapter error falls
 * back to the Firestore path byte-for-byte. Flag OFF / client null =
 * indistinguishable from the pre-migration tree.
 *
 * Wrap list (plan G2): compliance_obligations, default_notices,
 * compliance_templates, compliance_reports, compliance_triggers,
 * probation_restores (get/list/set/update), compliance_meta/generator
 * (get + set merge). NOT here: users, roles, chapters, audit_logs
 * (foreign clusters - compliance code keeps its Firestore handle for
 * those).
 *
 * The {ref, data} centerpiece: access.ts loaders historically return
 * a real DocumentReference and consumers call ref.update(...). The
 * supa ref facade below exposes exactly the ref surface those
 * consumers use (id / path / get / set / update / delete) backed by
 * the adapter, so loader consumers migrate without shape changes.
 * It is a data-access facade, not a Firestore impersonation: no
 * Timestamp shims are fabricated anywhere in this module.
 *
 * serverTimestamp rule (plan G2 hotspots): the adapter has no
 * serverTimestamp. Seam WRITES substitute an ISO string for any
 * FieldValue.serverTimestamp() sentinel found at the top level of a
 * write payload, so supa rows store ISO strings throughout. Writes
 * through this seam therefore flip only when the surface is
 * supa-primary for the collection (plan §0.4).
 */
import { getSupaAdapter, getSupaClient, useSupa, type SupaDoc, type WhereClause } from '@/lib/supa';

export const COMPLIANCE_SURFACE = 'compliance';

export function complianceSupaEnabled(): boolean {
    return useSupa(COMPLIANCE_SURFACE) && getSupaClient() !== null;
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

export function nowIso(): string {
    return new Date().toISOString();
}

function isServerTimestampSentinel(v: unknown): boolean {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    if (typeof o._methodName === 'string' && o._methodName.includes('serverTimestamp')) return true;
    const ctor = (v as { constructor?: { name?: string } }).constructor;
    return ctor?.name === 'ServerTimestampTransform';
}

/** Replace top-level serverTimestamp sentinels with an ISO now string (plan G2 seam rule). */
export function scrubServerTimestamps<T extends Record<string, any>>(data: T): T {
    let out: T | null = null;
    for (const [k, v] of Object.entries(data)) {
        if (isServerTimestampSentinel(v)) {
            if (!out) out = { ...data };
            (out as Record<string, any>)[k] = nowIso();
        }
    }
    return out ?? data;
}

function splitDoc(doc: SupaDoc): { id: string; data: Record<string, any> } {
    const { id, ...data } = doc as Record<string, any>;
    return { id: String(id), data };
}

export interface SupaRefFacade {
    id: string;
    path: string;
    get(): Promise<{ exists: boolean; id: string; data: () => Record<string, any> | undefined; ref: SupaRefFacade }>;
    set(data: Record<string, any>, opts?: { merge?: boolean }): Promise<void>;
    update(data: Record<string, any>): Promise<void>;
    delete(): Promise<void>;
}

export function supaRef(collection: string, id: string): SupaRefFacade {
    const ref: SupaRefFacade = {
        id,
        path: `${collection}/${id}`,
        async get() {
            const doc = await getSupaAdapter().getDoc(collection, id);
            return {
                exists: doc !== null,
                id,
                data: () => (doc ? splitDoc(doc).data : undefined),
                ref,
            };
        },
        async set(data, opts) {
            await getSupaAdapter().setDoc(collection, id, scrubServerTimestamps(data), opts);
        },
        async update(data) {
            await getSupaAdapter().updateDoc(collection, id, scrubServerTimestamps(data));
        },
        async delete() {
            await getSupaAdapter().deleteDoc(collection, id);
        },
    };
    return ref;
}

export interface SupaSnapDoc {
    id: string;
    data: () => Record<string, any>;
    ref: SupaRefFacade;
}

export interface SupaSnap {
    docs: SupaSnapDoc[];
    empty: boolean;
    size: number;
    forEach: (cb: (doc: SupaSnapDoc) => void) => void;
}

export const complianceData = {
    enabled: complianceSupaEnabled,
    toDateValue,
    nowIso,
    supaRef,

    /** Single-doc get as data-only (no id key), null on miss. */
    async getDocData(collection: string, id: string): Promise<Record<string, any> | null> {
        const doc = await getSupaAdapter().getDoc(collection, id);
        return doc ? splitDoc(doc).data : null;
    },

    /** List as {id, data} pairs (data excludes the id key). */
    async listDocData(
        collection: string,
        where?: WhereClause[],
        options?: { orderBy?: { field: string; direction?: 'asc' | 'desc' }; limit?: number },
    ): Promise<Array<{ id: string; data: Record<string, any> }>> {
        const docs = await getSupaAdapter().listDocs(collection, { where, orderBy: options?.orderBy, limit: options?.limit });
        return docs.map((d) => splitDoc(d));
    },

    /**
     * Snapshot-shaped list for consumers written against
     * collection.get() (cron loaders, the probation adapter): docs
     * carry data() and a ref facade whose update() routes to the
     * adapter with serverTimestamp scrubbing.
     */
    async listSnap(collection: string, where?: WhereClause[]): Promise<SupaSnap> {
        const rows = await complianceData.listDocData(collection, where);
        const docs: SupaSnapDoc[] = rows.map((row) => ({
            id: row.id,
            data: () => row.data,
            ref: supaRef(collection, row.id),
        }));
        return {
            docs,
            empty: docs.length === 0,
            size: docs.length,
            forEach: (cb) => docs.forEach(cb),
        };
    },

    async setDocData(collection: string, id: string, data: Record<string, any>, opts?: { merge?: boolean }): Promise<void> {
        await getSupaAdapter().setDoc(collection, id, scrubServerTimestamps(data), opts);
    },

    async updateDocData(collection: string, id: string, updates: Record<string, any>): Promise<void> {
        await getSupaAdapter().updateDoc(collection, id, scrubServerTimestamps(updates));
    },
};
