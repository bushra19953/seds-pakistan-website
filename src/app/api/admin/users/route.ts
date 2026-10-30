import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { withAuth } from "@/lib/auth-middleware";
import { hasServerPermissionForUser, getIdentityBundleCached } from "@/lib/server/permissions";
import { resolveEffectiveScope, resolveChapterFilter } from "@/lib/server/chapter-scoping";
import {
  getUsersSupaAdapter,
  supaGetRolesByIds,
  supaGetUsersByIds,
  supaListAllUsers,
  supaListRolesWhereRole,
  supaListUsersWhere,
  supaListUsersByNameKeyword,
  type SupaRow,
} from "@/lib/supa-seams/users-directory";
import { getAuth } from "firebase-admin/auth";
import {
  getUserContacts,
  stripContactFields,
  type UserContact,
} from "@/lib/server/user-contact";
import { normalizeRoleSlug } from "@/lib/role-catalog";
import {
  NAME_SEARCH_KEYWORDS_FIELD,
  nameSearchKeywordForTerm,
  docHasNameKeyword,
} from "@/lib/name-search-keywords";

function normalize(str: string) {
  return (str || "").trim();
}

// Custom-role grant expiry (expiry-ui plan 5.1): roles/{uid}.expiresAt is a
// Firestore Timestamp on the grant record (contracts 2.2); rows surface it
// as an ISO string (or null) under `roleExpiresAt`. Accepts Timestamp-like
// values, Dates and strings so test doubles and serialized values all work.
function expiryIso(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") {
    try { return value.toDate().toISOString(); } catch { return null; }
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

// Directory search entries: a bounded candidate window of users is
// fetched per request (Path B below) and fuzzy-scored in RAM; role
// filters instead resolve their exact holder set by equality (see
// resolveRoleHolderCandidates). The previous design rebuilt a full
// users+roles snapshot in memory on a 5-minute TTL (444 reads per
// rebuild); Read-Burn F6 removed that rebuild from the request path
// entirely, so no search can trigger one. See
// READ_BURN_CENSUS_2026-10-25.md item C3/F6.

interface UserDictionaryEntry {
  id: string;
  name: string;      // lowercase for search
  rawName: string;   // real case for display
  email: string;
  role: string | null;
  roleExpiresAt: string | null; // roles/{uid}.expiresAt as ISO (contracts 2.2)
  whatsapp: string;
  chapterId: string | null;
  isBanned?: boolean;
}

// Old basic search cache for empty state queries
const searchCache = new Map<string, { data: any, timestamp: number }>();
// RBT2 item 2: the Supa Path A arm gets the SAME 30s cache treatment
// (same duration, same getCacheKey keying, same consult/store
// conditions: idle browse only, never a startAfter page), but in its
// OWN map. The two arms must never answer for each other: a
// Firestore-warmed entry must not serve a flag-ON request (the
// coordinator merge pin below), and a Supa-warmed entry must not
// serve a flag-OFF one.
const supaSearchCache = new Map<string, { data: any, timestamp: number }>();
const SEARCH_CACHE_DURATION = 30 * 1000; // 30 seconds

function getCacheKey(params: { q: string, role: string, chapterId: string, pageSize: number, startAfter?: string, scopeKey?: string }) {
  return JSON.stringify(params);
}

// Execute query with timeout helper
const runWithTimeout = (promise: Promise<any>) => {
  const queryTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Query timeout")), 10000));
  return Promise.race([promise, queryTimeout]);
};

// Founder identity alias: these role-filter slugs denote the founder
// alone. The same rule is applied inline by the Path A and Path B
// scoring filters below; it lives here once for candidate resolution.
const FOUNDER_UID = "pLW0PuQCTAQHCNK1SfllVhPZdMz1";
const FOUNDER_ALIAS_ROLES = ["president_national", "superadmin", "founder_patron"];

// Projection shared by every Path B candidate fetch (window, exact
// role holders). Contact fields (email, whatsapp, whatsappNumber) are
// NOT projected: they no longer live on the user record — they are
// merged in from the gated contact records (mergeDirectoryContacts
// below) for this canManageUsers-gated directory only.
const DIRECTORY_USER_FIELDS = ["displayName", "name", "role", "chapterId", "chapter", "isBanned"];

// Contact doorway (contact-gating fix, 2026-10-28): load the gated
// contact records for a set of uids. A contact-store failure degrades
// to an empty map (rows serialize with empty contact fields) rather
// than failing the whole directory - but the degradation is LOUD:
// onDegraded fires so the response can carry contactsDegraded and the
// UI can say the columns are blank because the read failed. The silent
// version cost a night (2026-10-30): during the Firestore quota outage
// every contact read failed, the directory showed "-" for every email
// and email search matched nothing, and the empty columns were
// indistinguishable from "nobody has an email on file".
async function loadDirectoryContacts(
  db: any,
  uids: string[],
  onDegraded?: () => void,
): Promise<Map<string, UserContact>> {
  if (uids.length === 0) return new Map();
  try {
    return await getUserContacts(db, uids);
  } catch (e) {
    console.warn("[admin:users] Contact records unavailable; serving rows without contact data:", e);
    onDegraded?.();
    return new Map();
  }
}

// Merge one user's contact record into a flat user record in place:
// email from the contact record ("" when none), whatsapp from its
// whatsapp/whatsappNumber pair. Serialization shape is unchanged.
function applyDirectoryContact(record: Record<string, any>, contact?: UserContact): void {
  record.email = contact?.email ?? "";
  record.whatsapp = contact?.whatsapp || contact?.whatsappNumber || "";
  if (contact?.email_lowercase) record.email_lowercase = contact.email_lowercase;
}

// Exact holder resolution for role filters (Directory Search Defect,
// 2026-10-25): a role filter must never be answered from the bounded
// candidate window — a holder whose doc id sorts past the window is
// still a holder. Holders are resolved by equality instead: roles
// docs whose primary role == slug, union users docs whose role
// mirror field == slug, fetched by id in `in` chunks. The resolved
// set is exact at any directory size and its read cost is bounded by
// the holder count, never by the directory size. Role PRECEDENCE is
// unchanged: the chunked roles resolution in Path B still runs over
// these candidates, so a roles doc beats a stale users-doc mirror
// in both directions (a re-roled user is not a holder of their old
// mirror role). Only the PRIMARY role matches — additionalRoles
// confer no filter match, as everywhere else in this route; the
// founder's additionalRoles slugs are covered by the alias above.
// Errors propagate to the route's error handler on purpose: a loud
// 500 beats a silently wrong empty list (the defect being fixed).
async function resolveRoleHolderCandidates(db: any, roleSlug: string): Promise<{ id: string; data: Record<string, any> }[]> {
  const holderIds = new Set<string>();
  if (FOUNDER_ALIAS_ROLES.includes(roleSlug)) {
    holderIds.add(FOUNDER_UID);
  } else {
    const [rolesSnap, mirrorSnap] = await Promise.all([
      runWithTimeout(db.collection("roles").where("role", "==", roleSlug).select("role").get()),
      runWithTimeout(db.collection("users").where("role", "==", roleSlug).select("role").get()),
    ]);
    rolesSnap.docs.forEach((d: any) => holderIds.add(d.id));
    mirrorSnap.docs.forEach((d: any) => holderIds.add(d.id));
  }
  if (holderIds.size === 0) return [];

  const ids = Array.from(holderIds).sort();
  const chunkSize = 30; // Firestore `in` chunk pattern used across this route
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  // REQ 6 (latency margin): the chunk fetches are independent - run
  // them concurrently instead of stacking them sequentially against
  // a degraded backend. Errors still propagate (loud, as designed).
  const snaps = await Promise.all(chunks.map((chunk) => runWithTimeout(
    db.collection("users").where("__name__", "in", chunk).select(...DIRECTORY_USER_FIELDS).get()
  )));
  const docs: { id: string; data: Record<string, any> }[] = [];
  snaps.forEach((snap: any) => snap.docs.forEach((d: any) => docs.push({ id: d.id, data: d.data() })));
  // Doc-id order, mirroring the window query's orderBy("__name__").
  docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return docs;
}

// --- Supa serving path (G1, flag-gated via src/lib/supa-seams/users-directory)
// Exact role-holder resolution with the SAME semantics as
// resolveRoleHolderCandidates above, over the adapter: roles docs
// whose primary role == slug, union users docs whose role mirror ==
// slug, fetched by id. Founder alias slugs resolve to the founder
// alone. Role precedence is applied later by the shared scoring loop
// (the roles overlay still wins over the users mirror), unchanged.
async function supaResolveRoleHolderCandidates(
  adapter: NonNullable<ReturnType<typeof getUsersSupaAdapter>>,
  roleSlug: string,
): Promise<{ id: string; data: Record<string, any> }[]> {
  const holderIds = new Set<string>();
  if (FOUNDER_ALIAS_ROLES.includes(roleSlug)) {
    holderIds.add(FOUNDER_UID);
  } else {
    const [rolesRows, mirrorRows] = await Promise.all([
      supaListRolesWhereRole(adapter, roleSlug),
      supaListUsersWhere(adapter, "role", roleSlug),
    ]);
    rolesRows.forEach((r: SupaRow) => holderIds.add(r.id));
    mirrorRows.forEach((r: SupaRow) => holderIds.add(r.id));
  }
  if (holderIds.size === 0) return [];
  const ids = Array.from(holderIds).sort();
  const docs = await supaGetUsersByIds(adapter, ids);
  docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return docs.map((r) => ({ id: r.id, data: r.data as Record<string, any> }));
}

// Name-keywords candidates (directory search option (c)): for each
// query term that can use the index, one array-contains equality on
// users.nameSearchKeywords resolves exactly the docs whose stored
// name tokens start with the term - bounded by the match count, exact
// at any directory size, never a window and never a collection scan.
// Fetched rows are verified locally (docHasNameKeyword): a backend or
// test double that ignores the array-contains clause can never widen
// the candidate set beyond true index holders. Errors propagate like
// the role-holder helper's: a loud failure beats a silently wrong
// empty (or silently window-truncated) result.
async function resolveNameKeywordCandidates(
  db: any,
  terms: string[],
): Promise<{ id: string; data: Record<string, any> }[]> {
  const keywordTerms = terms
    .map((term) => nameSearchKeywordForTerm(term))
    .filter((k): k is string => !!k);
  // REQ 6 (latency margin): one independent query per term - run them
  // concurrently instead of stacking them sequentially.
  const snaps = await Promise.all(keywordTerms.map((keyword) => runWithTimeout(
    db.collection("users")
      .where(NAME_SEARCH_KEYWORDS_FIELD, "array-contains", keyword)
      .select(...DIRECTORY_USER_FIELDS, NAME_SEARCH_KEYWORDS_FIELD)
      .get()
  )));
  const byId = new Map<string, { id: string; data: Record<string, any> }>();
  snaps.forEach((snap: any, i: number) => {
    const keyword = keywordTerms[i];
    snap.docs.forEach((d: any) => {
      const data = d.data();
      if (docHasNameKeyword(data, keyword) && !byId.has(d.id)) {
        byId.set(d.id, { id: d.id, data });
      }
    });
  });
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function supaResolveNameKeywordCandidates(
  adapter: NonNullable<ReturnType<typeof getUsersSupaAdapter>>,
  terms: string[],
): Promise<{ id: string; data: Record<string, any> }[]> {
  const keywordTerms = terms
    .map((term) => nameSearchKeywordForTerm(term))
    .filter((k): k is string => !!k);
  // REQ 6 (latency margin): per-term queries run concurrently, as in
  // the Firestore twin above.
  const rowSets = await Promise.all(keywordTerms.map((keyword) => supaListUsersByNameKeyword(adapter, keyword)));
  const byId = new Map<string, { id: string; data: Record<string, any> }>();
  rowSets.forEach((rows, i: number) => {
    const keyword = keywordTerms[i];
    rows.forEach((r) => {
      const data = r.data as Record<string, any>;
      if (docHasNameKeyword(data, keyword) && !byId.has(r.id)) {
        byId.set(r.id, { id: r.id, data });
      }
    });
  });
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Roles overlay for a candidate set, via the adapter (chunked id
// lookups). Throws on adapter error on purpose: the caller converts a
// throw into the full Firestore fallback (never a partial Supa answer).
async function supaRolesOverlay(
  adapter: NonNullable<ReturnType<typeof getUsersSupaAdapter>>,
  ids: string[],
): Promise<{ rolesMap: Record<string, string>; expiresMap: Record<string, string | null> }> {
  const rolesMap: Record<string, string> = {};
  const expiresMap: Record<string, string | null> = {};
  const rows = await supaGetRolesByIds(adapter, ids);
  rows.forEach((r) => {
    if (r.data?.role) rolesMap[r.id] = String(r.data.role);
    // expiryIso consumes the adapter's timestamp guarantee directly:
    // SupaTimestamp (legacy dumped shape) via toDate(), ISO string as-is.
    expiresMap[r.id] = expiryIso(r.data?.expiresAt);
  });
  return { rolesMap, expiresMap };
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (authContext) => {
    const startTime = Date.now();
    console.log(`[admin:users] GET request received. UID: ${authContext.userId}, Role: ${authContext.role}`);

    try {
      const db = getDb();
      if (!db) {
        console.error("[admin:users] Database connection failed");
        throw new Error("Database connection failed");
      }

      // Check for module-level management permission
      const canManage = await hasServerPermissionForUser(db, authContext.userId, 'canManageUsers');
      console.log(`[admin:users] Permission check: canManageUsers = ${canManage}`);
      
      if (!canManage) {
        return NextResponse.json(
          { error: 'Unauthorized: Insufficient permissions to view users.' },
          { status: 403 }
        );
      }

      const { searchParams } = new URL(request.url);
      const q = normalize(searchParams.get("q") || "").toLowerCase();
      // Case fix (directory role-filter defect, second half): the
      // filter option can arrive in a non-slug form - the dropdown
      // renders the option with CSS capitalization ("Chapter_vice_
      // president") and callers paste title forms ("Chapter Vice
      // President") - while stored roles are lowercase slugs
      // ("chapter_vice_president"). Exact string equality against the
      // raw parameter therefore returned 0 holders for a real role.
      // Normalize the parameter ONCE here, at the same layer the
      // holder-set fix (resolveRoleHolderCandidates) consumes it, so
      // every downstream comparison (holder equality, founder alias,
      // scoring hard filter, both read arms) sees the stored slug
      // form. normalizeRoleSlug is hygiene only (role-catalog.ts):
      // lowercase, non-alphanumerics to "_", collapse, strip - it
      // performs no legacy-to-catalog mapping. 'All' is the client's
      // unfiltered sentinel and is preserved verbatim.
      const roleRaw = normalize(searchParams.get("role") || "");
      const role = roleRaw === "" || roleRaw === "All"
        ? roleRaw
        : normalizeRoleSlug(roleRaw);
      const chapterId = normalize(searchParams.get("chapterId") || "");
      const pageSizeParam = searchParams.get("pageSize");
      const startAfterVal = normalize(searchParams.get("startAfter") || "");
      const pageSize = pageSizeParam ? Math.min(Math.max(parseInt(pageSizeParam), 1), 50) : 20;

      // Item 5 caller scoping (P10): the role is the canonical
      // roles-first role from auth; the caller's own users doc is read
      // once for chapterId only. Rules R1-R3 (chapter-scoping.ts): a
      // global caller may filter by any chapter; a chapter caller sees
      // only their own chapter; asking for a foreign chapter is a 403,
      // never a silent substitution. 'All' is the client's spelling of
      // unfiltered and resolves to the caller's own scope.
      // Read-Burn A (§2.3 adoption): the caller's chapter comes from
      // their cached identity bundle - this was the third read of the
      // same users doc in one request (auth + permission + this one).
      const callerBundle = await getIdentityBundleCached(db, authContext.userId);
      const callerChapterId = (callerBundle.users?.chapterId as string | undefined) || null;
      const callerScope = await resolveEffectiveScope(authContext.role);
      const chapterFilter = resolveChapterFilter({
        scope: callerScope,
        callerChapterId,
        requestedChapterId: chapterId || null,
      });
      if (!chapterFilter.ok) {
        return NextResponse.json(
          { error: 'Forbidden: chapter scope mismatch.' },
          { status: 403 }
        );
      }
      const effectiveChapterId = chapterFilter.effectiveChapterId;
      // The Path A cache key carries the caller's effective scope: a
      // cached page is only ever shared between callers whose effective
      // scope is identical (closes the cross-scope cache leak).
      const scopeKey = `${callerScope}:${effectiveChapterId ?? ''}`;

      // 🚀 ENGINE ROUTING: flag OFF both paths are native Firestore;
      // flag ON (useSupa('users') + configured client) the Supa seam
      // serves first and any adapter error falls back to Firestore.
      // Path A serves idle browsing (no filters); Path B serves text
      // queries from a bounded candidate window and role filters
      // from the exact holder set.
      const isSearchActive = q.length > 0 || (role && role !== 'All');

      // Supa gate (G1): non-null only when SUPA_SURFACES names 'users'
      // AND a Supabase client is configured. Any Supa read error below
      // falls back to the Firestore path in full.
      const supaAdapter = getUsersSupaAdapter();

      // Contact-doorway health for THIS response: set by any
      // loadDirectoryContacts call whose contact read failed (the rows
      // then carry empty email/whatsapp). Serialized as
      // `contactsDegraded: true` - ONLY when degraded: the healthy
      // response shape is pinned byte-exact by the migration contract
      // suites (route-supa-contract.test.ts), so the flag is an
      // additive field on the degraded path alone, never a new
      // always-present key.
      let contactsDegraded = false;
      const markContactsDegraded = () => {
        contactsDegraded = true;
      };

      // Reject empty role/query cache bypass. The Firestore 30s Path A
      // cache is consulted only when the seam will not serve; a
      // Firestore-warmed entry must never answer a flag-ON request.
      // (Coordinator merge fix, users adjudication: the carried-over
      // acceptance pin "idle Path A served by the seam" exposed the
      // cache read sitting above this gate.) RBT2 item 2: the Supa arm
      // consults its own identically-keyed 30s cache (supaSearchCache)
      // inside the Supa Path A branch below instead.
      if (!isSearchActive && !startAfterVal && !supaAdapter) {
        const cacheKey = getCacheKey({ q, role, chapterId, pageSize, scopeKey });
        const cached = searchCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < SEARCH_CACHE_DURATION) {
          return NextResponse.json({ ...cached.data, cached: true, responseTime: Date.now() - startTime });
        }
      }

      // 🛑 PATH A: IDLE BROWSING (No Search Query, No Role Filter)
      if (!isSearchActive) {
        if (supaAdapter) {
          // RBT2 item 2: 30s cache for the Supa arm, same keying and
          // same consult condition as the flag-OFF arm above (idle
          // browse, first page only), served from supaSearchCache so
          // the two arms never cross-serve.
          if (!startAfterVal) {
            const supaCacheKey = getCacheKey({ q, role, chapterId, pageSize, scopeKey });
            const supaCached = supaSearchCache.get(supaCacheKey);
            if (supaCached && (Date.now() - supaCached.timestamp) < SEARCH_CACHE_DURATION) {
              return NextResponse.json({ ...supaCached.data, cached: true, responseTime: Date.now() - startTime });
            }
          }
          try {
            // Full filtered set via the adapter (no window at this
            // layer); id order + cursor + pageSize*3 window reproduce
            // the Firestore Path A paging shape exactly.
            const allRows = await supaListAllUsers(supaAdapter, effectiveChapterId);
            let sorted = [...allRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            if (startAfterVal) sorted = sorted.filter((r) => r.id > startAfterVal);
            const windowRows = sorted.slice(0, pageSize * 3);
            // RBT2 item 1: slice the window to the actual page BEFORE
            // merging contacts (and before the roles overlay), so an
            // idle load pays contact reads for pageSize rows (20),
            // not the whole pageSize*3 window (60). This reordering
            // cannot change the response: Path A runs only when no
            // search/role filter is active (the role filter below is
            // inert here) and supaListAllUsers already pushed the
            // effective chapter filter to the adapter, so the
            // in-memory filters below pass every window row; the
            // first pageSize rows are exactly what the old
            // merge-then-slice order serialized.
            const pageRows = windowRows.slice(0, pageSize);
            const baseUsers: { id: string; [key: string]: any }[] = pageRows.map((r) => ({ id: r.id, ...stripContactFields(r.data as Record<string, unknown>) }));
            const pathAContacts = await loadDirectoryContacts(db, baseUsers.map((u) => u.id), markContactsDegraded);
            baseUsers.forEach((u) => applyDirectoryContact(u, pathAContacts.get(u.id)));

            const { rolesMap, expiresMap: roleExpiresMap } = await supaRolesOverlay(
              supaAdapter,
              baseUsers.map((u) => u.id),
            );

            let users = baseUsers.map((u) => ({
              uid: u.uid || u.id,
              displayName: String(u.displayName || u.name || ""),
              email: String(u.email || ""),
              whatsapp: String(u.whatsapp || u.whatsappNumber || ""),
              role: rolesMap[u.id] || u.role || null,
              roleExpiresAt: roleExpiresMap[u.id] ?? null,
              chapterId: u.chapterId || u.chapter || null,
              isBanned: u.isBanned || false,
            }));

            if (role && role !== 'All') {
              users = users.filter((u) => {
                if (role === 'president_national' || role === 'superadmin' || role === 'founder_patron') {
                  return u.uid === 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
                }
                return u.role === role;
              });
            }
            if (effectiveChapterId) {
              users = users.filter((u) => u.chapterId === effectiveChapterId);
            }
            users = users.slice(0, pageSize);
            const nextCursor = users.length > 0 ? String(users[users.length - 1].uid) : "";
            const supaResponseData = { users, nextCursor, pageSize, responseTime: Date.now() - startTime, searchMethod: "supabase", ...(contactsDegraded ? { contactsDegraded: true } : {}) };
            // RBT2 item 2: Supa responses are written to the Supa
            // arm's OWN 30s cache (never the Firestore Path A cache),
            // under the same store condition as the flag-OFF arm:
            // first page only (no startAfter).
            if (!startAfterVal) supaSearchCache.set(getCacheKey({ q, role, chapterId, pageSize, scopeKey }), { data: supaResponseData, timestamp: Date.now() });
            return NextResponse.json(supaResponseData);
          } catch (e) {
            console.warn("[admin:users] Supa Path A failed; falling back to Firestore:", e);
          }
        }

        let queryRef: any = db.collection("users");

        // Item 5: the caller's effective chapter scope is applied in
        // the query itself, not just in memory.
        if (effectiveChapterId) {
          queryRef = queryRef.where("chapterId", "==", effectiveChapterId);
        }

        // If we have a role or chapter filter, native firestore indexing might be needed
        // For simplicity in the idle state, we use basic name sorting or just ID
        queryRef = queryRef.orderBy("__name__");
        
        if (startAfterVal) queryRef = queryRef.startAfter(startAfterVal);
        queryRef = queryRef.limit(pageSize * 3); // Fetch more to allow for filtering

        const snap = await runWithTimeout(queryRef.get());
        const baseUsers: { id: string; [key: string]: any }[] = snap.docs.map((d: any) => ({ id: d.id, ...stripContactFields(d.data() as Record<string, unknown>) }));
        const pathAContacts = await loadDirectoryContacts(db, baseUsers.map((u) => u.id), markContactsDegraded);
        baseUsers.forEach((u) => applyDirectoryContact(u, pathAContacts.get(u.id)));

        // Fetch dynamic roles for this page chunk
        const rolesMap: Record<string, string> = {};
        const roleExpiresMap: Record<string, string | null> = {};
        if (baseUsers.length > 0) {
          try {
            const uids = baseUsers.map(u => u.uid || u.id);
            const chunkSize = 30;
            const chunks: string[][] = [];
            for (let i = 0; i < uids.length; i += chunkSize) chunks.push(uids.slice(i, i + chunkSize));
            // REQ 6 (latency margin): chunks run concurrently, each
            // raced against the same 10s leg timeout as every other
            // query in this route (they had NO timeout before, so a
            // hung chunk hung the whole request). A failed chunk
            // degrades its rows to the users-doc role - the partial-
            // map behaviour this block always had - never a hang.
            // Projection: only role + expiresAt are read per doc.
            await Promise.all(chunks.map(async (chunk) => {
              try {
                const rolesSnap = await runWithTimeout(db.collection("roles").where("__name__", "in", chunk).select("role", "expiresAt").get());
                rolesSnap.docs.forEach((doc: any) => {
                  if (doc.data()?.role) rolesMap[doc.id] = String(doc.data().role);
                  roleExpiresMap[doc.id] = expiryIso(doc.data()?.expiresAt);
                });
              } catch (e) {
                console.warn("Failed to fetch basic roles chunk:", e);
              }
            }));
          } catch (e) {
            console.warn("Failed to fetch basic roles:", e);
          }
        }

        let users = baseUsers.map(u => ({
          uid: u.uid || u.id,
          displayName: String(u.displayName || u.name || ""),
          email: String(u.email || ""),
          whatsapp: String(u.whatsapp || u.whatsappNumber || ""),
          role: rolesMap[u.id] || u.role || null,
          roleExpiresAt: roleExpiresMap[u.id] ?? null,
          chapterId: u.chapterId || u.chapter || null,
          isBanned: u.isBanned || false,
        }));

        // Apply strict filters in memory for Path A
        if (role && role !== 'All') {
          users = users.filter(u => {
            // IDENTITY ALIAS: 'president_national' or 'superadmin' filter matches the Founder UID
            if (role === 'president_national' || role === 'superadmin' || role === 'founder_patron') {
              return u.uid === 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
            }
            return u.role === role;
          });
        }
        // Item 5: the in-memory filter compares against the EFFECTIVE
        // chapter (the caller's scope), never the raw client parameter.
        if (effectiveChapterId) {
          users = users.filter(u => u.chapterId === effectiveChapterId);
        }

        // Re-slice to exact pageSize after memory filtering
        users = users.slice(0, pageSize);

        const nextCursor = users.length > 0 ? String(users[users.length - 1].uid) : "";

        const responseData = { users, nextCursor, pageSize, responseTime: Date.now() - startTime, searchMethod: "native_firestore", ...(contactsDegraded ? { contactsDegraded: true } : {}) };
        if (!startAfterVal) searchCache.set(getCacheKey({ q, role, chapterId, pageSize, scopeKey }), { data: responseData, timestamp: Date.now() });

        return NextResponse.json(responseData);
      }

      // 🛑 PATH B: BOUNDED NATIVE SEARCH (Query and/or role filter provided)
      //
      // Read-Burn F6: this path used to rebuild a full users+roles
      // snapshot in RAM (444 reads) whenever its 5-minute cache went
      // cold, so ordinary searches were the directory's rebuild
      // trigger. Text searches now fetch a bounded candidate window
      // with the same native machinery as Path A: chapter-scoped in
      // the query itself, doc-id ordered, hard-capped at pageSize * 3
      // (<= 150) user docs, with roles resolved for those candidates
      // only (chunked `in` queries, <= 150 role docs). The fuzzy
      // scoring below runs over that window; searches are therefore
      // always live (no snapshot staleness) and can never trigger a
      // full-collection rebuild.
      //
      // Role filters are the exception (Directory Search Defect,
      // 2026-10-25): a role is a fact, not a fuzzy match, so its
      // candidate set is the exact holder set resolved by equality
      // (resolveRoleHolderCandidates above) — bounded by the holder
      // count, exact at any directory size.
      // Candidate assembly. With a role filter, candidates are the
      // EXACT holder set (resolveRoleHolderCandidates) — never the
      // window: filtering the window by role is what made holders
      // past position pageSize*3 silently invisible. Text-only
      // searches keep the bounded window unchanged. Chapter scoping
      // for the holder set happens in the scoring loop's hard filter
      // below (the window path keeps its in-query chapter filter).
      const roleFilterActive = role !== "" && role !== "All";
      let candidateDocs: { id: string; data: Record<string, any> }[] = [];
      let windowRolesMap: Record<string, string> = {};
      let windowRoleExpiresMap: Record<string, string | null> = {};
      let servedBySupa = false;

      // Supa candidate assembly (G1). Text search reads the COMPLETE
      // chapter-filtered fs_users set through the adapter — no
      // pageSize*3 window (the directory defect being designed out;
      // see the seam header for the bound: ~246 rows, adapter-paged).
      // Role filters resolve the exact holder set with the same
      // semantics as resolveRoleHolderCandidates. Any adapter error
      // discards the partial Supa state and runs Firestore below.
      if (supaAdapter) {
        try {
          if (roleFilterActive) {
            candidateDocs = await supaResolveRoleHolderCandidates(supaAdapter, role);
          } else {
            // Name search (option (c)): the keywords index leg is
            // the bounded primary source. When it resolves nobody -
            // the index is not backfilled for those docs yet - the
            // complete chapter-filtered set below remains the
            // transitional fallback (bounded by the adapter's id
            // paging, see the seam header), so an unindexed user is
            // never silently invisible during the backfill window.
            const keywordDocs = q
              ? await supaResolveNameKeywordCandidates(supaAdapter, q.split(" ").filter(Boolean))
              : [];
            if (keywordDocs.length > 0) {
              candidateDocs = keywordDocs;
            } else {
              const rows = await supaListAllUsers(supaAdapter, effectiveChapterId);
              candidateDocs = [...rows]
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                .map((r) => ({ id: r.id, data: r.data as Record<string, any> }));
            }
          }

          // The exact-email probe runs AFTER candidate assembly for
          // both serving legs (see below): the address no longer
          // lives on the user record, so the probe resolves through
          // Firebase Auth + the merged contact records instead of a
          // store-side email equality query.

          if (candidateDocs.length > 0) {
            const overlay = await supaRolesOverlay(supaAdapter, candidateDocs.map(d => d.id));
            windowRolesMap = overlay.rolesMap;
            windowRoleExpiresMap = overlay.expiresMap;
          }
          servedBySupa = true;
        } catch (e) {
          console.warn("[admin:users] Supa Path B failed; falling back to Firestore:", e);
          candidateDocs = [];
          windowRolesMap = {};
          windowRoleExpiresMap = {};
          servedBySupa = false;
        }
      }

      if (!servedBySupa && roleFilterActive) {
        candidateDocs = await resolveRoleHolderCandidates(db, role);
      } else if (!servedBySupa) {
        let candidateQuery: any = db.collection("users")
          .select(...DIRECTORY_USER_FIELDS);
        if (effectiveChapterId) {
          candidateQuery = candidateQuery.where("chapterId", "==", effectiveChapterId);
        }
        candidateQuery = candidateQuery.orderBy("__name__").limit(pageSize * 3);

        const candidateSnap = await runWithTimeout(candidateQuery.get());
        candidateDocs = candidateSnap.docs.map((d: any) => ({ id: d.id, data: d.data() }));

        // Name-keywords leg (option (c)): union the index-resolved
        // candidates into the window set. The index leg is the exact
        // source - it reaches holders past the window; the window leg
        // stays only as the transitional fallback for docs whose
        // index field has not been backfilled yet, and can be dropped
        // once the backfill lands (see the fix report). Chapter
        // scoping for index candidates is enforced by the scoring
        // loop's hard chapter filter, exactly as for role holders.
        if (q) {
          const keywordDocs = await resolveNameKeywordCandidates(
            db,
            q.split(" ").filter(Boolean),
          );
          keywordDocs.forEach((d) => {
            if (!candidateDocs.some((c) => c.id === d.id)) candidateDocs.push(d);
          });
        }
      }

      // Contact doorway merge (both serving legs): strip any legacy
      // contact fields off every loaded candidate record, then merge
      // the gated contact records back in. The scoring loop and the
      // serialized rows below read email/whatsapp from the merged
      // values exactly as they read them from the record before.
      candidateDocs.forEach((d) => {
        d.data = stripContactFields(d.data as Record<string, unknown>);
      });
      const candidateContacts = await loadDirectoryContacts(db, candidateDocs.map((d) => d.id), markContactsDegraded);
      candidateDocs.forEach((d) => applyDirectoryContact(d.data, candidateContacts.get(d.id)));

      // Exact-email probe: the standing find-a-person method is
      // lookup by email, and an exact address must resolve even when
      // its doc falls outside the candidate window above. The address
      // no longer lives on the user record, so the probe resolves
      // through the merged contact records first (an exact match on
      // email / email_lowercase among the loaded set is already in
      // the candidates and exact-scores below) and then through
      // Firebase Auth: an Auth hit whose uid is not yet loaded has
      // its record fetched (1 read) so it enters the candidate set.
      // Best effort only; the window scan below remains the fallback.
      const emailTerm = q.split(" ").find(t => t.includes("@"));
      if (emailTerm && !candidateDocs.some(d => String(d.data.email || "").toLowerCase() === emailTerm || String(d.data.email_lowercase || "").toLowerCase() === emailTerm)) {
        try {
          const authUser = await getAuth().getUserByEmail(emailTerm);
          const probeUid = authUser?.uid;
          if (probeUid) {
            // REQ 3 (directory zero-records fix): findability rides on
            // the Auth identity, never on the degradable contacts
            // merge. When the merge left the candidate's email blank
            // (contacts leg down), backfill the account email OF
            // RECORD from this Auth resolution so the exact term
            // exact-scores below - a contacts outage may blank the
            // WhatsApp display, never a person's findability (the
            // 2026-10-30 Shehriyar/Zainab zeros). A healthy merged
            // email is never overridden.
            const authEmail = String(authUser.email || emailTerm).toLowerCase();
            const existing = candidateDocs.find(c => c.id === probeUid);
            if (existing) {
              if (!String(existing.data.email || "").toLowerCase()) {
                existing.data.email = authEmail;
                existing.data.email_lowercase = authEmail;
              }
            } else {
              let probeData: Record<string, any> | null = null;
              if (servedBySupa && supaAdapter) {
                const probeRows = await supaGetUsersByIds(supaAdapter, [probeUid]);
                if (probeRows.length > 0) probeData = probeRows[0].data as Record<string, any>;
              } else {
                const probeSnap = await runWithTimeout(db.collection("users").doc(probeUid).get());
                if (probeSnap.exists) probeData = probeSnap.data();
              }
              if (probeData) {
                const stripped = stripContactFields(probeData as Record<string, unknown>);
                const probeContacts = await loadDirectoryContacts(db, [probeUid], markContactsDegraded);
                applyDirectoryContact(stripped, probeContacts.get(probeUid));
                if (!String(stripped.email || "").toLowerCase()) {
                  stripped.email = authEmail;
                  stripped.email_lowercase = authEmail;
                }
                candidateDocs.push({ id: probeUid, data: stripped });
                if (servedBySupa && supaAdapter) {
                  const overlay = await supaRolesOverlay(supaAdapter, [probeUid]);
                  Object.assign(windowRolesMap, overlay.rolesMap);
                  Object.assign(windowRoleExpiresMap, overlay.expiresMap);
                }
              }
            }
          }
        } catch (e) {
          console.warn("Exact-email probe failed:", e);
        }
      }

      // Roles for the candidate window only (never the full roles
      // collection): chunked `__name__ in` queries, same pattern as
      // Path A. Projection: only role + expiresAt are read per doc.
      if (!servedBySupa && candidateDocs.length > 0) {
        try {
          const uids = candidateDocs.map(d => d.id);
          const chunkSize = 30;
          const chunks: string[][] = [];
          for (let i = 0; i < uids.length; i += chunkSize) chunks.push(uids.slice(i, i + chunkSize));
          // REQ 6 (latency margin): chunks run concurrently, each
          // raced against the route's 10s leg timeout (they had NO
          // timeout before, so a hung chunk hung the whole request).
          // A failed chunk degrades its rows to the users-doc role -
          // the partial-map behaviour this block always had.
          await Promise.all(chunks.map(async (chunk) => {
            try {
              const rolesSnap = await runWithTimeout(db.collection("roles").where("__name__", "in", chunk).select("role", "expiresAt").get());
              rolesSnap.docs.forEach((doc: any) => {
                if (doc.data()?.role) windowRolesMap[doc.id] = String(doc.data().role);
                windowRoleExpiresMap[doc.id] = expiryIso(doc.data()?.expiresAt);
              });
            } catch (e) {
              console.warn("Failed to fetch window roles chunk:", e);
            }
          }));
        } catch (e) {
          console.warn("Failed to fetch window roles:", e);
        }
      }

      const directoryWindow: UserDictionaryEntry[] = candidateDocs.map(d => {
        const data = d.data;
        const rawDisplayName = String(data.displayName || data.name || "");
        return {
          id: d.id,
          name: rawDisplayName.toLowerCase(),
          rawName: rawDisplayName,
          email: String(data.email || "").toLowerCase(),
          role: windowRolesMap[d.id] || data.role || null,
          roleExpiresAt: windowRoleExpiresMap[d.id] ?? null,
          whatsapp: String(data.whatsapp || data.whatsappNumber || "").toLowerCase(),
          chapterId: data.chapterId || data.chapter || null,
          isBanned: data.isBanned || false,
        };
      });

      // 2. Execute Fuzzy Memory Scan over the bounded candidate window
      const terms = q.split(" ").filter(t => t.length > 0);
      const scoredResults: { user: UserDictionaryEntry, score: number }[] = [];

      for (const u of directoryWindow) {
        // 1. Hard Chapter Filter. Item 5: this compares against the
        // EFFECTIVE chapter (caller scope resolved through R1-R3), so
        // for a chapter caller it is a hard scope wall applied BEFORE
        // scoring and pagination slicing; totalScored below therefore
        // counts only the caller's scope. For a global caller it is
        // exactly the client chapter filter (null = no filter).
        if (effectiveChapterId && u.chapterId !== effectiveChapterId) continue;
        
        // 2. Hard Role Filter with IDENTITY ALIAS
        // `role` arrives here already slug-normalized (see the parse
        // site); the stored side is compared in the same normalized
        // form, so a stored value with stray casing can never hide a
        // holder either. Display keeps the stored value verbatim -
        // only this comparison normalizes. Primary role only:
        // additionalRoles confer no match, as everywhere in this
        // route (pinned by route-rolefilter.test.ts test 6).
        if (role && role !== 'All') {
          if (role === 'president_national' || role === 'superadmin' || role === 'founder_patron') {
             if (u.id !== 'pLW0PuQCTAQHCNK1SfllVhPZdMz1') continue;
          } else {
             if (!u.role || normalizeRoleSlug(String(u.role)) !== role) continue;
          }
        }

        let score = 0;

        // 3. Scoring (Only if search terms exist)
        if (terms.length > 0) {
          for (const term of terms) {
            if (u.name === term || u.email === term) score += 100; // Exact match absolute priority
            else if (u.name.startsWith(term)) score += 80;
            else if (u.name.includes(term)) score += 60;
            else if (u.email.includes(term)) score += 40;
            else if (u.whatsapp.includes(term)) score += 30;
          }
        } else {
          // If no search query, users who passed hard filters get a base score to be included
          score = 1;
        }

        if (score > 0) {
          scoredResults.push({ user: u, score });
        }
      }

      // 3. Sort by accuracy
      scoredResults.sort((a, b) => b.score - a.score);

      // 4. Memory-Level Pagination Routing
      let startIndex = 0;
      if (startAfterVal) {
        // Find where the previous cursor left off in the newly sorted memory array
        const idx = scoredResults.findIndex(r => r.user.id === startAfterVal);
        if (idx !== -1) startIndex = idx + 1;
      }

      const pagedResults = scoredResults.slice(startIndex, startIndex + pageSize);

      // 5. Expand final results
      const users = pagedResults.map(r => ({
        uid: r.user.id,
        displayName: r.user.rawName,
        email: r.user.email,
        whatsapp: r.user.whatsapp,
        role: r.user.role,
        roleExpiresAt: r.user.roleExpiresAt ?? null,
        chapterId: r.user.chapterId,
        isBanned: r.user.isBanned || false,
      }));


      // If we want real case formatting, we must map back to the real object, but the frontend actually applies CSS capitalization

      let nextCursor = "";
      if (pagedResults.length > 0 && startIndex + pageSize < scoredResults.length) {
        // More pages exist
        nextCursor = pagedResults[pagedResults.length - 1].user.id;
      }

      const responseTime = Date.now() - startTime;
      console.log(`🎯 [Search Engine] Found ${scoredResults.length} matches. Returned page starting at index ${startIndex} in ${responseTime}ms`);

      return NextResponse.json({
        users,
        nextCursor,
        pageSize,
        responseTime,
        searchMethod: servedBySupa ? "supabase" : "native_firestore",
        ...(contactsDegraded ? { contactsDegraded: true } : {}),
        cached: false,
        debug: {
          query: q,
          totalScored: scoredResults.length
        }
      });

    } catch (e: any) {
      const responseTime = Date.now() - startTime;
      console.error(`❌ Admin users API error after ${responseTime}ms:`, e);

      const isTimeout = String(e?.message || "").includes("Query timeout");
      const status = isTimeout ? 504 : 500;
      return NextResponse.json({
        error: isTimeout ? "Gateway timeout" : "Internal server error",
        responseTime,
        details: process.env.NODE_ENV === 'development' ? e?.message : undefined
      }, { status });
    }
  });
}
