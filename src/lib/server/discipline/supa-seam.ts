/**
 * supa-seam.ts - the ONE Supabase seam for the discipline group
 * (CLUSTER_COMPLIANCE_PLAN.md G1). Surface: useSupa('discipline').
 *
 * Every other discipline file keeps its Firestore calls or calls this
 * seam; no other discipline file imports '@/lib/supa/*'. Gate rule
 * (plan §0.2): the seam is only consulted when
 * `useSupa('discipline') && getSupaClient()`; consumers wrap seam
 * calls so an adapter error falls back to the Firestore path
 * byte-for-byte. Flag OFF / client null = indistinguishable from the
 * pre-migration tree.
 *
 * Wrap list (plan G1): disciplinary_cases gets/lists,
 * deadline_miss_records gets/lists, active-expulsions lookup,
 * settings/discipline (read half), warningConfig/global (read half),
 * governance_votes + governance_votes/{id}/ballots (READ HALF ONLY).
 *
 * NOT here, by plan ruling (G1 never-bulk-migrate): every write to
 * disciplinary_cases / users / users/{uid}/warnings / counters /
 * audit_logs / points_audit / tasks / roles. The decision, expulsion
 * and founder-review transactions stay Firestore writers; this seam
 * transports reads only and never transitions a case status.
 */
import { getSupaAdapter, getSupaClient, useSupa, type SupaDoc, type WhereClause } from '@/lib/supa';

export const DISCIPLINE_SURFACE = 'discipline';

/** True only when the surface flag is on AND a client is configured. */
export function disciplineSupaEnabled(): boolean {
    return useSupa(DISCIPLINE_SURFACE) && getSupaClient() !== null;
}

/**
 * The seam's single date converter (plan §0.3): stored values arrive
 * as ISO strings (adapter storage ruling), Dates, Timestamp-likes, or
 * dumped {seconds,nanoseconds} shapes. Returns a Date or null; never
 * fabricates a Timestamp-shaped shim.
 */
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

async function getDocData(collection: string, id: string): Promise<Record<string, any> | null> {
    const doc = await getSupaAdapter().getDoc(collection, id);
    if (!doc) return null;
    return doc as Record<string, any>;
}

async function listDocData(
    collection: string,
    where?: WhereClause[],
    options?: { orderBy?: { field: string; direction?: 'asc' | 'desc' }; limit?: number },
): Promise<Array<Record<string, any>>> {
    const docs: SupaDoc[] = await getSupaAdapter().listDocs(collection, { where, orderBy: options?.orderBy, limit: options?.limit });
    return docs as Array<Record<string, any>>;
}

export const disciplineData = {
    enabled: disciplineSupaEnabled,
    toDateValue,

    /** disciplinary_cases single get; null on miss. */
    getCase: (caseId: string) => getDocData('disciplinary_cases', caseId),

    /** disciplinary_cases list (adapter returns full docs; projections are dropped client-side by callers, per plan G1). */
    listCases: (
        where?: WhereClause[],
        options?: { orderBy?: { field: string; direction?: 'asc' | 'desc' }; limit?: number },
    ) => listDocData('disciplinary_cases', where, options),

    listCasesBySubject: (uid: string) => listDocData('disciplinary_cases', [['subjectUid', '==', uid]]),

    /** deadline_miss_records single get / list. */
    getMissRecord: (id: string) => getDocData('deadline_miss_records', id),
    listMissRecords: (where?: WhereClause[], options?: { limit?: number }) =>
        listDocData('deadline_miss_records', where, options),

    /** threshold-ban's only live read: active expulsion records for a user. */
    listActiveExpulsions: (uid: string) =>
        listDocData('expulsions', [
            ['userId', '==', uid],
            ['status', '==', 'active'],
        ]),

    /** settings/discipline read half (defaults live in settings.ts, not here). */
    getDisciplineSettingsDoc: () => getDocData('settings', 'discipline'),

    /** warningConfig/global read half. */
    getWarningConfig: () => getDocData('warningConfig', 'global'),

    /** governance_votes read half. */
    getVote: (voteId: string) => getDocData('governance_votes', voteId),
    listBallots: (voteId: string) => listDocData(`governance_votes/${voteId}/ballots`),
};
