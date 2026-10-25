# Identity Cluster — Acceptance Audit (feat/supa-identity-6, base ab4b5ee)

## Item 1 Pin integrity: PASS
- git diff 4d5a1e16..ba529ca pinned paths = 0 lines; ba529ca..ab4b5ee pinned paths = 0 lines.
- git diff --name-status 4d5a1e16..ab4b5ee: only A (new): NOTES-B.md, identity-supa.ts, identity-backend.ts, identity-supa.test.ts, identity-backend.test.ts, 2x identity-backend-repoint.test.ts; M: exactly src/app/api/positions/route.ts + src/app/api/profile/[userId]/route.ts. No pre-existing test file modified.
- B route diffs eyeballed: positions = flag-gated bundle read replacing direct roles get in checkPositionManagementPermission fallback (claims read + hasServerPermissionForUser untouched, OFF = original get verbatim); profile = flag-gated bundle shim {exists,data:()=>{role}} replacing requester roles get (OFF = original get verbatim, same .catch -> snap null).

## Item 2 Parity swap: PASS (52/52)
- Copied identity-2 parity suite + fixtures into this tree (counting-firestore.ts already in base, byte-identical). Flipped SUPA_IDENTITY_READER_FACTORY_UNDER_TEST from createStubSupaIdentityReader to createRealSupaIdentityReader wrapping A's real loadIdentityBundleFromSupa/loadPermissionDocFromSupa; only mock = global fetch (fetchRowData transport) serving fsRowsFor rows + test SUPABASE env, per A's identity-supa.test.ts pattern.
- Result: 1 suite, 52 tests, all passed. Bundle deep-equal B==A==expected for ALL 15 fixtures; PermissionDocEntry deep-equal for every fixture permission doc; cap case (index-3 verbatim) and founder-string case pass; side-A auth derivation matches expectedAuth for all fixtures.
- Honest scope note: the suite's two side-B RESOURCE_EXHAUSTED cases construct the STUB factory directly (test names say "(stub)") — they do not exercise the real reader's throw path. Real-reader throw semantics are evidenced by A's identity-supa/identity-backend suites in the pinned-family run (fetch-failure throws, never exists:false; dispatcher fallback).

## Item 4 Lookup counts
- Measured in this audit via A's suites executed in the pinned-family run on this tree: identity-backend.test.ts asserts ON cold bundle fetchCount=2 (fs_roles+fs_users), warm second call fetchCount still 2 (0 additional, same object); permission doc cold=1, warm=0 additional (fetchCount stays 1). identity-supa.test.ts asserts loadIdentityBundleFromSupa fetchCalls length exactly 2 and loadPermissionDocFromSupa exactly 1.
- The parity run itself did not count fetches (its mock was a row server, not a counter) — shape parity measured here, counts inherited from A's suite evidence as executed here.

## Item 6 Flag default OFF: PASS
- identity-backend.ts:41-47 useSupaIdentity(): parses SUPA_SURFACES comma-list, returns true iff it includes 'identity'. Env unset -> '' -> false. OFF branches call getIdentityBundleCached / Firestore mirror loader (identity-backend.ts:66,109).
- B OFF-state evidence: profile repoint suite flag-OFF cases (Firestore roles doc used, backend never called, sensitive-field behavior as today) and positions repoint suite flag-OFF cases (direct get used, backend never called, verdict/403 as today); identity-backend.test.ts OFF case: existing Firestore cached accessor, zero Supa fetches. All in the pinned-family run on this tree.

## Item 3 Pinned family: PASS (13 suites, 123 tests)
- Run in 3 chunks because jest does not exit on this tree without --forceExit (pre-existing route-module setInterval open handle — B's NOTES-B.md documents the same; tests themselves complete in seconds). Chunk 1: 10 suites / 99 tests PASS (identity-cache, -race, -ta5-ta4, -hardening, -write-invalidation, -write-invalidation-governors, -write-invalidation-ratification-chapter, identity-supa, identity-backend, positions repoint). Chunk 2 (--forceExit): identity-cache-integration + workflows route-assignment-notifications, 2 suites / 19 tests PASS. Chunk 3 (--runTestsByPath, --forceExit): profile repoint, 1 suite / 5 tests PASS.
- Total: 13 suites, 123 tests, 0 failures. git status clean afterwards: no pre-existing test file modified (only additions: the parity suite + fixtures, committed as audit scaffolding).

## Item 5 tsc: PASS (measured in this audit)
- Command: rm -f tsconfig.tsbuildinfo; NODE_OPTIONS=--max-old-space-size=4608 npx tsc --noEmit (foreground, completed in ~102s, exit 2 as expected with baseline errors).
- Result: 151 errors = baseline 151, zero new. grep of the error log: 0 errors in any identity file (identity-supa, identity-backend, identity-cache, identity-supa-parity, identity-parity-fixtures), 0 in profile/[userId] or positions routes. This independently matches B's completed identical-tree run (151, NOTES-B.md); my tree additionally contains the parity scaffolding, which contributed 0 errors.

## FINAL VERDICTS
1. Pin integrity: PASS
2. Parity swap (real reader): PASS — 52/52, deep-equal across all 15 fixtures; stub-only throw cases noted, real-reader throw semantics covered by item-3 suites
3. Pinned family: PASS — 13 suites / 123 tests green, existing files unmodified
4. Lookup counts: PASS — cold bundle 2 / warm 0, permission doc 1 / 0 (A's counting suites executed on this tree in item 3; parity run measured shape, not counts)
5. tsc: PASS — 151 = baseline, zero new, none in identity files (measured here, foreground)
6. Flag default OFF: PASS — useSupaIdentity (identity-backend.ts:41-47) false when SUPA_SURFACES unset; OFF behavior byte-identical per B repoint suites (green in item 3)

## Merge-planner notes (non-blocking gaps from checklist s2, fixtures only)
- Parity fixtures lack: expiresAt {_seconds}/{seconds}/millis shapes (A's own suite covers {_seconds} passthrough), additionalRoles non-array as-is, roles-doc-present-but-blank-role mirror fallback, custom-subject deny-by-absence at hasServerPermission level. None diverge in the executed runs; they are coverage gaps in identity-2's fixture set, recommended as fixture additions, not merge blockers.
