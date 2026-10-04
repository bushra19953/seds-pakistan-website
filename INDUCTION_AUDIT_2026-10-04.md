# Induction Flow Deep Audit, 2026-10-04

Scope: `src/app/induction/page.tsx`, `src/components/induction-stepper/*`,
`src/hooks/use-autosave.ts`, `src/hooks/use-universities.ts`,
`src/components/admin/applications/induction-form-editor.tsx`, `firestore.rules`.
Branch: `feat/remediation-harness-complete`. Method: 20 parallel read-only
agents, systematic-debugging (root cause, pattern, hypothesis). No code changed.

## Executive verdict

The induction flow is structurally sound but has real defects in three areas:
persistence (autosave is fully dead at the rules layer), submission integrity
(no transaction, silent flag failures, false failure toasts), and admin config
safety (zero validation, zero audit trail on the live form config). Several
earlier live-test alarms turned out to be test-environment artifacts, not code
bugs; those are listed first so nobody chases them.

---

## PART A: Not bugs, do not chase these

### A1. The "missing auth gate" was a contaminated browser profile
Track 1 proved the auth gate works: `page.tsx:47-50` redirects anonymous users
to `/auth/login`, `page.tsx:136` renders null without a user, and `useUser`
never fabricates guests (zero `signInAnonymously` in src). The 20 browser agents
shared one profile holding a persisted Firebase session (Admin/Profile links
visible in "unauthenticated" screenshots, which is impossible when logged out).
Every "unauthenticated happy path" conclusion from 2026-10-03 is invalid and
must be re-run in a clean profile before anyone relies on it.

### A2. The "spontaneous theme reverts" were cross-tab sync between test agents
Track 16 traced every writer of the `<html>` class: exactly one, next-themes
`applyTheme`. The two theme agents ran overlapping sessions on one shared
profile; each tab's `setTheme` fired a `storage` event that flipped the other
tab. Single real-user tabs cannot flip spontaneously. No fix needed. Minor real
note: `StarryBackground` renders unconditionally, so Light mode still shows a
dark starfield, which can look like a mixed theme state.

### A3. The university dropdown "click interception" is an automation artifact
Track 5 traced the full click path: cmdk `CommandItem` has a genuine onClick,
Radix popover renders in a body portal at z-50, no element overlaps it. The
agents' hit-test failures came from clicking options below the 300px scroll
fold without scrolling them into view. Real users scroll first, so selection
works. Recommend one live confirmation (scroll option into view, then click)
before closing. Two REAL defects were found in the same component, see H6/H7.

---

## PART B: Critical, fix before next production push

### B1. Autosave is completely dead: no Firestore rule for `drafts`
Tracks 12 and 14. `firestore.rules` has zero `match /drafts/...` blocks, so
Firestore denies every read and write by default. `use-autosave.ts:47`
(`setDoc drafts/{uid}`) and the draft-load `getDoc` (`page.tsx:198`) both throw
PERMISSION_DENIED on 100 percent of attempts, swallowed by console-only
catches. Autosave has never worked since the initial commit. The profile
autofill else-branch also never runs because the denied read jumps to catch.
Fix: add an owner-scoped rule
(`match /drafts/{userId} { allow read, write: if request.auth.uid == userId; }`)
or delete the autosave code. The current silent-failure state is the worst option.

### B2. Every submission shows a false "Submission Failed" toast
Track 12. `page.tsx:270` runs `deleteDoc(doc(db, 'drafts', user.uid))` inside
the submit try-block AFTER the application write. With no `drafts` rule this
throws, the outer catch fires, and the user sees "Submission Failed" even
though their application was saved. Same pattern for `logAuditEntry`
(`page.tsx:269`): a non-critical side effect in the critical path misreports
success as failure. Fix: move both out of the success-critical path into
guarded try/catch blocks.

### B3. No transaction on submit; flag failure is swallowed
Track 10. `setDoc(applications/{uid})` and `updateDoc(users/{uid},
{hasApplied: true})` are independent writes. The flag write sits in an inner
try/catch that only `console.warn`s, then execution continues to the success
toast and profile redirect. If the flag write fails, the user sees success but
`hasApplied` is never set, so the duplicate guard never triggers. Fix: single
Firestore batch for both writes.

### B4. `applications` create is not bound to the caller's uid
Track 14. `firestore.rules` allows `create: if isSignedIn()` on
`applications/{id}` with no `request.auth.uid == id` constraint. Any signed-in
user can pre-create `applications/{victimUid}`, turning the victim's later
submit into a denied update ("Submission Failed"). There is also zero payload
validation on create. Fix: bind doc ID to uid and validate fields, following
the existing pattern at `firestore.rules:163-168`.

### B5. `hasApplied` / `applicationStatus` are user-mutable
Track 14. `privilegedFieldsUnchanged()` (`firestore.rules:140-146`) guards
`isBanned`, `role`, etc., but not `hasApplied` or `applicationStatus`. Any user
can `updateDoc(users/{ownUid}, {hasApplied: false})` from devtools to re-enter
the form, or set `applicationStatus: 'approved'`, which renders verbatim on the
"Application Received" card. Fix: add both fields to the privileged list.

---

## PART C: High severity

### H1. Admin form editor has zero validation and zero audit trail
Track 20. `induction-form-editor.tsx` `saveFields` is a bare
`setDoc(settings/induction_form, { fields })`: no validation, no confirmation,
no `logAuditEntry`, no `updatedAt`/`updatedBy`. Any superadmin can silently
reshape or break the public application flow with no record. This also
explains the 8-field vs 5-field Step 1 mystery from the live tests: an admin
(or console) write replaced the config between the two sessions, and it is
untraceable. Fix: validate on save, log the change, stamp the doc.

### H2. Reserved-name collision silently drops required validation
Track 4 (proven by executing the real schema code). The schema loop runs after
the hardcoded `resumeUpload`/`portfolioLink`/`githubLink` entries, so an admin
field named `resumeUpload` overwrites them silently: `required:false` makes the
mandatory Drive upload pass when empty; `required:true` replaces URL/Drive
validation with plain `z.string().min(1)`. Fix: reserve the names in the editor
or namespace dynamic fields.

### H3. Nameless configured field bricks submission invisibly
Track 4. A field with no `name` creates `schemaShape["undefined"]`; step-level
`trigger` never blocks on it, but final `handleSubmit` fails at path
`["undefined"]` with no UI element rendering the error. The form becomes
permanently unsubmittable with only the generic toast. Fix: reject nameless
fields on save.

### H4. Negative-step required field = invisible, unsubmittable form
Track 20. `(f.step || 0) === stepNum` never matches negative steps, so the
field renders on no step, but the schema is built from ALL fields. A required
negative-step field blocks submission forever with no visible field. Fix:
validate step ranges on save.

### H5. Duplicate field names corrupt data silently
Tracks 4 and 20. No uniqueness check on the data key. Later duplicates
overwrite earlier ones in `schemaShape` and `defaultValues`; two inputs bind
one RHF field and mirror each other. Fix: uniqueness check in the editor.

### H6. University dropdown trigger is implicitly `type="submit"`
Track 5. The `PopoverTrigger asChild` Button sets no `type`, and the stepper
sits inside `<form onSubmit>`. Every click that opens the dropdown also submits
the form, producing spurious "Validation Error" toasts on Step 1. Fix: add
`type="button"`.

### H7. "Add university" flow is unreachable dead code
Track 5. `CommandEmpty` only renders when cmdk's internal filtered count is 0,
but `shouldFilter={false}` means cmdk never filters, so the empty state never
renders. Users with unlisted universities have no path forward despite
`handleAddNew` existing. Fix: implement the empty state or remove the flow.

### H8. Draft `reset()` wipes user input and validation errors
Tracks 4 and 13. The load effect awaits Firestore, then calls `reset()`
unconditionally, clearing `formState.errors` and any typed values. With the
observed 10-30s config latency, a user typing during the window loses
everything when the promise resolves. The autofill branch additionally lets
profile values deterministically overwrite user-typed values for 5 fields.
Fix: dirty-check before reset, or load the draft before first paint.

### H9. Stale draft keys propagate into production application records
Track 13. `sanitizedPayload` is a bare spread with no key filtering; unknown
keys flow through `watch()` into autosave and through `...formData` into the
`applications/{uid}` document. After any admin field rename, 30-day-lived
drafts inject stale keys into production records. Fix: filter draft keys
against the current field config.

### H10. Slow config load is a code-level serial waterfall
Track 3. The 10-30s spinner is dominated by ~6 sequential network round trips
before the form renders: unbounded `getIdToken()` await
(`user-provider.tsx:113`, no timeout), two sequential role-definition reads, a
role `onSnapshot` handshake, then three strictly sequential `getDoc`s
(users, applications, settings) where the only render-blocking one
(`settings/induction_form`, publicly readable) runs LAST. A 10s auth-timeout
backstop means the auth phase alone can stall 10s. Fix: fetch the public
config in parallel with, not after, user resolution; add a token timeout;
skip the guaranteed-denied `applications/{uid}` read for non-admins.

### H11. Out-of-range `?step=` crashes the page
Tracks 2, 15, 17, 20. `?step=99` gives `initialStep=98`; `steps[98].title`
(`page.tsx:356`) throws into the error boundary ("Something went wrong").
`?step=abc` gives NaN and `Math.max(0, NaN)` is NaN, same crash. Fix: clamp to
a valid step.

### H12. `linkedinUrl` mapped into `portfolioLink`
Track 13. `page.tsx:215` autofills `portfolioLink` from `profile.linkedinUrl`;
no `portfolioUrl` field exists anywhere, so LinkedIn URLs are submitted and
displayed as "Portfolio Link" in production records. Fix: correct mapping or
drop the autofill.

---

## PART D: Medium severity

- **M1.** Errors do not clear live on input. `useForm` uses default
  `mode:'onSubmit'`; `handleNextStep` validates via `trigger()`, which never
  sets submitted state, so `reValidateMode:'onChange'` never engages. Typing
  after a failed Next leaves stale errors until Next is clicked again.
  (`page.tsx:184-187, 323`)
- **M2.** Step 4 (portfolio) silent failure: the inline error element EXISTS
  (`Step3Portfolio.tsx:31`) and a jsdom repro with the real schema rendered it.
  The live "silent" report contradicts itself (it quoted the inline-only
  message "Must be a valid Google Drive link" as helper text). Likely a
  reset-race or observation artifact; needs one instrumented live re-check, no
  code change indicated yet.
- **M3.** Step 2 placeholder grammar: hardcoded `Type a ${label}` in
  `Step2Skills.tsx:43` produces "Type a skills and press Enter". One-line fix.
- **M4.** Review page "N/A" masks missing required fields. Direct `?step=5`
  with empty required fields shows "N/A" / "No link provided" (the latter on a
  REQUIRED field), giving no signal anything is missing. Final submit still
  blocks, but the UX misleads. (`Step4Review.tsx:21,29`)
- **M5.** Browser Back after in-app stepping exits the flow. `updateStepInUrl`
  uses `replaceState`, so no history entries exist; there is no popstate
  handler. The live "back works" observation came from address-bar navigation
  (fresh mounts), not in-app stepping.
- **M6.** No focus management on step change; step heading is a plain div, no
  aria-live, so screen-reader users get no step-change announcement.
  (`page.tsx:333, 366-372`)
- **M7.** MBTI step is 100 percent admin-configured (Firestore), invisible to
  code review and version control. If the config doc is deleted, Step 3
  silently vanishes and URL step positions shift. (`settings/induction_form`)
- **M8.** `field.type` is ignored everywhere; every non-university field
  renders as a text input, and the editor has no type control. Email/date/tel
  degrade silently with no format validation. (`Step1Personal.tsx:31-42`)
- **M9.** `watch()` with no args re-renders the entire form tree (all mounted
  steps, 50 star divs) on every keystroke. (`page.tsx:190`,
  `Step4Review.tsx:11`)
- **M10.** In-place `fields.sort()` in `Step4Review.tsx:18` mutates the
  parent's `dynamicFields` state during render. Benign today, latent bug.
- **M11.** Duplicate submit is data-safe (doc ID = uid) but resubmission
  hardcodes `status:'pending'`, silently reverting an admin's approve/reject.
  (`page.tsx:~243`)
- **M12.** Silent early return when `user.email` is missing (phone-auth
  users): enabled Submit button does nothing, zero feedback. (`page.tsx:232`)
- **M13.** `onError` toast names no step or field; with URL-skippable steps,
  users landing on Review via `?step=5` get no guidance where to go back to.
- **M14.** Duplicate-submission guard fails open: the existence check's catch
  swallows read failures and renders the form anyway. (`page.tsx:73-75`)
- **M15.** Step-gap configs mislabel steps: the loop skips empty steps but
  titles use raw config step numbers, so "Step 2" can show step-3 content.
- **M16.** Tag remove X is mouse-only (bare svg onClick, no role/label) and
  12px, failing WCAG target size. (`tag-input.tsx:36-39`)
- **M17.** Error text `text-red-500` is 3.76:1 on white, failing WCAG AA in
  light mode.
- **M18.** University search input has an empty accessible name (cmdk label
  prop never passed); required asterisks have no sr text; errors lack
  aria-describedby. (`UniversityAutocomplete.tsx:78-79`)
- **M19.** Dormant `stepNames[3]`/`stepNames[4]` ("Technical Questions",
  "Additional Info") silently activate if an admin adds step-3/4 fields,
  growing the flow without warning.
- **M20.** 25s trailing autosave debounce resets per keystroke, so continuous
  typing never autosaves and there is no `beforeunload` flush.
  (`use-autosave.ts:50`)
- **M21.** `users/{uid}` is read twice (loader + draft autofill) with no
  dedup; `settings` read twice (`induction_form` + `induction_metadata`).
- **M22.** Dead code: `GoogleDriveUpload.tsx` (276 lines, imported once, never
  rendered; its active path uses `window.prompt`), unused `AuthForm` import in
  `page.tsx:10` (bloats the route chunk), unused `watch`/`selectedFileName` in
  `Step3Portfolio`.
- **M23.** Magic-string coupling: `field.name === 'university'` is the only
  trigger for the autocomplete; an admin renaming the key silently downgrades
  it to a text input. (`Step1Personal.tsx:31`)

---

## PART E: Decisions needed from Zubair (do not guess)

1. **Login requirement:** code gates the form behind login; earlier tests
   assumed public. Should induction require login, or be publicly fillable?
2. **Step 2 optionality:** every default and the admin config say optional.
   Should skills/interests stay optional?
3. **Step locking:** direct `?step=N` URL access skips validation; submission
   stays safe via full-schema validation. Allow skipping or enforce sequence?
4. **Out-of-range `?step`:** fall back to step 1, clamp to last step, or show a
   proper error? (Currently crashes.)
5. **Rejected applicants:** `hasApplied` stays true forever with no re-apply
   path unless an admin purges. Should rejected applicants be able to re-apply?
6. **Canonical Step 1 schema:** 5-field student set or 8-field public set?
   Lock it in and stop ad-hoc config edits.
7. **Drafts:** add the owner-scoped Firestore rule, or remove autosave code?
8. **Anonymous submit test:** the earlier happy-path test ran under a saved
   session, so its "no auth wall" conclusion is void. Re-run in a clean
   profile if anonymous behavior matters; do NOT click Submit with test data
   casually, it would create a real application record.

---

## Appendix: per-track file index

| Track | Focus | Key files |
|---|---|---|
| 1 | Auth gate | `src/app/induction/page.tsx:47-50,136`, `src/firebase/user-provider.tsx`, `src/components/layout/header.tsx:259` |
| 2 | Step routing | `src/app/induction/page.tsx:170-171,294-336,356` |
| 3 | Slow config load | `src/app/induction/page.tsx:57-125`, `src/firebase/user-provider.tsx:100-180` |
| 4 | Dynamic schema | `src/app/induction/page.tsx:96-119` |
| 5 | University autocomplete | `src/components/induction-stepper/UniversityAutocomplete.tsx`, `src/hooks/use-universities.ts` |
| 6 | Step 1 component | `src/components/induction-stepper/Step1Personal.tsx` |
| 7 | Step 2 component | `src/components/induction-stepper/Step2Skills.tsx`, `src/components/ui/tag-input.tsx` |
| 8 | Step 3 portfolio | `src/components/induction-stepper/Step3Portfolio.tsx`, `GoogleDriveUpload.tsx` (dead) |
| 9 | Step 4 review | `src/components/induction-stepper/Step4Review.tsx` |
| 10 | Submit handler | `src/app/induction/page.tsx:231-284` |
| 11 | Duplicate guard | `src/app/induction/page.tsx:58-75,250-262`, `firestore.rules` applications/users blocks |
| 12 | Autosave | `src/hooks/use-autosave.ts`, `src/app/induction/page.tsx:192-229` |
| 13 | Draft load/autofill | `src/app/induction/page.tsx:192-227` |
| 14 | Firestore rules | `firestore.rules` (drafts missing; applications create; privileged fields) |
| 15 | Validation UX | `src/app/induction/page.tsx:184-187,323,358`, `Step3Portfolio.tsx:31` |
| 16 | Theme persistence | `src/components/layout/app-client-shell.tsx:71`, `theme-toggle-button.tsx` |
| 17 | Navigation state | `src/app/induction/page.tsx:319-321,356-372` |
| 18 | Accessibility | stepper components, `tag-input.tsx`, `UniversityAutocomplete.tsx:78-79` |
| 19 | Performance | `src/app/induction/page.tsx:190`, `use-autosave.ts`, `starry-background.tsx` |
| 20 | Admin editor | `src/components/admin/applications/induction-form-editor.tsx:76-79` |
