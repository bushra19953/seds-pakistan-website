# Data Origin and Architectural Hierarchy

This document provides a hierarchical, top-down view of how data flows through the SEDS Pakistan application - from its origin in Firebase Firestore through administrative control panels to public-facing displays.

## 1. The Foundation: Data Origin (Firebase Firestore)

All application data originates in these primary Firestore collections:

- **`users`**: Stores all user profile information including authentication data, personal details, and role assignments
- **`roles`**: Contains user permission levels (superadmin, admin, team_leader, blog_writer, member, guest)
- **`applications`**: Member induction applications with personal info, skills, portfolio, and review status
- **`projects`**: Project data including team members, status, descriptions, and media assets
- **`blogs`**: Blog posts with content, author information, publication status, and metadata
- **`events`**: Event details including dates, locations, registration info, and attendee management
- **`workshops`**: Workshop information with registration links, schedules, and participant tracking
- **`resources`**: Resource library items with categorization and access controls
- **`audit_logs`**: Complete audit trail of all administrative actions and system events
- **`page_content`**: Dynamic content for homepage sections and other customizable page elements
- **`pageVisits`**: Analytics data tracking page visits and user engagement metrics
- **`invites`**: Invitation codes for shortlisted applicants to join the organization

## 2. The Control Layer: Data Creation & Management (Admin Panel)

Administrators control Firestore collections through dedicated management interfaces:

```
Firebase Firestore
├── users (Collection)
│   ├── **Controls:** `/admin/users` (User Management)
│   └── **Controls:** `/admin/roles` (Role Assignment)
├── applications (Collection)
│   └── **Controls:** `/admin/applications` (Application Review & Shortlisting)
├── projects (Collection)
│   └── **Controls:** `/admin/projects` (Project Management)
│   └── **Controls:** `/projects/new` (User Project Creation)
├── blogs (Collection)
│   └── **Controls:** `/admin/blogs` (Blog Management)
│   └── **Controls:** `/admin/blogs/new` (Create New Blog)
├── events (Collection)
│   └── **Controls:** `/admin/events` (Event Management)
│   └── **Controls:** `/admin/events/new` (Create New Event)
├── workshops (Collection)
│   └── **Controls:** `/admin/workshops` (Workshop Management)
│   └── **Controls:** `/admin/workshops/new` (Create New Workshop)
├── resources (Collection)
│   └── **Controls:** `/admin/resources` (Resource Management)
├── page_content (Collection)
│   └── **Controls:** `/admin/pages` (Page Content Management)
├── audit_logs (Collection)
│   └── **Controls:** `/admin/audit-logs` (Audit Log Viewer)
└── pageVisits (Collection)
    └── **Controls:** `/admin/analytics` (Analytics Dashboard)
```

## 3. The Presentation Layer: Public Data Display

Public-facing pages read and display data from Firestore collections:

```
Firebase Firestore
├── projects (Collection)
│   ├── **Controls:** `/admin/projects` (Admin Page)
│   ├── **Displays on:** `/projects` (Public Projects Listing)
│   ├── **Displays on:** `/projects/detail/[slug]` (Individual Project Pages)
│   └── **Displays on:** `/` (Homepage Featured Projects Section)
├── blogs (Collection)
│   ├── **Controls:** `/admin/blogs` (Admin Page)
│   ├── **Displays on:** `/blog` (Public Blog Listing)
│   ├── **Displays on:** `/blog/[slug]` (Individual Blog Posts)
│   └── **Displays on:** `/` (Homepage Latest Blog Posts)
├── events (Collection)
│   ├── **Controls:** `/admin/events` (Admin Page)
│   ├── **Displays on:** `/events` (Public Events Listing)
│   ├── **Displays on:** `/events/[slug]` (Individual Event Pages)
│   └── **Displays on:** `/` (Homepage Upcoming Events Section)
├── workshops (Collection)
│   ├── **Controls:** `/admin/workshops` (Admin Page)
│   ├── **Displays on:** `/workshops` (Public Workshops Listing)
│   └── **Displays on:** `/workshops/detail/[slug]` (Individual Workshop Pages)
├── users (Collection)
│   ├── **Controls:** `/admin/users` (Admin Page)
│   ├── **Displays on:** `/profile/[uid]` (Public User Profiles)
│   └── **Displays on:** `/about` (Team Members Display)
├── page_content (Collection)
│   ├── **Controls:** `/admin/pages` (Admin Page)
│   └── **Displays on:** `/` (Homepage Dynamic Content Sections)
└── pageVisits (Collection)
    └── **Displays on:** `/admin/analytics` (Admin Analytics Dashboard)
```

## 4. Special Case: User-Generated Data

The induction application system represents a unique data flow where regular users create data that flows to admin review:

```
User-Generated Data Flow
├── **User** at `/induction` (Application Form)
│   ├── **Creates documents in:** `applications` (Collection)
│   ├── **Auto-saves to:** `drafts` (Temporary Collection)
│   └── **Uploads files to:** Firebase Storage (Resumes)
├── **Admin** at `/admin/applications` (Review Dashboard)
│   ├── **Reads from:** `applications` (Collection)
│   ├── **Updates:** Application status (pending → shortlisted/rejected)
│   ├── **Creates:** `invites` (Collection) for shortlisted candidates
│   └── **Logs actions to:** `audit_logs` (Collection)
└── **Shortlisted User** receives invite link
    ├── **Creates:** `users` profile document
    ├── **Receives:** `roles` assignment
    └── **Gains access:** Member-only features
```

## Data Lifecycle Summary

### Content Creation Flow:
1. **Origin**: Data is created in Firebase Firestore collections
2. **Control**: Administrators manage content through `/admin/*` interfaces
3. **Publication**: Content status changes (draft → published/active)
4. **Display**: Public pages fetch and display published content
5. **Analytics**: Page visits and user interactions are tracked

### User Application Flow:
1. **Submission**: User submits application at `/induction`
2. **Storage**: Application data stored in `applications` collection
3. **Review**: Admin reviews at `/admin/applications`
4. **Decision**: Admin updates status and creates invites
5. **Onboarding**: Shortlisted users receive roles and access

### Audit Trail:
- All administrative actions are logged to `audit_logs`
- User applications create comprehensive audit trails
- Role assignments and permission changes are tracked
- Content modifications are recorded with timestamps and actor information

This architecture ensures data integrity, provides clear accountability, and enables comprehensive tracking of all system activities from creation through public display.