# STAGE 3 — PAGE BREAKDOWN: PROFILE & USER HUB
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 6 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** The profile page (`/profile`) is the user's permanent home. It reflects their rank, points, badges, and history. This MD focuses on the profile structure, editability, and visibility rules.

---

## 👤 Page: User Profile (`/profile`)

**Files:** `src/app/profile/page.tsx`, `src/app/profile/[uid]/page.tsx`  
**Visibility:** 
- **Own Profile:** Full edit access + private data (WhatsApp, Warnings).
- **Other Profiles:** Public demographic info + achievements.

---

## Profile Sections

### 1. Identity Header
- **Avatar:** User-uploaded photo or Google profile pic default.
- **Display Name:** Editable name (validated for profanity).
- **Role Badge:** Visible role (e.g., "Vice President", "Member").
- **Chapter Info:** Linked SEDS chapter (e.g., "IST", "LUMS").

### 2. Achievement Stats
- **Points:** Total points earned from tasks and contributions.
- **Badges:** Visual tokens awarded by admins for specific milestones.
- **Position:** Current official title in the SEDS Pakistan hierarchy.

### 3. Personal Bio & Social Links
- **Bio:** Markdown-supported short description of the user.
- **Academic Info:** University, Field of Study, Graduation Year.
- **Socials:** GitHub, LinkedIn, Website URLs (clickable).

### 4. Private Information (Self/Admin Only)
- **WhatsApp:** Direct contact for organizational communication.
- **Warning Count:** Discrete indicator of internal policy violations.
- **Ban Status:** Hidden from public, only visible if `isBanned: true`.

---

## ✏️ Edit Profile Flow

1. User visits `/profile` and clicks "Edit Profile".
2. **Form Interaction:**
   - Text fields: Name, Bio, University.
   - Dropdowns: Field of study, Chapter.
   - File Upload: New profile picture (Firebase Storage).
3. **Submission:**
   - Client validates fields.
   - `PATCH /api/profile` updates Firestore `users/{uid}`.
4. **Result:** Changes reflected immediately in UI via Firestore real-time listener.

---

## 🏢 Profile Admin (`/admin/users/[id]`)

**Access:** President / Superadmin / HR Director.  
**Powers:**
- **Manually adjust points:** Overwrite point totals.
- **Award/Revoke Badges:** Grant specific honors.
- **Change Chapter:** Move members between university chapters.
- **View Warning History:** Detailed log of all warnings issued.
- **Ban/Unban:** Set `isBanned` flag with a mandatory reason.

---

*AGENT 03 sign-off: Profile and user hub page fully documented.*
