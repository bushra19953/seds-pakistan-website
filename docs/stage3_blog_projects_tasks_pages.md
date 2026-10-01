# STAGE 3 — PAGE BREAKDOWN: BLOG, PROJECTS, TASKS, ABOUT, APPLY & MORE
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGES 7–11)
**AGENT 03 – PAGE BUTCHER**

---

## 📰 Page: Blog (`/blog` and `/blog/[slug]`)

**Files:** `src/app/blog/` directory  
**Visibility:** Public  
**Purpose:** SEDS knowledge hub — articles, project updates, announcements

### Blog Listing (`/blog`)
- Filter by category, tag, author
- Search by title
- Pagination (server-side rendered)

### Blog Post (`/blog/[slug]`)
- Full markdown/rich text article
- Author info, published date, tags
- Related posts section
- Comment/reaction section (if enabled)

### Blog Status Flow
```
Draft → Under Review → Published → Archived
```

### Blog RBAC
| Action | Roles |
|---|---|
| Create blog | manageBlogs roles OR own author |
| Edit any blog | manageBlogs roles |
| Edit own blog | manageOwnBlogs roles (chair_marketing, marketing_head) |
| Publish/Archive | manageBlogs roles |
| Delete | manageBlogs roles |

### Admin Blog Management (`/admin/blog` and `/admin/blogs/`)
- Post list with status filters
- Click post → full editor (`/admin/blogs/[id]`)
- Rich text / markdown editor
- Cover image upload
- Tag/category assignment
- Author assignment (for drafts by staff)

---

## 🚀 Page: Projects (`/projects`)

**Visibility:** Public  
**Purpose:** Showcase SEDS technical projects (Rocketry, CubeSat, Rover, etc.)

### Projects Listing
- Cards for each project with status, team, description
- Filter by: status (active/completed/upcoming), team type
- Click → project detail page

### Project Detail
- Full project description, milestones, team composition
- Progress indicator
- Links to related events/blogs

### Admin Projects (`/admin/projects`)
- Create/edit/archive projects
- Assign team leads and members
- Set project milestones and status
- Link to tasks

---

## ✅ Page: Tasks (`/tasks`)

**Visibility:** Signed-in members  
**Purpose:** Personal task dashboard — view assigned tasks and submit completions

### Task System Overview
```
Admin creates task in /admin/tasks →
  Assigned to member(s) OR role(s) →
  Member sees task in /tasks →
  Member submits completion →
  Admin/supervisor reviews in /admin/submissions →
  If approved: member earns points
  If rejected: member may receive warning
```

### Task Fields (as seen by member)
| Field | Description |
|---|---|
| Title | Task name |
| Description | What needs to be done |
| Assigned By | Which admin created it |
| Due Date | Deadline |
| Points Value | Points earned on completion |
| Status | pending / submitted / approved / rejected |
| Submission | Text or file upload |

### Task Admin (`/admin/tasks`)
- Create tasks with title, description, due date, point value
- Assign to specific users OR roles
- Use AI task generator (Gemini) to suggest tasks
- View completion submissions
- Approve/reject with notes
- Issue warnings for missed deadlines (via `/admin/defaulters`)

---

## 📖 Page: About (`/about`)

**Visibility:** Public  
**Sections:**
1. Mission & Vision
2. Our Story
3. Leadership Team (current)
4. Advisory Board
5. Chapter Network Map
6. Partner Organizations

**Admin Control:** `/admin/hierarchy` and `/admin/positions` for team management

---

## 📝 Page: Apply (`/apply`)

**Visibility:** Public (but requires sign-in to submit)  
**Purpose:** Induction application for new members

### Application Flow
```
1. Guest visits /apply
2. Clicks "Apply Now" → prompted to sign in if not authenticated
3. Signs in via Google OAuth
4. Fills application form:
   - Personal info (name, university, field of study)
   - Why SEDS? (motivation statement)
   - Skills/experience
   - Which chapter/team interested in
   - WhatsApp number
5. Submits → stored in Firestore `induction_applications/{id}`
6. HR Director sees it in /admin/submissions (Universal Inbox)
7. Application reviewed → status: pending → shortlisted | rejected
8. If shortlisted → Invite sent via /admin/applications
9. Guest receives invite email → accepts → becomes member
```

---

## 🏛️ Page: Leadership History (`/leadership-history`)

**Visibility:** Public  
**Purpose:** Archive of all past SEDS leadership cycles

### Content
- Chronological list of past presidents, VPs, secretaries, directors
- Photos, terms, key achievements
- Admin control: `/admin/timeline` for adding/editing leadership entries

---

## 🔐 Page: Auth (`/auth` and `/signup`)

### Auth Pages
| Path | Purpose |
|---|---|
| `/auth` | Google OAuth sign-in prompt |
| `/signup` | First-time user welcome |
| `/welcome` | Post-signup onboarding |
| `/banned` | Banned user landing |
| `/invite/[token]` | Invite acceptance |

### Auth Flow
```
User clicks "Sign In" →
  Google OAuth popup →
  Firebase Auth creates/retrieves user →
  Role fetched from Firestore roles/{uid} →
  If isBanned → redirect /banned →
  If no role → guest →
  If role exists → appropriate dashboard
```

---

## 📡 Page: Verify (`/verify/[ticketId]`)

**Visibility:** Public  
**Purpose:** QR code scan verification for event tickets

### Verification Flow
```
Scanner scans QR on ticket →
visits /verify/[ticketId] →
System fetches ticket from Firestore →
Shows: attendee name, event, status (CONFIRMED/INVALID/CANCELLED) →
Admin/volunteer marks attendee as arrived
```

---

## Additional Pages Quick Reference

| Page | Path | Access | Purpose |
|---|---|---|---|
| Community | `/community` | Members | Member forum/discussion |
| Competitions | `/competitions` | Public | Competition listings |
| Contact | `/contact` | Public | Contact form |
| Donate | `/donate` | Public | Donation page |
| Gallery | `/gallery` | Public | Photo/media gallery |
| Resources | `/resources` | Members | Opportunities & resources |
| Skills | `/skills` | Members | Skill building content |
| Timeline | `/timeline` | Public | SEDS milestone timeline |
| Workshops | `/workshops` | Public | Workshop listings |
| Podcast | `/podcast` | Public | SEDS podcast episodes |
| Privacy Policy | `/privacy-policy` | Public | Legal |
| Terms | `/terms` | Public | Terms of service |

---

*AGENT 03 sign-off: All major pages documented. 11+ page MDs delivered.*
