# UX Audit: Submitter-Facing Submission Flow (UX-01)

Worker 1 audit, 2026-10-06. Investigation only, no code changed.

Scope: `src/components/profile/assigned-tasks.tsx` (mission cards, expanded SITREP form, TRANSMIT two-step flow, `handleQuickAction`, `handleFullUpdate`) and `src/components/profile/task-detail-dialog.tsx` (Mission Report tab).

Skills check: ui-ux-pro-max, web-design-guidelines, and clarify are NOT installed in ~/workspace/skills/. Used the lenses from humanizer (v3.1.0) and frontend-design ("name things by what users will understand in simple language", "a CTA says exactly what happens when it is used", "an action keeps the same name through the whole flow"), plus standard UX heuristics.

Root cause summary: Maira's confusion ("couldn't figure out what file to upload where and how to submit ... how to lock it for review") traces to three systemic causes. (A) There is no file upload control in the submitter flow at all; deliverables are paste-a-link only, and only in one of two forms. (B) One action (submit for review / lock) wears five different names across two competing forms. (C) Military jargon ("SITREP", "TRANSMIT", "Tactical") replaces plain verbs, so a first-timer never learns the mental model.

## Confusion points

1. One action, five names. The same lock-for-review action is called "TRANSMIT SUCCESS" (assigned-tasks.tsx:425), "Transmit" pill (assigned-tasks.tsx:558-560), "TRANSMIT FOR REVIEW" (assigned-tasks.tsx:595), "SUBMIT INTELLIGENCE (REVIEW)" select option (task-detail-dialog.tsx:773), and "Transmit Mission Update" button (task-detail-dialog.tsx:792), so a first-timer cannot tell these are the same step. Fix: use one verb everywhere, e.g. "Submit for review".

2. "TRANSMIT SUCCESS" names an outcome, not the action. It does not say it locks the task for review or that a written report is required first (assigned-tasks.tsx:424-425), so the most prominent button invites a blind click. Fix: label it "Submit for review" with subtext "locks your report until the reviewer decides".

3. No file upload exists in the submitter flow. "Artifact Links (Deliverables)" is a bare textarea for pasting links (task-detail-dialog.tsx:787), and the card quick-transmit path (`handleQuickAction`, assigned-tasks.tsx:269) submits report text only with no deliverable field at all, which matches Maira's "confusing to see what file to upload where". Fix: add a real file-upload control to both submitter forms instead of link pasting only.

4. The deliverables placeholder shows a literal backslash-n. `placeholder="https://github.com/...\nhttps://drive.google.com/..."` in a JSX attribute renders "\n" as visible text (task-detail-dialog.tsx:788), so the hint looks broken and never says one link per line. Fix: fix the placeholder to read "Paste one link per line".

5. The pencil icon opens the wrong surface. The pencil button (assigned-tasks.tsx:443) suggests editing, but opens a read-mostly dialog whose default tab is "Briefing" (assigned-tasks.tsx:668), while the submission form hides under the "Mission Report" tab. Fix: change the icon to an eye or document icon, or default assignees to the Mission Report tab.

6. Military jargon replaces plain verbs: "TACTICAL SITREP", "SITREP", "Execution Log", "TRANSMIT", "Mission Command", "Operational Briefing". A first-timer does not know SITREP means "write what you did". Fix: rename to plain words like "Your report" and "Submit for review".

7. Action and inputs live in different places. The submit button sits on the collapsed card (assigned-tasks.tsx:424) while the report field only exists after expanding the card (the whole card is the toggle, assigned-tasks.tsx:366), so the button is separated from what it needs. Fix: keep the report field and submit button together, or auto-expand the card when it is the user's turn.

8. The report requirement is enforced only after the click. Nothing on the button says a written report is required; the user finds out via error toast "Write your SITREP report below before transmitting." (assigned-tasks.tsx:276). Fix: mark the field required with helper text and keep the button disabled until a report exists.

9. Dialog toast lies about what happened. `handleUpdateMission` (task-detail-dialog.tsx:314-333) toasts "Mission Report Transmitted" (line 331) even when the status select was left at STANDBY (a draft save), and the button always says "Transmit Mission Update" (line 792). Fix: make the toast and button label match the chosen status, e.g. "Draft saved" vs "Submitted for review".

10. Status labels disagree across surfaces: card pills "Standby / Active / Transmit" (assigned-tasks.tsx:558-560), dialog options "STANDBY (TO DO) / ACTIVE (IN PROGRESS) / SUBMIT INTELLIGENCE (REVIEW)" (task-detail-dialog.tsx:771-773), the read badge says "In Review", and the steps list renders the raw machine value "in-progress" (assigned-tasks.tsx:155). Fix: one canonical label set across both forms and lists.

11. The card's expanded form has no deliverables field (assigned-tasks.tsx:540-598), so the most discoverable submit path omits the very thing reviewers check. Fix: add the deliverables/upload field to the card's expanded form too.

12. The lock concept is never explained before submit. The copy "Transmitted ... awaiting review ... Locked while the reviewer decides" only appears after submitting, so Maira's "how to lock it for review" had no answer in the UI beforehand. Fix: add one line under the submit button: "Submitting locks your report until the reviewer approves or asks for changes."

13. "Recall submission" is opaque vocabulary (assigned-tasks.tsx:536, task-detail-dialog.tsx:811); a first-timer may not realize it means un-submit and keep editing. Fix: rename to "Withdraw and keep editing".

14. Entry points disagree on where the work is. QR deep links open the dialog on the Mission Report tab, but the card's pencil opens on Briefing (assigned-tasks.tsx:668). Fix: open the dialog on the Mission Report tab whenever the viewer is the assignee.

15. Machine internals shown to submitters: the "DIRECTIVE # xxxxxxxx" ID badge and raw status strings carry no meaning for the person doing the work. Fix: hide internal IDs and raw status values from the assignee view.

16. "Restricted to mission-critical personnel." (assigned-tasks.tsx:603) tells a blocked user nothing about who can submit or why. Fix: state it plainly, e.g. "Only the assigned person can submit this task."

17. After transmitting, the assignee cannot see what they sent. The locked panel shows only "Transmitted — awaiting review"; the only way to view the submission is to recall it first. Fix: show the assignee their own submitted report and deliverables inside the locked panel.

18. No submit checklist ties briefing to submission. The WHAT/HOW/STANDARDS/VERIFICATION briefing sections are collapsed accordions never connected to what counts as done, so a first-timer guesses what "done" means. Fix: surface the VERIFICATION checklist inside the submission panel.

19. Success toasts drift in vocabulary: `handleFullUpdate` toasts "Operational Log Saved." (assigned-tasks.tsx:348) whether the user saved a draft or transmitted. Fix: toast per outcome, e.g. "Draft saved" vs "Submitted for review".

20. The TRANSMIT SUCCESS button vanishes for co-assignees on non-current steps (`isYourTurn` requires `isCurrentStep`) with no explanation of why there is no way to submit. Fix: show a disabled state or a note saying which step is currently submittable.

21. "Hours Logged" stepper (assigned-tasks.tsx:573-581) defaults to 0.0 with no explanation of what the number is for. Fix: add helper text, e.g. "Rough time you spent; recorded on your activity log".

22. No late-submission warning at submit time. The platform deducts penalty points for late approval, but nothing near the submit button warns that submitting past the deadline costs points. Fix: show the deadline and a plain note about the late penalty next to the submit button.
