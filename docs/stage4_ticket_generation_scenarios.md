# STAGE 4 — SCENARIO ANALYSIS: TICKET GENERATION & VERIFICATION
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO 7 of 8)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** The Live Ticket Studio is a unique USP. This MD details how tickets are designed once and generated thousands of times with dynamic data.

---

## 🎫 Scenario 7.1: Designing the National Conference Ticket

**Actor:** `chair_events`.  
**Trigger:** Event registration is about to go live.

1. **Studio Entry:** Admin visits `/admin/events/[id]/tickets`.
2. **Asset Upload:** Admin uploads two high-res PNGs (Front and Back template).
3. **Precision Mapping:**
   - Admin selects "Attendee Name" overlay → Drags it to the center of the template.
   - Selects "QR Code" overlay → Positions it bottom-right.
   - Selects "Payment Status" overlay → Sets font color to Green (to indicate verified).
4. **The Mirror:** Changes are saved. Any ticket generated for this event will now follow this exact pixel-perfect layout.

---

## 🎫 Scenario 7.2: A Member Accessing Their Confirmed Ticket

**Actor:** `member` (Status: Confirmed).  
**Trigger:** Event day approaching.

1. **Access:** Member visits their `/profile`.
2. **The Section:** Scrolls to **"My Event Tickets"**.
3. **Action:** Clicks "Download PDF" on the conference card.
4. **The Magic (Server-Side):**
   - System fetches the event's `ticketConfig`.
   - Injects user's Name, Email, and Unique UID into the templates.
   - Encodes a Verification URL into the QR code.
   - Generates a PDF buffer and serves it for download.

---

## 🎫 Scenario 7.3: Event Entry Gate (The Verification)

**Actor:** An on-site volunteer (Guest/Member with scanning duties).  
**Trigger:** Attendee arrives at the gate.

1. **The Scan:** Volunteer uses any phone camera to scan the QR on the member's ticket.
2. **The URL Point:** Opens `/verify/[uniqueTicketId]`.
3. **The Result:**
   - **PASS:** Page shows a giant green check: "VERIFIED: Ahmed (Member)".
   - **FAIL:** Page shows a red X: "INVALID: This ticket has already been scanned" or "Payment Not Verified".
4. **Log:** Each verification is recorded in the event attendance log in Firestore.

---

*AGENT 04 sign-off: Ticket generation and verification scenarios fully documented.*
