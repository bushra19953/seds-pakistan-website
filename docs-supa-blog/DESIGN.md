# Blog + Content cluster — Supabase migration design
Base 4d5a1e16. Adapter: feat/supa-adapter src/lib/supa (getSupaAdapter/createSupaAdapter/getSupaClient/useSupa; ops getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc over fs_<collection>; SupaDoc = {id, ...data} plain; listDocs orders by data->>'field' TEXT; updateDoc read-modify-write, rejects code 'not-found' on missing row; gate = useSupa(surface) && getSupaClient(), SUPA_SURFACES env, default OFF = Firestore byte-identical).
## 1. Flag surface + gate per call site [RULING]
## 2. Date normalization [RULING — decide from migrate_db.js evidence]
## 3. Seam modules per group (G1 blog-server + api/blogs/[slug]; G2 api/blogs + latest + authors + categories; G3 api/admin/blogs/[id]; G4 client) [RULING: paths + signatures]
## 4. Write/mirror rules [RULING]
## 5. Client-scope rulings [RULING per surface]
## 6. Fallback + posture rules [RULING per surface]
## 7. Declaration shim src/lib/supa/index.d.ts [VERBATIM BLOCK]
## 8. Shared-file flags [LIST]
## 9. Gate commands per group [LIST]
