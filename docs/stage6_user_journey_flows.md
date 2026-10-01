# STAGE 6 — USER JOURNEY FLOWS
## v11.0 SWARM DEPLOYED — STAGE 6/15
**AGENT 07 – USER JOURNEY MAPPER**

---

> **Thinking (COT):** Real-life users don't read docs — they navigate by intent. These journeys map the most common real-world paths through the site for each role, so any user can operate without a walkthrough.

---

## 🗺️ Journey 1: New Guest → Becomes a Member

```mermaid
flowchart TD
    A["Visits seds.pk (Guest)"] --> B["Browses Home Page"]
    B --> C["Gets inspired by projects/events"]
    C --> D["Clicks 'Apply Now'"]
    D --> E{Signed In?}
    E -->|No| F["Google OAuth Login"]
    F --> G["Now guest user"]
    E -->|Yes| G
    G --> H["Fills application form at /apply"]
    H --> I["Submits application"]
    I --> J["Application pending in /admin/submissions"]
    J --> K["HR Director reviews"]
    K --> L{Decision}
    L -->|Rejected| M["Email: Application Rejected"]
    L -->|Shortlisted| N["Admin sends invite"]
    N --> O["Guest receives invite email"]
    O --> P["Clicks /invite/token link"]
    P --> Q["Signs in with Google"]
    Q --> R["Role auto-set to 'member'"]
    R --> S["Redirected to /welcome"]
    S --> T["Full member access granted"]
```

---

## 🗺️ Journey 2: Member Registers for a Paid Event

```mermaid
flowchart TD
    A["Member visits /events"] --> B["Finds paid event"]
    B --> C["Clicks event → /events/slug"]
    C --> D["Sees event details + price"]
    D --> E["Clicks 'Register'"]
    E --> F{Has linked productId?}
    F -->|Yes| G["Redirected to /checkout?productId=X"]
    F -->|No| H["Manual payment modal"]
    G --> I["Reviews product + price"]
    I --> J["Enters bank transfer + uploads receipt"]
    J --> K["Enters Transaction ID"]
    K --> L["Submits order"]
    L --> M["Order created: status=pending"]
    M --> N["Admin receives notification"]
    N --> O["Admin verifies receipt in /admin/orders"]
    O --> P{Verified?}
    P -->|Yes| Q["Order confirmed"]
    P -->|No| R["Order rejected → member notified"]
    Q --> S["Event registration confirmed"]
    S --> T["Member receives ticket via email"]
    T --> U["Downloads PDF ticket"]
```

---

## 🗺️ Journey 3: Admin Creates & Publishes an Event

```mermaid
flowchart TD
    A["Admin logs in → goes to /admin/events"] --> B["Clicks 'New Event'"]
    B --> C["Fills event form"]
    C --> D["Sets status: 'draft'"]
    D --> E["Saves draft"]
    E --> F["Previews on /events page (draft not public)"]
    F --> G{Ready to publish?}
    G -->|No| H["Continue editing"]
    G -->|Yes| I["Changes status to 'published'"]
    I --> J["Sets visibility: public or members"]
    J --> K{Paid event?}
    K -->|Yes| L["Creates Store product in /admin/store"]
    L --> M["Links productId to event"]
    K -->|No| N["Skips store setup"]
    M --> O["Designs ticket in Live Ticket Studio"]
    N --> O
    O --> P["Toggles registrationOpen = true"]
    P --> Q["Optionally toggles showInTicker = true"]
    Q --> R["Event live at /events/slug"]
    R --> S["Home page ticker shows it (if toggled)"]
    S --> T["Push notification sent to all subscribers"]
```

---

## 🗺️ Journey 4: Admin Manages Induction Applications

```mermaid
flowchart TD
    A["HR Director logs in → /admin/submissions"] --> B["Sees Universal Inbox"]
    B --> C["Clicks 'Applications' tab"]
    C --> D["Lists all pending applications"]
    D --> E["Clicks an application"]
    E --> F["Views: name, university, motivation, skills"]
    F --> G{Decision}
    G -->|Pass| H["Marks as 'Shortlisted'"]
    G -->|Fail| I["Marks as 'Rejected' + reason"]
    H --> J["Sends invite from applications page"]
    J --> K["Invite email sent to applicant"]
    K --> L["Applicant accepts → becomes member"]
    I --> M["Rejection email sent automatically"]
```

---

## 🗺️ Journey 5: Member Completes a Task & Earns Points

```mermaid
flowchart TD
    A["Member logs in → visits /tasks"] --> B["Sees assigned task card"]
    B --> C["Reads task: title, description, due date, points"]
    C --> D["Completes work externally or in-app"]
    D --> E["Clicks 'Submit Completion'"]
    E --> F["Enters submission text + optional file"]
    F --> G["POST /api/tasks/id/submit"]
    G --> H["Task status → 'submitted'"]
    H --> I["Admin sees in /admin/submissions → Tasks tab"]
    I --> J{Admin Decision}
    J -->|Approved| K["Member earns points"]
    J -->|Rejected| L["Member notified with reason"]
    K --> M["Profile points updated"]
    M --> N["Leaderboard ranking updated"]
    N --> O["Badge potentially awarded if milestone hit"]
```

---

## 🗺️ Journey 6: Superadmin Sets Up Financial System

```mermaid
flowchart TD
    A["Superadmin logs in → /admin/store"] --> B["Creates product categories"]
    B --> C["Creates products for events, chapters, donations"]
    C --> D["Sets prices, stock, currency (PKR)"]
    D --> E["Goes to /admin/seed (Financial Setup)"]
    E --> F["Seeds default products if not already done"]
    F --> G["Links event products to events in /admin/events"]
    G --> H["Tests checkout flow as a regular user"]
    H --> I["Verifies order appears in /admin/orders"]
    I --> J["Confirms payment manually → order status updated"]
    J --> K["Financial system operational"]
```

---

## 🗺️ Journey 7: Guest Browses Public Content (No Sign-In)

```mermaid
flowchart TD
    A["Visits seds.pk"] --> B["Home: hero, ticker, events, projects"]
    B --> C["Clicks on an event → /events/slug"]
    C --> D{Public event?}
    D -->|Yes| E["Sees full event details"]
    D -->|No| F["Sees blurred/locked card"]
    E --> G{Wants to register?}
    G -->|Yes| H["Clicks Register → prompted to sign in"]
    H --> I["Google OAuth → guest role → can register"]
    G -->|No| J["Continues browsing"]
    J --> K["Visits /blog, /projects, /about, /gallery"]
    K --> L["Finds apply CTA → visits /apply"]
    L --> M["Submits application as non-member"]
```

---

*AGENT 07 sign-off: 7 complete user journey flows with mermaid diagrams for all major roles and scenarios.*
