# STAGE 4 — SCENARIO ANALYSIS: NOTIFICATIONS & BROADCASTS
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO 5 of 8)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** Notifications are the pulse of the app. This MD details how messages move from admin to user across different channels.

---

## 🔔 Scenario 5.1: Urgent National Security Broadcast

**Actor:** `general_secretary`.  
**Trigger:** Venue change for an upcoming physical event.

1. **Command:** Admin visits `/admin/announcements` → **"New Announcement"**.
2. **Draft:** Title: "VENUE CHANGE: Rocket Launch"; Body: "Moved to Ground B due to weather."
3. **Priority:** Sets priority to **"High"** and toggles **"Show in Home Ticker"**.
4. **The Blast:** Clicks "Publish".
5. **The Cascade:**
   - **In-App:** All 400 members get a red dot in their navbar.
   - **Push:** Mobile devices across Pakistan vibrate with the update.
   - **Visual:** The home page hero ticker immediately starts scrolling the new text.

---

## 🔔 Scenario 5.2: Automated Milestone Notification

**Actor:** System (Automated).  
**Trigger:** Admin approves a task.

1. **Back-end hook:** `onTaskApproval` function triggers.
2. **The Result:** 
   - User `A` receives an in-app alert: "Task Approved! 50 Points added to your profile."
   - User's mobile: "Achievement Unlocked: Senior Engineer Badge!"
3. **Logic:** These are pre-defined templates found in `src/lib/notifications.ts`.

---

## 🔔 Scenario 5.3: Dealing with Notification Fatigue (User Opt-Out)

**Actor:** Any user.  
**Trigger:** Too many alerts.

1. **Action:** User goes to browser settings (Lock icon in URL bar) → Notifications → **Block**.
2. **The Result:**
   - Push messages are blocked at the OS level.
   - **BUT:** In-app notifications in `/notifications` still continue to accumulate normally.
   - **Email:** The user still receives critical "Order Verification" emails as these ignore browser push settings.

---

*AGENT 04 sign-off: Notification and broadcast scenarios fully documented.*
