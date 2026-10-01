import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { withAuth } from "@/lib/auth-middleware";
import { hasServerPermission } from "@/lib/server/permissions";

function normalize(str: string) {
  return (str || "").trim();
}

// 🧠 GOD-TIER ACCURACY ENGINE: Global Node.js Memory Dictionary
// We fetch a compact dictionary of all users every 5 minutes and perform 0ms fuzzy text scanning in RAM.
// This completely destroys Firestore's rigid query restrictions.

interface UserDictionaryEntry {
  id: string;
  name: string;      // lowercase for search
  rawName: string;   // real case for display
  email: string;
  role: string | null;
  whatsapp: string;
  chapterId: string | null;
  isBanned?: boolean;
}

let globalSearchDirectory: UserDictionaryEntry[] | null = null;
let lastDirectoryFetch = 0;
const DIRECTORY_TTL = 5 * 60 * 1000; // 5 minutes

// Old basic search cache for empty state queries
const searchCache = new Map<string, { data: any, timestamp: number }>();
const SEARCH_CACHE_DURATION = 30 * 1000; // 30 seconds

function getCacheKey(params: { q: string, role: string, chapterId: string, pageSize: number, startAfter?: string }) {
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
      const canManage = await hasServerPermission(authContext.role, 'canManageUsers');
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

      // 🚀 ENGINE ROUTING: Use RAM search for text queries OR specific role filters.
      // Native Firestore (Path A) is ONLY for idle browsing with no filters.
      const isSearchActive = q.length > 0 || (role && role !== 'All');

      // Reject empty role/query cache bypass
      if (!isSearchActive && !startAfterVal) {
        const cacheKey = getCacheKey({ q, role, chapterId, pageSize });
        const cached = searchCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < SEARCH_CACHE_DURATION) {
          return NextResponse.json({ ...cached.data, cached: true, responseTime: Date.now() - startTime });
        }
      }

      // 🛑 PATH A: IDLE BROWSING (No Search Query, No Role Filter)
      if (!isSearchActive) {
        let queryRef: any = db.collection("users");
        
        // If we have a role or chapter filter, native firestore indexing might be needed
        // For simplicity in the idle state, we use basic name sorting or just ID
        queryRef = queryRef.orderBy("__name__");
        
        if (startAfterVal) queryRef = queryRef.startAfter(startAfterVal);
        queryRef = queryRef.limit(pageSize * 3); // Fetch more to allow for filtering

        const snap = await runWithTimeout(queryRef.get());
        const baseUsers = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

        // Fetch dynamic roles for this page chunk
        const rolesMap: Record<string, string> = {};
        if (baseUsers.length > 0) {
          try {
            const uids = baseUsers.map(u => u.uid || u.id);
            const chunkSize = 30;
            for (let i = 0; i < uids.length; i += chunkSize) {
              const chunk = uids.slice(i, i + chunkSize);
              const rolesSnap = await db.collection("roles").where("__name__", "in", chunk).get();
              rolesSnap.docs.forEach((doc: any) => {
                if (doc.data()?.role) rolesMap[doc.id] = String(doc.data().role);
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
          chapterId: u.chapterId || u.chapter || null,
          isBanned: u.isBanned || false,
        }));

        // Apply strict filters in memory for Path A
        if (role) {
          users = users.filter(u => {
            // IDENTITY ALIAS: 'president_national' or 'superadmin' filter matches the Founder UID
            if (role === 'president_national' || role === 'superadmin') {
              return u.uid === 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
            }
            return u.role === role;
          });
        }
        if (chapterId && chapterId !== 'All') {
          users = users.filter(u => u.chapterId === chapterId);
        }

        // Re-slice to exact pageSize after memory filtering
        users = users.slice(0, pageSize);

        const nextCursor = users.length > 0 ? String(users[users.length - 1].uid) : "";

        const responseData = { users, nextCursor, pageSize, responseTime: Date.now() - startTime, searchMethod: "native_firestore" };
        if (!startAfterVal) searchCache.set(getCacheKey({ q, role, chapterId, pageSize }), { data: responseData, timestamp: Date.now() });

        return NextResponse.json(responseData);
      }

      // 🚀 PATH B: GOD-TIER FULL-DATABASE FUZZY SEARCH (Query Provided)

      // 1. Maintain Engine Dictionary Cache
      if (!globalSearchDirectory || Date.now() - lastDirectoryFetch > DIRECTORY_TTL) {
        console.log("⚡ [Search Engine] Rebuilding Node.js Global Dictionary Cache...");
        const snap = await db.collection("users").select("displayName", "name", "email", "role", "whatsapp", "whatsappNumber", "chapterId", "chapter").get();
        console.log(`[Search Engine] Fetched ${snap.size} user records`);

        // We must fetch ALL roles to map the dictionary accurately
        const allRolesSnap = await db.collection("roles").get();
        console.log(`[Search Engine] Fetched ${allRolesSnap.size} role records`);
        
        const globalRolesMap: Record<string, string> = {};
        allRolesSnap.docs.forEach((d: any) => { if (d.data()?.role) globalRolesMap[d.id] = String(d.data().role); });

        globalSearchDirectory = snap.docs.map((d: any) => {
          const data = d.data();
          const rawDisplayName = String(data.displayName || data.name || "");
          return {
            id: d.id,
            name: rawDisplayName.toLowerCase(),
            rawName: rawDisplayName,
            email: String(data.email || "").toLowerCase(),
            role: globalRolesMap[d.id] || data.role || null,
            whatsapp: String(data.whatsapp || data.whatsappNumber || "").toLowerCase(),
            chapterId: data.chapterId || data.chapter || null,
            isBanned: data.isBanned || false,
          };
        });
        lastDirectoryFetch = Date.now();
        console.log(`✅ [Search Engine] Dictionary built with ${globalSearchDirectory.length} records in RAM.`);
      }

      // 2. Execute Fuzzy Memory Scan over thousands of records in <2ms
      const terms = q.split(" ").filter(t => t.length > 0);
      const scoredResults: { user: UserDictionaryEntry, score: number }[] = [];

      for (const u of globalSearchDirectory) {
        // 1. Hard Chapter Filter
        if (chapterId && chapterId !== 'All' && u.chapterId !== chapterId) continue;
        
        // 2. Hard Role Filter with IDENTITY ALIAS
        if (role) {
          if (role === 'president_national' || role === 'superadmin') {
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
        searchMethod: "node_fuzzy_ram",
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
