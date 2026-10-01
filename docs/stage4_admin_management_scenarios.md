# STAGE 4 — SCENARIO ANALYSIS: ADMIN MANAGEMENT
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO 4 of 8)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** Admin operations (Banning, Role Assignment, Submissions) are the "back-office" power moves. This MD details the high-impact scenarios for site leadership.

---

## ⚙️ Scenario 4.1: Assigning a New National Director

**Actor:** `president_national` or `superadmin`.  
**Trigger:** Structural change in the organization.

1. **Target:** Admin navigates to `/admin/users` and searches for "Ahmed".
2. **The Edit:** Admin clicks "Edit Role" on Ahmed's profile card.
3. **Selection:** Admin selects `projects_director` from the dropdown list.
4. **Confirmation:** Admin clicks "Save Changes".
5. **The Backend:**
   - API `PATCH /api/users/[uid]/role` updates Firestore.
   - Audit Log records: `President updated Ahmed to Projects Director`.
6. **The Handover:** Ahmed is notified. **CRITICAL:** Ahmed must sign out and back in for his new permissions to activate.

---

## ⚙️ Scenario 4.2: Handling a Policy Violation (Banning)

**Actor:** `hr_director` or `superadmin`.  
**Trigger:** User consistently fails tasks or violates code of conduct.

1. **Initiation:** Admin clicks "Ban User" on the target's profile.
2. **Justification:** Admin enters "Repeated failure to submit project milestones after 3 warnings."
3. **The Execute:** Admin confirms. 
   - `users/{uid}.isBanned` → `true`.
   - All session tokens invalidated.
4. **The Block:** User is immediately logged out. Next attempt to visit the site redirects them to `/banned`, showing only the reason for their expulsion.

---

## ⚙️ Scenario 4.3: Processing Recruitment In-Bulk

**Actor:** `hr_director`.  
**Trigger:** National Induction Drive deadline passed.

1. **Aggregation:** Admin visits `/admin/submissions` (Applications tab).
2. **The Filter:** Sorts by "University: IST" to process chapter-by-chapter.
3. **Review:** Clicks a candidate → Reads motivation → Clicks **"Shortlist"**.
4. **The Invite:** For all shortlisted candidates, clicks "Send Invite Email".
5. **Result:** Tokens are generated in the `invites` collection; applicants receive official entry links.

---

*AGENT 04 sign-off: Admin management scenarios fully documented.*
