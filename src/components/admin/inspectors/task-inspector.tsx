import React from "react";
import GenericInspector from "./generic-inspector";
import { z } from "zod";

const taskSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.string().optional(),
    submissionData: z.any().optional()
}).passthrough();

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

                        <div className="border border-blue-200 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-900/50 p-4 rounded-lg shadow-sm">
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs text-blue-800 dark:text-blue-400 uppercase tracking-widest font-semibold">Member Submission Data</p>
                                {submissionStr.startsWith('http') && (
                                    <a
                                        href={submissionStr}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-[10px] bg-blue-600 text-foreground px-2 py-0.5 rounded-full font-bold hover:bg-blue-700 transition-colors"
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
