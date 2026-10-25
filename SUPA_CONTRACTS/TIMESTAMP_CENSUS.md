# Timestamp-Mismatch Census — the #1 migration bug class

Compiled 2026-10-25 by `test/supa-adapter-contracts` from
`feat/integration-wave3 @ 4d5a1e16`. Zero live reads.

## 1. What is actually in the jsonb (measured)

`migrate_db.js` stores `data = doc.data()` and dumps/pushes with
`JSON.stringify`. `doc.data()` returns live Firestore `Timestamp`
instances, and `@google-cloud/firestore`'s `Timestamp` defines **no
`toJSON`**. Measured locally against the kit's own dependency tree:

```
JSON.stringify(Timestamp.fromMillis(1761379200123))
→ {"_seconds":1761379200,"_nanoseconds":123000000}
```

So after migration, every timestamp field in `fs_*` `data` jsonb is a
plain object `{"_seconds": int, "_nanoseconds": int}` — **not** an ISO
string, and not a `{seconds, nanoseconds}` object either. Three
different shapes are in play across the boundary, and consumer code
was written against the first:

| Shape | Where it exists |
|---|---|
| Live `Timestamp` (methods `.toDate()/.toMillis()`, getters `.seconds/.nanoseconds`) | Firestore reads today |
| `{"_seconds","_nanoseconds"}` plain object | What the kit actually writes into Supabase jsonb |
| ISO 8601 string | What several consumers defensively accept; what some specs assume the jsonb holds |

## 2. The adapter's three options, and what each breaks

| Adapter returns | Breaks |
|---|---|
| (a) Raw jsonb (`{_seconds,_nanoseconds}`) | Every unguarded `.toDate()/.toMillis()` (**crash**); every `{seconds}` fallback arm — the dumped keys carry underscores, the code checks `v.seconds` (**silent wrong values**); every `new Date(value)` arm — `new Date({...})` is Invalid Date (**silent**) |
| (b) ISO strings | Every unguarded `.toDate()/.toMillis()` (**crash** — strings have neither); guarded sites whose fallback assumes Timestamp-or-nothing (**silent**, e.g. dashboard audit tail stamps `now()`); cursor math that needs `.toMillis()` (tasks nextCursor → null, pagination truncates) |
| (c) Rehydrated Timestamp-compatible objects | Nothing in this census. This is the only transparent option at 207 sites |

**Recommendation the contracts encode:** the adapter contract tests
pin behavior (c)-equivalence for timestamp fields — the returned
value must support `.toDate()` and `.toMillis()` and expose
`.seconds` — OR the migration must pair option (a)/(b) with a
consumer-fix wave covering every CRASH and SILENT site below and in
the full enumeration (`TIMESTAMP_SITES.txt`). Shipping (a) or (b)
against un-fixed consumers is a known-bug release.

## 3. Scale

Tree-wide (excluding tests), at 4d5a1e16:

- **207** call sites of `.toDate()` / `.toMillis()` across **121 files**
  (`grep -rn "\.toDate()\|\.toMillis()" src --include=*.ts --include=*.tsx`).
- Full file:line enumeration: `TIMESTAMP_SITES.txt` beside this file
  (machine-generated, same grep).

Most of those 207 sit behind five or six shared helpers; the helpers
are the leverage points. The sites in §4 are hand-verified by reading
the code; §5 classifies the helper families the enumeration shows.

## 4. Hand-verified sites in the census-top patterns

Classification: **CRASH** = throws on string/`{_seconds}` ·
**SILENT** = no throw, wrong data · **TOLERANT** = correct for both
Timestamp and ISO string (still wrong for `{_seconds}` where noted).

| # | Site | Code | Class | Consequence under (a) `{_seconds}` | Under (b) ISO string |
|---|---|---|---|---|---|
| TS-1 | `src/app/api/admin/users/route.ts:18-26` | `expiryIso()` — string arm, guarded `toDate`, Date arm | TOLERANT (b) / SILENT (a) | `roleExpiresAt` → null for every user (expiry display lost) | correct |
| TS-2 | `src/app/api/admin/dashboard/init/route.ts:132-141` | `timestampMillis()` — toMillis / Date / `{seconds}` / string / toDate arms | TOLERANT (b) / SILENT (a) | every pending app excluded from median → `medianDaysWaiting` null | correct |
| TS-3 | `src/app/api/admin/dashboard/init/route.ts:256` | `data.timestamp?.toDate ? … : new Date().toISOString()` | **SILENT (a) and (b)** | all 20 audit rows stamped with request time | same — **wrong under both non-rehydration options** |
| TS-4 | `src/app/api/tasks/route.ts:1936-1941` and `:2023-2027` | `serializeTs()` — toDate / `{seconds}` / passthrough | TOLERANT (b) / BROKEN (a) | the raw `{_seconds,_nanoseconds}` object is shipped in the JSON response for deadline/createdAt/updatedAt/completedAt/releasedAt/submittedAt/individualDeadline | correct ISO passthrough |
| TS-5 | `src/app/api/tasks/route.ts:1932-1935` and `:1999-2002` | `createdAtMs()` — toMillis / `{seconds}` only, else 0 | **SILENT (a) and (b)** | sort keys all 0 → assignee-branch order degenerates; cursor filter `createdAtMs < cursor` misbehaves (0 < cursor keeps everything → duplicate pages) | same as (a) |
| TS-6 | `src/app/api/tasks/route.ts:2039` | `nextCursor` via `lastCreated.toMillis` typeof guard | **SILENT (a) and (b)** | `nextCursor = null` after page 1 → list pagination silently ends | same as (a) |
| TS-7 | `src/lib/announcements.ts:109-115` | `announcementDate()` — `value?.toDate ? … : new Date(value)`, Invalid → null | TOLERANT (b) / **SILENT (a)** | publish_date parses Invalid → treated as **due**; expiresAt Invalid → treated as **not expired** → future-dated and expired announcements become visible | correct |
| TS-8 | `src/lib/announcements.ts:36-39` | `AnnouncementDoc` typing: `expiresAt?: any; // Firestore Timestamp or ISO string` | — (contract evidence) | the codebase's own type contract already admits ISO strings for these three fields — option (b) is type-compatible here, option (a) is not | — |

## 5. Helper families (from the full enumeration)

- Shared date helpers (e.g. `src/lib/announcements.ts` `announcementDate`,
  dashboard `timestampMillis`, tasks `serializeTs`/`createdAtMs`,
  directory `expiryIso`) concentrate a large share of the 207 sites'
  *effective* behavior: fix or satisfy ~6 helpers and most routes
  follow. The contract tests therefore assert adapter behavior against
  the helper inputs, not against each route.
- Unguarded direct calls (`.toDate()` on a doc field inside a
  component or route with no typeof guard) are pure CRASH class under
  both (a) and (b); they are the long tail the full enumeration lists.
- Filter-value constructions (`Timestamp.fromDate(now)` in
  `announcements.ts:245`, `Timestamp.fromMillis(cursorMs)` in
  `tasks/route.ts:1973`) are the mirror problem: consumers will hand
  the adapter live Timestamp objects as filter/cursor values, and the
  adapter must convert them for comparison against whatever shape it
  stored — under (a) that means comparing `{_seconds,_nanoseconds}`
  numerically; under (b) lexicographic ISO comparison (safe only if
  every string is UTC `Z`-suffixed with identical precision — the
  dump does not produce strings at all, so (b) requires a kit-side
  conversion the kit does not currently do).

## 6. Kit-side gap (blocks any option except (c) or a kit fix)

`migrate_db.js` as committed performs no timestamp conversion. If the
program chooses ISO strings (b), the kit needs a `doc.data()`
transform (Timestamp → ISO) in `rowFor` **before** dump; if it
chooses (a)+(consumer fixes), the `{_seconds}` shape must be written
into the adapter spec so cluster teams stop assuming `{seconds}` or
ISO. As of this census, neither the kit nor (yet) the adapter branch
states the choice — **this is the single highest-leverage decision in
the migration**, and the contract suite is written to detect which
choice the adapter made and fail loudly on the other two.
