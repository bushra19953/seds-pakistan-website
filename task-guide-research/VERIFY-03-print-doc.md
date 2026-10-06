# VERIFY-03 — "Print Production & Material Procurement" document deep-read
Doc ID: `UHtT8yldnfIjWFmnnhGM` · Read: 2026-10-06 ~07:20 PKT via Firestore REST (`projects/seds-pakistan/databases/(default)/documents/tasks/UHtT8yldnfIjWFmnnhGM`)
`createTime`: 2026-10-04T06:43:18.286991Z · `updateTime`: 2026-10-05T15:53:24.947775Z (== submission moment; nothing written since)

## Complete field inventory (33 fields, verbatim)

| Field | Value |
|---|---|
| `title` | "Print Production & Material Procurement" |
| `status` | "submitted-for-review" |
| `report` | "https://docs.google.com/document/d/18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2/edit?usp=sharing&ouid=108789080876588241975&rtpof=true&sd=true" — **the ONLY URL on the document** |
| `description` | (full text) "WHAT: Procure 5 sets of the 4-Page Executive Meeting Portfolio and 3 standalone copies of the IST Room 204 Institutional Endorsement Letter from an executive digital print facility... **VERIFICATION: Photographic evidence of the procured print materials (pages and endorsement letters) and the matte-black presentation folders, including close-ups verifying paper GSM and print quality, must be uploaded. Receipt(s) for printing services and folder purchase must also be submitted.**" |
| `submittedAt` | "2026-10-05T15:53:19.448Z" (= Oct 5, 20:53 PKT) |
| `submittedBy` | "aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2" (Maira Batool) |
| `assigneeId` | "aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2" |
| `assigneeIds` | ["aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2", "njnWidUfROQTgb92mDWVoXguifR2"] |
| `assignerId` | "pLW0PuQCTAQHCNK1SfllVhPZdMz1" |
| `deadline` | "2026-10-04T19:00:00Z" (= Oct 5, 00:00 PKT) |
| `individualDeadline` | "2026-10-04T09:00:00Z" (= Oct 4, 14:00 PKT) |
| `penaltyPoints` | 5 (auto-deducted; submitted ~20h53m after `deadline`, way past `individualDeadline`) |
| `points` | 3 |
| `workflowBonusPoints` | 10 |
| `sequenceIndex` | 1 |
| `isCurrentStep` | false |
| `workflowId` | "wf_1791096197560_ugmmt1" |
| `workflowTitle` | "Executive 4-Page Portfolio & Institutional Endorsement Letter Procurement (5 Sets + 3 Letters)" |
| `workflowParticipantIds` | ["aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2"] |
| `workflowTags` | [] |
| `resources` | [] (empty) |
| `createdAt` | "2026-10-04T06:43:18.128Z" |
| `updatedAt` | "2026-10-05T15:53:19.448Z" (== `submittedAt`) |
| `recreatedFrom` | "XaJfv7jZquadzzOarG3k" |
| `chapterId` | null |
| `estimatedDuration` | null |
| `finalWorkflowCompletionBadgeId` | null |
| `guidance` | null |
| `projectId` | null |
| `releasedAt` | null |
| `role` | null |
| `stepSpecificBadgeId` | null |
| `workflowPriority` | null |

## Fields that are ABSENT (not null — not present at all)
- `hoursWorked` — absent. Confirmed: the submit page (`missions/[workflowId]/submit/[stepIndex]/page.tsx:106`) and task-detail dialog (`task-detail-dialog.tsx:314`) both save `hoursWorked`; PATCH zod schema accepts it (`src/app/api/tasks/route.ts:273`); the field is simply missing from this doc.
- `deliverableFiles` — absent. Schema + UI support it (route.ts:277, task-detail-dialog.tsx:704, submit page:109); nothing was uploaded/stored.
- `resourceLinks` — absent.
- No `submission` nested object, no `attachments`, no `statusHistory`, no `reviewerNotes`, no `feedback_text`, no resubmission fields, no version counters of any kind. No other arrays/objects besides `resources: []`, `assigneeIds`, `workflowParticipantIds`, `workflowTags: []`.

## Verdict
**CONFIRMED.** The document contains exactly one piece of submission content: the `report` field with a single Google Doc link (`18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2`). No hours logged, no files attached, no photo evidence, no receipts, no nested submission object, no review history. The task's own description demands photographic evidence of the print materials/folders (incl. close-ups verifying paper GSM) plus purchase receipts — **none of that exists anywhere on the document.**

Side observations (not verdict-relevant): `penaltyPoints: 5` was auto-deducted on submit (late). The stored `deadline` (2026-10-04T19:00:00Z) and `individualDeadline` (2026-10-04T09:00:00Z) do not match the Oct 5 20:00 PKT deadline in MEMORY.md — they still look like pre-swarm drifted values (a possible follow-up for the deadline worker, if not already covered).
