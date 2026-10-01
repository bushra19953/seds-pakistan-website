# STAGE 5 — PURPOSE EXPLANATION MATRIX
## v11.0 SWARM DEPLOYED — STAGE 5/15
**AGENT 05 – PURPOSE EXPLAINER**

---

> **Thinking (COT):** Every system element exists for a concrete reason. This matrix documents the WHY and HOW for every major feature, page, API, and data structure. Purpose understanding prevents misuse and enables confident operation by all roles.

---

## 🎯 Purpose Matrix — All Site Features

### Public Pages

| Feature | Why It Exists | How It Works | Who Benefits |
|---|---|---|---|
| Home Page | First impression, recruitment conversion | Static + dynamic hero, event ticker, project showcases | Guests (recruitment) |
| Events Listing | Event discovery | Fetches published events from Firestore, filtered by visibility | All users |
| Event Detail | Event information + registration | Shows full event info, registration CTA routes to checkout | Members + guests |
| Blog | Knowledge sharing, thought leadership | Markdown/rich text articles, tag filtering | All users |
| About Page | Organizational credibility | Static + dynamic leadership data from Firestore | Guests (trust building) |
| Leadership History | Legacy and continuity | Timeline of past officers from `/admin/timeline` | All, especially recruits |
| Gallery | Visual credibility | Photo grid from Firebase Storage | All users |
| Projects Page | Showcase technical work | Project cards with status, team, description | Guests + members |
| Apply Page | New member recruitment funnel | Application form → Firestore → Admin review queue | Guests wanting to join |
| Competitions | Opportunity broadcasting | Static or dynamic list of competitions | Members + students |
| Resources | Member utility | Curated links, opportunities, scholarships | Members |
| Contact | Public inquiry channel | Contact form → email via SMTP | Guests with questions |
| Donate | Financial support | Donation form → Store checkout | Supporters |
| Verify | Ticket validation | QR scan → Firestore lookup → status display | Event entry volunteers |

### Member-Authenticated Features

| Feature | Why It Exists | How It Works | Who Benefits |
|---|---|---|---|
| Profile Page | Personal identity + achievement display | Reads users/{uid} from Firestore | Members |
| Notifications | Real-time information delivery | FCM push + Firestore in-app + Email SMTP | All authenticated |
| Tasks Dashboard | Accountability + engagement | Shows assigned tasks from Firestore | Members |
| Leaderboard | Gamification + motivation | Aggregated points per member | Members |
| Skills Page | Self-development tracking | Skill catalog associated with member profile | Members |
| Community | Peer connection | Discussion/forum features | Members |
| Leave Requests | Absence management | Submit via form → Admin reviews in submissions | Members |

### Admin Features

| Feature | Why It Exists | How It Works | Who Benefits |
|---|---|---|---|
| Admin Dashboard | Command center overview | Fetches metrics + streams audit logs | All admin roles |
| User Management | Control membership | CRUD users, assign roles, ban/unban | President, Superadmin |
| Event Management | Run events | Full CRUD for events, ticket studio, registration review | manageEvents roles |
| Blog Management | Content publishing | Full CMS with draft/review/publish workflow | manageBlogs roles |
| Announcements | Broadcast communication | CRUD with ticker toggle + TTL | manageAnnouncements roles |
| Store Management | Financial operations hub | Product CRUD, order management, payment verification | Superadmin only |
| Applications/Submissions | Universal inbox | Single queue for all pending actions | HR Director + leadership |
| Task Management | Workforce accountability | Create tasks, AI-generate, review submissions | Projects Director |
| Audit Logs | Compliance + oversight | Real-time Firestore log stream | Leadership tier |
| CRM Console | Lead management | Track potential sponsors, partners, recruits | marketing_head |
| Forms Builder | Custom data collection | Drag-and-drop form creation linked to products/events | Admin roles |
| Chapters | Chapter network admin | CRUD for university chapters | Leadership tier |
| Organizations | External partnerships | Track partner orgs, sponsors | Leadership tier |
| Hierarchy | Org chart management | Visual org structure editor | Leadership tier |
| Positions | Role definitions | Define what each position is responsible for | Leadership tier |
| Certificates | Achievement recognition | Issue certificates with templates | Leadership tier |
| Badges | Gamified recognition | Award/revoke badges visible on profiles | Leadership tier |
| Timeline | History management | Add past/future milestones | Leadership tier |
| Site Settings | Global configuration | Site-wide overrides (name, logo, social links) | Superadmin |
| Backup & Restore | Data protection | Export/import Firestore data | Superadmin |
| Analytics | Data-driven decisions | Usage stats from internal logging | Leadership tier |
| Superadmin Panel | System-level control | Direct Firebase access, claim setting | Superadmin only |

### Financial System

| Feature | Why It Exists | How It Works | Who Benefits |
|---|---|---|---|
| Store Products | Single source for all paid items | Products link to events, chapters, donations | All payers |
| Bank Transfer Flow | No payment processor fees | Manual transfer → receipt upload → admin verify | Organization (no fees) |
| Transaction ID | Fraud prevention | Required field, admin cross-checks with bank | Organization (security) |
| Receipt Upload | Proof of payment | Firebase Storage URL saved on order | Admin verification |
| Payment Status States | Clear money flow tracking | unpaid → pending → verified → refunded | Finance transparency |
| originatingModule | Audit trail | Tags order source (store / event / donation) | Treasurer reporting |

### Notification System

| Feature | Why It Exists | How It Works | Who Benefits |
|---|---|---|---|
| Firebase FCM Push | Real-time alerts even when app closed | Service Worker + VAPID → FCM → browser | All active members |
| In-App Notifications | Persistent notification inbox | Firestore notifications/{uid}/items | All authenticated |
| Email Notifications | Critical events via email | Nodemailer SMTP → critical events only | All users |
| Broadcast Until TTL | Auto-expiring announcements | `broadcastUntil` timestamp stops showing old items | Prevents stale info |
| showInTicker | Selective broadcasting | Opt-in per announcement/event for home ticker | Admin control |

---

*AGENT 05 sign-off: Purpose matrix complete — every feature's WHY and HOW documented.*
