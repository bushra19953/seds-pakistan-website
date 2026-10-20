import React from "react";
import GenericInspector from "./generic-inspector";
import { ProofPreview } from "@/components/profile/proof-submission-drawer";
import { z } from "zod";

const taskSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.string().optional(),
    submissionData: z.any().optional()
}).passthrough();

const formatDateTime = (value: any): string | null => {
    if (value === null || value === undefined || value === "") return null;
    try {
        let d: any = value;
        if (d && typeof d.toDate === "function") d = d.toDate(); // Firestore Timestamp
        else if (typeof d === "string" || typeof d === "number") d = new Date(d);
        if (d instanceof Date && !isNaN(d.getTime())) return d.toLocaleString();
    } catch (e) { /* fall through to null */ }
    return null;
};

interface DeliveryRow {
    key: string;
    name: string;
    version: string | null;
    sentAt: string | null;
    viewedAt: string | null;
}

// Reads instruction delivery records off the task doc, tolerating a few shapes
// so the inspector keeps working as the writer side evolves:
//   instructionDelivery: [{assigneeId, assigneeName, instructionVersion, sentAt, viewedAt}]
//   instructionDelivery: { "<assigneeId>": {assigneeName, instructionVersion, sentAt, viewedAt} }
//   assignees: [{assigneeId, assigneeName, instructionVersion, instructionSentAt, instructionViewedAt}]
function buildDeliveryRows(data: any): DeliveryRow[] {
    const rows: DeliveryRow[] = [];
    const pushRow = (key: string, entry: any) => {
        if (!entry || typeof entry !== "object") return;
        const version = entry.instructionVersion ?? entry.version ?? entry.sentVersion ?? null;
        const sentAt = formatDateTime(entry.sentAt ?? entry.instructionSentAt ?? entry.sent);
        const viewedAt = formatDateTime(entry.viewedAt ?? entry.instructionViewedAt ?? entry.viewed);
        if (version == null && sentAt == null && viewedAt == null) return; // nothing recorded, skip
        const name = entry.assigneeName ?? entry.name ?? entry.assigneeEmail ?? entry.email ?? key ?? "Assignee";
        rows.push({
            key,
            name: String(name),
            version: version != null ? String(version) : null,
            sentAt,
            viewedAt
        });
    };

    const delivery = data?.instructionDelivery;
    if (Array.isArray(delivery)) {
        delivery.forEach((entry, i) =>
            pushRow(String(entry?.assigneeId ?? entry?.uid ?? entry?.assigneeName ?? i), entry)
        );
    } else if (delivery && typeof delivery === "object") {
        Object.entries(delivery).forEach(([key, entry]) => pushRow(key, entry));
    }

    const assignees = data?.assignees;
    if (Array.isArray(assignees) && rows.length === 0) {
        assignees.forEach((entry, i) =>
            pushRow(String(entry?.assigneeId ?? entry?.uid ?? entry?.assigneeName ?? i), entry)
        );
    }

    return rows;
}

export default function TaskInspector(props: any) {
    return (
        <GenericInspector
            {...props}
            title="TASK REVIEW"
            schema={taskSchema}
            renderPayload={(data) => {
                const title = data?.title || "Unknown Task";
                const desc = data?.description || "No description provided.";
                const priority = data?.priority || "Normal";

                let submissionStr = "N/A";
                if (typeof data?.submissionData === 'string') {
                    submissionStr = data.submissionData;
                } else if (data?.submissionData) {
                    submissionStr = JSON.stringify(data.submissionData, null, 2);
                }

                const deliveryRows = buildDeliveryRows(data);

                // Deliverable files for inline preview. Real task docs carry
                // deliverableFiles at the top level; the inbox row shape
                // (if ever passed through) carries them under submissionData.
                const taskFiles: Array<{ fileName?: string; driveFileId?: string; downloadUrl: string; contentType?: string }> =
                    (() => {
                        const fromDoc = data?.deliverableFiles;
                        const fromRow = data?.submissionData?.deliverableFiles;
                        const chosen = Array.isArray(fromDoc) ? fromDoc : (Array.isArray(fromRow) ? fromRow : []);
                        return chosen.filter((f: any) => f && typeof f.downloadUrl === "string" && f.downloadUrl.length > 0);
                    })();
                const taskReport: string | null =
                    (typeof data?.report === "string" && data.report) ||
                    (typeof data?.submissionData?.report === "string" ? data.submissionData.report : null);

                return (
                    <div className="space-y-4">
                        <div className="bg-muted/40 p-4 rounded-lg flex items-center justify-between">
                            <div>
                                <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Task Title</p>
                                <p className="text-lg font-medium text-foreground">{title}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Priority</p>
                                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${priority.toLowerCase() === 'high' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' :
                                    priority.toLowerCase() === 'medium' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400' :
                                        'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                                    }`}>{priority}</span>
                            </div>
                        </div>

                        <div className="border border-border/50 p-4 rounded-lg bg-card shadow-sm">
                            <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-2">Description</p>
                            <p className="text-sm whitespace-pre-wrap text-foreground/80 leading-relaxed">{desc}</p>
                        </div>

                        {/* WS6: member work report with inline proof previews. */}
                        {taskReport && (
                            <div className="border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-900/50 p-4 rounded-lg shadow-sm">
                                <p className="text-xs text-emerald-800 dark:text-emerald-400 uppercase tracking-widest font-semibold mb-2">Work Report</p>
                                <p className="text-sm whitespace-pre-wrap text-foreground/90 leading-relaxed">{taskReport}</p>
                            </div>
                        )}

                        {taskFiles.length > 0 && (
                            <div className="border border-border/50 p-4 rounded-lg bg-card shadow-sm">
                                <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-3">
                                    Proof Files ({taskFiles.length})
                                </p>
                                <ul className="space-y-2">
                                    {taskFiles.map((file, i) => (
                                        <li key={file.driveFileId || `proof-${i}`} className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
                                            <ProofPreview file={file} />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-semibold text-foreground truncate">{file.fileName || "Proof file"}</p>
                                                <p className="text-[10px] text-muted-foreground">inline preview</p>
                                            </div>
                                            <a
                                                href={file.downloadUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-[11px] font-bold text-blue-600 dark:text-blue-400 underline underline-offset-2 shrink-0"
                                            >
                                                Open
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {deliveryRows.length > 0 && (
                            <div className="border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-900/50 p-4 rounded-lg shadow-sm">
                                <p className="text-xs text-emerald-800 dark:text-emerald-400 uppercase tracking-widest font-semibold mb-3">Instruction Delivery Status</p>
                                <div className="space-y-3">
                                    {deliveryRows.map((row) => (
                                        <div key={row.key} className="bg-white dark:bg-black/40 border border-border/50 rounded-lg p-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <p className="text-sm font-semibold text-foreground">{row.name}</p>
                                                {row.viewedAt ? (
                                                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                                                        Viewed
                                                    </span>
                                                ) : (
                                                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                                                        Not yet viewed
                                                    </span>
                                                )}
                                            </div>
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                                                <div>
                                                    <p className="text-muted-foreground uppercase tracking-widest font-semibold text-[10px] mb-0.5">Instruction version</p>
                                                    <p className="font-medium text-foreground/90">{row.version ?? "Not recorded"}</p>
                                                </div>
                                                <div>
                                                    <p className="text-muted-foreground uppercase tracking-widest font-semibold text-[10px] mb-0.5">Sent</p>
                                                    <p className="font-medium text-foreground/90">{row.sentAt ?? "Not recorded"}</p>
                                                </div>
                                                <div>
                                                    <p className="text-muted-foreground uppercase tracking-widest font-semibold text-[10px] mb-0.5">Viewed</p>
                                                    <p className="font-medium text-foreground/90">{row.viewedAt ?? "Not yet viewed"}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="border border-blue-200 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-900/50 p-4 rounded-lg shadow-sm">
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs text-blue-800 dark:text-blue-400 uppercase tracking-widest font-semibold">Member Submission Data</p>
                                {submissionStr.startsWith('http') && (
                                    <a
                                        href={submissionStr}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded-full font-bold hover:bg-blue-700 transition-colors"
                                    >
                                        Launch Link
                                    </a>
                                )}
                            </div>
                            <pre className="text-xs whitespace-pre-wrap bg-white dark:bg-black/40 p-4 rounded border border-border/50 overflow-x-auto font-mono text-foreground/90">
                                {submissionStr}
                            </pre>
                        </div>
                    </div>
                );
            }}
        />
    );
}
