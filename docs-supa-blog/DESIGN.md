# Blog + Content cluster — Supabase migration design
Base 4d5a1e16. Adapter: feat/supa-adapter src/lib/supa (getSupaAdapter/createSupaAdapter/getSupaClient/useSupa; ops getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc over fs_<collection>; SupaDoc = {id, ...data} plain; listDocs orders by data->>'field' TEXT; updateDoc read-modify-write, rejects code 'not-found' on missing row; gate = useSupa(surface) && getSupaClient(), SUPA_SURFACES env, default OFF = Firestore byte-identical).

## 1. Flag surface + gate per call site [RULING]
Surface name: 'blog' (PLAN.md). Every call site gates through blogSupaEnabled() in src/lib/server/blog-supa.ts = useSupa('blog') && !!getSupaClient(), wrapped in try/catch (any throw = OFF). Sites: blog-server getBlogBySlug/getRelatedBlogs, GET /api/blogs, GET /api/blogs/[slug], GET /api/blogs/latest, GET /api/admin/blogs/[id], GET /api/authors (blogs reads only; users collection stays Firestore). Client surfaces never import '@/lib/supa': admin list stays a Firestore one-shot read (section 5).

## 2. Date normalization [RULING — decide from migrate_db.js evidence]
Evidence (migrate_db.js normalizeTimestamps + adapter header): the kit converts Firestore Timestamps to ISO strings at dump/push; the adapter converts Date/Timestamp-like values to ISO on write and rehydrates legacy {_seconds,_nanoseconds} dumps to SupaTimestamp (toDate/toMillis) on read. Ruling: fs_blogs dates are ISO strings (or SupaTimestamp for legacy rows). All blog serializers go through serializeBlogDate (src/lib/blog-data-utils.ts) / blogDateToDate (blog-supa.ts), which accept Timestamp-like, Date, ISO string, epoch number, {seconds}/{_seconds,_nanoseconds} shapes. In-memory publishedAt sorts parse via Date, never raw text order, in route code; adapter listDocs orderBy on publishedAt is used only for related-post candidate fetch where route code re-filters and caps (final public ordering is by parsed date).

## 3. Seam modules per group (G1 blog-server + api/blogs/[slug]; G2 api/blogs + latest + authors + categories; G3 api/admin/blogs/[id]; G4 client) [RULING: paths + signatures]
Single seam for the whole cluster (built on feat/supa-blog-0 as one team): src/lib/server/blog-supa.ts — blogSupaEnabled(), blogDateToDate(), blogDateToIso(), supaDocData(), supaListBlogs(), supaGetBlog(), supaFindBlogBySlug(), mirrorBlogCreate(id, data), mirrorBlogUpdate(id, data). Shared write helper in blog-server.ts: createBlogPost(data) / updateBlogPost(id, data) (Firestore primary + mirror). api/categories is NOT migrated in this build: it was in the G2 inventory but outside this task's route list; recorded as a gap in the residual record. G4: no client-side Supabase; see section 5.

## 4. Write/mirror rules [RULING]
Firestore is always the primary write. When the gate is ON, a completed Firestore write mirrors best-effort: POST /api/blogs -> setDoc; admin PUT -> updateDoc; admin DELETE -> updateDoc with the canonical state {deleted:true, deletedAt, status:'archived'} (pinned, unchanged); blog-server helper writes likewise. Mirror failures are logged and never fail the request. mirrorBlogUpdate falls back to setDoc{merge:true} on adapter 'not-found' so the mirror converges. Reads, when ON, serve from Supabase alone (Firestore fallback only on adapter error, never a merge of both).

## 5. Client-scope rulings [RULING per surface]
- src/app/admin/blog/page.tsx: no-limit onSnapshot listener (census B1) becomes one-shot useCollection(listen:false) + manual Refresh button (refreshNonce rebuilds query identity -> refetch). Approach (d) per CLUSTER_MAP.
- src/app/admin/blog/edit/page.tsx: blogDocRef construction moves behind the createBlogDocRef() seam in src/lib/blog-data-utils.ts (single DocumentReference owner); useMemo + null semantics unchanged. The edit write path itself stays client Firestore (its mirror is the REST/admin path's job when used; direct client-SDK writes are a recorded gap).
- src/hooks/use-blogs*.ts and public blog pages: unchanged — they consume the API routes / Firestore as today; the routes carry the migration.

## 6. Fallback + posture rules [RULING per surface]
Every surface: flag OFF, client unconfigured, or ANY adapter error -> the pre-migration Firestore code path runs unchanged. Public posture is identical on both backends: status=='published' && deleted!==true for list/detail/latest/authors (unit-pinned incl. legacy flag-only deletes); admin GET serves any status. Cache contract unchanged: list/detail/authors 's-maxage=600, stale-while-revalidate=86400'; latest 'public, s-maxage=60, stale-while-revalidate=300'. Slug semantics unchanged: slug query first, doc-id fallback, non-public -> 404 on detail / null in blog-server.

## 7. Declaration shim src/lib/supa/index.d.ts [VERBATIM BLOCK]
Superseded on this branch by the task instruction: the real src/lib/supa/ was copied verbatim from wt-supa-adapter (adapter.ts, client.ts, flags.ts, index.ts, unedited). No declaration shim is carried; at merge the adapter step's copy and this copy are identical files. Note: the branch carries no package.json change (forbidden); @supabase/supabase-js arrives with the adapter step at merge.

## 8. Shared-file flags [LIST]
- src/app/api/authors/route.ts — SHARED: only its blogs reads migrate; users collection stays Firestore.
- src/app/api/categories/route.ts — SHARED, NOT touched in this build (gap).
- src/lib/server/blog-server.ts — shared write helper added (createBlogPost/updateBlogPost); existing exports unchanged in signature.
- src/lib/blog-data-utils.ts — additive only (serializeBlogDate, createBlogDocRef).
- Pinned files byte-untouched: src/app/api/workflows/route.ts, src/lib/server/gamification-transaction.ts, src/lib/auth-middleware.ts, src/lib/server/permissions.ts, src/lib/server/identity-cache.ts, shared firestore hooks (useCollection implementation untouched — only its call site in admin/blog/page.tsx changed).

## 9. Gate commands per group [LIST]
- New contracts: jest src/lib/server/__tests__/blog-supa-contracts.test.ts (26 tests).
- Pre-existing blog suites: admin/blog (3), api/admin/blogs/[id] (3), api/blogs (4), api/blogs/[slug] (1), api/authors (2), lib/server blog-related, lib blog-slug, blog/[slug] related-wiring, blog post-page-no-mock, components/admin/blog blog-post-form (18 suites).
- Scoped tsc: tsc --noEmit, errors counted only in touched files vs base (zero new allowed). Bracket-path suites need --runTestsByPath (jest treats [id]/[slug] args as regex classes). Jest cache must live on disk-backed TMPDIR in this sandbox (/tmp tmpfs fills -> ENOSPC).
