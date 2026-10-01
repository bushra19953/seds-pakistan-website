# STAGE 4 — SCENARIO ANALYSIS: ERROR & EDGE CASE BEHAVIOR
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO 8 of 8)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** Software breaks. This MD details exactly what the user sees when things go wrong and how the system self-heals.

---

## 🚨 Scenario 8.1: Network Failure during 5MB Receipt Upload

**Actor:** Any user.  
**Condition:** WiFi signal dies at 80% upload.

1. **The Symptoms:** The progress bar stops moving.
2. **The Recovery:** 
   - Firebase Storage SDK handles retries automatically for 30 seconds.
   - If it truly fails, the UI shows a "Broken Upload" icon.
3. **Self-Healing:** The file isn't partially saved. The user is prompted to "Try Again". No partial order is ever sent to the server until the upload is 100% complete.

---

## 🚨 Scenario 8.2: Concurrent Admin Edits on the Same Event

**Actor:** Two Admins (`Chair A` and `Chair B`).  
**Condition:** Both editing the same event description at 14:00.

1. **The Conflict:** Chair A saves a new location. Chair B (still on the old page) saves a new description.
2. **The Behavior:** 
   - Firestore follows the **"Last Write Wins"** rule. 
   - Chair B's save will overwrite Chair A's location if the whole document is patched.
3. **Prevention:** Admins are advised to look at the "Last Updated By" timestamp visible in the footer of the admin editor before making major changes.

---

## 🚨 Scenario 8.3: Attempting to Use an Expired Invite Link

**Actor:** A Guest.  
**Condition:** Admin set the invite to expire in 24h; Guest clicks it in 48h.

1. **The Click:** Guest visits `/invite/expired-token`.
2. **The Validation:** 
   - Auth middleware queries `invites` collection.
   - Finds `token` but checks `expiresAt < now`.
3. **The Result:** User is shown a custom 404/expired page: "This invitation has expired. Success in SEDS requires speed! Please contact your chapter president for a fresh link."

---

## 🚨 Scenario 8.4: Deleting a User with Active Orders

**Actor:** `superadmin`.  
**Condition:** Removing a user who has pending payments.

1. **The Safety:** Site logic prevents direct deletion of users with linked operational data.
2. **The Correct Path:** Admin must first **Archive** or **Ban** the user. This keeps the financial audit trial (orders) intact while revoking all access.
3. **Result:** The system integrity remains 1:1. No "ghost orders" are left without a parent UID.

---

*AGENT 04 sign-off: Error and edge case scenarios fully documented. Stage 4 complete with 8 MDs.*
