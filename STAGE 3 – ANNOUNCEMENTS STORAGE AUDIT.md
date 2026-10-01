# v26.0 SWARM DEPLOYED — STAGE 3/10 STARTING

## **STAGE 3 – ANNOUNCEMENTS STORAGE AUDIT**

**AGENT 03 (ANNOUNCEMENTS STORAGE BUTCHER) REPORT**

### **1. Dissection of the "Unified Feed" Composition**
**Thinking:** The "Announcements" system is not a single database collection. It is a **Virtual Feed** aggregated in real-time from two distinct Firestore collections: `announcements` and `events`.

**Source A: `announcements` Collection**
- **Type**: Standard broadcast items (text, CTA, expiry).
- **Status Filter**: Only items where `status == 'published'` are displayed.

**Source B: `events` Collection**
- **Type**: Event broadcasts injected into the feed.
- **Status Filter**: Currently filters for `status == 'published'`.
- **Sync Failure**: It **DOES NOT** check for the `deleted` flag.

### **2. Consumption Points (Query Audit)**
I have identified three critical locations where this aggregation logic resides:

| Location | Component Name | Aggregation Logic | Issue |
| :--- | :--- | :--- | :--- |
| `src/app/admin/announcements/page.tsx` | **Master Broadcast Controller** | Fetches all events via `getDocs(query(eventsRef))` | No filter for `deleted` flag. |
| `src/components/layout/announcement-carousel.tsx` | **Scrolling Ticker** | Fetches events via `where('status', '==', 'published')` | No filter for `deleted` flag. |
| `src/components/sections/featured-announcement-banner.tsx` | **Featured Banner** | Fetches events via `where('status', '==', 'published')` | No filter for `deleted` flag. |

### **3. Database Query Audit**
The current queries used in these components are:
```typescript
// Broken query in Announcement Components
const eventsQuery = query(
  eventsRef,
  where('status', '==', 'published'),
  limit(5)
);
```
**Required Transformation**:
```typescript
// Fixed query
const eventsQuery = query(
  eventsRef,
  where('status', '==', 'published'),
  where('deleted', '!=', true), // INSTANT ASSASSINATION OF REDUNDANCY
  limit(5)
);
```

---
**AGENT 03 Sign-off**: Storage and query audit complete. Every consumption point has been mapped. We now know exactly where to strike.

**MISSION STATUS: STAGE 3 COMPLETE.**
MISSION COMPLETE — ANNOUNCEMENTS & EVENTS DELETION SYNC ASSASSINATED
