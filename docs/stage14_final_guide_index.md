# STAGE 14 — FINAL GUIDE INDEX & POLISH
## v11.0 SWARM DEPLOYED — STAGE 14/15
**AGENT 09 – GUIDE COMPILER** (Final Polish)

---

## 📚 Master Table of Contents

All guide files are located in `e:\SEDS WEBSITE UPDATED SHIT\docs\`

### Stage Files Reference

| Stage | File | Contents | Priority |
|---|---|---|---|
| Stage 1 | `stage1_overview.md` | Codebase structure, file count, coverage plan | Admin Setup |
| Stage 2a | `stage2_admin_role.md` | Superadmin + 8 leadership roles, permissions matrix | Admin Onboarding |
| Stage 2b | `stage2_member_guest_role.md` | Member, Guest, Chair, Team roles | All Users |
| Stage 2c | `stage2_chapter_lead_role.md` | Chapter president, full 24-role index | Chapter Leads |
| Stage 3a | `stage3_home_page.md` | Home page sections, components, admin controls | Content Team |
| Stage 3b | `stage3_events_page.md` | Events, detail page, ticket studio, registrations | Events Team |
| Stage 3c | `stage3_admin_dashboard_page.md` | Admin dashboard, sidebar navigation | Admins |
| Stage 3d | `stage3_store_profile_pages.md` | Store, Checkout, Profile, Notifications | All Users |
| Stage 3e | `stage3_blog_projects_tasks_pages.md` | Blog, Projects, Tasks, About, Apply + more | All Users |
| Stage 4a | `stage4_login_scenarios.md` | 7 auth scenarios: sign-in, ban, invite, expiry | All Users |
| Stage 4b | `stage4_event_store_admin_scenarios.md` | Event registration, store, admin scenarios | Admins + Members |
| Stage 4c | `stage4_notifications_tasks_tickets_errors.md` | Notifications, tasks, tickets, error scenarios | All Roles |
| Stage 5 | `stage5_purpose_matrix.md` | WHY/HOW matrix for every feature | Reference |
| Stage 6 | `stage6_user_journey_flows.md` | 7 user journey flows with mermaid diagrams | Visual Reference |
| Stage 7 | `stage7_edge_case_audit.md` | 14 edge cases with resolution paths | Support Team |
| Stage 8-10 | `stage8_to_10_guide_structure_rollout_performance.md` | Guide structure, PDF export, performance tips | All Admins |
| Stage 11 | **`stage11_full_guide.md`** | **⭐ MASTER GUIDE — all in one** | **Start Here** |
| Stage 12 | `stage12_coverage_validation.md` | 98% coverage audit | QA |
| Stage 13 | `stage13_testing_protocol.md` | 34-test validation protocol | QA |
| Stage 14 | THIS FILE | Index + Quick Reference Cards | Reference |
| Stage 15 | `stage15_manifesto.md` | Declaration + deploy checklist | Leadership |

---

## ⚡ Quick Reference Cards

### Card 1: "Where Do I Find...?"

| I Want To... | Go To |
|---|---|
| See all events | `/events` |
| Register for an event | `/events/[slug]` → Register button |
| Buy something / pay for event | `/checkout?productId=[id]` |
| View my tickets | `/profile` → My Tickets |
| Submit a task | `/tasks` → find task → Submit |
| Update my profile | `/profile` → Edit Profile |
| Apply for membership | `/apply` |
| View notifications | `/notifications` |
| See who leads SEDS | `/about` or `/leadership-history` |
| Verify a ticket QR | `/verify/[ticketId]` |
| Admin: Manage everything | `/admin` |
| Admin: Review pending items | `/admin/submissions` |
| Admin: Manage events | `/admin/events` |
| Admin: Manage users + roles | `/admin/users` |
| Admin: Confirm payments | `/admin/orders` |
| Admin: Store products | `/admin/store` (superadmin only) |
| Admin: Issue announcements | `/admin/announcements` |
| Admin: Track audit trail | `/admin/audit-logs` |

---

### Card 2: Admin Permission Quick-Check

| Permission | Who Has It |
|---|---|
| Assign roles | superadmin, president_national |
| Delete users | superadmin, president_national |
| Ban users | superadmin, president_national |
| Manage Store | superadmin ONLY |
| Manage events | Leadership tier (VP and above) + chair_events |
| Manage blogs | Leadership tier + chair_projects + chair_events |
| Manage gallery | superadmin, president_national, marketing_head, chair_marketing |
| Manage applications | superadmin, president_national, VP, gen_sec, hr_director |
| Manage projects | superadmin, president_national, VP, projects_director, chair_projects |
| Manage tasks | superadmin, president_national, projects_director |

---

### Card 3: Payment Status Reference

| Status Combination | Meaning | Action Needed |
|---|---|---|
| paymentStatus: `unpaid`, status: `pending` | Free event, unconfirmed | Admin confirm or auto-confirm |
| paymentStatus: `pending`, status: `pending` | Receipt uploaded, awaiting verification | Admin verify in /admin/orders |
| paymentStatus: `verified`, status: `confirmed` | Paid and confirmed ✅ | None — complete |
| paymentStatus: `failed`, status: `cancelled` | Payment rejected ❌ | User must re-submit |
| paymentStatus: `refunded` | Refund processed | None |

---

### Card 4: Role Assignment Process

```
1. Go to /admin/users
2. Find target user (search by name/email)
3. Click "Edit Role"
4. Select from dropdown (24 roles)
5. Confirm
6. Tell user to: sign out + sign back in
7. New permissions active immediately after re-login
```

---

### Card 5: Event Publishing Checklist

```
□ Title set (auto-generates slug)
□ Type selected (event/workshop/webinar)
□ Status set to 'draft' initially
□ Start date/time set
□ Visibility set (public/members/private)
□ Description + value proposition written
□ Banner image uploaded
□ If paid: Store product created + productId linked
□ registrationOpen toggled ON
□ Status changed to 'published'
□ Optionally: showInTicker ON + broadcastUntil set
□ Ticket design saved in Live Ticket Studio
```

---

## 🔍 Search Terms Glossary

| Term | Definition |
|---|---|
| `showInTicker` | Flag on event/announcement to show in home page scrolling ticker |
| `broadcastUntil` | Expiry timestamp — item auto-hides from ticker after this date |
| `registrationOpen` | Boolean — controls whether the Register button is active |
| `isPaid` | Boolean on event — determines if checkout flow is needed |
| `productId` | Links event to a Store product for payment routing |
| `proofOfPaymentUrl` | Firebase Storage URL of uploaded receipt image |
| `originatingModule` | Tags order source: 'store', 'chapter-registration', 'donation' |
| `hasSiteAdminAccess` | Function checking if role can see admin sidebar |
| `hasPermission` | Function checking specific action permission by role |
| `ROLE_HIERARCHY` | Numeric level map for role comparison (0-11) |
| `audit_logs` | Firestore collection tracking all admin actions |
| `Universal Inbox` | `/admin/submissions` — single queue for all pending items |
| `banReason` | Firestore field explaining why a user was banned |
| `warningCount` | Number of warnings a member has received |
| FCM | Firebase Cloud Messaging — push notification service |
| VAPID | Web push encryption key (required for browser push) |

---

*AGENT 09 sign-off: Final index, table of contents, 5 quick reference cards, and glossary complete.*
