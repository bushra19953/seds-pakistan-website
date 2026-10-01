# STAGE 4 — SCENARIO ANALYSIS: EVENT REGISTRATION, STORE CHECKOUT & ADMIN SCENARIOS
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO SET 2-4)
**AGENT 04 – SCENARIO HUNTER**

---

## 🎟️ SCENARIO SET 2: Event Registration

### Scenario 2.1: Free Event Registration (Happy Path)

```
Actor: Member
Trigger: Clicks "Register" on a free event

Step 1: Event detail page /events/[slug] loads
Step 2: Event is published, visibility=public, registrationOpen=true
Step 3: paymentDetails.isPaid = false (free event)
Step 4: User is signed in (member role)
Step 5: User clicks "Register" CTA
Step 6: POST /api/event-registrations with eventId, uid
Step 7: EventRegistrationDoc created:
  { uid, eventId, status: 'pending', paymentStatus: 'unpaid' }
Step 8: Email notification sent to user
Step 9: User sees confirmation on page
```

---

### Scenario 2.2: Paid Event via Store (Happy Path)

```
Actor: Member
Trigger: Clicks "Register" on a paid event with linkedStoreProductId

Step 1: Event detail page loads
Step 2: paymentDetails.isPaid = true, productId = "prod_abc123"
Step 3: User clicks "Register" CTA
Step 4: Front-end detects productId → redirects to /checkout?productId=prod_abc123
Step 5: Checkout page loads product: "Event Ticket — [Event Name]"
Step 6: User fills buyer info (name, email, phone auto-filled from profile)
Step 7: Bank transfer details displayed (account number, instructions)
Step 8: User transfers money manually (outside the app)
Step 9: User uploads receipt photo
Step 10: User enters Transaction ID (mandatory field)
Step 11: Submit → Order created with status: 'pending', paymentStatus: 'pending'
Step 12: Admin sees order in /admin/orders or /admin/submissions
Step 13: Admin verifies receipt → confirms order
Step 14: EventRegistration updated: status: 'confirmed', paymentStatus: 'verified'
Step 15: User receives email: "Your registration is confirmed!"
```

---

### Scenario 2.3: Registration Closed (Edge Case)

```
Actor: Any user
Event: registrationOpen = false

Step 1: User visits event detail page
Step 2: CTA button shows "Registration Closed" (disabled)
Step 3: No registration possible
Resolution: Admin must toggle registrationOpen in /admin/events/[id]
```

---

### Scenario 2.4: Event at Full Capacity (Edge Case)

```
Step 1: Event has capacity = 50, attendeeIds.length = 50
Step 2: User clicks Register
Step 3: API checks: attendeeIds.length >= capacity
Step 4: Returns 409 Conflict: "Event is at full capacity"
Step 5: User shown waitlist option (if enabled) or denial message
```

---

## 🛒 SCENARIO SET 3: Store Checkout

### Scenario 3.1: Chapter Registration Fee (Happy Path)

```
Actor: Chapter president or member
Trigger: Chapter registration payment

Step 1: Admin creates product "Chapter Registration Fee" in /admin/store
  → category: 'chapter-registration'
  → price: 500 PKR
  → formId: 'chapter_reg_form'
Step 2: User visits /checkout?productId=[id]
Step 3: Custom form appears (chapter name, president name, members count)
Step 4: User completes form
Step 5: Proceeds to payment step (bank transfer)
Step 6: Uploads receipt + Transaction ID
Step 7: Order created: originatingModule: 'chapter-registration'
Step 8: Admin reviews → confirms
Step 9: Chapter activated in /admin/chapters
```

---

### Scenario 3.2: Admin Manually Confirms Order (`/admin/orders`)

```
Actor: Admin (any role with store access)
Trigger: Pending order awaiting verification

Step 1: Admin opens /admin/orders (or /admin/submissions → Orders tab)
Step 2: Sees order with paymentStatus: 'pending'
Step 3: Clicks "View Receipt" → receipt image opens
Step 4: Verifies bank transaction ID against screenshot
Step 5: Clicks "Confirm Payment"
Step 6: POST /api/admin/store/verify-order
Step 7: Order status → paymentStatus: 'completed', status: 'delivered'
Step 8: If linked to event → EventRegistration confirmed
Step 9: User notified via email + in-app notification
```

---

### Scenario 3.3: Order Rejection / Fake Receipt

```
Step 1–4: Same as 3.2
Step 5: Admin detects fake/invalid receipt
Step 6: Clicks "Reject Payment"
Step 7: Admin enters reason for rejection
Step 8: Order: paymentStatus: 'failed', status: 'cancelled'
Step 9: User notified: "Your payment could not be verified"
Step 10: User prompted to re-submit or contact admin
```

---

## ⚙️ SCENARIO SET 4: Admin Management

### Scenario 4.1: Creating a New Event

```
Actor: Admin with manageEvents permission
Step 1: /admin/events → click "New Event"
Step 2: Event form loads (/admin/events/new)
Step 3: Fill required fields: title, slug, date, type, status
Step 4: Set visibility: public | members | private
Step 5: Toggle registrationOpen if accepting registrations
Step 6: If paid: enable isPaid, set price, link Store product
Step 7: Upload event image
Step 8: Write description, value proposition, catalyst statement
Step 9: Save as 'draft' first
Step 10: Preview → publish (status → 'published')
Step 11: Toggle showInTicker if should appear in home ticker
Step 12: Event appears in /events listing
```

---

### Scenario 4.2: Banning a User

```
Actor: Superadmin or President
Step 1: /admin/users → search for user
Step 2: Click user → user detail view
Step 3: Click "Ban User"
Step 4: Enter ban reason (text field)
Step 5: Confirm ban
Step 6: System writes: users/{uid}.isBanned = true, banReason = [reason]
Step 7: User's next API call returns redirectTo: '/banned'
Step 8: User sees ban page with reason
Step 9: Audit log entry: "BANNED_USER" recorded
```

---

### Scenario 4.3: Role Assignment

```
Actor: Superadmin or President_national
Step 1: /admin/users → find user
Step 2: Click "Edit Role" 
Step 3: Dropdown of all 24 roles
Step 4: Select new role
Step 5: Confirm
Step 6: PATCH /api/users/{uid}/role (requires assignRoles permission)
Step 7: Firestore roles/{uid}.role updated
Step 8: Audit log: "ASSIGNED_ROLE: member → vice_president"
Step 9: User gets new permissions on next login/token refresh
Step 10: User receives email notification about role change
```

---

*AGENT 04 sign-off: Event registration, store checkout, and admin management scenarios covered.*
