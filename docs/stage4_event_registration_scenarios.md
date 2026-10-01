# STAGE 4 — SCENARIO ANALYSIS: EVENT REGISTRATION
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO 2 of 8)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** Event registration is the primary driver of member engagement. It varies by visibility and price. This MD details the registration funnel for free vs. paid events.

---

## 🎟️ Scenario 2.1: Registering for a Free Public Event

**Actor:** Any signed-in `member` or `guest`.  
**Trigger:** User wants to attend a free session.

1. **Discovery:** User visits `/events` and clicks on a "Free" event card.
2. **Detail Review:** Page `/events/[slug]` loads. User reads topic, date, and location.
3. **Action:** User clicks the **"Register Now"** button.
4. **Backend Processing:**
   - Script checks `registrationOpen: true`.
   - Script checks `attendeeIds.length < capacity`.
   - Create `event-registrations/{id}`: `status: 'confirmed'`, `paymentStatus: 'free'`.
5. **Success:** Button changes to "Registered". User receives a "Registration Successful" email.

---

## 🎟️ Scenario 2.2: Registering for a Paid Event (Store Link)

**Actor:** Any signed-in user.  
**Trigger:** User wants to attend a premium workshop.

1. **Discovery:** User clicks "Register" on a paid event.
2. **The Hand-Off:** 
   - Front-end detects `isPaid: true` and `linkedProductId`.
   - User is auto-redirected to `/checkout?productId=[linkedId]&eventId=[id]`.
3. **The Purchase:** User completes the Store Checkout (see Stage 4.3).
4. **The Linkage:** After admin verifies payment in `/admin/orders`:
   - System searches for `eventId` in the order metadata.
   - System updates `event-registrations/{id}`: `status: 'confirmed'`, `paymentStatus: 'verified'`.
5. **Verification:** User's profile now shows the dynamic event ticket.

---

## 🎟️ Scenario 2.3: Attempting to Register for a Private Event

**Actor:** A `guest` user.  
**Trigger:** User tries to bypass UI to access a members-only event URL.

1. **Unauthorized Access:** User visits `/events/private-session-slug`.
2. **The Guardrail:** 
   - Auth middleware checks `eventVisibility: 'members'`.
   - Compares with user's role (`guest`).
3. **The Deny:** UI renders a locked state: "This event is exclusive to SEDS Pakistan Members. Please sign in or apply to join."
4. **Resolution:** User must be inducted and granted the `member` role by an admin.

---

## 🎟️ Scenario 2.4: Registration When at Full Capacity

**Actor:** Any user.  
**Trigger:** Last ticket just sold.

1. **The Check:** User clicks "Register".
2. **The API Response:** Server returns `409 Conflict`: "This event has reached maximum capacity."
3. **UI Update:** Button changes to "Sold Out" (disabled).
4. **User Path:** User is encouraged to follow the social ticker for last-minute openings or next sessions.

---

*AGENT 04 sign-off: Event registration scenarios fully hunted and documented.*
