# PLAN GF: Verification hooks (commission accrual, stock, escrow, credits)

Build group GF, spec step 7 (BUILD_SPEC.md Section 10 step 7), plus the
delivery, refund, cancel, and claim side effects GF owns for spec
Section 5 transitions 2, 3, 6, 7, 8 and Section 2.4 / 2.7.

- Worktree: `~/workspace/vendor_shop/wt-gf`, branch `feat/vs-gf`.
- Base: `b1ae3281dadbb2c9c70aefbf0f32c7bc26efa994` (verified with
  `git rev-parse HEAD` in the worktree, 2026-10-31). Every file and
  line citation below is from that tree.
- Design verifier pass only. No code was modified. No jest, tsc, or
  build was run. Production Firestore reads spent: 0. Every runtime
  read this plan introduces is a bounded single-document get, plus
  two bounded queries that already have precedent (named where used).
- Skills applied by name: `local-owasp-security-check` (server-side
  authorization on every new route, fail-closed money inputs, no
  client-supplied amounts or timestamps), `local-systematic-debugging`
  (root-cause tracing of the completion path before specifying any
  hook; the reads-before-writes trap in Section 3 was found by
  tracing `decideMoneyApproval`, not guessed),
  `supabase-postgres-best-practices` (mirror shape awareness only:
  the `fs_<collection>` tables are jsonb document mirrors, so a
  mirrored ledger entry keeps document id = orderId as its key and
  needs no relational redesign; see Section 8).

## 0. The one paragraph that governs everything

Money counts only when a checker who is not the maker approves a
money approval request. At base that completion happens in exactly
one place on the Firestore path: `decideMoneyApproval` in
`src/lib/finance/money-approval.ts`, which runs `applyChange` inside
the same Firestore transaction as the decision stamp. GF therefore
puts the verification and refund effects INSIDE `applyChange`, in
that transaction, and nowhere else. No GF effect ever runs at maker
raise time, at order creation, or in any UI handler. A second,
complete writer exists when the finance surface is Supa-primary
(the SQL function in Section 8); that path is a launch gate, not a
footnote.

## 1. Real hook points at b1ae3281 (evidence)

### 1.1 The completion engine: `src/lib/finance/money-approval.ts` (959 lines)

| Fact | Evidence |
|---|---|
| Maker creates a request only; nothing about the order changes | `createMoneyApprovalRequest` at line 197; it writes one `money_approvals` doc plus a `MONEY_APPROVAL_REQUESTED` audit row in a batch (lines 338 to 347) |
| Verify and Mark Paid are the same completion | `createOrConsumeMoneyApprovalRequest` at line 402; comment at lines 351 to 358 names `order_verify_payment` and `order_mark_paid` as one consumable request family |
| Checker decision entry point | `decideMoneyApproval` at line 751; HTTP adapter is `POST /api/admin/finance/approvals/decide` (`src/app/api/admin/finance/approvals/decide/route.ts:27`) |
| Checker permission, maker not equal checker, stale check | `decideMoneyApproval` body: permission check, self-check denial with its own audit row (422, code `MAKER_EQUALS_CHECKER`), then the stale-snapshot check at line 880 (`deepEqual(snapshotFor(...), req.beforeSnapshot)`, 409 on mismatch) |
| The stale snapshot does NOT cover stock or vendor fields | `snapshotFor` at lines 98 to 117: for order targets it snapshots only `status`, `paymentStatus`, `total`, `totalPkr`, `amount`, `isDeleted`. A stock correction therefore does NOT invalidate a pending request. This is load-bearing for the stock-block design in Section 3 |
| Request-time validation does not check stock, and must not start | `validateOrderTransition` at lines 157 to 189: verify types require status `pending_verification` and payment not `completed`; refund requires payment `completed`. Called at request creation (line 291) |
| The apply step is one transaction | `decideMoneyApproval`, lines 903 to 941: `db.runTransaction(...)` re-reads the request and the target inside the transaction, calls `applyChange(ctx)`, writes the finance audit row, and stamps the request `approved_applied`, all in that one transaction |
| Apply dispatch | `applyChange` at line 560; verify cases at lines 566 to 573 call `applyOrderVerify(ctx, withSeatEffects)` |
| Verification writes today | `applyOrderVerify` at lines 481 to 558: order update to `verified` / `completed` (lines 488 to 497), event registration mirror when seat effects apply, one income draft in `ledger_entries` priced from `totalPkr` (lines 508 to 543, note: `totalPkr`, delivery included, and this is the society income ledger, NOT the commission ledger), one `finance_receipts` record (lines 546 to 558) |
| Refund writes today | `applyChange` case `order_refund`, lines 577 to about 610: order `paymentStatus` to `refunded`, order `status` to `refunded` only when the order was not `shipped` or `delivered` (line 579, `fulfilled` check), plus a reversal draft in `ledger_entries` when a posted income entry exists; that lookup is a bounded db-level query (`limit(1)`, lines 586 to 591) executed outside the transaction object, which is the precedent GF's credit-restore query follows |
| Failure semantics of the apply transaction | `decideMoneyApproval` catch block, lines 943 to 957: a `MoneyApprovalError` is rethrown as-is (the transaction has aborted, so the request stamp inside it never landed and the request stays `pending`); any other error stamps the request `apply_failed` and returns 500. The `GATE_NOT_SATISFIED` code (used by the `crm_status_active` arm, line 697) is the in-file precedent for "throw a coded `MoneyApprovalError` from inside the apply step and leave the request pending on purpose" |
| Errors reach the admin as status, message, and code | `financeErrorResponse` in `src/lib/server/finance-http.ts:38-49` returns `{ error: message, code }` with the error's HTTP status. A coded 422 thrown by GF is therefore visible to the checker in the Finance queue response with no new plumbing |
| The Supa-primary decide path bypasses all of the above | `decideMoneyApproval` lines 764 to 848: when `financePrimaryEnabled()` is true, the whole decision, including the apply step, runs in the Postgres function `tx_finance_decide_money_approval`; `applyChange` never executes. Gate definition: `src/lib/finance/supa/primary.ts`, `financePrimaryEnabled()` = `isSupaPrimary('finance')` plus a configured client; default OFF (flags law in `src/lib/supa/flags.ts:22-42`). SQL apply arms: `src/lib/supa/sql/tx_finance_decide_money_approval.sql`, verify arm at its lines 304 to 371, refund arm at lines 372 to about 395 |

### 1.2 Order shape and pricing inputs GF consumes

| Fact | Evidence |
|---|---|
| No GF field or collection exists at base | Whole-tree grep at b1ae3281: zero hits for `commission_ledger`, `store_credits`, `group_buys`, `vendor_payouts` in `src/`. GA (step 1) creates the fields and collections; GE (step 6) writes them on orders. GF consumes, never invents, that shape (Dependencies D1, D2) |
| `normalizeOrder` drops every new field | `src/lib/finance/order-canonical.ts:98-163` returns a fixed field set with no `vendorId`, `subtotalPkr`, `groupBuyId`, `escrowStatus`, or `creditAppliedPkr`. GF appliers therefore read the RAW `ctx.targetData` map (which `decideMoneyApproval` reads fresh inside the transaction), never the normalized order, for GF fields. `normalizeOrder` stays in use for the existing writes only |
| Order type today | `src/types/store.ts:30-88`: status enum at line 49, payment enum at line 51, `items[]` with `productId`, `quantity`, `subtotal` at lines 22 to 28, top-level `productId` at line 81. GA extends this type; GF reads `items` for the stock product and quantity (Section 5.1 step V2) |
| Stock is decorative at base | STORE_AUDIT.md Section 2, confirmed by grep: no order path reads or writes `products.stock`. `Product.stock` is `src/types/store.ts:10` |
| Server pricing is fail-closed and already exists | `src/lib/server/store-pricing.ts`, used by `createOrder` (`src/app/actions/store.ts:67`) and `POST /api/store/orders`. GF never prices anything; it reads `subtotalPkr` that GE's server pricing wrote |

### 1.3 The delivery and cancel surface at base (the bypass GF must close)

| Fact | Evidence |
|---|---|
| The generic orders PATCH allows `delivered` and `cancelled` as plain status writes | `src/app/api/store/orders/route.ts:534` (`allowedStatuses`), with only `status` and `fulfilmentNote` writable (line 538, `NON_MONEY_FIELDS`) |
| That PATCH cannot set `deliveredAt`, courier fields, or any GF effect, on either write arm | Firestore arm is a plain batch update (lines 605 to 648); Supa-primary arm calls `patchStoreOrderViaPrimary` (lines 549 to 568), whose SQL function takes only explicit scalar status and fulfilmentNote parameters (`src/lib/supa/sql/tx_store_order_patch.sql:36-37, 61-65`) |
| The admin UI calls that PATCH for delivered | `src/app/admin/store/components/order-management.tsx:404` (`handleStatusUpdate`), invoked for delivered at lines 1130 and 1167 |
| Money states are already fenced off from that PATCH | `route.ts:519-531`: money fields or a transition into `verified`, `refunded`, or `soft_deleted` get a 409 pointing at the approvals flow. GF's guard extends this exact block, in the same place, for the two fulfilment transitions that carry money effects on vendor orders |
| No buyer cancel path exists at base | Grep for `cancelled` writes: only the orders PATCH above. Spec transition 2's "buyer or admin" therefore lands, in the pilot, as: admin action plus GH's expiry sweep, both through the GF helper (Choice C9) |
| No claim flow, no group code, no vendor surface exists at base | STORE_AUDIT.md Sections 4, 7, 10 (gaps 6, 10); grep confirms no `group_buys` or claim code. GG builds the surfaces; GF builds the helpers and three thin admin routes (Section 6) |

### 1.4 Test harness at base

| Fact | Evidence |
|---|---|
| A fake Firestore with transactional buffering already exists | `src/lib/finance/__tests__/fake-firestore.ts`: `createFakeFirestore` at line 62, `runTransaction` at line 181. Its transaction buffers writes and applies them only when the callback resolves; a throw discards them, so "applies the change, or none on injected failure" is provable in unit tests |
| The existing decide-level test pattern to copy | `src/lib/finance/__tests__/money-approval.test.ts`: jest mocks for `firebase-admin/firestore` `FieldValue` (lines 13 to 18) and for `@/lib/server/permissions` (lines 31 to 42), seeded orders, assertions on order state, `ledger_entries`, `finance_receipts`, and audit actions (case 6, lines 96 to 120) |
| One limitation of the fake | Its `tx.get` reads the live store and it does NOT enforce Firestore's reads-before-writes rule. Ordering discipline (Section 3.3) is therefore pinned by construction and by acceptance code-reading, not by a fake test. Named here so nobody claims a test proves it |
| Rules pattern for server-only collections | `firestore.rules:1777-1781` (`ledger_entries`: signed-in finance read, `allow write: if false`, server-only via Admin SDK). GF's collections follow it (Dependency D1) |

## 2. Files GF creates and modifies (exact list)

Created:

1. `src/lib/server/vendor-money.ts`: standalone transition helpers
   (delivery, pre-verification cancel, claim flag), the pure money
   math, the payout-eligibility predicate, the PATCH guard predicate,
   and `VendorMoneyError`. It imports nothing from
   `money-approval.ts`, so there is no import cycle.
2. `src/app/api/admin/store/orders/[id]/deliver/route.ts`: thin
   admin adapter over `deliverVendorOrder` (Section 6.2).
3. `src/app/api/admin/store/orders/[id]/cancel/route.ts`: thin
   admin adapter over `cancelPreVerificationOrder`.
4. `src/app/api/admin/store/orders/[id]/claim/route.ts`: thin
   admin adapter over `setReturnClaimFlag`.
5. Test files in Section 9.

Modified:

1. `src/lib/finance/money-approval.ts`: two surgical insertions:
   a prepare step and a write step inside the `order_verify_payment`
   / `order_mark_paid` cases of `applyChange` (lines 566 to 573),
   and the same pair inside the `order_refund` case (lines 577 to
   about 610). It imports ONLY the pure functions and types from
   `vendor-money.ts` (one-way import; the tx-scoped appliers live in
   this file because they need the file-local `ApplyCtx` type and
   the file-local `MoneyApprovalError` class, exactly as
   `applyOrderVerify` does). No other case, no signature, and
   neither `snapshotFor` nor `validateOrderTransition` changes.
2. `src/app/api/store/orders/route.ts`: one guard block inside
   `PATCH`, immediately after the existing money-field guard
   (lines 519 to 531) and before the Supa-primary branch (line 549),
   so it governs both write arms. It uses the exported guard
   predicate from `vendor-money.ts` (Section 6.4).
3. `src/lib/supa/sql/tx_finance_decide_money_approval.sql`: ONLY
   if Choice C2's launch gate fails (finance primary ON). Conditional
   work, specified in Section 8, not part of the default build.

Not touched by GF: checkout and order creation (GE), the vendor
role and vendor CRUD (GB), catalogue and pages (GD), the vendor
surface and payout draft endpoint (GG), `group_buys` writes (GH),
`firestore.rules` and collection registration (GA; GF's requirement
is Dependency D1), `snapshotFor`, `validateOrderTransition`, the
maker-side approvals route (`src/app/api/admin/finance/approvals/route.ts`).

## 3. CHOICE C1 (first, because everything depends on it): how the stock block surfaces

Spec Section 7 rule 2 and test S2: at verification, if stock cannot
cover the order, verification fails loudly, names the product and
the order, and the order stays `pending_verification`.

### 3.1 The design

1. The GF prepare step for the verify cases runs INSIDE
   `decideMoneyApproval`'s existing transaction, before any write
   (Section 5.1). It re-reads the product with `tx.get`.
2. On insufficient stock it throws
   `new MoneyApprovalError(422, <message>, { code: 'STOCK_INSUFFICIENT' })`
   from inside the transaction callback.
3. Throwing aborts the transaction. Every staged write is discarded
   together: the order update, the society income draft, the
   finance receipt, the commission accrual, and the request's
   `approved_applied` stamp, which is written inside the same
   transaction (Section 1.1). Nothing partial can exist.
4. The catch block (lines 943 to 957) rethrows a `MoneyApprovalError`
   untouched. The `apply_failed` stamp is written only for
   non-`MoneyApprovalError` failures, so the approval request is
   NOT burned: it stays `pending`, with maker, snapshot, and expiry
   unchanged. This reuses the file's own `GATE_NOT_SATISFIED`
   precedent (line 697) for "coded refusal inside apply, request
   deliberately left pending".
5. `POST /api/admin/finance/approvals/decide` maps the error through
   `financeErrorResponse` (`src/lib/server/finance-http.ts:38-49`),
   so the checker receives HTTP 422 with
   `{ error: <message>, code: 'STOCK_INSUFFICIENT' }`. The message
   text (admin-facing, plain words, no em dashes, names both ids):

   `Cannot verify order <orderId>: product "<productName>" has <stock> in stock and this order needs <quantity>. The order stays pending verification. Correct the stock after a physical count, or refund the order through the approvals flow.`

6. Recovery needs no new request and no cleanup: the admin corrects
   stock (admin product edit, as today) or counts again, and the
   SAME checker, or any other checker, approves the SAME pending
   request. The stale-snapshot check cannot block this, because
   `snapshotFor` does not snapshot the product at all (Section 1.1).
   Alternatively the maker raises an `order_refund` request and the
   order leaves through the refund path; a pending verify request
   for it then fails its own stale check in the normal way, which
   is existing behaviour, not GF state.

### 3.2 What this design refuses to do

- It does not check stock at request creation. The maker raising a
  request is not a money event; the block belongs at completion,
  and `validateOrderTransition` stays unchanged.
- It does not verify the order and "fix stock later". Verification
  against stock that does not exist is the exact failure spec
  Section 7 rule 2 bans.
- It does not mark the request `apply_failed`, reject it, or expire
  it. Any of those would corrupt the approval state: the maker
  would have to re-raise, the audit trail would show a decision
  that never happened, and S2's "order stays pending_verification"
  would be met while the approval silently died.
- It does not run as a pre-check in the decide route or in the UI.
  A pre-check races with the transaction; the read that decides
  must be the transactional read.

### 3.3 The reads-before-writes rule (the trap inside this design)

Firestore transactions require every `tx.get` to execute before the
first `tx.set` or `tx.update` in the same transaction; a `tx.get`
after a write throws a plain `Error`, which the catch block would
turn into `apply_failed` plus 500, burning the request for a
programming mistake. `applyOrderVerify`'s first write is its order
`tx.update` (line 497). Therefore, in both edited cases of
`applyChange`, the order of calls is fixed:

1. `const prep = await prepareVendorVerification(ctx)` (verify) or
   `await prepareVendorRefund(ctx)` (refund): performs ALL GF
   `tx.get` reads (product, vendor, commission ledger entry,
   adjustment entry, consumed credit docs) and ALL throws. No
   writes.
2. The existing case body runs unchanged (`applyOrderVerify(...)`
   for verify; the existing order update and reversal-draft logic
   for refund).
3. `writeVendorVerification(ctx, prep)` or
   `writeVendorRefund(ctx, prep)`: writes only, no reads, no
   throws except assertion failures.

The refund case's existing db-level query for a posted
`ledger_entries` entry (lines 586 to 591) is a database read, not a
transaction read, and is unaffected by this rule; GF's credit query
follows the same pattern (query first, then `tx.get` each returned
ref inside the prepare step, before step 2).

## 4. Money math (exact, shared by every transition)

All in `src/lib/server/vendor-money.ts`, pure, exported for tests.
Money is integer PKR everywhere (spec Section 2 preamble).

```
roundHalfUp(n: number): number          // n >= 0; Math.floor(n + 0.5)
commissionFor(subtotalPkr: number, rate: number):
  { commissionPkr: number, vendorDuePkr: number }
  commissionPkr = roundHalfUp(subtotalPkr * rate)
  vendorDuePkr  = subtotalPkr - commissionPkr
lateCreditFor(subtotalPkr: number): number
  raw       = subtotalPkr * 0.10
  rounded10 = Math.round(raw / 10) * 10   // nearest PKR 10, half up
  amount    = min(500, max(100, rounded10))
isLateDelivery(deliveredAtMs: number, promised: unknown): boolean
```

Commission examples (rate 0.10), pinned by tests in Section 9:
subtotal 1000 gives commission 100, due 900. Subtotal 1055 gives
106 (105.5 rounds up), due 949. Subtotal 999 gives 100, due 899.
Subtotal 250 gives 25, due 225. Subtotal 1 gives 0, due 1.
Subtotal 0 gives 0, due 0 (the entry is still written; a priced
zero product is GE's pricing decision, not GF's to second-guess).

Delivery is never in the base: the base is the order's
`subtotalPkr`, never `totalPkr` (which includes delivery, and which
the existing society income draft correctly uses for its own
purpose). An order whose `totalPkr` is 1200 with `subtotalPkr`
1000 and delivery 200 accrues on 1000. Test M2 pins this exact
case.

Late credit examples (spec Section 2.7), pinned by tests:
subtotal 800 gives 100 (10 percent is 80, rounded 80, raised to the
100 minimum). Subtotal 4000 gives 400. Subtotal 4550 gives 460
(455 rounds to 460). Subtotal 1050 gives 110 (105 rounds to 110).
Subtotal 9999 gives 500 (1000 after rounding, cut to the 500 cap).

`isLateDelivery` rule: `promisedDeliveryDate` names a calendar
date; delivery on that date, Pakistan time, is on time. Formally:
convert the promised value to millis (accepting a Firestore
Timestamp, a `Date`, an ISO string, or a `{ seconds }` shape, the
same tolerance as `toMillis` in `money-approval.ts` lines 718 to
731); take its Asia/Karachi calendar date; the deadline is the end
of that date in Asia/Karachi (UTC+5, no daylight saving); late if
and only if `deliveredAtMs` is after that deadline. Boundary cases
pinned by tests: promised 2026-11-05 and delivered at 23:00 PKT on
2026-11-05 is on time; delivered at 00:30 PKT on 2026-11-06 is
late. A null or unparseable promised date means no credit and no
error (the promise is GE's field; its absence cannot block a
delivery).

## 5. Side effects per transition (ordered step lists)

Conventions for every list: "tx" means the transaction named in the
step; all timestamps written by GF are `FieldValue.serverTimestamp()`
(the file's `tsNow()` pattern), except `deliveredAt` and credit
`expiresAt`, which must be concrete values inside their own step
and are taken from the server clock at call time (Choice C8).
"House order" means `vendorId` is null or absent; every GF step is
skipped for house orders and existing behaviour is byte-identical.

### 5.1 Transition 3: `pending_verification -> verified` (spec Sections 5.3, 7, 2.4)

Hook: `applyChange` cases `order_verify_payment` (line 566) and
`order_mark_paid` (line 569), inside `decideMoneyApproval`'s
transaction. Runs only on checker approval. Never at maker raise.

Prepare step `prepareVendorVerification(ctx)` (reads and throws
only, in this order):

- V1. Read `vendorId` from the raw target data (`ctx.targetData`).
  Absent or null: return null (house order, no GF effects).
- V2. Resolve the stock line: `productId` = the order's top-level
  `productId` if a non-empty string, else the first item's
  `productId`; `quantity` = the sum of `quantity` over items whose
  `productId` matches (a missing item quantity counts as 1). Pilot
  checkout is single-product, quantity 1 (spec Section 1), but the
  sum keeps the code honest if an item list ever carries more. If
  no product id can be resolved: throw `MoneyApprovalError` 422,
  code `VENDOR_ORDER_SHAPE`, message naming the order and stating
  that a vendor order must carry a product before it can be
  verified.
- V3. `tx.get` the product doc. Missing: throw `MoneyApprovalError`
  422, code `PRODUCT_MISSING`, message naming the product id and
  the order id and stating the order stays pending verification.
- V4. Stock check: read `stock` from the product data. If it is not
  a finite number, or `stock < quantity`: throw the
  `STOCK_INSUFFICIENT` error of Section 3.1 (this is the S2 block).
- V5. `tx.get` the vendor doc `vendors/<vendorId>`. Missing, or
  `commissionRate` not a finite number: throw `MoneyApprovalError`
  422, code `VENDOR_RECORD_MISSING`, message naming the vendor id
  and the order. Money never accrues at a guessed rate (fail
  closed, per `local-owasp-security-check` insecure-design rule).
  Vendor `status` is NOT checked: an order taken while the vendor
  was active still completes if the vendor is later paused
  (agreement clause 12, spec Section 3.2 rule 5).
- V6. Read `subtotalPkr` from the raw target data. Not an integer
  or below 0: throw `MoneyApprovalError` 422, code
  `ORDER_SUBTOTAL_MISSING`, message naming the order and stating
  the commission base is missing. GF never derives the base from
  `totalPkr` (delivery would leak into commission) and never from
  item subtotals (a second pricing path). GE's contract to always
  write it is Dependency D2.
- V7. `tx.get` the commission ledger doc `commission_ledger/<orderId>`.
  If it exists: throw a plain `Error` (not a `MoneyApprovalError`),
  message `Commission ledger entry already exists for order <orderId>`.
  A pre-existing entry inside a fresh verification transaction can
  only mean corrupted state, because this transaction is the only
  writer and it is atomic. The plain error takes the existing
  `apply_failed` path (500, request stamped `apply_failed`, loud
  in the audit trail), which is the correct treatment for
  corruption, as opposed to the recoverable stock block. The
  document id = orderId rule (spec Section 2.4) is the idempotency
  guard; this check is what makes a second accrual a loud bug
  instead of a silent overwrite.
- V8. Compute `commissionFor(subtotalPkr, vendor.commissionRate)`
  with the rate copied from the vendor record read in V5, at this
  moment (spec Section 2.4: rate copied at verification).

Existing body (unchanged): `applyOrderVerify` writes the order to
`verified` / `completed`, the event mirror when applicable, the
society income draft, and the finance receipt.

Write step `writeVendorVerification(ctx, prep)` (writes only):

- V9. `tx.set` `commission_ledger/<orderId>` with exactly:
  `id` = orderId, `type` = `accrual`, `vendorId`, `orderId`,
  `salePricePkr` = subtotalPkr, `commissionRate` (the V5 copy),
  `commissionPkr`, `vendorDuePkr`, `state` = `accrued`,
  `payoutId` = null, `createdAt`, `updatedAt`. (Field set is spec
  Section 2.4 plus the `type` field its refund paragraph adds.)
- V10. `tx.update` the product: `stock` = (stock read in V4) minus
  quantity, `updatedAt`. The value is computed from the
  transactional read, so concurrent verifications of the same
  product serialize on the transaction and cannot both spend the
  same unit.
- V11. `tx.update` the order: `commissionLedgerId` = orderId
  (spec Section 2.3), and, for a group order (`groupBuyId` a
  non-empty string), `escrowStatus` = `held` (restated per spec
  Section 5 transition 3; GE set it at creation, GF reasserts it
  now that money is confirmed). Vendor visibility needs no field:
  the status flip in the existing body is the visibility event,
  and GG's vendor query keys on `vendorId` plus status
  (Dependency D3).

Failure behaviour: any V2 to V7 throw aborts the whole decision
transaction; order stays `pending_verification`, payment stays
`pending`, no society draft, no receipt, no accrual, no stock
movement, request stays `pending` (coded `MoneyApprovalError`) or
is stamped `apply_failed` (V7 corruption only). Safe retry: the
full checker decision, unchanged, after the cause is fixed. There
is no partial state to clean up, ever, because there is one
transaction.

Group orders: identical, including accrual (spec Section 5
transition 3). Accrual state is `accrued`, never `payable`, so a
held group entry cannot enter a payout draft (Section 7 contract).

### 5.2 Transition 6: `shipped -> delivered` (spec Sections 5.6, 2.4, 2.7, 6)

Hook: NO existing server path performs this transition with side
effects (Section 1.3). GF owns it as a standalone helper,
`deliverVendorOrder` (signature in Section 6.1), which runs its own
Firestore transaction. GG's vendor fulfilment route and GF's admin
deliver route both call it; the generic orders PATCH is fenced off
from vendor-order deliveries by the guard in Section 6.4 so this
helper is the only road.

Steps inside the helper's transaction (all reads before all
writes, same discipline as Section 3.3):

- D1. `tx.get` the order. Missing: `VendorMoneyError` 404,
  `Order not found`.
- D2. `vendorId` absent or null: `VendorMoneyError` 409, code
  `NOT_VENDOR_ORDER`, message stating the order is not a vendor
  order and the standard status update applies. House deliveries
  keep today's behaviour untouched.
- D3. Status is already `delivered`: return the replay result with
  NO writes (idempotent replay): `alreadyDelivered: true`, ledger
  state and credit read from the existing docs (reads in D5 and D7
  still run, writes are skipped). A double tap, a retried request,
  or vendor-plus-admin both marking delivery therefore produces
  exactly one set of effects and exactly one credit.
- D4. Status is not `shipped`: `VendorMoneyError` 409, code
  `INVALID_TRANSITION`, message naming the order and its current
  status and stating that only a shipped order can be marked
  delivered.
- D5. `tx.get` `commission_ledger/<orderId>`. Missing:
  `VendorMoneyError` 500, code `LEDGER_MISSING` (a verified vendor
  order without an accrual means the Section 5.1 hook did not run;
  fail closed and loud rather than delivering money into a void).
  State is `paid` or `reversed`: 409, code `LEDGER_STATE`. State
  is `payable` while the order is not delivered: 500,
  `LEDGER_STATE` (inconsistent state, human review). Expected
  states here are `accrued` or `held_dispute`.
- D6. Compute the target ledger state: `held_dispute` if the
  order's `returnClaimOpen` is `true` (spec Section 5 transition
  6: payable unless a return claim is open), else `payable`.
- D7. Group orders only: `tx.get` `store_credits/late_<orderId>`
  (the deterministic credit doc id, Choice C5) and evaluate
  `isLateDelivery(now, order.promisedDeliveryDate)` (Section 4).
- D8. Writes: order update with `status` = `delivered`,
  `deliveredAt` = server time at call time, `updatedAt`, and for
  group orders `escrowStatus` = `released`. Ledger update with
  `state` = the D6 result, `updatedAt` (skipped if the state is
  unchanged, which can happen when D5 read `held_dispute` and D6
  also yields `held_dispute`). Late credit, only when D7 says the
  order is a late group order and the credit doc does not exist:
  `tx.set` `store_credits/late_<orderId>` with `id`, `userId` =
  the order's `buyerUserId`, `code` = `LATE-` plus the first 6
  characters of the order id uppercased (Choice C5),
  `amountPkr` = `lateCreditFor(subtotalPkr)`, `sourceOrderId`,
  `groupBuyId`, `state` = `available`, `expiresAt` = delivery
  time plus 90 days, `consumedOrderId` = null, `createdAt`.
  Audit: one `writeFinanceAudit` row in the same transaction
  (`src/lib/server/finance-audit.ts:28`, the same writer
  `decideMoneyApproval` uses), action `ORDER_DELIVERED`, payload
  carrying orderId, vendorId, the ledger state written, and the
  credit id or null.

After the transaction commits (never inside it):

- D9. Group orders only: call GH's team-completion helper,
  `checkGroupBuyCompletion(db, groupBuyId)` (Dependency D4). If it
  throws or is not yet built, log and return
  `teamCompleted: null`; delivery, escrow release, ledger, and
  credit are already correct and committed, and team completion
  is retryable by the next member's delivery or by GH's own
  sweep. A team-state failure must never roll back a delivery.

Failure behaviour: D1 to D7 throws abort the transaction; the
order stays `shipped`, the ledger stays `accrued`, no credit
exists. Safe retry: call the helper again. Replay after success
is D3.

Non-group vendor orders: D7 and D9 are skipped; no credit is ever
issued for a non-group order, however late (spec Section 2.7 is a
group-buy rule, and spec Section 5 transition 6 scopes the credit
to group orders).

### 5.3 Transitions 7 and 8: `verified` / `processing` / `delivered -> refunded` (spec Sections 5.7, 5.8, 2.4, 7 rule 4)

Hook: `applyChange` case `order_refund` (line 577), inside the
same decision transaction. The refund request itself is raised
through the existing approvals route with target type
`order_refund` (reason mandatory, per `REASON_REQUIRED` in
`money-approval.ts` lines 74 to 78); GF adds effects only.

Prepare step `prepareVendorRefund(ctx)` (reads and throws only):

- R1. House order (`vendorId` absent): return null; the existing
  refund body runs alone, byte-identical to base.
- R2. `tx.get` `commission_ledger/<orderId>`. Missing: throw a
  plain `Error`, message `Vendor order <orderId> refunded without a commission ledger entry`.
  Rationale (Choice C6): a vendor order's payment can only be
  `completed` if Section 5.1 ran, so a missing entry is corrupted
  state; the refund must fail loudly into `apply_failed` for
  human repair, never silently skip the money reversal.
- R3. Resolve product id and quantity exactly as in V2. `tx.get`
  the product. If the product doc is missing, record
  `productMissing: true` in the prep and continue (Choice C7):
  a refund of real money must not be held hostage by a deleted
  product record; the stock restore is skipped and the skip is
  written into the audit payload of the decision (step R8).
- R4. Credit restore set: query `store_credits` where
  `consumedOrderId` == orderId and `state` == `consumed`, limit
  50 (bounded; a pilot order consumes a handful of credits at
  most). This is a db-level query following the refund arm's own
  precedent (lines 586 to 591). Then `tx.get` each returned ref;
  keep only docs still `consumed` with `consumedOrderId` equal to
  this order. GE's consumption contract (state `consumed`,
  `consumedOrderId` set, order's `creditAppliedPkr` the sum) is
  Dependency D2; this restore key is the exact inverse.
- R5. If the ledger entry's state is `paid`: `tx.get`
  `commission_ledger/adj_<orderId>` (the deterministic adjustment
  id, Choice C4) and record whether it already exists.

Existing body (unchanged): order payment and status updates, and
the society `ledger_entries` reversal draft when a posted income
entry exists.

Write step `writeVendorRefund(ctx, prep)` (writes only):

- R6. `tx.update` the commission entry: `state` = `reversed`,
  `updatedAt`. This applies whatever the prior state was
  (`accrued`, `payable`, `held_dispute`, or `paid`), per spec
  Section 2.4 (`reversed` on refund).
- R7. Refund after payout only (prior state `paid`, and the
  adjustment doc does not already exist): `tx.set`
  `commission_ledger/adj_<orderId>` with `id` = `adj_<orderId>`,
  `type` = `adjustment`, `vendorId`, `orderId`,
  `salePricePkr` = the original entry's `salePricePkr` negated,
  `commissionRate` = the original rate, `commissionPkr` negated,
  `vendorDuePkr` negated, `state` = `payable` (so GG's
  payable-only draft rule picks it up into the next draft, which
  is what spec Section 2.4 orders), `payoutId` = null,
  `adjustmentFor` = orderId, `createdAt`, `updatedAt`. Spec names
  only the negative `vendorDuePkr`; the negated sale and
  commission keep GG's draft sums (gross, commission, net)
  consistent to the rupee (Choice C4).
- R8. Stock restore: when the product exists, `tx.update` it with
  `stock` = (stock read in R3) plus quantity, `updatedAt`. Runs
  for both transition 7 (pre-dispatch) and transition 8
  (delivered, defective return), per spec's "same side effects".
  When `productMissing`, no stock write; the decision's audit
  payload gains `stockRestoreSkipped: 'product_missing'` (GF adds
  this key by extending the payload the refund case contributes;
  if the implementer finds the audit payload is built only in
  `decideMoneyApproval` from `changePayload`, the fallback is a
  `console.error` plus a field `stockRestoreSkippedAt` stamped on
  the order in this step; either way the skip is recorded, never
  silent).
- R9. Order update: for group orders, `escrowStatus` = `refunded`.
  (`commissionLedgerId` already points at the entry.)
- R10. Credit restore: for each doc kept in R4, `tx.update` with
  `state` = `available`, `consumedOrderId` = null, `updatedAt`.
  Restore runs even when the order's `creditAppliedPkr` is 0 or
  absent; the query result, not the order field, is the truth,
  so a shape drift in the order cannot strand a buyer's credit.

Failure behaviour: an R2 throw aborts the decision transaction;
the order keeps its prior status and `completed` payment, the
ledger entry keeps its prior state, stock and credits are
untouched, and the request is stamped `apply_failed` for human
repair. All other steps cannot throw by construction (reads were
in prepare). Safe retry after repair: a NEW refund request (the
failed one is terminal, as with every `apply_failed` today). A
second refund of an already refunded order cannot be raised:
`validateOrderTransition` requires payment `completed` (line 177
to 180), so double reversal and double stock restore are
structurally impossible through this path.

Group expiry (spec Section 6 step 4, test G3): GH raises one
`order_refund` per paid member order; this arm is the whole of
GF's part. The entry was `accrued` (never delivered, never
payable), becomes `reversed`; stock returns; consumed credit
returns; escrow becomes `refunded`. Full refund including
delivery is a property of the approvals refund itself (the
existing arm), not of any GF field.

### 5.4 Transition 2: `pending_verification -> cancelled` (spec Section 5.2)

Hook: helper `cancelPreVerificationOrder` (Section 6.1), called
by GF's admin cancel route and directly by GH's expiry sweep.
No ledger entry can exist yet (accrual happens only at
verification), and no stock has moved (decrement happens only at
verification), so the only GF effect is credit restore. Steps
inside the helper's transaction:

- X1. `tx.get` the order. Missing: 404.
- X2. Status already `cancelled`: return
  `{ alreadyCancelled: true }` with no writes (idempotent replay;
  the GH sweep may run twice).
- X3. Status not `pending_verification`: `VendorMoneyError` 409,
  code `INVALID_TRANSITION`. Verified-or-later orders leave only
  through the refund approvals path; this helper must never
  become a side door around maker-checker.
- X4. Find consumed credits exactly as in R4 (bounded query, then
  `tx.get` each, keep those still consumed by this order).
- X5. Writes: order `status` = `cancelled`, `updatedAt`; each
  kept credit back to `available` with `consumedOrderId` = null;
  one `writeFinanceAudit` row, action
  `ORDER_CANCELLED_PRE_VERIFICATION`, in the same transaction.
- X6. Return `{ orderId, groupBuyId, creditsRestored }`. Freeing
  the team seat (removing the order from `memberOrderIds`) is
  GH's write on GH's collection; GF returns the ids GH needs and
  never edits `group_buys` (Dependency D4).

The generic orders PATCH fence for cancellations is in
Section 6.4: a plain vendor order with no consumed credit and no
team may still be cancelled through the PATCH exactly as today
(nothing GF owns has moved); an order with consumed credit or a
team may not, because those effects live only in this helper.

### 5.5 Claim flag: ledger `payable <-> held_dispute` (spec Sections 2.4, 5.6, test M7)

The pilot has no in-code claim flow (spec Section 1, out of
scope; STORE_AUDIT gap 10). The smallest honest surface
(Choice C3): one GF helper, `setReturnClaimFlag`, one GF admin
route, and one pair of buttons in GG's Store Orders detail.
M7's wording "open a return claim (admin note)" cannot by itself
flip a ledger state in code, so the button is the pilot surface
and the approval note remains the human record.

Helper steps, inside its own transaction:

- F1. `tx.get` the order (404 if missing) and `tx.get`
  `commission_ledger/<orderId>` (may legitimately not exist).
- F2. No-op check: the order's `returnClaimOpen` already equals
  the requested value AND the ledger is already in the state F3
  would produce: return `{ changed: false }`, no writes.
- F3. Writes: order `returnClaimOpen` = the requested boolean,
  `updatedAt`. Ledger, only when an entry exists: on open,
  `payable` becomes `held_dispute`; `accrued` stays `accrued`
  (the flag on the order makes Section 5.2 step D6 route the
  eventual delivery to `held_dispute`); `paid` and `reversed`
  never move (money already left or already reversed; a late
  claim on a paid order is a refund decision, not a hold). On
  close, `held_dispute` becomes `payable` (reachable only for
  delivered orders, the only way an entry enters `held_dispute`);
  every other state is unchanged. One `writeFinanceAudit` row,
  action `ORDER_RETURN_CLAIM_OPENED` or
  `ORDER_RETURN_CLAIM_CLOSED`, same transaction.
- F4. Return `{ orderId, claimOpen, ledgerState, changed }`.

The order field `returnClaimOpen` is GF's one requested addition
to GA's Section 2.3 field list (Dependency D1). Default absent
means no claim, so every read treats absence as `false`.

### 5.6 What GF deliberately does not do at any transition

- No accrual, decrement, or credit at maker raise, at order
  creation, or in any client code. If it is not inside a checker
  completion or a GF helper transaction, it does not exist.
- No payout state writes. Entries become `paid` only in GG's
  payout completion (spec Section 8 step 5); GF reads that state
  (R5) and never writes it.
- No edits to `group_buys`, `vendor_payouts`, `vendors`, or
  `products` outside the stock updates named above.
- No changes to house orders on any path (prepares return null,
  helpers refuse with a named 409, the PATCH guard passes them
  through).

## 6. Helper signatures (the contracts GG and GH consume)

All in `src/lib/server/vendor-money.ts` unless stated. `Firestore`
is the Admin SDK type, as in `money-approval.ts`. Every helper is
server-only, takes every money input from server documents, and
accepts no amount, price, rate, stock, or timestamp from a caller.

### 6.1 Standalone helpers

```ts
export class VendorMoneyError extends Error {
  status: number;          // 404, 409, or 500
  code?: string;           // NOT_VENDOR_ORDER, INVALID_TRANSITION,
                           // LEDGER_MISSING, LEDGER_STATE
}

export interface DeliverOrderResult {
  orderId: string;
  alreadyDelivered: boolean;
  deliveredAt: string | null;        // ISO string when known
  ledgerState: 'payable' | 'held_dispute' | null;
  escrowStatus: 'released' | 'none' | null;
  credit: { id: string; code: string; amountPkr: number } | null;
  teamCompleted: boolean | null;     // null: no team, or GH check unavailable
}
export async function deliverVendorOrder(
  db: Firestore,
  input: { orderId: string; actorUid: string },
): Promise<DeliverOrderResult>;

export interface CancelOrderResult {
  orderId: string;
  alreadyCancelled: boolean;
  groupBuyId: string | null;
  creditsRestored: number;
}
export async function cancelPreVerificationOrder(
  db: Firestore,
  input: { orderId: string; actorUid: string },
): Promise<CancelOrderResult>;

export interface ClaimFlagResult {
  orderId: string;
  claimOpen: boolean;
  ledgerState: string | null;        // entry state after the call, or null
  changed: boolean;
}
export async function setReturnClaimFlag(
  db: Firestore,
  input: { orderId: string; claimOpen: boolean; actorUid: string },
): Promise<ClaimFlagResult>;

// Pure, exported for GG's draft builder and for tests:
export function isLedgerEntryPayoutEligible(
  entry: { state: string; type?: string },
  order: { escrowStatus?: string | null } | null,
): boolean;
// true only when entry.state is 'payable' AND the order is not
// escrow-held. Adjustment entries (type 'adjustment') in state
// 'payable' ARE eligible; that is how a refund after payout is
// recovered from the next payout.
```

GH's helper that GF calls (Dependency D4, GH owns the
implementation):

```ts
// Expected from GH (module path GH's plan names; GF imports it
// lazily inside deliverVendorOrder's post-commit step so a
// missing GH module degrades to teamCompleted: null, never to a
// failed delivery):
export async function checkGroupBuyCompletion(
  db: Firestore, groupBuyId: string,
): Promise<{ completed: boolean }>;
```

### 6.2 GF routes (thin adapters, all admin)

Auth pattern for all three, copied from the orders route
(`src/app/api/store/orders/route.ts:487-505`): Bearer ID token,
then `hasServerPermissionForUser(db, uid, 'canManageStore')`,
else 403. Errors from helpers map by their `status`, with body
`{ error: message, code }`. No route accepts a money field; a
body carrying one is ignored for deliver and cancel, and claim
reads only the boolean named below (mass-assignment guard, per
`local-owasp-security-check`).

| Route | Body | Calls | Success |
|---|---|---|---|
| `POST /api/admin/store/orders/[id]/deliver` | none | `deliverVendorOrder` | 200 with the `DeliverOrderResult` |
| `POST /api/admin/store/orders/[id]/cancel` | none | `cancelPreVerificationOrder` | 200 with the `CancelOrderResult` |
| `POST /api/admin/store/orders/[id]/claim` | `{ claimOpen: boolean }` (non-boolean: 400) | `setReturnClaimFlag` | 200 with the `ClaimFlagResult` |

GG's vendor fulfilment route (`PATCH /api/vendor/orders/[id]`,
GG's file) calls `deliverVendorOrder` directly after its own
Section 3.1 ownership checks when the vendor requests the
delivered transition; it never writes `status: delivered` itself
(Dependency D3). The helper re-reads the order's `vendorId` from
the order document and trusts no caller-supplied vendor id.

### 6.3 The in-transaction appliers (money-approval.ts, GF-internal)

```ts
interface VendorVerifyPrep { /* productRef, stock, quantity,
  productId, vendorId, subtotalPkr, commissionRate, commissionPkr,
  vendorDuePkr, isGroup */ }
async function prepareVendorVerification(ctx: ApplyCtx):
  Promise<VendorVerifyPrep | null>;       // reads + throws only
function writeVendorVerification(ctx: ApplyCtx, prep: VendorVerifyPrep): void;

interface VendorRefundPrep { /* ledgerRef, priorState, vendorId,
  productRef | null, productStock, quantity, creditRefs,
  adjustmentExists, isGroup */ }
async function prepareVendorRefund(ctx: ApplyCtx):
  Promise<VendorRefundPrep | null>;       // reads + throws only
function writeVendorRefund(ctx: ApplyCtx, prep: VendorRefundPrep): void;
```

### 6.4 The PATCH guard predicate (vendor-money.ts, used by the orders route)

```ts
export function vendorPatchGuard(
  orderData: Record<string, unknown>,
  updates: Record<string, unknown>,
): { blocked: true; status: 409; error: string } | { blocked: false };
```

Rules, evaluated in `PATCH /api/store/orders` after the existing
money guard and before both write arms, only when
`updates.status` is `delivered` or `cancelled` (any other PATCH
skips the extra read entirely, so house traffic is unchanged):

- `delivered` and the order has a `vendorId`: blocked. Error:
  `Vendor orders are marked delivered through the delivery action, so commission and store credit are recorded. Use the delivery action for this order.`
- `cancelled` and (`creditAppliedPkr` above 0 or `groupBuyId`
  set): blocked. Error:
  `This order holds store credit or a group seat. Cancel it through the cancel action, so the credit and the seat are released.`
- Otherwise: not blocked; today's behaviour, both arms.

The guard needs the order document: the Firestore arm already
reads it (route lines 605 to 608) and the guard reuses that read
by being placed after it on that arm; on the Supa-primary arm it
costs exactly one single-document get, only for these two status
values. The implementer may restructure the route minimally to
share one read; the contract is the predicate and its placement
before any write, not the route's internal layout.

## 7. Payout-draft inclusion contract (GG builds the draft; this state machine is the contract)

From spec Sections 2.4 and 8 step 5, restated as guarantees GG
may rely on and rules GG must keep:

1. An entry is includable only in state `payable`.
   `isLedgerEntryPayoutEligible` (Section 6.1) is the shared
   predicate; GG's draft builder must use it or reproduce it
   exactly.
2. GF guarantees `payable` is reachable only at delivery
   (Section 5.2) or as a refund adjustment (Section 5.3 R7) or by
   a claim closing on a delivered order (Section 5.5). An
   undelivered order's entry is `accrued` or `reversed`, never
   `payable`.
3. Group escrow: GF sets the ledger state and the order's
   `escrowStatus` to `released` in the same transaction at
   delivery, so `payable` on a group order implies escrow
   released. The predicate still checks the order's escrow state
   as a second lock, per spec Section 6 ("excludes the order's
   ledger entry from every payout draft until the order is
   delivered").
4. `held_dispute` is excluded until the claim closes (Section
   5.5). `accrued`, `paid`, and `reversed` are excluded always.
   Adjustment entries are ordinary `payable` entries with
   negative amounts and are included exactly once (their doc id
   `adj_<orderId>` cannot be written twice; R5 checks existence).
5. Draft sums (GG's arithmetic, GF's data): gross = sum of
   `salePricePkr`, commission = sum of `commissionPkr`, net = sum
   of `vendorDuePkr`, over the included entries. Because refund
   adjustments negate all three fields, a payout that follows a
   refund-after-payout reconciles to the rupee (test M5, M6, E3
   territory; GG's tests own the draft, GF's tests own the entry
   shapes the sums read).

## 8. Supa-primary parity (Choice C2, a launch gate)

When `SUPA_PRIMARY` contains `finance`, `decideMoneyApproval`
delegates the entire decision to
`tx_finance_decide_money_approval`
(`src/lib/supa/sql/tx_finance_decide_money_approval.sql`), whose
verify arm (its lines 304 to 371) writes only the order, the
society income entry, and the receipt into the `fs_` mirrors, and
whose refund arm writes only the order and the reversal draft.
No GF effect exists in that function at base. Turning the flag
on without parity would silently switch off commission accrual,
the stock block, stock restore, and credit restore, while every
surface still looked healthy. That is the worst failure shape
this group can ship.

Decision, in order:

1. Launch gate (default): the coordinator confirms, from the
   deployed environment, that `SUPA_PRIMARY` does not contain
   `finance` before the pilot's first vendor listing. With the
   flag off, the Firestore path in Section 5 is the only writer
   and this plan is complete as written. (The flag's own law,
   `src/lib/supa/flags.ts:37-42`, makes OFF the safe default, and
   the store surface was deliberately parked last in the cutover,
   per STORE_AUDIT.md Section 6.)
2. If the flag is on, or is turned on during the pilot, the SQL
   parity work becomes a blocker owned by the GF implementer
   with finance-owner review, mirroring Section 5 exactly inside
   the SQL function's own transaction: in the verify arm, lock
   the `fs_products` row for the order's product (`for update`,
   the pattern the function already uses for its extra locks at
   its lines 172 to 198), return
   `{ ok: false, httpStatus: 422, code: 'STOCK_INSUFFICIENT', message: <same text as Section 3.1> }`
   before any update when stock cannot cover the order (the
   function's result contract returns business rejections, per
   `src/lib/finance/supa/primary.ts` lines 30 to 40, and the TS
   call site maps that to the same 422 the checker sees today),
   insert the `fs_commission_ledger` row with id = orderId, and
   decrement the mirrored stock; in the refund arm, reverse the
   `fs_commission_ledger` row, write the adjustment row when the
   entry was `paid`, restore mirrored stock, and restore
   mirrored consumed credits. Per
   `supabase-postgres-best-practices`, the mirror tables are
   jsonb document stores, so these are document updates keyed by
   id with row locks, not relational joins; no schema change is
   needed beyond GA's `fs_commission_ledger` and `fs_store_credits`
   mirror tables existing (Dependency D1).
3. The orders PATCH primary arm (`store-orders-api`) needs no
   parity work: GF's guard is TypeScript route code that runs
   before either arm (Section 6.4), and GF's helpers are
   Firestore transactions whose callers (GG vendor route, GF
   admin routes) do not pass through that PATCH.

## 9. Tests (fixtures and mocks only, zero production reads)

Harness for all files: `createFakeFirestore` from
`src/lib/finance/__tests__/fake-firestore.ts`, plus the two jest
mocks copied verbatim from `money-approval.test.ts` lines 13 to
42 (`FieldValue`, `@/lib/server/permissions`). Seeds are inline
documents: a vendor (`vendors/vendor-1`, `commissionRate` 0.10), a
product (`products/prod-1`, name `Test Widget`, stock set per
case), orders in the GE shape (`vendorId`, `subtotalPkr`,
`deliveryPkr`, `totalPkr`, `items: [{ productId: 'prod-1', quantity: 1, price, subtotal }]`,
`buyerUserId`), and, where needed, `commission_ledger`,
`store_credits`, and `group_buys` docs. No test reads a real
collection, a real file outside fixtures, or the network.

### 9.1 `src/lib/finance/__tests__/vendor-verify-hooks.test.ts`

Drives the real `createMoneyApprovalRequest` plus
`decideMoneyApproval`, maker and checker as different uids (the
existing suite's maker and checker fixtures).

| Test name | Maps to | Asserts |
|---|---|---|
| `m1_vendor_verify_completes_only_under_a_different_checker` | M1 | Self-approval is refused (422 `MAKER_EQUALS_CHECKER`, existing behaviour, re-pinned on a vendor order); a different checker's approval returns `approved_applied`, order `verified`, payment `completed` |
| `m2_commission_math_uses_subtotal_and_rounds_half_up` | M2 | Table over subtotals 1000, 1055, 999, 250, 1: entry `commissionPkr` and `vendorDuePkr` match Section 4; the 1200-total case (subtotal 1000, delivery 200) accrues on 1000, proving delivery is excluded; entry `state` is `accrued`, `commissionRate` is the vendor record's 0.10, doc id equals the order id, order's `commissionLedgerId` equals the order id |
| `m2_rate_is_copied_from_the_vendor_record_at_verification` | M2 | Vendor rate changed to 0.2 after the order was created; the entry carries 0.2 and commission to match (rate at verification, not at creation) |
| `s1_stock_decrements_exactly_once_at_verification` | S1 | Stock 5 at order creation and after the maker raises the request (no movement before completion); 4 after checker approval |
| `s2_verification_blocks_loudly_when_stock_cannot_cover` | S2 | Stock 0, pending order: decide rejects with status 422, code `STOCK_INSUFFICIENT`, message containing the product name and the order id; order still `pending_verification` with payment `pending`; approval request still `pending` (not `apply_failed`, not decided); zero docs in `commission_ledger`, `ledger_entries`, and `finance_receipts`; stock still 0 |
| `s2_blocked_request_succeeds_after_stock_correction` | S2 | Continuing the blocked case: stock corrected to 1, the SAME approval id is approved by the checker and applies in full (order verified, entry accrued, stock 0). This is the proof the block corrupts nothing |
| `s2_missing_product_and_missing_vendor_fail_closed` | S2 (edge) | Product doc absent: 422 `PRODUCT_MISSING`, request still pending. Vendor doc absent: 422 `VENDOR_RECORD_MISSING`, request still pending. Neither writes anything |
| `verify_house_order_is_byte_identical_to_base` | regression | Order without `vendorId`: approval applies, society draft and receipt exist, and `commission_ledger` stays empty, product stock untouched |
| `g2_group_order_accrues_and_stays_held_at_verification` | G2 (escrow half) | Group order (`groupBuyId` set, `escrowStatus` `held`): after approval the entry exists in state `accrued`, the order's `escrowStatus` is still `held`, and `isLedgerEntryPayoutEligible` returns false for the pair |

### 9.2 `src/lib/finance/__tests__/vendor-refund-hooks.test.ts`

Same harness; each case first verifies an order through the real
decide path (or seeds the exact post-verification state where the
verify path is not the subject), then raises and approves an
`order_refund` with a reason.

| Test name | Maps to | Asserts |
|---|---|---|
| `s3_refund_restores_stock_and_reverses_the_entry` | S3 | Start stock 5, verify (stock 4, entry `accrued`), refund: stock back to 5, entry `reversed`, order `refunded` with payment `refunded`, no adjustment entry |
| `refund_of_delivered_unpaid_order_reverses_from_payable` | S3 / F2 pair | Entry seeded `payable`, order `delivered`: refund leaves order status `delivered` (existing arm), payment `refunded`, entry `reversed`, stock restored, group order's `escrowStatus` becomes `refunded` |
| `refund_after_payout_writes_one_negative_adjustment` | Section 2.4 rule | Entry seeded `paid` with `payoutId` set: refund sets it `reversed` and creates `commission_ledger/adj_<orderId>` with `type` `adjustment`, all three money fields negated, state `payable`, and `isLedgerEntryPayoutEligible` true for it |
| `refund_restores_consumed_store_credit_exactly_once` | Section 2.7 rule | Two credits seeded `consumed` with `consumedOrderId` = the order, one credit consumed by a different order: refund returns exactly the two to `available` with `consumedOrderId` null; the third is untouched |
| `g3_expired_team_paid_order_refund_carries_full_effects` | G3 (GF halves) | Group order verified but never delivered, entry `accrued`, escrow `held`: refund reverses the entry, restores stock, sets escrow `refunded`; and at no point in the sequence was the entry `payable` or payout-eligible (asserted before and after) |
| `refund_house_order_has_no_commission_effects` | regression | House order refund matches base behaviour (society reversal draft logic unchanged) and writes nothing to `commission_ledger` |
| `refund_of_vendor_order_without_entry_fails_loud` | Choice C6 | Vendor order with payment `completed` and no entry: decide returns 500, the request is stamped `apply_failed`, the order is unchanged |

### 9.3 `src/lib/server/__tests__/vendor-money.test.ts`

Pure math first (no Firestore), then helpers on the fake.

| Test name | Maps to | Asserts |
|---|---|---|
| `commission_math_table` | M2 | The full Section 4 table through `commissionFor` |
| `late_credit_math_table_and_bounds` | Section 2.7 | The full Section 4 table through `lateCreditFor`, including the 100 floor and the 500 cap |
| `late_delivery_boundary_is_pakistan_time` | G4 (rule half) | `isLateDelivery` on the two Section 4 boundary cases, plus a null promised date returning false |
| `f2_delivery_moves_the_entry_accrued_to_payable` | F2 (ledger half) | Shipped vendor order with entry `accrued`: `deliverVendorOrder` returns ledger state `payable`; order is `delivered` with `deliveredAt` set; the entry in the store reads `payable`. (F2's delivery action itself is GG's surface; the state proof is GF's) |
| `delivery_with_an_open_claim_goes_to_held_dispute` | Spec Section 5 transition 6 | Order with `returnClaimOpen: true`: entry becomes `held_dispute`, not `payable` |
| `delivery_replay_is_a_no_op` | idempotency | Second call on a delivered order returns `alreadyDelivered: true` and writes nothing (store contents identical, exactly one credit doc when the first call issued one) |
| `delivery_rejects_wrong_states_and_house_orders` | guard | `processing` order: 409 `INVALID_TRANSITION`. House order: 409 `NOT_VENDOR_ORDER`. Missing accrual: 500 `LEDGER_MISSING`, order still `shipped` |
| `g4_late_group_delivery_issues_one_bounded_credit` | G4 (credit half) | Group order delivered after its promised date: one `store_credits/late_<orderId>` doc, `code` matching `LATE-` plus 6 characters, amount from the Section 4 table for the seeded subtotal, `state` `available`, `expiresAt` 90 days after delivery, order escrow `released`, entry `payable` |
| `g4_on_time_group_delivery_and_late_single_order_issue_no_credit` | G4 | On-time group delivery: no credit doc. Late non-group vendor order: no credit doc |
| `g2_delivery_releases_escrow_and_makes_the_entry_eligible` | G2 (escrow half) | Group order: before delivery the pair is not payout-eligible; after `deliverVendorOrder`, `escrowStatus` is `released`, entry is `payable`, and `isLedgerEntryPayoutEligible` returns true |
| `cancel_restores_credit_and_refuses_later_states` | Transition 2 | Pending order with a consumed credit: cancel returns the credit to `available`, order `cancelled`, result reports the group id; second call returns `alreadyCancelled: true`; a verified order gets 409 and keeps its credit consumed |
| `m7_claim_flag_flips_payable_both_ways_and_spares_other_states` | M7 (state half) | Payable entry: open makes it `held_dispute` and not payout-eligible; close returns it to `payable`. Accrued entry: open records the flag and leaves the state `accrued`. Paid entry: open leaves it `paid`. Repeat open is a no-op with `changed: false`. (M7's draft exclusion is GG's test; the state this test pins is what the draft reads) |
| `patch_guard_blocks_only_the_two_vendor_cases` | Section 6.4 | `vendorPatchGuard` table: vendor order plus `delivered` blocked; credit-or-team order plus `cancelled` blocked; plain vendor order plus `cancelled` allowed; house order plus either allowed; any order plus `shipped` allowed |

Suites that must stay green, unchanged (the regression baseline
pins them): `src/lib/finance/__tests__/money-approval.test.ts`,
`money-approval-consume-pending.test.ts`,
`supa-write-cutover-contracts.test.ts` (it snapshots
`snapshotFor`, which GF does not touch), and the orders route
suites under `src/app/api/store/orders/__tests__/` (the PATCH
guard is additive and its predicate is unit-tested in 9.3).

Known harness limit, restated for the test author: the fake
transaction does not enforce reads-before-writes (Section 1.4),
so no test above can catch a prepare/write ordering mistake.
The acceptance auditor checks the ordering by reading the
`applyChange` diff against Section 3.3.

## 10. Drift versus the audit and the spec

1. Audit line drift: STORE_AUDIT.md Section 4 cites the
   completion writes at `money-approval.ts:483-500` on the audit
   tree (`85c75ccc`). At b1ae3281 `applyOrderVerify` is lines 481
   to 558 and the decide transaction is lines 903 to 941. Same
   code, moved lines. All citations in this plan are b1ae3281.
2. The audit says verification creates "a ledger draft and a
   finance_receipts record" (Section 4). True, and the draft is
   in `ledger_entries`, priced from `totalPkr` with delivery
   included. The spec's commission ledger is a different
   collection (`commission_ledger`), priced from `subtotalPkr`.
   The similar names are a live confusion risk; GF's code and
   tests must never shorten `commission_ledger` to "ledger".
3. The audit says stock "is stored and displayed, but no order
   path reads, checks, or decrements it" (Section 2). Confirmed
   at b1ae3281. GF is the first reader and writer of stock in an
   order path, which is why the block design (Section 3) had to
   be built from the transaction semantics, not copied.
4. Spec Section 5 transition 4 and the vendor surface assume a
   `delivered` write exists somewhere with room for side
   effects. At base the only delivered write is the generic
   PATCH, which cannot carry `deliveredAt` or any effect on
   either of its two write arms (Section 1.3). GF's helper plus
   PATCH guard is the correction; without the guard, the admin
   UI's existing Delivered buttons (order-management.tsx lines
   1130, 1167) would silently bypass commission release, escrow
   release, and late credit for the whole pilot.
5. Spec Section 2.3 lists order fields as additions "at order
   creation". None exist at base, and `normalizeOrder` would
   drop them even if they did; GF's raw-map reads (Section 1.2)
   are the workaround inside the finance file, and GA's type
   work does not remove the need for them there.
6. Spec Section 11 test M7 says a return claim is opened "by
   admin note". A note cannot move a ledger state; Section 5.5
   is the smallest code surface that makes M7 passable, and the
   difference is recorded as Choice C3 for the founder, per spec
   Section 12's own convention.
7. Spec Section 6 expiry says a pending member order is
   `cancelled` and a verified one is refunded, in one step. At
   base neither a sweep nor a cancel helper exists; GF supplies
   the cancel half as a reusable helper (Section 5.4) and the
   refund half already exists as the approvals path GF extends
   (Section 5.3). GH owns the sweep and the sequencing.
8. The finance Supa-primary path (Section 8) postdates the
   audit's "Firestore is the live primary for products and
   orders" (audit Section 6): orders still are, but finance
   decisions have a complete second writer behind a flag. The
   spec does not mention it. GF surfaces it as a launch gate
   rather than designing against a writer the spec never named.

## 11. CHOICE and DEPENDENCY register

Choices (GF decides, founder can overrule; spec silent or
spec-loose on each):

- C1. Stock block surfacing: a coded `MoneyApprovalError` (422,
  `STOCK_INSUFFICIENT`) thrown inside the decision transaction,
  leaving the request pending for a same-request retry after a
  stock correction. Full design in Section 3. This is the
  group's hardest design point and the one the acceptance
  auditor should attack first.
- C2. Finance Supa-primary: launch gate by default (flag must be
  off for `finance`), SQL parity as blocking conditional work if
  it is on. Section 8.
- C3. Claim surface: GF helper plus GF admin route plus GG
  buttons, instead of M7's literal "admin note" (which cannot
  change state). Section 5.5.
- C4. Adjustment entry shape: doc id `adj_<orderId>`, state
  `payable`, all three money fields negated, `adjustmentFor`
  set. Spec Section 2.4 names only the negative `vendorDuePkr`
  and "into the next payout draft"; the rest is the minimum that
  keeps GG's draft sums consistent.
- C5. Credit identity: doc id `late_<orderId>` (the idempotency
  key), `code` = `LATE-` plus the first 6 characters of the
  order id, uppercased. Spec Section 2.7 shows the code's shape
  (`LATE-<short id>`) and no doc id rule.
- C6. Refund of a vendor order whose commission entry is
  missing fails the whole refund loudly (`apply_failed`), rather
  than skipping the reversal. Money integrity over refund
  convenience; the state is unreachable unless Section 5.1 was
  bypassed or data was corrupted.
- C7. Refund with a missing product doc completes, with the
  stock restore skipped and the skip recorded, rather than
  blocking a money refund on a catalogue problem.
- C8. `deliveredAt` and credit `expiresAt` come from the server
  clock inside the helper, never from a request body. A
  caller-supplied delivery time would let a late delivery be
  backdated out of its credit (insecure design, per
  `local-owasp-security-check`).
- C9. Cancel entry points in the pilot are the GF admin route
  and GH's sweep calling the helper. No buyer self-cancel is
  built by GF; none exists at base for any order, and adding a
  buyer surface is GD's or GG's scope if the founder wants it.

Dependencies (GF cannot complete without these, in build order):

- D1, on GA (step 1): order fields `vendorId`, `subtotalPkr`,
  `deliveryPkr`, `groupBuyId`, `escrowStatus`, `creditAppliedPkr`,
  `commissionLedgerId`, `payoutId`, `deliveredAt`,
  `promisedDeliveryDate`, plus GF's one requested addition,
  `returnClaimOpen` (boolean, absent means false); collections
  `vendors`, `commission_ledger`, `vendor_payouts`,
  `store_credits`, `group_buys` with the spec Section 2 shapes;
  `firestore.rules` blocks for `commission_ledger`,
  `vendor_payouts`, and `store_credits` in the server-only
  pattern of `ledger_entries` (rules lines 1777 to 1781: finance
  read at most, `allow write: if false`); `fs_` mirror
  registration for the new collections that captures Admin SDK
  server writes (GF writes only through the Admin SDK, so a
  client-triggered mirror would miss every GF document).
- D2, on GE (step 6): every vendor order is created with
  `vendorId`, integer `subtotalPkr` (goods only), `deliveryPkr`,
  `promisedDeliveryDate`, and, for team orders, `groupBuyId`
  plus `escrowStatus` `held`; store credit consumption writes
  each consumed `store_credits` doc to state `consumed` with
  `consumedOrderId` = the consuming order and the order's
  `creditAppliedPkr` = the summed amount. GF's restores key on
  exactly that pair of writes; a different consumption key
  breaks restore silently, so this is a contract, not a hope.
- D3, on GG (steps 8 and 9): the vendor fulfilment route calls
  `deliverVendorOrder` for the delivered transition and never
  writes `delivered` directly; the admin Store Orders UI routes
  vendor-order delivery and credit-or-team cancellation to GF's
  routes (the PATCH guard will 409 the old path regardless, so
  an un-updated UI fails loudly, not silently); the Finance
  queue and Store Orders surfaces render the decide endpoint's
  `error` text to the checker, which is how the Section 3 stock
  message reaches a human; the claim buttons call GF's claim
  route; the payout draft builder honours Section 7, and payout
  completion is what sets entries `paid` with `payoutId` (GF's
  refund-after-payout branch reads exactly that state).
- D4, on GH (step 10): `checkGroupBuyCompletion(db, groupBuyId)`
  exists with the Section 6.1 signature (GF tolerates its
  absence at runtime, but G2's team-completed proof needs it);
  the expiry sweep calls `cancelPreVerificationOrder` for
  pending member orders, raises `order_refund` approvals for
  verified ones, and performs the `group_buys` member-array
  updates itself, using the ids GF's cancel result returns.
- D5, on the coordinator: confirm the deployed `SUPA_PRIMARY`
  value for Choice C2 before the first listing, and confirm
  GA's mirror registration (D1) covers Admin SDK writes before
  GF's acceptance tests are read as mirror evidence. Neither
  check costs a production data read; both are configuration
  reads.

## 12. Implementer checklist (in order)

1. `src/lib/server/vendor-money.ts`: pure math (Section 4),
   `VendorMoneyError`, `isLedgerEntryPayoutEligible`,
   `vendorPatchGuard`, then the three standalone helpers
   (Sections 5.2, 5.4, 5.5), each one transaction, reads before
   writes, audit row inside the transaction.
2. `src/lib/finance/money-approval.ts`: import the pure math;
   add the prepare and write function pairs; wire them into the
   verify cases (lines 566 to 573) and the refund case (line
   577) in the Section 3.3 order. Nothing else in the file
   changes; in particular not `snapshotFor`, not
   `validateOrderTransition`, not the catch block.
3. The three GF routes (Section 6.2).
4. The PATCH guard (Section 6.4) in
   `src/app/api/store/orders/route.ts`.
5. Tests in Section 9 order: 9.3 pure math first (fastest
   signal), then 9.1, then 9.2.
6. Conditional only: the Section 8 SQL parity, if the C2 gate
   fails.

Founder-facing summary of what this group proves when built:
a shop order's money exists only from the moment a second person
verifies it; at that same moment the platform takes its 10
percent on paper, takes the unit out of stock, or refuses the
whole verification with the product and order named; delivery is
what makes the vendor's money payable and releases a team's
escrow; a late team delivery pays the buyer a bounded credit
exactly once; and every reversal (refund, cancel, claim) has
exactly one coded road back.
