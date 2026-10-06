# VERIFY-11 — `deliverableFiles` dropped by the "View Submission" dialog (investigation only, no code changes)

## 1. The dialog: location, component/state, and what it renders today

**File:** `src/app/admin/tasks/page.tsx` (1,659 lines)
**State:** line 110 — `const [viewSubmissionTask, setViewSubmissionTask] = useState<Task | null>(null);`
**Trigger:** "View Submission" button on each table row, line 1339: `onClick={() => setViewSubmissionTask(task)}`.
**Dialog JSX:** lines 1503–1576, an inline IIFE block (not a separate named component) inside the default export of the page:

```tsx
{/* Read-only submission viewer for submitted-for-review tasks. No inputs, no save path. */}
<Dialog open={viewSubmissionTask !== null} onOpenChange={(open) => { if (!open) setViewSubmissionTask(null); }}>
  <DialogContent className="w-[95vw] sm:max-w-xl max-h-[85vh] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>Submission: {viewSubmissionTask?.title}</DialogTitle>
      ...
```

**Fields it currently renders (in order):**
1. **Submitted by** — `t.submittedBy || t.submittedById`, name resolved via `usersMap`, falls back to raw id → `'No submitter recorded'`
2. **Submitted at** (or 'Updated at (no submission timestamp recorded)') — `toDate(t.submittedAt)` with `t.updatedAt` fallback, formatted `dd/MM/yyyy hh:mm a` → `'Not recorded'`
3. **Hours worked** — `t.hoursWorked` as a `<Badge>` (`{hours}h`) → `'No hours logged'`
4. **Report** — `t.report` in a bordered pre-wrap box → `'No report submitted'`
5. **Deliverable links** — `t.resourceLinks` (newline-separated string or array) rendered as bordered `<a>` links → `'No deliverable links submitted'`

**Where `deliverableFiles` is missing:** the dialog reads `t.resourceLinks` only. It never touches `t.deliverableFiles`, so uploaded proof files (Google Drive uploads from the submit flow) are invisible to reviewers. There is no placeholder or comment acknowledging the field — it is silently dropped. The fix belongs in the same IIFE, after the "Deliverable links" block (~line 1572, before the closing `</div>`).

## 2. The shape of `deliverableFiles` in Firestore

**Authoritative shape** — zod schema in the submit API handler, `src/app/api/tasks/route.ts` lines 277–283 (PATCH /api/tasks, `updates` object):

```ts
deliverableFiles: z.array(z.object({
  fileName: z.string().optional(),
  driveFileId: z.string().optional(),
  downloadUrl: z.string(),
  sizeBytes: z.number().optional(),
  contentType: z.string().optional(),
})).optional(),
```

So: **an array of objects**, `downloadUrl` required, everything else optional.

**Who writes it** — `src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx` lines 108–114 (`handleTransmit`):

```ts
if (uploadedFiles.length > 0) {
  updates.deliverableFiles = uploadedFiles.map((f) => ({
    fileName: f.fileName,
    driveFileId: f.driveFileId,
    downloadUrl: f.downloadUrl,
    sizeBytes: f.sizeBytes,
    contentType: f.contentType,
  }));
}
```

`uploadedFiles` comes from the Drive upload flow (`src/lib/uploads/client.ts` + `/api/uploads`); per `upload-handler.ts`, `downloadUrl` is the Drive `webViewLink` (or `thumbnailUrl` for visual files). `deliverableFiles` is in `ASSIGNEE_SAFE_FIELDS` (route.ts line 461), so assignees can set it directly via PATCH.

**TypeScript interface** in `src/components/profile/task-detail-dialog.tsx` lines 51–57 matches exactly:

```ts
deliverableFiles?: Array<{
    fileName?: string;
    driveFileId?: string;
    downloadUrl: string;
    sizeBytes?: number;
    contentType?: string;
}>;
```

## 3. Existing render pattern to mirror (working, in the review modal)

`src/components/profile/task-detail-dialog.tsx` lines 704–719 — the profile review modal **does** render `deliverableFiles` (this is the "working" side). Quote exactly:

```tsx
{displayTask.deliverableFiles && displayTask.deliverableFiles.length > 0 && (
    <div className="space-y-3 pt-2">
        <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest flex items-center gap-2"><FileText className="h-3 w-3" /> Deliverable Files</p>
        <div className="grid gap-2">
            {displayTask.deliverableFiles.map((file, i) => {
                const sizeLabel = formatFileSize(file.sizeBytes);
                return (
                    <a key={file.driveFileId || `file-${i}`} href={file.downloadUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 p-3 rounded-xl bg-card border border-slate-800 hover:bg-muted text-xs text-blue-400 hover:text-blue-300 transition-all">
                        <ExternalLink className="h-3 w-3 shrink-0" />
                        <span className="truncate">{file.fileName || 'Deliverable file'}</span>
                        {sizeLabel && <span className="ml-auto font-mono text-[10px] text-muted-foreground shrink-0">{sizeLabel}</span>}
                    </a>
                );
            })}
        </div>
    </div>
)}
```

With helper `formatFileSize` (lines 140–147):

```ts
const formatFileSize = (bytes?: number | null) => {
    if (bytes == null || isNaN(bytes)) return null;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(1)} ${units[unit]}`;
};
```

Also note: `FileText` and `ExternalLink` are already imported in the admin page? **Check for the implementer:** page.tsx renders links with its own lighter style (`className="block text-sm text-primary underline underline-offset-2 break-all rounded-md border p-2.5 hover:bg-muted/40"`). Simplest consistent fix is a "Deliverable files" section styled like the existing "Deliverable links" block, using `file.fileName || 'Deliverable file'` as label and `file.downloadUrl` as href.

## 4. Dialog's truthful-empty placeholder style (match this)

The dialog's existing empty states, all `<p className="text-sm text-muted-foreground">`:
- `'No submitter recorded'`
- `'Not recorded'` (timestamp)
- `'No hours logged'`
- `'No report submitted'`
- `'No deliverable links submitted'`

Section labels use: `<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Label</p>`.
Link items use: `className="block text-sm text-primary underline underline-offset-2 break-all rounded-md border p-2.5 hover:bg-muted/40"` with `href={link.startsWith('http') ? link : `https://${link}`}` (the `https://` prefixing is **not** needed for deliverableFiles since `downloadUrl` is always a full URL).

**Suggested placeholder for the new section:** `<p className="text-sm text-muted-foreground">No deliverable files submitted</p>` — mirrors the existing pattern exactly.

## Notes for the implementer
- The dialog casts `viewSubmissionTask as any`, so `t.deliverableFiles` type-checks fine.
- `driveFileId` keys are unique per file; the profile modal's key strategy (`file.driveFileId || `file-${i}``) can be mirrored.
- One serializer caveat worth verifying: the admin task list API (which populates `viewSubmissionTask`) recently dropped `submittedAt` (fixed in `84b4f3b`); confirm it passes `deliverableFiles` through too before assuming the fix is purely presentational.
