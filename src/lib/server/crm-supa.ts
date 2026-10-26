/**
 * CRM sponsors/partners -> Supabase seam (Cluster F, merge plan step 7).
 *
 * Every Supabase touch for the `sponsors_partners` collection owned by the
 * CRM cluster lives here; the admin partners routes, the related-party
 * route, the AI match route, the partners export consumer check and the
 * finance public-org gate call these helpers and keep their Firestore
 * code paths untouched for the flag-OFF case.
 *
 * Gate: useSupa('crm') && getSupaClient() (SUPA_SURFACES env, default
 * OFF). Flag OFF, client unconfigured, or ANY adapter error => read
 * helpers return null and callers fall back to Firestore byte-identically.
 *
 * Writes: Firestore stays primary and authoritative. mirror* helpers copy
 * a completed Firestore write into Supabase best-effort — they never
 * throw, so a mirror failure can never fail a request Firestore served.
 *
 * Whole-collection reads (CLUSTER_MAP F, census P14/B2): the sponsor-
 * match panel and the CRM list read the WHOLE collection per run. The
 * seam serves those reads through the adapter's listDocs WITHOUT a
 * limit: the adapter fetches through an id-keyset paged loop (page size
 * 1000), so a collection larger than the PostgREST row cap is returned
 * complete — no 1000-row silent truncation. The paged variant
 * (supaListPartnersPage) exists for the CRM list port, which adds the
 * server pagination Firestore never had (CLUSTER_MAP F, listener B2).
 *
 * Ordering (type hotspot named in CLUSTER_MAP F): the contacts query
 * orders by `updatedAt` desc. Firestore Timestamps and the adapter's
 * ISO strings sort differently as raw text for equal-second rows; the
 * adapter's client-side finishing sorts timestamp fields
 * chronologically with a document-id-ascending final tiebreak, which is
 * the ordering this seam requests. Seam rows normalize every known
 * timestamp field to an ISO string before consumers see them.
 *
 * Hidden-read note (finance residual report, `crm_status_active`): the
 * money-approval apply path (cluster M, A21) reads a sponsors_partners
 * target doc inside its Firestore transaction plus, when the target
 * carries a related-party consent id, a consent view via getConsentView.
 * Neither read is touched here: the transactional target read stays
 * Firestore (its atomicity is the approvals flow's), and the consent
 * view stays behind finance's own `finance-lib-core` gate. This seam
 * must never be wired into money-approval.ts.
 *
 * EV-P07 fence: nothing here touches store products or event-ticket
 * linking; the Linked Store Product defect is a separate defect change.
 */

import { getSupaAdapter, getSupaClient, isSupaPrimary, useSupa } from '@/lib/supa';
import type { SupaDoc } from '@/lib/supa';

export const CRM_SUPA_SURFACE = 'crm';
export const CRM_COLLECTION = 'sponsors_partners';

/* ------------------------------------------------------------ port gate */

export interface CrmSupaPort {
  listDocs: ReturnType<typeof getSupaAdapter>['listDocs'];
  getDoc: ReturnType<typeof getSupaAdapter>['getDoc'];
  setDoc: ReturnType<typeof getSupaAdapter>['setDoc'];
  updateDoc: ReturnType<typeof getSupaAdapter>['updateDoc'];
  deleteDoc: ReturnType<typeof getSupaAdapter>['deleteDoc'];
}

let enabledOverride: boolean | undefined;
let portOverride: CrmSupaPort | null | undefined;

/** Test-only: force the crm surface gate on/off. */
export function __setCrmSupaEnabledForTests(v: boolean | undefined): void {
  enabledOverride = v;
}

/** Test-only: inject a fake adapter port (null = unconfigured). */
export function __setCrmSupaPortForTests(p: CrmSupaPort | null | undefined): void {
  portOverride = p;
}

export function crmSupaEnabled(): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  try {
    return useSupa(CRM_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

/** The adapter port when the surface can serve, else null (fall back). */
export function crmSupaPort(): CrmSupaPort | null {
  if (enabledOverride !== undefined) {
    if (!enabledOverride) return null;
    if (portOverride !== undefined) return portOverride;
    // Forced ON in tests still needs a port; fall through to the real one.
  }
  try {
    if (!useSupa(CRM_SUPA_SURFACE)) return null;
    if (!getSupaClient()) return null;
    return getSupaAdapter() as unknown as CrmSupaPort;
  } catch {
    return null;
  }
}

function port(): CrmSupaPort | null {
  if (portOverride !== undefined && enabledOverride !== undefined) {
    return enabledOverride ? portOverride : null;
  }
  return crmSupaPort();
}

/* ------------------------------------------------------------- timestamps */

/** Any stored timestamp shape -> ISO string (or null). */
export function crmTimestampToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'object') {
    const t = v as {
      toDate?: () => Date;
      toMillis?: () => number;
      _seconds?: number;
      seconds?: number;
      _nanoseconds?: number;
      nanoseconds?: number;
    };
    if (typeof t.toDate === 'function') {
      try {
        const d = t.toDate();
        return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null;
      } catch {
        return null;
      }
    }
    if (typeof t.toMillis === 'function') {
      const d = new Date(t.toMillis());
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    const seconds = t._seconds ?? t.seconds;
    if (typeof seconds === 'number') {
      const nanos = t._nanoseconds ?? t.nanoseconds ?? 0;
      return new Date(seconds * 1000 + nanos / 1_000_000).toISOString();
    }
  }
  return null;
}

const PARTNER_TIME_FIELDS = ['createdAt', 'updatedAt', 'lastContactAt', 'nextActionDate'] as const;

/**
 * Copy a seam-read partner row with every known timestamp field (top
 * level plus timeline / interactionHistory entry timestamps) normalized
 * to an ISO string. Unparseable values are left untouched so no
 * information is silently destroyed; null stays null.
 */
export function normalizePartnerTimes<T extends Record<string, unknown>>(doc: T): T {
  const out: Record<string, unknown> = { ...doc };
  for (const f of PARTNER_TIME_FIELDS) {
    if (out[f] === undefined || out[f] === null) continue;
    const iso = crmTimestampToIso(out[f]);
    if (iso !== null) out[f] = iso;
  }
  for (const listField of ['timeline', 'interactionHistory'] as const) {
    const list = out[listField];
    if (!Array.isArray(list)) continue;
    out[listField] = list.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const e = { ...(entry as Record<string, unknown>) };
      if (e.timestamp !== undefined && e.timestamp !== null) {
        const iso = crmTimestampToIso(e.timestamp);
        if (iso !== null) e.timestamp = iso;
      }
      return e;
    });
  }
  return out as T;
}

function plain(doc: SupaDoc): Record<string, unknown> {
  return normalizePartnerTimes(doc as Record<string, unknown>);
}

/* ------------------------------------------------------------------ reads */

async function tryRead<T>(fn: (p: CrmSupaPort) => Promise<T>): Promise<T | null> {
  const p = port();
  if (!p) return null;
  try {
    return await fn(p);
  } catch (err) {
    console.error('[crm-supa] read failed; falling back to Firestore', err);
    return null;
  }
}

export interface FakePartnerDoc {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

function toFakeDoc(doc: SupaDoc | null, requestedId: string): FakePartnerDoc {
  if (!doc) return { id: requestedId, exists: false, data: () => undefined };
  const data = plain(doc);
  const { id, ...rest } = data;
  return { id: String(id ?? requestedId), exists: true, data: () => rest };
}

/** One partner doc as a fake Firestore doc snapshot, or null to fall back. */
export async function supaPartnerDoc(id: string): Promise<FakePartnerDoc | null> {
  return tryRead(async (p) => toFakeDoc(await p.getDoc(CRM_COLLECTION, id), id));
}

/** One partner doc as a plain normalized record, or null to fall back. */
export async function supaGetPartner(id: string): Promise<Record<string, unknown> | null> {
  const fake = await supaPartnerDoc(id);
  if (!fake) return null;
  if (!fake.exists) return null;
  return { id: fake.id, ...(fake.data() ?? {}) };
}

/**
 * The WHOLE sponsors_partners collection, updatedAt desc (the contacts
 * query's ordering). No limit is passed: the adapter keyset-pages
 * internally, so the result is complete at any collection size.
 * Returns null to fall back.
 */
export async function supaListAllPartners(): Promise<Array<Record<string, unknown>> | null> {
  return tryRead(async (p) =>
    (
      await p.listDocs(CRM_COLLECTION, {
        orderBy: { field: 'updatedAt', direction: 'desc' },
      })
    ).map(plain),
  );
}

/** Whole collection filtered by status (sponsor-match fallback mode). */
export async function supaListPartnersByStatus(
  status: string | null,
): Promise<Array<Record<string, unknown>> | null> {
  if (!status || status === 'All') return supaListAllPartners();
  return tryRead(async (p) =>
    (
      await p.listDocs(CRM_COLLECTION, {
        where: [['status', '==', status]],
        orderBy: { field: 'updatedAt', direction: 'desc' },
      })
    ).map(plain),
  );
}

/** Specific partners by id (sponsor-match batch mode), input order kept,
 * missing ids skipped — the Firestore getAll(...refs) semantics. */
export async function supaGetPartnersByIds(
  ids: string[],
): Promise<Array<Record<string, unknown>> | null> {
  return tryRead(async (p) => {
    const docs = await Promise.all(ids.map((id) => p.getDoc(CRM_COLLECTION, id)));
    const out: Array<Record<string, unknown>> = [];
    for (const d of docs) if (d) out.push(plain(d));
    return out;
  });
}

export interface PartnerPage {
  partners: Array<Record<string, unknown>>;
  /** updatedAt ISO of the last row when a full page was returned. */
  nextCursor: string | null;
}

/**
 * One server page of the CRM list (updatedAt desc), for the port's new
 * pagination. `cursor` is the previous page's last updatedAt, passed to
 * the adapter as a startAfter bound on the ordered field: an ISO string
 * for ISO-stored rows (compared chronologically by the adapter's
 * finishing), or a millis number when the caller holds one (the
 * adapter's tasks-list idiom for timestamp-shaped rows).
 *
 * Known limit (inherited from value cursors): rows sharing the exact
 * updatedAt instant of the page boundary sort by id inside the page,
 * but a value-only cursor cannot resume inside that equal-instant
 * group, so such rows can be skipped across pages. The whole-collection
 * read (supaListAllPartners) has no such limit and stays the
 * completeness path.
 */
export async function supaListPartnersPage(opts: {
  limit: number;
  cursor?: string | number | null;
  status?: string | null;
}): Promise<PartnerPage | null> {
  return tryRead(async (p) => {
    const docs = await p.listDocs(CRM_COLLECTION, {
      where: opts.status ? [['status', '==', opts.status]] : undefined,
      orderBy: { field: 'updatedAt', direction: 'desc' },
      limit: opts.limit,
      startAfter: opts.cursor ?? undefined,
    });
    const partners = docs.map(plain);
    let nextCursor: string | null = null;
    if (partners.length === opts.limit && partners.length > 0) {
      nextCursor = crmTimestampToIso(partners[partners.length - 1].updatedAt);
    }
    return { partners, nextCursor };
  });
}

/* ---------------------------------------------------------------- mirrors */

/** Deep-convert a write payload to its jsonb form (dates/timestamps and
 * serverTimestamp sentinels -> ISO strings). Never throws. */
export function serializePartnerForMirror(value: unknown): unknown {
  try {
    return serializeValue(value);
  } catch {
    return value;
  }
}

function isServerTimestampSentinel(v: Record<string, unknown>): boolean {
  if (v.__serverTimestamp === true) return true;
  if (typeof v._methodName === 'string') return v._methodName === 'serverTimestamp';
  const ctor = (v as { constructor?: { name?: string } }).constructor;
  return ctor?.name === 'ServerTimestampTransform' || ctor?.name === 'FieldValue';
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return crmTimestampToIso(value);
  const v = value as Record<string, unknown>;
  if (isServerTimestampSentinel(v)) return new Date().toISOString();
  const iso = crmTimestampToIso(value);
  // A timestamp-like object ({_seconds,...} or toDate-bearing) has no
  // other meaningful keys; crmTimestampToIso only succeeds for those.
  if (iso !== null && (typeof v._seconds === 'number' || typeof v.seconds === 'number' || typeof (v as { toDate?: unknown }).toDate === 'function')) {
    return iso;
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val);
  return out;
}

async function mirror(op: 'set' | 'update' | 'delete', id: string, data?: Record<string, unknown>): Promise<void> {
  const p = port();
  if (!p) return;
  try {
    if (op === 'delete') {
      await p.deleteDoc(CRM_COLLECTION, id);
    } else if (op === 'update') {
      try {
        await p.updateDoc(CRM_COLLECTION, id, serializePartnerForMirror(data ?? {}) as Record<string, unknown>);
      } catch (e: unknown) {
        if ((e as { code?: string })?.code === 'not-found') {
          await p.setDoc(CRM_COLLECTION, id, serializePartnerForMirror(data ?? {}) as Record<string, unknown>, { merge: true });
          return;
        }
        throw e;
      }
    } else {
      await p.setDoc(CRM_COLLECTION, id, serializePartnerForMirror(data ?? {}) as Record<string, unknown>);
    }
  } catch (err) {
    console.error(`[crm-supa] mirror ${op} ${CRM_COLLECTION}/${id} failed (Firestore is authoritative)`, err);
  }
}

/** Best-effort mirror of a completed Firestore create — never throws. */
export async function mirrorPartnerCreate(id: string, data: Record<string, unknown>): Promise<void> {
  await mirror('set', id, data);
}

/** Best-effort mirror of a completed Firestore update — never throws. */
export async function mirrorPartnerUpdate(id: string, data: Record<string, unknown>): Promise<void> {
  await mirror('update', id, data);
}

/** Best-effort mirror of a completed Firestore delete — never throws. */
export async function mirrorPartnerDelete(id: string): Promise<void> {
  await mirror('delete', id);
}

/* ------------------------------------------------------------- primacy */
/* WRITE PRIMACY (cutover W4): isSupaPrimary('crm') — token in BOTH
 * SUPA_SURFACES and SUPA_PRIMARY. PrimaryFirst helpers write the
 * adapter FIRST and THROW on failure (never a silent Firestore
 * fallback); the caller then runs its Firestore write as the
 * best-effort post-commit mirror. OFF (default): helpers return false
 * and callers run today's Firestore-first flow + mirror, byte-identical.
 * Payloads go through the same serializePartnerForMirror as the mirror
 * path, so the primary row is byte-identical to today's mirror row. */

let primaryOverride: boolean | undefined;

/** Test-only: force the crm primacy gate on/off. */
export function __setCrmSupaPrimaryForTests(v: boolean | undefined): void {
  primaryOverride = v;
}

export function crmSupaPrimary(): boolean {
  if (primaryOverride !== undefined) return primaryOverride;
  try {
    return isSupaPrimary(CRM_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export async function setPartnerPrimaryFirst(id: string, data: Record<string, unknown>): Promise<boolean> {
  if (!crmSupaPrimary()) return false;
  const p = port();
  if (!p) return false;
  await p.setDoc(CRM_COLLECTION, id, serializePartnerForMirror(data) as Record<string, unknown>);
  return true;
}

export async function updatePartnerPrimaryFirst(id: string, data: Record<string, unknown>): Promise<boolean> {
  if (!crmSupaPrimary()) return false;
  const p = port();
  if (!p) return false;
  await p.updateDoc(CRM_COLLECTION, id, serializePartnerForMirror(data) as Record<string, unknown>);
  return true;
}

export async function deletePartnerPrimaryFirst(id: string): Promise<boolean> {
  if (!crmSupaPrimary()) return false;
  const p = port();
  if (!p) return false;
  await p.deleteDoc(CRM_COLLECTION, id);
  return true;
}
