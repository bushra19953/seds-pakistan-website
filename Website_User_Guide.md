# Complete User Guide for SEDS Pakistan – Digital Hub

Welcome to the **SEDS Pakistan Digital Hub**, the central platform for Students for the Exploration and Development of Space (SEDS) in Pakistan. This guide provides a detailed walkthrough of every feature, from guest exploration to administrative management, ensuring a seamless experience for all space enthusiasts.

---

## 1. Introduction & Overview
The SEDS Pakistan website is a modular, high-performance platform designed to foster a community of space explorers, researchers, and engineers. It serves as a central repository for project tracking, educational resources, news, and member coordination.

**Key Achievements Users Can Reach:**
- Discover and contribute to national space projects.
- Access exclusive aerospace learning resources and podcasts.
- Apply for official membership through a structured induction process.
- Manage team tasks and earn "Efficiency" points through active contribution.

---

## 2. Getting Started (Sign Up & Login)

### Exclusive Google Authentication
For maximum security and a seamless experience, SEDS Pakistan primarily uses **Google Sign-In**. This eliminates the need for separate password management.

- **How to Acccess:** Click the **Login** or **Sign Up** buttons in the header.
- **Onboarding:** First-time users are automatically registered and assigned the `member` role upon their first Google login.

### Manual Registration ("Join The Mission")
Alternatively, users can register manually via the footer form on the homepage.
1. **Navigate** to the bottom of the home page to the "Join The Mission" section.
2. **Fill in Required Fields:**
   - **Full Name** (e.g., Ada Lovelace)
   - **Email** (Must be valid)
   - **Password** (Minimum 6 characters)
   - **University**
   - **Field of Study**
3. **Agreement:** You must read and checkbox the Terms and Conditions and Privacy Policy.
4. **Action:** Click "Join The Mission". You will receive a verification email.

[Screenshot: The Join The Mission form at the bottom of the home page]

### Email Verification
After manual registration, you will be redirected to a verification prompt.
- **Action:** Check your inbox for a verification link.
- **Note:** You cannot access the **Unified Profile** or **Induction** pages until your email is verified.

---

## 3. Understanding the Main Interface

### The Universal Header
The header provides quick access to all major sections:
- **Explore Dropdown:** About SEDS, Events, Leadership Timeline, 3D Gallery.
- **Learn Dropdown:** Blogs, Podcasts, Skills Directory.
- **Direct Links:** Projects, Community, Contact.
- **User Actions:** Dynamic buttons for **Admin** (if authorized), **Profile**, and **Theme Toggle**.

### Navigation Logic
- **Sticky Behavior:** The header automatically hides when you scroll down to maximize screen space and reappears when you scroll up.
- **Mobile View:** On mobile devices, the navigation collapses into a right-side drawer (Hamburger Menu). The "Contact" link is highlighted as a primary CTA button.

---

## 4. How to Discover & Search (Core Features)

### Projects Directory
The primary hub for ongoing research and initiatives.
- **Interface:** Search bar + Category filters (Technical, Logistics, Sponsorship, Ethics, Outreach).
- **Search Logic:** Matches titles and descriptions.
- **Project Cards:**
  - View project title, short summary, and category tags.
  - **Progress Tracker:** Displays the percentage of completed tasks (e.g., "75%").
  - **Links:** Quick access to GitHub repositories or Documentation.
- **Roadmap Dialog:** Clicking the progress bar opens a detailed roadmap showing task status (Pending, In Progress, Completed).

[Screenshot: Projects listing page with search filters and progress bars]

### Blog & News
Stay updated with aerospace insights.
- **Filters:** Search by keyword, browse by Category, or find posts by specific Authors.
- **Reading Experience:** Clean, markdown-rendered articles with reading time estimates and author snapshots.

---

## 5. Member Onboarding (Induction Flow)

The Induction process is the gateway to becoming an active member of SEDS Pakistan.
1. **Login Required:** You must be signed in with a verified email to apply.
2. **Application Form:** Accessible via the "Apply Now" CTA or `/induction`. 
3. **Multi-Stage Process:**
   - **Stage 1: Initial Application:** Submit your university details, skills, and motivation.
   - **Stage 2: Technical Evaluation:** Automated or manual assessment based on your field.
   - **Stage 3: Personality Fit:** Assessing cultural alignment.
   - **Stage 4: Final Interview:** Face-to-face or virtual interview with the core leadership.

[Screenshot: The induction application redirect page (Login Prompt)]

---

## 6. User Dashboard (Unified Profile)

The Unified Profile is your personal Mission Control. It is divided into several high-impact sections:

| Section | Purpose | Features |
| :--- | :--- | :--- |
| **Identity Hub** | Personal Brand | Bio, University, Skills (Capabilities), and Social Links. |
| **Mission Control** | Task Management | View **Assigned Tasks**, track due dates, and access **Task History**. |
| **My Team** | Hierarchy | View your place in the organization and your direct reports/leaders. |
| **Projects** | Contributions | Track the projects you are currently assigned to with deep links to detail pages. |
| **Credentials** | Recognition | View and verify earned **Certificates** and **Badges**. |

### Profile Optimization
- **Efficiency Score:** A real-time calculation of your task completion speed. Higher efficiency leads to faster role progression.
- **Points:** Earned through upvotes from leadership and successful task completion.

---

## 7. Admin Hub (Leadership Only)

Members with `admin` or higher roles have access to the **Admin Dashboard**, the "Brain" of the operation.

- **Analytics Dashboard:** Real-time metrics on Users, Projects, Blogs, and Events.
- **Recruitment Management:** Review pending applications, shortlist candidates, or send rejection notices.
- **Audit Logs:** A security-first log of every critical system action taken by admins.
- **Content Management:** 
  - **Blog/Event Editors:** Rich text editors for publishing new content.
  - **Announcements:** Broadcast site-wide alerts to all users.
  - **User Management:** Assign roles (Superadmin, Admin, Founder, etc.) and manage permissions.

---

## 8. How the System Works (Architecture Overview)

The platform is built on a modern, decoupled architecture:
- **Frontend:** Next.js 15 (App Router) for high-performance Server-Side Rendering (SSR).
- **Styling:** Tailwind CSS with a "Dark Space" aesthetic.
- **Real-time Engine:** Firebase Firestore for instant updates on tasks and notifications.
- **Security:** Role-Based Access Control (RBAC). Permissions are strictly enforced both on the client and in the database rules.
- **AI Integration:** Includes a (currently experimental) **Research Copilot** and AI-assisted task generation for leadership.

---

## 9. Tips, Best Practices & Troubleshooting

### Tips for New Members
- **Update your Skills:** Ensure your skills are accurate in your profile; this is how admins find contributors for new projects.
- **Check Notifications:** The bell icon in the header alerts you to new task assignments or announcement updates.

### Common Troubleshooting
- **Cannot access Induction?** Ensure your email is verified. Check the banner on your profile page.
- **Empty States:** If you see "No items found", it usually means that specific module (like Gallery or Events) is currently in a refresh cycle. Check back later!
- **Slow Loading?** The site uses "Lazy Loading" for heavy sections. If a section looks empty, wait a moment for the cosmic particles to align (data to fetch).

---

## 10. Summary & Conclusion
The SEDS Pakistan Digital Hub is more than just a website; it's a mission control for the next generation of Pakistani space leaders. By participating in tasks, contributing to projects, and engaging with learning resources, you are directly helping Pakistan reach for the stars.

**Reach for the heavens, one task at a time.**

---
*Created by Antigravity AI for SEDS Pakistan (2025)*
