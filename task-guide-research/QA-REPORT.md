# QA Report: Task-Submission-Guide.pdf

Date: 2026-10-05
PDF: `~/workspace/your_files/Task-Submission-Guide.pdf` (11 pages, 783KB)
Research: `task-guide-research/01-08`
Verdict: **PASS** (1 minor wording fix recommended, no blockers)

## Factual cross-check (all 8 research files)

| PDF claim | Research source | Result |
|---|---|---|
| P2: Mission Control section, Google sign-in, ACTIVE DIRECTIVES badge | 01 | ✅ |
| P2: Status filters (ALL/STANDBY/ACTIVE/IN REVIEW/OVERDUE), YOU badge, lightning border | 01, 06 | ✅ |
| P2: "All Systems Nominal" empty state | 01 | ✅ |
| P3: Status colors/meanings, Bounty, Ends In countdown, Attachments, Operational Briefing sections | 01, 02 | ✅ |
| P4 Path A: SITREP panel, Execution Log, hours stepper, Transmit pill, TRANSMIT FOR REVIEW vs SUBMIT SITREP | 01, 02 | ✅ |
| P4 WARNING: TRANSMIT SUCCESS quick button submits instantly with generic note | 02, 03, 08 | ✅ |
| P4 Path B: personal link, Work Report, Hours, Deliverable Links, Drive upload, Save Progress | 04 | ✅ |
| P8: IN REVIEW lock, reviewer notified, validation queue, approve/revision, Recall | 02, 05 | ✅ |
| P9: Awaiting Your Validation box, Review Submission, Approve/Request Revision, who-can-review rules, no self-approval | 05 | ✅ |
| P10: NO reminders, NO miss alerts, task turns red | 06 | ✅ (matches: remind-deadlines cron unscheduled, overdue sends nothing) |
| P11: confetti-on-failure bug, badge-is-proof rule, not-assignee, IN REVIEW filter, recall, phone tap warning | 03, 08 | ✅ |

## Issues found

### 1. (Minor, wording) P10 says "five places", lists four
Text: "Your deadline is shown in at least five places."
Bullets listed: Profile, Mission page, Submit page, PDF brief = 4.
Research 06 lists a 5th: WhatsApp share text ("Deadline: 5 Oct 2026" inline).
Fix: either add bullet "- Shared links: when a task link is shared on WhatsApp, the deadline is in the message." or change "five" to "four".

### 2. (Nit, visual) P5 screenshot is small
The mission-page screenshot renders at ~40% page width with large empty space below. Readable but could be larger. Not blocking.

## Coverage check
- Both submit paths: ✅ (P4)
- Reviewer flow: ✅ (P9)
- Known transmit bug (confetti on failure): ✅ (P4 WARNING + P11)
- Deadlines: ✅ (P10)
- Troubleshooting: ✅ (P11)
- Mobile tap warning: ✅ (P11)

## Readability
Language is plain and direct. Military terms (SITREP, Transmit, Directive, Mission Control) are the site's actual UI labels and are explained where first used. No unexplained jargon. Suitable for non-technical users.

## Visual QA (rendered P1, P4, P5, P11 at 100dpi)
- No overlapping text, no broken images, no contrast failures.
- Dark theme consistent across pages. TIP (green) and WARNING (red) callouts render correctly.
- Footer pagination correct on all pages.

## Not re-verified
- Live E2E submit (needs authenticated session; research 07 notes the same limitation).
- Phone rendering (research 08 was static audit only).
