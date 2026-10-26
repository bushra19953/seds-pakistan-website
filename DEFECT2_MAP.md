# Defect 2 — mechanism map (written before the fix)

## How registration and Store order are linked

- Registration: `events/{eventId}/registrations/{uid}` (doc id = buyer uid).
- Order: `orders/{orderId}`.
- Link fields, by creation path:
  - Store checkout (`src/app/actions/store.ts` createOrder): registration is
    mirrored with `orderId: <order doc id>`; order carries top-level
    `eventId`, `buyerUserId`/`userId`, status `pending_verification`,
    paymentStatus `pending`.
  - Paid event-registrations route (`src/app/api/event-registrations/route.ts`):
    order doc is random-id; registration and order share the buyer-supplied
    `transactionId` (payment reference) value; order has
    `items[0].eventId` + `originatingModule: 'Events'`, no top-level eventId.
  - Money-approval apply mirror (`mirrorEventRegistration` in
    `src/lib/finance/money-approval.ts`): registration written with
    `transactionId: <order doc id>` — so for those registrations the
    transactionId IS the order doc id.

## Status fields each surface reads

- Attendees panel (`event-attendees-panel.tsx`): registration `status`
  (`confirmed`) + `paymentStatus` (`verified`). Its Issue Ticket enables on
  `status === 'confirmed' && paymentStatus === 'verified'` (registration vocab).
- Order management (`order-management.tsx`): order `status`
  (`pending_verification` -> `verified`) + `paymentStatus`
  (`pending` -> `completed`). Its Issue Ticket enables only on
  `paymentStatus === 'completed'` (order vocab).

## The pending-request (maker-checker) mechanism

- Collection: `money_approvals`. One doc per request:
  `{ targetType, targetId, targetCollection, changePayload, beforeSnapshot,
  reason, makerUid, checkerUid, status: 'pending', expiresAt: +7d, ... }`.
- Target for order actions: `orders/{orderId}` (all `order_*` targetTypes map
  to collection `orders` in `MONEY_APPROVAL_TARGET_COLLECTIONS`).
- Uniqueness (spec 3.4) in `createMoneyApprovalRequest`
  (`src/lib/finance/money-approval.ts`): one pending request per
  `(targetType, targetId)` — checked via the Supa seam
  `supaPendingApproval` first, Firestore query fallback. A second create for
  the same pair throws `MoneyApprovalError 409 'A pending request already
  exists for this target'` with `existingId` set; the approvals route's
  `financeErrorResponse` forwards `{ error, existingId }` with status 409.
  This 409 contract is pinned by money-approval.test.ts case 8 and is NOT
  changed by this fix.
- Who creates: ONLY the Store order surface (order-management.tsx):
  'Verify Payment & Confirm Seat' -> POST /api/admin/finance/approvals
  `order_verify_payment`; 'Mark Paid' (certificates) -> `order_mark_paid`.
  Both types apply through the same `applyOrderVerify` (order ->
  verified/completed + registration mirror + ledger draft + receipt).
- Who consumes: a DIFFERENT admin (maker != checker, UID-enforced) approving
  in the Finance approvals queue via the decide route ->
  `decideMoneyApproval` -> stale-snapshot check -> transaction apply.
- Who never creates/consumes: the Attendees panel. Its Verify Payment /
  Confirm Seat are direct client Firestore writes to the registration doc
  ONLY (plus event counters and a best-effort Supa registration mirror).

## Root cause (two halves)

1. Divergence: attendees-side verify/confirm never touches the linked order,
   so the registration reaches confirmed/verified while the order stays
   `pending_verification` / paymentStatus `pending`, and the order's Issue
   Ticket (gated on paymentStatus `completed`) stays disabled.
2. Dead-end: once any `order_verify_payment` request is pending for the
   order (e.g. from an earlier click on the order's own button), clicking
   'Verify Payment & Confirm Seat' again POSTs a create, gets the 409, and
   the handler does `throw new Error(data.error)` -> toast 'Failed — A
   pending request already exists for this target'. The handler discards
   `existingId`, offers no path to the existing request, and the button is
   not even disabled by pending state (only the certificate Mark Paid
   button consults `pendingApprovalIds`). The existing request is perfectly
   consumable — by the checker queue, or as the caller's own outstanding
   request — but the action treats its existence as a hard failure.
