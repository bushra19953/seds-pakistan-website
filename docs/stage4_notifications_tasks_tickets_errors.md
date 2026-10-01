# STAGE 4 — SCENARIO ANALYSIS: NOTIFICATIONS, TASKS, TICKETS & ERROR SCENARIOS
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO SET 5-8)
**AGENT 04 – SCENARIO HUNTER**

---

## 🔔 SCENARIO SET 5: Notifications

### Scenario 5.1: Admin Broadcasts Announcement

```
Actor: Admin with manageAnnouncements permission
Step 1: /admin/announcements → New Announcement
Step 2: Fill title, body, priority
Step 3: Toggle showInTicker = true
Step 4: Set broadcastUntil = [expiry date]
Step 5: Save
Step 6: Announcement appears in home page ticker immediately
Step 7: Push notification sent to all subscribed users via Firebase FCM
Step 8: In-app notification created in notifications/{uid}/items for each subscribed user
```

### Scenario 5.2: User Receives Push Notification

```
Step 1: User has previously granted notification permissions on browser
Step 2: Service worker registered with VAPID key
Step 3: Admin publishes event or announcement
Step 4: Backend calls Firebase FCM API
Step 5: Browser receives push message (even when tab not open)
Step 6: Notification popup appears with title + body
Step 7: User clicks notification → directed to relevant page
```

---

## ✅ SCENARIO SET 6: Task Workflow

### Scenario 6.1: Task Assignment & Completion

```
Actor: Admin (assigns), Member (completes)

[ADMIN SIDE]
Step 1: /admin/tasks → New Task
Step 2: Fill title, description, due date, points value
Step 3: Assign to: specific uid OR role (e.g., all 'member')
Step 4: Optional: use AI generator (Gemini) to suggest task description
Step 5: Save → task appears in assignees' /tasks page

[MEMBER SIDE]
Step 6: Member visits /tasks → sees new task card
Step 7: Reads task details
Step 8: Completes work (external or in-app submission)
Step 9: Clicks "Submit Completion"
Step 10: Enter submission text and/or upload file
Step 11: POST /api/tasks/[id]/submit
Step 12: Task status → 'submitted'

[ADMIN REVIEW SIDE]
Step 13: Admin sees task in /admin/submissions (Universal Inbox → Tasks tab)
Step 14: Reviews member's submission
Step 15a: If approved → "Mark Complete"
  → Member earns points (users/{uid}.points += task.pointValue)
  → Member notified
Step 15b: If rejected → "Reject with Note"
  → Admin enters rejection reason
  → Optional: issue warning
  → Member notified
```

---

### Scenario 6.2: Task Defaulter

```
Step 1: Due date passes with no submission
Step 2: Admin checks /admin/defaulters
Step 3: Lists all users with overdue tasks
Step 4: Admin issues warning to defaulter
Step 5: Warning stored in users/{uid}.warningHistory[]
Step 6: warningCount incremented
Step 7: If warningCount >= 3 → admin may ban user
```

---

## 🎫 SCENARIO SET 7: Ticket Generation

### Scenario 7.1: Admin Designs Event Ticket

```
Step 1: /admin/events/[id]/tickets → Live Ticket Studio opens
Step 2: Upload front and back ticket template images
Step 3: For each overlay (name, email, date, QR code, etc.):
  → Drag to desired position on the ticket canvas
  → Set font size, color, enabled/disabled
Step 4: Click "Preview" → see how actual ticket will look
Step 5: Click "Save Configuration" → saved to events/{id}.ticketConfig
Step 6: Ticket design locked in for this event
```

### Scenario 7.2: Member Downloads Their Ticket

```
Step 1: Member's registration is confirmed (paymentStatus: 'verified')
Step 2: Member visits /profile → "My Tickets" section
  OR: member clicks link in confirmation email
Step 3: System fetches EventRegistrationDoc for this member+event
Step 4: System loads event's ticketConfig from Firestore
Step 5: Ticket rendered using ticketConfig overlays on the template images
Step 6: Member's data injected: name, email, ticketNum, QR code
Step 7: PDF generated via pdf-utils.ts
Step 8: PDF download triggered in browser
Step 9: Member has printable ticket with verification QR
```

### Scenario 7.3: Ticket Verification at Event Entry

```
Step 1: Event volunteer uses phone to scan QR code on ticket
Step 2: QR contains URL: /verify/[ticketId]
Step 3: Verification page loads
Step 4: System looks up EventRegistrationDoc by ticketId
Step 5: Checks status:
  CONFIRMED → Show green "VALID" banner with attendee name
  CANCELLED → Show red "CANCELLED" banner
  PENDING → Show yellow "PENDING REVIEW" banner
  NOT FOUND → Show red "INVALID TICKET" banner
Step 6: Volunteer marks as arrived (optional)
```

---

## 🚨 SCENARIO SET 8: Error & Edge Case Scenarios

### Scenario 8.1: Network Failure During Payment Submission

```
Step 1: User filling checkout form
Step 2: Uploads receipt — upload succeeds (Firebase Storage URL saved)
Step 3: User clicks "Submit"
Step 4: Network drops
Step 5: POST /api/store/create-order fails with network error
Step 6: UI shows "Failed to place order. Please try again."
Step 7: Receipt URL is NOT cleared — still valid
Step 8: User can retry without re-uploading receipt
NOTE: Idempotency key should be checked — duplicate order creation prevented
```

---

### Scenario 8.2: Admin Panel Access by Unauthorized User

```
Step 1: Member (not admin) manually types /admin in URL
Step 2: AdminLayout checks hasSiteAdminAccess(role)
Step 3: Returns false for 'member' role
Step 4: User redirected to / (home)
Step 5: No admin data is ever sent to unauthorized client
NOTE: Server-side API routes also check permissions before returning data
```

---

### Scenario 8.3: Concurrency — Two Admins Edit Same Event

```
Step 1: Admin A opens /admin/events/[id]
Step 2: Admin B opens same event simultaneously
Step 3: Admin A saves changes → Firestore doc updated
Step 4: Admin B's form still has old data
Step 5: Admin B saves → overwrites Admin A's changes
CURRENT STATE: Last-write-wins (no optimistic locking)
RECOMMENDATION: Admin should reload before saving for critical events
```

---

### Scenario 8.4: Firestore Security Rule Violation

```
Step 1: Malicious user crafts direct Firestore SDK call
Step 2: Attempts to write to events/{id} from client
Step 3: Firestore rules (firestore.rules, 43KB) evaluated
Step 4: Rule: isAdmin() function required for writes to events
Step 5: User's token does not have admin claim
Step 6: Write rejected with PERMISSION_DENIED error
Step 7: Error emitter logs FirestorePermissionError
Step 8: Audit log records the violation attempt
```

---

*AGENT 04 sign-off: All 8 scenario sets documented. Notifications, tasks, tickets, and error scenarios complete.*
