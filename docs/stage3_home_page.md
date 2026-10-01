# STAGE 3 — PAGE BREAKDOWN: HOME PAGE
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 1 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The home page (`src/app/page.tsx`) is the primary landing surface for all visitors. It contains a hero with 3D WebGL animation, a credibility marquee, upcoming launches/events section, announcements ticker, projects/command center, stats section, and a CTA. Guests see the full page. Members see additional personalized content. Admins see no special overlay here — the admin panel is separate.

---

## 🏠 Page: Home (`/`)

**File:** `src/app/page.tsx` (4.6 KB)  
**Visibility:** Public (all users including unauthenticated guests)  
**Purpose:** First impression / conversion engine. Showcases SEDS Pakistan's mission, projects, and events.

---

## Page Sections (Top to Bottom)

### 1. Hero Section
- **Content:** Full-screen immersive hero with 3D WebGL/Vanta.js background
- **Elements:** Organization name, tagline, primary CTAs ("Explore Events", "Apply Now")
- **Who sees it:** Everyone
- **Admin control:** Site-wide text in `/admin/site-settings` or `/admin/pages`

### 2. Credibility Marquee
- **Content:** Scrolling ticker with partner logos, sponsor names, media mentions
- **Who sees it:** Everyone
- **Admin control:** `/admin/sponsors-partners` → toggles items in/out of marquee
- **File:** `src/components/CredibilityMarquee.tsx`

### 3. Live Announcements Ticker
- **Content:** Horizontal scrolling ticker with latest announcements and upcoming events
- **Data source:** Firestore `announcements` collection (where `showInTicker: true`)
- **Controls:** Admins set `showInTicker` and `broadcastUntil` (TTL) in `/admin/announcements`
- **Events also appear here** if their `showInTicker: true` and `broadcastUntil` is in the future

### 4. Upcoming Launches / Events Grid
- **Content:** Cards for the next 3–6 published events
- **Data source:** Firestore `events` collection (status: `published`, visibility: `public` or `members`)
- **Member events:** Members see events with visibility `members`; guests see only `public` events
- **Admin control:** Create/edit events in `/admin/events`

### 5. Projects Slider (Command Center)
- **Content:** Horizontal scrolling cards for active projects
- **Data source:** Firestore `projects` collection
- **Who sees it:** Everyone (public projects)
- **Admin control:** `/admin/projects`

### 6. Statistics Section
- **Content:** Animated count-up numbers (members, events, chapters, etc.)
- **Data source:** Aggregated counts from Firestore
- **Admin control:** `/admin/site-settings` (can override displayed numbers)

### 7. About/Mission Section
- **Content:** SEDS Pakistan's mission statement, vision, and values
- **Admin control:** `/admin/pages` → page content editor

### 8. CTA Section (Bottom)
- **Content:** "Apply to Join" and "Explore Events" buttons
- **CTA targets:** `/apply` (guests) and `/events` (all)

---

## Interaction Flows by Role

| Role | Experience |
|---|---|
| **Guest** | Sees full page, ticker shows public events/announcements, events grid shows public events only |
| **Member** | Sees member-visibility events in home grid, may see member-exclusive announcements |
| **Admin** | Same as member view on home page; goes to `/admin` for control |

---

## Component Dependencies

| Component | Purpose | File |
|---|---|---|
| `CredibilityMarquee` | Scrolling partner logos | `components/CredibilityMarquee.tsx` |
| `EventCard` | Upcoming event display | `components/EventCard.tsx` |
| `AnnouncementsTicker` | Live broadcast ticker | `components/AnnouncementsTicker.tsx` |
| `ProjectsSlider` | Project showcase | `components/ProjectsSlider.tsx` |
| Vanta.js WebGL | 3D hero background | `lib/webgl-utils.ts` |

---

## SEO Info
- **Title:** SEDS Pakistan — Space Empowerment & Development
- **Meta Description:** Pakistan's leading university space organization
- **OG Image:** Organization logo/hero image

---

*AGENT 03 sign-off: Home page fully documented.*
