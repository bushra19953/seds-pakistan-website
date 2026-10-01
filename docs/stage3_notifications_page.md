# STAGE 3 — PAGE BREAKDOWN: NOTIFICATIONS & BROADCASTS
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 7 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The notification system is multi-channel (In-App, Push, Email). This MD details how users interact with notifications and how admins blast broadcasts.

---

## 🔔 Page: Notifications (`/notifications`)

**File:** `src/app/notifications/page.tsx`  
**Visibility:** Signed-in users only.  
**Purpose:** Centralized inbox for system-to-user alerts.

---

## Multi-Channel Delivery System

| Channel | Trigger | Delivery Method |
|---|---|---|
| **In-App** | Any activity | Firestore collection `notifications/{uid}/items` |
| **Push** | Announcements / Events | Firebase FCM + Service Worker |
| **Email** | Critical Events | Nodemailer SMTP (e.g., payment status, role change) |

---

## User Interaction Flow

### 📦 In-App Inbox
- Notifications are sorted by newest first.
- **Indicators:** Red dot in navbar shows unread count.
- **Action:** Click notification → "Mark as Read" → Redirect to relevant page (e.g., event detail, task).

### 📱 Push Opt-In
- First-time users are prompted to "Allow Notifications".
- **Logic:** Browser registers VAPID key → FCM token saved to user profile.
- **Result:** User receives desktop/mobile alerts even when the browser tab is closed.

---

## 📡 Admin Broadcasts (`/admin/announcements`)

**Access:** `manageAnnouncements` permission roles.  
**Purpose:** Send urgent updates to all or specific segments of members.

### Announcement Logic
```
1. Admin creates announcement (title, body, priority).
2. Admin toggles 'showInTicker' = true (shows on home page).
3. Admin sets 'broadcastUntil' = [expiry timestamp].
4. System executes:
   - Saves to 'announcements' collection.
   - Triggers FCM broadcast to all subscribed tokens.
   - Adds in-app notification to all active user profiles.
```

---

## 🏁 Auto-Expiry & Clean-Up
- Announcements with a past `broadcastUntil` date are automatically filtered out from the home page ticker.
- Old Notifications are periodically archived to maintain Firestore performance.

---

*AGENT 03 sign-off: Notifications and broadcast page fully documented.*
