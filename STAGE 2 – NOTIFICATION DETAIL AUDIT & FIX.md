# v31.0 SWARM DEPLOYED — STAGE 2/12 STARTING

## AGENT 02: NOTIFICATION DETAIL ENFORCER

**Objective:** Audit and fix the missing deadline, countdown, and event detail fields inside the global and personal notifications.

### 🧠 Chain of Thought (Aggressive COT)
*Thinking: The problem is twofold. The `POST /api/events/publish` API routes the notification payload to Firestore, but strictly limiting it to `title` and `body` strings. This creates an information vacuum. To resolve this, I must enforce FOMO parameters at payload creation: `deadline`, `location`, and `capacity`. Then, the receiver component `notification-center.tsx` must be rebuilt to process these rich payloads and conditionally calculate a dynamic "Closes in X hours" badge based on `deadline`. This must be robust—failing gracefully if an older notification lacks these fields. The UI must match the premium readability standard.*

### 🚀 Execution Protocol

**1. Payload Injection (`api/events/publish/route.ts`)**
- Added `deadline: eventData?.registrationDeadline || eventData?.endAt` to both `EVENT_PROMO` (Announcements) and `SYSTEM` (Personal) payloads.
- Injected `capacity` and `location` parameters directly from the source Event Document.

**2. UI Rendering Architecture (`notification-center.tsx`)**
- Imported missing Lucide iconography: `MapPin`, `Users`, `Timer`.
- Formatted `PersonalNotification` and `AnnouncementDoc` typing loops to accept dynamic object spreading.
- Built a dynamic `fomoBadge` calculator:
  - If `deadline` is active and `< 72 hours` -> Renders `Closes in Xh` with destructive red styling.
  - If active but far away -> Renders `Open` in neutral styling.
  - If expired -> Renders `Closed` in outline styling.
- Rendered an Event Details Grid underneath the description using `MapPin`, `Timer`, and `Users` badges.

### 🎯 Mission Status
Notifications are no longer vague stubs. They are full-fledged, actionable, high-urgency panels.

MISSION COMPLETE FOR STAGE 2. AGENT 02 HANDING OFF TO STAGE 3.
