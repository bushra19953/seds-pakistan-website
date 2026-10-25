/**
 * chapters-supa.ts — the ONE Supabase seam for the chapters surface
 * (APPS-3: admin chapters CRUD, public v1 chapters, chapter reads).
 *
 * Every Supabase touch for `chapters` lives in this module. Consumers:
 *   src/app/api/admin/chapters/route.ts        (POST create)
 *   src/app/api/admin/chapters/[id]/route.ts   (PATCH lifecycle/cosmetic)
 *   src/app/api/v1/chapters/route.ts           (GET public list)
 *
 * NOT consumers (inventoried, left on Firestore — see the report):
 *   src/app/api/v1/chapters/invoice/route.ts — contains NO chapters
 *     collection access at all (reads users + warningConfig, reads/writes
 *     chapter_applications, writes audit_logs; all other clusters).
 *   Client direct reads (admin chapters page, chapter-selector,
 *     role-clusters-overview, chapter-switcher) — the adapter is
 *     server-side and no design-verifier ruling / approved server route
 *     exists for them; each read site carries a blocker comment.
 *
 * Behavior contract:
 * - Flag OFF (default), adapter absent/unconfigured, or adapter load
 *   failure -> resolveChaptersSupaAdapter() returns null and every
 *   caller behaves EXACTLY as it does on Firestore today.
 * - Flag ON + adapter present: reads (existence, current-doc, public
 *   list) are served from fs_chapters through this seam; any seam read
 *   error makes the caller fall back to its Firestore read. Writes stay
 *   Firestore-primary and are mirrored through this seam; mirror
 *   helpers NEVER throw (a missed mirror is a stale read copy, not a
 *   failed write).
 *
 * The real adapter (src/lib/supa/, branch feat/supa-adapter) is NOT in
 * this tree. It is reached through a lazy dynamic import with a variable
 * specifier so tsc stays clean on this base, typed against the locally
 * declared ChaptersSupaAdapter interface matching the adapter contract
 * (getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc over
 * fs_<collection>). MERGE-TIME RE-POINT = the one specifier line in
 * loadAdapterModule() below (default '@/lib/supa', whose index exports
 * getSupaAdapter()/getSupaClient()/useSupa).
 *
 * INBOUND CONTRACT for APPS-1 (chapter-applications approval):
 * approval creates a chapters doc keyed by slug. APPS-1 calls (at merge
 * time, from src/app/actions/chapter-applications.ts after its
 * Firestore set succeeds):
 *   mirrorChapterCreate(finalSlug, chapterData)
 * with chapterData EXACTLY the object it wrote to Firestore:
 *   {
 *     name: string,                 // proposedChapterName
 *     slug: string,                 // === finalSlug (doc id)
 *     city: string, country: string,
 *     universityName: string,
 *     isActive: true,
 *     applicationId: string,
 *     foundedBy: string,            // applicant uid
 *     teamMembers: Array<{ name: string; email: string; role: string; department?: string }>,
 *     facultyAdvisor: { name: string; email: string; department?: string; designation?: string } | null,
 *     createdAt: <serverTimestamp sentinel | Date | ISO string>,
 *     updatedAt: <same>,
 *   }
 * mirrorChapterCreate serializes timestamps/sentinels to ISO strings
 * and upserts fs_chapters row { id: finalSlug, parent_path: 'chapters',
 * data }. It never throws and is a no-op when the flag is OFF.
 *
 * Timestamp reality: Firestore Timestamps do not survive jsonb. Stored
 * values come back as ISO strings, epoch numbers, or Admin-SDK dump
 * shapes ({ _seconds, _nanoseconds } / { seconds, nanoseconds }).
 * chapterDocFromSupa() restores createdAt/updatedAt to a
 * Timestamp-shaped value (seconds/nanoseconds/toMillis/toDate/
 * toISOString) for any consumer that expects Firestore Timestamps.
 * Current route consumers do not read chapter timestamps (hotspot list
 * in the APPS-3 report), so this is seam-level insurance, unit-tested.
 */

export type SupaWhereClause = [field: string, op: string, value: any];

export interface SupaListOptions {
  where?: SupaWhereClause[];
  orderBy?: string | { field: string; direction?: 'asc' | 'desc' } | Array<{ field: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  startAfter?: string | number;
}

/** The adapter contract (src/lib/supa, parallel workstream). */
export interface ChaptersSupaAdapter {
  getDoc(collection: string, id: string): Promise<Record<string, any> | null>;
  listDocs(collection: string, options?: SupaListOptions): Promise<Array<Record<string, any>>>;
  countDocs(collection: string, where?: SupaWhereClause[]): Promise<number>;
  setDoc(collection: string, id: string, data: Record<string, any>, options?: { merge?: boolean }): Promise<unknown>;
  updateDoc(collection: string, id: string, data: Record<string, any>): Promise<unknown>;
  deleteDoc(collection: string, id: string): Promise<void>;
}

export const CHAPTERS_SUPA_SURFACE = 'chapters';
export const CHAPTERS_COLLECTION = 'chapters';

/**
 * useSupa('chapters') equivalent for this tree: SUPA_SURFACES
 * comma-list, case-insensitive, '*' = all surfaces; default OFF.
 * At merge time swap for the adapter's useSupa('chapters').
 */
export function isChaptersSupaFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SUPA_SURFACES || '';
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.includes('*') || parts.includes(CHAPTERS_SUPA_SURFACE);
}

// ---------------------------------------------------------------------------
// Adapter resolution (lazy, cached, test-injectable)
// ---------------------------------------------------------------------------

let injectedAdapter: ChaptersSupaAdapter | null | undefined;
let adapterPromise: Promise<ChaptersSupaAdapter | null> | null = null;

/** Test-only: inject a mocked adapter (or null to simulate absence). */
export function __setChaptersSupaAdapterForTests(adapter: ChaptersSupaAdapter | null): void {
  injectedAdapter = adapter;
  adapterPromise = null;
}

/** Test-only: clear injection and the cached adapter promise. */
export function __resetChaptersSupaAdapterForTests(): void {
  injectedAdapter = undefined;
  adapterPromise = null;
}

async function loadAdapterModule(): Promise<ChaptersSupaAdapter | null> {
  // Variable specifier on purpose: the adapter module does not exist in
  // this tree, so a static/literal import would fail tsc and the build.
  // MERGE-TIME RE-POINT: this one line -> '@/lib/supa'.
  const specifier: string = process.env.SUPA_ADAPTER_SPECIFIER || '@/lib/supa';
  try {
    const mod: any = await import(/* webpackIgnore: true */ specifier);
    let candidate: any = null;
    if (typeof mod?.getSupaAdapter === 'function') {
      // Real adapter index: getSupaAdapter() builds over getSupaClient();
      // its methods throw SupaUnavailableError when unconfigured, which
      // callers here treat as "fall back to Firestore".
      candidate = mod.getSupaAdapter();
    } else {
      candidate = mod?.default ?? mod?.adapter ?? mod;
    }
    if (
      candidate &&
      typeof candidate.getDoc === 'function' &&
      typeof candidate.listDocs === 'function' &&
      typeof candidate.setDoc === 'function' &&
      typeof candidate.updateDoc === 'function' &&
      typeof candidate.deleteDoc === 'function'
    ) {
      return candidate as ChaptersSupaAdapter;
    }
    console.warn('[supa-seam:chapters] Adapter module loaded but does not match the contract; staying on Firestore');
    return null;
  } catch (err) {
    console.warn('[supa-seam:chapters] Adapter unavailable; staying on Firestore', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolve the adapter for this surface, or null when the flag is OFF,
 * the adapter is absent, or loading failed. Null always means: use the
 * Firestore path, unchanged.
 */
export async function resolveChaptersSupaAdapter(): Promise<ChaptersSupaAdapter | null> {
  if (!isChaptersSupaFlagOn()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  if (!adapterPromise) adapterPromise = loadAdapterModule();
  return adapterPromise;
}

// ---------------------------------------------------------------------------
// Timestamp normalization / restoration
// ---------------------------------------------------------------------------

export const CHAPTER_TIMESTAMP_FIELDS = ['createdAt', 'updatedAt'] as const;

export interface SeamTimestamp {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
  toDate(): Date;
  toISOString(): string;
}

export function seamTimestampFromMs(ms: number): SeamTimestamp {
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = Math.floor((ms - seconds * 1000) * 1e6);
  return {
    seconds,
    nanoseconds,
    toMillis: () => ms,
    toDate: () => new Date(ms),
    toISOString: () => new Date(ms).toISOString(),
  };
}

/** Any stored timestamp representation -> epoch ms, or null. */
export function supaTimestampToMs(value: any): number | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === 'number') return isNaN(new Date(value).getTime()) ? null : value;
    if (typeof value === 'string') {
      const ms = new Date(value).getTime();
      return isNaN(ms) ? null : ms;
    }
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value?.toMillis === 'function') return value.toMillis();
    if (typeof value?.toDate === 'function') {
      const d = value.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d.getTime() : null;
    }
    const seconds = value?._seconds ?? value?.seconds;
    if (typeof seconds === 'number') {
      const nanos = value?._nanoseconds ?? value?.nanoseconds ?? 0;
      return seconds * 1000 + Math.floor(nanos / 1e6);
    }
    return null;
  } catch {
    return null;
  }
}

export function supaTimestampToIso(value: any): string | null {
  const ms = supaTimestampToMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Convert one adapter doc ({ id, ...data }, the adapter's Firestore
 * shape) into the chapter shape route consumers use: id wins, and
 * createdAt/updatedAt are restored to Timestamp-shaped values.
 */
export function chapterDocFromSupa(doc: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...doc };
  for (const field of CHAPTER_TIMESTAMP_FIELDS) {
    if (out[field] !== undefined && out[field] !== null) {
      const ms = supaTimestampToMs(out[field]);
      if (ms !== null) out[field] = seamTimestampFromMs(ms);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mirror-write serialization (Firestore values -> jsonb values)
// ---------------------------------------------------------------------------

/**
 * Deep-convert a chapter document being written to Firestore into the
 * JSON shape stored in fs_chapters.data: Timestamp-like values and
 * serverTimestamp() sentinels -> ISO strings; other FieldValue
 * sentinels -> null; plain data recurses. Never throws.
 */
export function serializeChapterForSupa(data: any): any {
  try {
    return serializeValue(data);
  } catch {
    return data;
  }
}

function serializeValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return supaTimestampToIso(value);
  if (typeof value?.toDate === 'function') return supaTimestampToIso(value);
  const method = (value as any)?._methodName;
  if (method === 'serverTimestamp') return new Date().toISOString();
  if (typeof method === 'string') return null;
  const seconds = (value as any)?._seconds ?? (value as any)?.seconds;
  if (typeof seconds === 'number' && Object.keys(value).length <= 3) {
    return supaTimestampToIso(value);
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
  return out;
}

// ---------------------------------------------------------------------------
// Read helpers (throw on adapter error so callers fall back to Firestore)
// ---------------------------------------------------------------------------

/** getDoc('chapters', id) with timestamps restored, or null if absent. */
export async function getChapterViaSupa(
  adapter: ChaptersSupaAdapter,
  id: string,
): Promise<Record<string, any> | null> {
  const doc = await adapter.getDoc(CHAPTERS_COLLECTION, id);
  return doc ? chapterDocFromSupa(doc) : null;
}

/** listDocs('chapters') — bounded; adapter returns { id, ...data }. */
export async function listChaptersViaSupa(
  adapter: ChaptersSupaAdapter,
  limit = 1000,
): Promise<Array<Record<string, any>>> {
  const docs = await adapter.listDocs(CHAPTERS_COLLECTION, { limit });
  return docs.map(chapterDocFromSupa);
}

// ---------------------------------------------------------------------------
// Mirror helpers (NEVER throw; Firestore is primary)
// ---------------------------------------------------------------------------

async function mirror(op: string, id: string, run: (a: ChaptersSupaAdapter) => Promise<unknown>): Promise<void> {
  try {
    const adapter = await resolveChaptersSupaAdapter();
    if (!adapter) return;
    await run(adapter);
  } catch (err) {
    console.error('[chapters-supa] mirror failed', op, id, err);
  }
}

/** setDoc mirror after a Firestore chapter create (incl. APPS-1's). */
export async function mirrorChapterCreate(id: string, data: Record<string, any>): Promise<void> {
  await mirror('set', id, (a) => a.setDoc(CHAPTERS_COLLECTION, id, serializeChapterForSupa(data)));
}

/** updateDoc mirror after a Firestore chapter update. */
export async function mirrorChapterUpdate(id: string, updates: Record<string, any>): Promise<void> {
  await mirror('update', id, (a) => a.updateDoc(CHAPTERS_COLLECTION, id, serializeChapterForSupa(updates)));
}

/** deleteDoc mirror after a Firestore chapter delete. */
export async function mirrorChapterDelete(id: string): Promise<void> {
  await mirror('delete', id, (a) => a.deleteDoc(CHAPTERS_COLLECTION, id));
}
