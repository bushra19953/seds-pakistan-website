# STAGE 3 — PAGE BREAKDOWN: PROJECTS SHOWCASE
## v11.0 SWARM DEPLOYED — STAGE 3/15 (PAGE 9 of 11)
**AGENT 03 – PAGE BUTCHER**

---

> **Thinking (COT):** Technical projects (Rocketry, Rover, CubeSat) are the "proof of work" for SEDS. This MD details how projects are displayed and managed.

---

## 🚀 Page: Projects (`/projects`)

**File:** `src/app/projects/page.tsx`  
**Visibility:** Public.  
**Purpose:** Presenting active and completed technical milestones of SEDS Pakistan.

---

## User Interaction

### 1. Project Cards
- **Elements:** High-res image, project name, current status (Active / Milestone Hit / Completed / Ongoing).
- **Domain Badge:** Tags for Rocketry, E-Lab, C-Lab, etc.
- **Progress Bar:** Visual indicator of project stage completeness.

### 2. Project Detail View
- **Description:** Motivation, technical specs, and goal statements.
- **Team List:** Link to profiles of the leads and members involved.
- **Milestones:** Chronological list of project achievements.

---

## 🛠️ Admin Project Controls (`/admin/projects`)

**Access:** `manageProjects` permission roles (`projects_director`, `chair_projects`).  
**Purpose:** Track and update the state of national projects.

### Management Options
- **Project Editor:** Update status strings, progress percentages, and milestone lists.
- **Member Assignment:** Search for users and link them to the project team.
- **Media Gallery:** Link specific Firebase Storage images to the project showcase.

---

## 🔄 Interaction with Tasks
- Projects are linked to the **Task System**.
- Admins can create tasks *specific* to a project.
- Member completion of project-linked tasks can auto-increment the project's progress bar (if logic enabled).

---

*AGENT 03 sign-off: Projects showcase page fully documented.*
