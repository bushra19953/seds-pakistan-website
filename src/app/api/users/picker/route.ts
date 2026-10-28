import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from 'firebase-admin/auth';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { canUnmaskContacts } from '@/lib/privacy';
import { pickerUserMatchesQuery } from '@/lib/user-picker-search';
import {
  getUsersSupaAdapter,
  supaGetRolesByIds,
  supaListAllUsers,
} from '@/lib/supa-seams/users-directory';
import { getUserContacts } from '@/lib/server/user-contact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/users/picker (Item 6, Phase 0).
 *
 * A narrow, authenticated, server-side member picker that replaces
 * direct client-side LIST reads of the users collection for the
 * consumers the Phase 0 rules change cannot cover with a permission
 * grant (shared pickers and the one non-admin list, projects/new).
 * Once the Batch 1 rules are published, a plain signed-in account
 * can no longer list users or roles from the client; this API is
 * what those pickers call instead.
 *
 * Field allowlist is exhaustive and deliberate: uid, displayName,
 * photoURL, chapterId, role, additionalRoles, isOnVacation — plus
 * email under ONE condition (picker email/role search, 2026-10-26):
 * email is serialized ONLY for unmask-privileged callers
 * (canUnmaskContacts: chairs, presidents, executives — the exact
 * gate /api/users/search already uses). For every other caller the
 * payload is byte-identical to the original allowlist: no email key
 * at all. NEVER whatsapp/whatsappNumber, NEVER points, warning, or
 * ban fields, for anyone. additionalRoles (Custom Roles Fix
 * Program, consumers Surface 2) lets the assignee filter match a
 * role held in additionalRoles, not only the primary role; it
 * follows the same roles-first precedence as role.
 *
 * Params: q (optional substring matched against displayName, email,
 * and role — slug, spaced slug, or display title, primary and
 * additionalRoles — via the shared picker search helper; minimum 2
 * chars, mirroring /api/users/search). Matching is NOT gated:
 * anyone may FIND a person by email, but only unmask-privileged
 * callers SEE the address. chapterId (optional plain filter; this
 * is a picker, not a register - register scoping lives in
 * /api/admin/users), limit (default 100, max 1000).
 *
 * Email source (contact-gating fix, 2026-10-28): email no longer
 * lives on the user record at all — the doc fields are NOT read.
 * Both row builders fill each row's email FIRST from the gated
 * contact record (src/lib/server/user-contact.ts getUserContacts):
 * the contact email is the profile's stated address and WINS over a
 * differing Auth email, per the precedence the 2026-10-27 fix
 * established for doc emails. Rows still missing an email are then
 * filled from Firebase Auth (bulk getUsers, chunks of 100) before
 * the rows enter the 5-minute cache, which is what bounds the Auth
 * cost. Nothing is written anywhere (no backfill); if a lookup
 * fails, the builders degrade to the remaining source and never
 * throw.
 *
 * Params: uid (optional): return the single projected row for that
 * uid — same allow-list projection, email serialized only under the
 * same canUnmaskContacts gate — in the same { users: [...] }
 * envelope with one element (or an empty array when unknown).
 *
 * Read-burn (census F2): the projected rows are cached server-side
 * per chapterId filter for 5 minutes — the same TTL and the same
 * staleness tradeoff as the /api/admin/users directory (C3). Before
 * this cache, every picker mount on every surface re-read the full
 * users collection plus its roles overlay (~444 reads); the admin
 * tasks page alone mounts two picker consumers plus its own fetch.
 * q filtering and the limit slice are applied per request against
 * the cached rows, so response contracts are unchanged.
 */
type PickerRow = {
  uid: string;
  displayName: string;
  // Held server-side for q matching; serialized only for
  // unmask-privileged callers (see the header comment).
  email: string | null;
  photoURL: string | null;
  chapterId: string | null;
  role: string | null;
  additionalRoles: string[];
  isOnVacation: boolean;
};

const PICKER_CACHE_TTL_MS = 5 * 60 * 1000;
const pickerRowsCache = new Map<string, { rows: PickerRow[]; expiresAt: number }>();

/**
 * Fill row emails from the gated contact records (see the header
 * comment for the precedence rule: contact record first, Auth as
 * the fallback). Mutates the rows in place; called by both row
 * builders inside the cached build, so it runs at most once per
 * TTL window per chapter filter. Never throws: a contact-store
 * failure leaves the rows for the Auth fill below.
 */
async function fillRowEmailsFromContacts(db: any, rows: PickerRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const contacts = await getUserContacts(db, rows.map((r) => r.uid));
    for (const r of rows) {
      const email = contacts.get(r.uid)?.email;
      if (email) r.email = email;
    }
  } catch (e) {
    console.warn('[api/users/picker] Contact email fill unavailable; falling back to Auth only:', e);
  }
}

/**
 * Fill missing row emails from Firebase Auth (see the header
 * comment for the root cause and the precedence rule). Mutates the
 * rows in place; called by both row builders inside the cached
 * build, so it runs at most once per TTL window per chapter
 * filter. Never throws: any Auth failure leaves the contact-record
 * emails exactly as they were.
 */
async function fillRowEmailsFromAuth(rows: PickerRow[]): Promise<void> {
  const missing = rows.filter((r) => !r.email);
  if (missing.length === 0) return;

  let auth: ReturnType<typeof getAuth>;
  try {
    auth = getAuth();
  } catch (e) {
    console.warn('[api/users/picker] Auth email fill unavailable; using profile emails only:', e);
    return;
  }

  // getUsers accepts at most 100 identifiers per call.
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const res = await auth.getUsers(chunk.map((r) => ({ uid: r.uid })));
      const emailByUid = new Map<string, string>();
      for (const u of res.users) {
        if (u.email) emailByUid.set(u.uid, u.email);
      }
      for (const r of chunk) {
        const email = emailByUid.get(r.uid);
        if (email) r.email = email;
      }
    } catch (e) {
      console.warn('[api/users/picker] Auth email fill failed for a chunk; using profile emails only:', e);
    }
  }
}

/**
 * Build (or return the cached) projected picker rows for one
 * chapterId filter. The Firestore work — full users get for the
 * filter plus the chunked roles overlay — happens at most once per
 * TTL window per filter; q and limit are applied by the caller
 * against the returned rows.
 */
async function loadPickerRows(db: any, chapterId: string): Promise<PickerRow[]> {
  const cacheKey = chapterId || '';
  const hit = pickerRowsCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.rows;
  }

  let usersQuery: any = db.collection('users');
  if (chapterId) {
    usersQuery = usersQuery.where('chapterId', '==', chapterId);
  }
  const snap = await usersQuery.get();

  const baseUsers: Array<{ id: string; data: any }> = snap.docs.map((d: any) => ({ id: d.id, data: d.data() || {} }));

  // Roles overlay, roles-first (roles/{uid} is the source of truth;
  // the users mirror is the fallback), in chunks of 30 by document
  // id - the pattern /api/admin/users already uses.
  const coerceAdditionalRoles = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((v) => String(v)) : [];
  const rolesMap: Record<string, string> = {};
  const rolesAdditionalMap: Record<string, string[]> = {};
  const uids = baseUsers.map((u) => u.id);
  for (let i = 0; i < uids.length; i += 30) {
    const chunk = uids.slice(i, i + 30);
    if (chunk.length === 0) continue;
    try {
      const rolesSnap = await db.collection('roles').where('__name__', 'in', chunk).get();
      rolesSnap.docs.forEach((doc: any) => {
        const data = doc.data() || {};
        if (data.role) rolesMap[doc.id] = String(data.role);
        // Recorded for EVERY roles doc (even without the field): the
        // roles doc is the source of truth, so its additionalRoles -
        // or their absence - win over the users mirror.
        rolesAdditionalMap[doc.id] = coerceAdditionalRoles(data.additionalRoles);
      });
    } catch (e) {
      console.warn('[api/users/picker] roles overlay failed for a chunk:', e);
    }
  }

  const rows: PickerRow[] = baseUsers.map((u) => ({
    uid: u.id,
    displayName: String(u.data.displayName || u.data.name || ''),
    // Email is never read from the user record: it is filled from
    // the gated contact record, then Firebase Auth, below.
    email: null,
    photoURL: u.data.photoURL || null,
    chapterId: u.data.chapterId || u.data.chapter || null,
    role: rolesMap[u.id] || u.data.role || null,
    additionalRoles: Object.prototype.hasOwnProperty.call(rolesAdditionalMap, u.id)
      ? rolesAdditionalMap[u.id]
      : coerceAdditionalRoles(u.data.additionalRoles),
    isOnVacation: u.data.isOnVacation === true || u.data.vacationMode === true,
  }));

  await fillRowEmailsFromContacts(db, rows);
  await fillRowEmailsFromAuth(rows);

  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));

  pickerRowsCache.set(cacheKey, { rows, expiresAt: Date.now() + PICKER_CACHE_TTL_MS });
  return rows;
}

/**
 * Supa counterpart of loadPickerRows (G2): same projected rows, same
 * roles-first overlay semantics, same per-chapter cache and TTL, read
 * through the adapter instead of Firestore. The users read is the
 * adapter's unbounded listDocs (chapter equality pushed down as a
 * where clause) — the picker always needed the full filtered set, so
 * there is no window to reproduce here. Throws on adapter error; the
 * caller falls back to loadPickerRows (Firestore) in full.
 */
async function loadPickerRowsSupa(
  adapter: NonNullable<ReturnType<typeof getUsersSupaAdapter>>,
  chapterId: string,
  db: any,
): Promise<PickerRow[]> {
  const cacheKey = chapterId || '';
  const hit = pickerRowsCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.rows;
  }

  const userRows = await supaListAllUsers(adapter, chapterId || null);
  const baseUsers = userRows.map((r) => ({ id: r.id, data: r.data as any }));

  const coerceAdditionalRoles = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((v) => String(v)) : [];
  const rolesMap: Record<string, string> = {};
  const rolesAdditionalMap: Record<string, string[]> = {};
  const roleRows = await supaGetRolesByIds(adapter, baseUsers.map((u) => u.id));
  roleRows.forEach((r) => {
    const data = r.data as any;
    if (data.role) rolesMap[r.id] = String(data.role);
    rolesAdditionalMap[r.id] = coerceAdditionalRoles(data.additionalRoles);
  });

  const rows: PickerRow[] = baseUsers.map((u) => ({
    uid: u.id,
    displayName: String(u.data.displayName || u.data.name || ''),
    // Email is never read from the user record: it is filled from
    // the gated contact record, then Firebase Auth, below.
    email: null,
    photoURL: u.data.photoURL || null,
    chapterId: u.data.chapterId || u.data.chapter || null,
    role: rolesMap[u.id] || u.data.role || null,
    additionalRoles: Object.prototype.hasOwnProperty.call(rolesAdditionalMap, u.id)
      ? rolesAdditionalMap[u.id]
      : coerceAdditionalRoles(u.data.additionalRoles),
    isOnVacation: u.data.isOnVacation === true || u.data.vacationMode === true,
  }));

  await fillRowEmailsFromContacts(db, rows);
  await fillRowEmailsFromAuth(rows);

  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));

  pickerRowsCache.set(cacheKey, { rows, expiresAt: Date.now() + PICKER_CACHE_TTL_MS });
  return rows;
}

export async function GET(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim().toLowerCase();
  const chapterId = (searchParams.get('chapterId') || '').trim();
  const uidParam = (searchParams.get('uid') || '').trim();
  const limitParam = parseInt(searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), 1000)
    : 100;

  // Mirrors /api/users/search: a supplied query shorter than 2 chars
  // matches nothing rather than dumping the directory.
  if (q && q.length < 2) {
    return NextResponse.json({ users: [] });
  }

  // Supa gate (G2): flag ON + configured client serves through the
  // adapter; any adapter error falls back to the Firestore build.
  const supaAdapter = getUsersSupaAdapter();
  const loadRows = async (chapter: string): Promise<PickerRow[]> => {
    if (supaAdapter) {
      try {
        return await loadPickerRowsSupa(supaAdapter, chapter, db);
      } catch (e) {
        console.warn('[api/users/picker] Supa rows failed; falling back to Firestore:', e);
      }
    }
    return loadPickerRows(db, chapter);
  };
  const rows = await loadRows(chapterId);

  // Email leaves the server only for unmask-privileged callers
  // (canUnmaskContacts, the /api/users/search gate). Everyone else
  // gets the original allowlist shape, key for key.
  const includeEmail = canUnmaskContacts(auth.user.role);
  const serializeRow = (u: PickerRow) =>
    includeEmail
      ? u
      : {
          uid: u.uid,
          displayName: u.displayName,
          photoURL: u.photoURL,
          chapterId: u.chapterId,
          role: u.role,
          additionalRoles: u.additionalRoles,
          isOnVacation: u.isOnVacation,
        };

  // Single-row lookup by uid: same projected row, same envelope
  // ({ users: [row] }), same email gate as list rows. A uid outside
  // the requested chapter filter is retried against the unfiltered
  // build (the per-chapter cache makes the warm case free).
  if (uidParam) {
    let row = rows.find((u) => u.uid === uidParam);
    if (!row && chapterId) {
      const allRows = await loadRows('');
      row = allRows.find((u) => u.uid === uidParam);
    }
    return NextResponse.json({ users: row ? [serializeRow(row)] : [] });
  }

  const filtered = q
    ? rows.filter((u) => pickerUserMatchesQuery(u, q))
    : rows;

  const page = filtered.slice(0, limit);

  const users = page.map(serializeRow);

  return NextResponse.json({ users });
}
