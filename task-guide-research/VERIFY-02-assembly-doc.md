# VERIFY-02: "Assembly, 5-Point Quality Control & Final Delivery" — Full Field Inventory

- **Task doc ID:** `z20ZnLAPd3q8ZWRPnRVr` (collection `tasks`)
- **Read method:** Firestore REST API, unauthenticated (no API key needed — the egress proxy in this sandbox drops requests carrying a `?key=` query param with an empty reply; the document is readable without it, consistent with the unauthenticated-read rule for task docs with non-null `workflowId`).
- **Read at:** 2026-10-06 ~07:25 PKT
- **Document path:** `projects/seds-pakistan/databases/(default)/documents/tasks/z20ZnLAPd3q8ZWRPnRVr`
- **createTime (server):** `2026-10-04T06:43:17.725775Z`
- **updateTime (server):** `2026-10-05T15:48:01.685775Z` — note: ~5.5 s AFTER `updatedAt`, so a second write landed immediately after the submission write.

The document has exactly **35 top-level fields**. Complete inventory below.

## Verdict: SURFACE CHECK CONFIRMED — no additional proof anywhere in the document

The `report` field contains **only** a single Google Doc URL and nothing else. There is **no** `deliverableFiles`, `attachments`, `submission` object, `statusHistory`, `reviews`, `reviewerNotes`, `feedback`, `resubmission*`, or version-counter field. `resources` and `workflowTags` are empty arrays. The single URL in the entire document is the report link.

---

## Field-by-field inventory (verbatim values)

### Identity / metadata
| Field | Type | Value |
|---|---|---|
| `title` | string | `"Assembly, 5-Point Quality Control & Final Delivery"` |
| `description` | string | Long spec (see below) |
| `workflowTitle` | string | `"Executive 4-Page Portfolio & Institutional Endorsement Letter Procurement (5 Sets + 3 Letters)"` |
| `workflowId` | string | `"wf_1791096197560_ugmmt1"` |
| `sequenceIndex` | integer | `2` |
| `recreatedFrom` | string | `"1YWKRgRJkgpsx1bVDJz4"` |
| `createdAt` | **string** (note: stored as a string, not a Timestamp) | `"2026-10-04T06:43:17.560Z"` |
| `updatedAt` | timestamp | `2026-10-05T15:47:56.154Z` (= 2026-10-05 20:47:56 PKT) |
| `releasedAt` | null | — |
| `role` | null | — |
| `projectId` | null | — |
| `chapterId` | null | — |
| `guidance` | null | — |
| `workflowPriority` | null | — |
| `workflowTags` | array (empty) | `[]` |
| `resources` | array (empty) | `[]` — **no Drive resource links on this step task** |

### Assignment
| Field | Type | Value |
|---|---|---|
| `assigneeId` | string | `"aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2"` (Maira Batool) |
| `assigneeIds` | array | `["aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2", "njnWidUfROQTgb92mDWVoXguifR2"]` (Maira + Huzaifah) |
| `assignerId` | string | `"pLW0PuQCTAQHCNK1SfllVhPZdMz1"` |
| `workflowParticipantIds` | array | `["aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2"]` (Maira only) |
| `isCurrentStep` | boolean | `false` |

### Deadlines / points
| Field | Type | Value |
|---|---|---|
| `deadline` | timestamp | `2026-10-05T05:00:00Z` (= 2026-10-05 10:00 AM PKT) |
| `individualDeadline` | timestamp | `2026-10-04T09:00:00Z` (= 2026-10-04 2:00 PM PKT) |
| `points` | integer | `3` |
| `penaltyPoints` | integer | `5` — submission was after both deadlines, so the deduction engine recorded 5 penalty points |
| `workflowBonusPoints` | integer | `10` |
| `estimatedDuration` | null | — |
| `finalWorkflowCompletionBadgeId` | null | — |
| `stepSpecificBadgeId` | null | — |

### Submission (the core of this investigation)
| Field | Type | Value |
|---|---|---|
| `status` | string | `"submitted-for-review"` |
| `submittedBy` | string | `"aeOh3GGm1KO2RJ8PQMNRnqv1jZQ2"` (Maira Batool) |
| `submittedAt` | timestamp | `2026-10-05T15:47:56.154Z` (= 2026-10-05 20:47:56 PKT; identical to `updatedAt`) |
| `startedAt` | timestamp | `2026-10-05T15:17:43.417Z` (= 2026-10-05 20:17:43 PKT) |
| `hoursWorked` | double | `0.5` |
| `report` | string — **the ONLY content; ONLY a URL** | `"https://docs.google.com/document/d/18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2/edit?usp=sharing&ouid=108789080876588241975&rtpof=true&sd=true"` |

There is **no prose** in `report` — no summary, no findings, no checklist results, no photo descriptions. Just the bare URL above. It is the **only URL in the entire document** (verified: no URL appears in any other field).

### Explicitly ABSENT fields (searched and not found)
- `deliverableFiles` — absent (the task description's VERIFICATION section demands photographic evidence of assembled portfolios AND a handover photo; none is attached here)
- `attachments` — absent
- `submission` (nested object) — absent
- `statusHistory`, `reviews`, `reviewLog` — absent
- `reviewerNotes`, `feedback`, `adminNotes` — absent (no reviewer has left any note on this document)
- `resubmissionCount`, `resubmittedAt`, `rejectionReason`, `revisionNotes` — absent
- `version`, `revision`, `editCount` counters — absent
- No nested map/object field of any kind exists on this document (all fields are scalar, null, or flat arrays of strings)

---

## Description field (verbatim, for reference)

```
WHAT: Assemble the 5 executive meeting portfolios, collating all 4 pages in the specified sequence within each folder. Perform a mandatory 5-point quality control audit on all assembled items and the standalone endorsement letters. Finally, deliver all completed materials to the President and provide photographic proof of delivery.

HOW: 1. For each of the 5 portfolios, collate the printed pages in the exact sequence: Page 1 (Global Heritage & 22-Nation Roster), Page 2 (HEC ORIC Policy 2021 Statutory Deal Card), Page 3 (Institutional Differentiation Matrix), and Page 4 (Facility Allocation Memorandum & Dual Signature Blocks). Insert these collated pages into the clear poly sleeves of the matte-black presentation folders. 2. Conduct the 5-point quality control audit for each portfolio and endorsement letter: a) Tactile rigidity (ensure paper feels substantial, not flimsy). b) Toner smudge resistance (check for smudges on text/graphics). c) Table border alignment (verify all table borders are perfectly aligned). d) Folder scratch inspection (ensure folders are free of any scratches or defects). e) Page collation check (confirm correct page order and orientation). 3. Place the 5 collated folders and 3 standalone endorsement letters into a suitable executive document envelope. 4. Personally deliver the sealed envelope to the President (sdadasdadadaa). 5. Take clear photographs of the physical deliverables (the assembled folders and endorsement letters) before delivery, and another photo confirming delivery to the President or a designated representative.

STANDARDS: Each portfolio must be flawlessly collated and free of any assembly errors. All items must pass the 5-point quality control audit without exception. The final presentation must be impeccable, suitable for executive-level use.

RESOURCES: Printed pages, presentation folders, executive document envelope, camera for photographic proof.

VERIFICATION: Photographic evidence of the 5 assembled portfolios and 3 endorsement letters (before delivery) must be uploaded. A separate photograph confirming the handover of the document envelope to the President (sdadasdadadaa) or their authorized representative must also be submitted to the task review portal.
```

---

## Notes / caveats

1. **Read is raw Firestore, not the app serializer** — so fields hidden by GET /api/tasks (like the old `submittedAt` serializer bug) are all visible here. Nothing additional exists.
2. **The linked Google Doc's content** (doc `18KZZX5MK39tN-WNEkVdWBGqDK--osuZ2`) was not opened as part of this task; its contents would need a browser/authorized fetch to verify the "blank template" claim. The document record itself contributes nothing beyond the link.
3. **Reviewer-side state lives elsewhere** — any reviewer notes, review-queue entries, notifications, or points-ledger records would be in other collections (`points_ledger`, review queue, etc.), not on this task document. This task doc itself carries no review trace.
4. The `njnWidUfROQTgb92mDWVoXguifR2` co-assignee (Huzaifah) appears in `assigneeIds` but not in `workflowParticipantIds` — worth flagging to the coordinator as a possible visibility/coverage gap, though outside this doc-inventory scope.
5. Timestamp discrepancy for the coordinator: `deadline` = Oct 5 10:00 AM PKT while `individualDeadline` = Oct 4 2:00 PM PKT (individual earlier than the task deadline) — recorded as found, not judged.

## Bottom line

**The surface check is confirmed, not overturned.** Task `z20ZnLAPd3q8ZWRPnRVr` ("Assembly, 5-Point Quality Control & Final Delivery", submitted by Maira Batool at 20:47:56 PKT on 2026-10-05, hoursWorked 0.5) contains **zero** proof beyond a single bare Google Doc link in `report`. No deliverable files, no attachments, no photos, no prose report, no nested submission object, no reviewer notes. The task's own VERIFICATION requirement (photo of assembled portfolios + photo of handover to the President) is not satisfied anywhere in this document.
