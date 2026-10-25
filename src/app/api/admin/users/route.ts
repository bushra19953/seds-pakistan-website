import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { withAuth } from "@/lib/auth-middleware";
import { hasServerPermissionForUser, getIdentityBundleCached } from "@/lib/server/permissions";
import { resolveEffectiveScope, resolveChapterFilter } from "@/lib/server/chapter-scoping";

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
// fetched per request (Path B below) and fuzzy-scored in RAM. The
// previous design rebuilt a full users+roles snapshot in memory on a
// 5-minute TTL (444 reads per rebuild); Read-Burn F6 removed that
// rebuild from the request path entirely, so no search can trigger
// one. See READ_BURN_CENSUS_2026-10-25.md item C3/F6.

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
const SEARCH_CACHE_DURATION = 30 * 1000; // 30 seconds

function getCacheKey(params: { q: string, role: string, chapterId: string, pageSize: number, startAfter?: string, scopeKey?: string }) {
  return JSON.stringify(params);
}

// Execute query with timeout helper
const runWithTimeout = (promise: Promise<any>) => {
  const queryTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Query timeout")), 10000));
  return Promise.race([promise, queryTimeout]);
};

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
      const role = normalize(searchParams.get("role") || "");
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

      // 🚀 ENGINE ROUTING: both paths are native Firestore now.
      // Path A serves idle browsing (no filters); Path B serves text
      // queries and role filters from a bounded candidate window.
      const isSearchActive = q.length > 0 || (role && role !== 'All');

      // Reject empty role/query cache bypass
      if (!isSearchActive && !startAfterVal) {
        const cacheKey = getCacheKey({ q, role, chapterId, pageSize, scopeKey });
        const cached = searchCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < SEARCH_CACHE_DURATION) {
          return NextResponse.json({ ...cached.data, cached: true, responseTime: Date.now() - startTime });
        }
      }

      // 🛑 PATH A: IDLE BROWSING (No Search Query, No Role Filter)
      if (!isSearchActive) {
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
        const baseUsers: { id: string; [key: string]: any }[] = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

        // Fetch dynamic roles for this page chunk
        const rolesMap: Record<string, string> = {};
        const roleExpiresMap: Record<string, string | null> = {};
        if (baseUsers.length > 0) {
          try {
            const uids = baseUsers.map(u => u.uid || u.id);
            const chunkSize = 30;
            for (let i = 0; i < uids.length; i += chunkSize) {
              const chunk = uids.slice(i, i + chunkSize);
              // Projection: only role + expiresAt are read from each roles doc.
              const rolesSnap = await db.collection("roles").where("__name__", "in", chunk).select("role", "expiresAt").get();
              rolesSnap.docs.forEach((doc: any) => {
                if (doc.data()?.role) rolesMap[doc.id] = String(doc.data().role);
                roleExpiresMap[doc.id] = expiryIso(doc.data()?.expiresAt);
              });
            }
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
        if (role) {
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

        const responseData = { users, nextCursor, pageSize, responseTime: Date.now() - startTime, searchMethod: "native_firestore" };
        if (!startAfterVal) searchCache.set(getCacheKey({ q, role, chapterId, pageSize, scopeKey }), { data: responseData, timestamp: Date.now() });

        return NextResponse.json(responseData);
      }

      // 🛑 PATH B: BOUNDED NATIVE SEARCH (Query and/or role filter provided)
      //
      // Read-Burn F6: this path used to rebuild a full users+roles
      // snapshot in RAM (444 reads) whenever its 5-minute cache went
      // cold, so ordinary searches were the directory's rebuild
      // trigger. It now fetches a bounded candidate window with the
      // same native machinery as Path A: chapter-scoped in the query
      // itself, doc-id ordered, hard-capped at pageSize * 3 (<= 150)
      // user docs, with roles resolved for those candidates only
      // (chunked `in` queries, <= 150 role docs). The fuzzy scoring
      // below runs over that window only; searches are therefore
      // always live (no snapshot staleness) and can never trigger a
      // full-collection rebuild.
      let candidateQuery: any = db.collection("users")
        .select("displayName", "name", "email", "role", "whatsapp", "whatsappNumber", "chapterId", "chapter", "isBanned");
      if (effectiveChapterId) {
        candidateQuery = candidateQuery.where("chapterId", "==", effectiveChapterId);
      }
      candidateQuery = candidateQuery.orderBy("__name__").limit(pageSize * 3);

      const candidateSnap = await runWithTimeout(candidateQuery.get());
      const candidateDocs: { id: string; data: Record<string, any> }[] =
        candidateSnap.docs.map((d: any) => ({ id: d.id, data: d.data() }));

      // Exact-email probe (<= 1 read): the standing find-a-person
      // method is lookup by email, and an exact address must resolve
      // even when its doc falls outside the candidate window above.
      // Best effort only; the window scan below remains the fallback.
      const emailTerm = q.split(" ").find(t => t.includes("@"));
      if (emailTerm && !candidateDocs.some(d => String(d.data.email || "").toLowerCase() === emailTerm)) {
        try {
          const probeSnap = await runWithTimeout(
            db.collection("users")
              .select("displayName", "name", "email", "role", "whatsapp", "whatsappNumber", "chapterId", "chapter", "isBanned")
              .where("email", "==", emailTerm)
              .limit(1)
              .get()
          );
          probeSnap.docs.forEach((d: any) => {
            if (!candidateDocs.some(c => c.id === d.id)) {
              candidateDocs.push({ id: d.id, data: d.data() });
            }
          });
        } catch (e) {
          console.warn("Exact-email probe failed:", e);
        }
      }

      // Roles for the candidate window only (never the full roles
      // collection): chunked `__name__ in` queries, same pattern as
      // Path A. Projection: only role + expiresAt are read per doc.
      const windowRolesMap: Record<string, string> = {};
      const windowRoleExpiresMap: Record<string, string | null> = {};
      if (candidateDocs.length > 0) {
        try {
          const uids = candidateDocs.map(d => d.id);
          const chunkSize = 30;
          for (let i = 0; i < uids.length; i += chunkSize) {
            const chunk = uids.slice(i, i + chunkSize);
            const rolesSnap = await db.collection("roles").where("__name__", "in", chunk).select("role", "expiresAt").get();
            rolesSnap.docs.forEach((doc: any) => {
              if (doc.data()?.role) windowRolesMap[doc.id] = String(doc.data().role);
              windowRoleExpiresMap[doc.id] = expiryIso(doc.data()?.expiresAt);
            });
          }
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
        if (role) {
          if (role === 'president_national' || role === 'superadmin' || role === 'founder_patron') {
             if (u.id !== 'pLW0PuQCTAQHCNK1SfllVhPZdMz1') continue;
          } else {
             if (u.role !== role) continue;
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
        searchMethod: "native_firestore",
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
