import React from "react";
import GenericInspector from "./generic-inspector";
import { z } from "zod";

const submissionSchema = z.object({
    type: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    description: z.string().optional(),
    organization: z.string().optional(),
    tags: z.array(z.string()).optional(),
    deadline: z.any().optional(),
}).passthrough();

export default function SubmissionInspector(props: any) {
    return (
        <GenericInspector
            {...props}
            title="RESOURCE SUBMISSION"
            schema={submissionSchema}
            renderPayload={(data) => {
                const subType = data?.type || "Resource";
                const title = data?.title || "No Title";
                const url = data?.url || "#";
                const org = data?.organization || "N/A";
                const desc = data?.description || "No description provided.";
                const tags = data?.tags || [];

                let deadlineStr = "N/A";
                if (data?.deadline) {
                    try {
                        let dObj = data.deadline;
                        if (dObj.toDate) dObj = dObj.toDate();
                        else if (typeof dObj === 'string') dObj = new Date(dObj);
                        deadlineStr = dObj instanceof Date && !isNaN(dObj.getTime()) ? dObj.toLocaleDateString() : "N/A";
                    } catch (e) { }
                }

                return (
                    <div className="space-y-6">
                        <div className="bg-gradient-to-br from-indigo-900 to-indigo-700 p-5 rounded-xl text-white shadow-md relative overflow-hidden">
                            <div className="absolute -right-4 -top-4 opacity-10">
                                <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="7.5 4.21 12 6.81 16.5 4.21"></polyline><polyline points="7.5 19.79 7.5 14.6 3 12"></polyline><polyline points="21 12 16.5 14.6 16.5 19.79"></polyline><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                            </div>
                            <p className="text-[10px] text-indigo-300 uppercase tracking-widest font-black mb-1">{subType}</p>
                            <h4 className="text-xl font-bold">{title}</h4>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-muted/30 p-4 rounded-xl border border-border/40">
                                <p className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-1 shadow-sm">Organization</p>
                                <p className="text-sm font-semibold truncate">{org}</p>
                            </div>
                            <div className="bg-muted/30 p-4 rounded-xl border border-border/40">
                                <p className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-1 shadow-sm">Deadline</p>
                                <p className="text-sm font-semibold">{deadlineStr}</p>
                            </div>
                        </div>

                        <div className="p-4 rounded-xl bg-blue-50/50 dark:bg-blue-900/10 border border-blue-500/20 shadow-sm flex items-center justify-between">
                            <div>
                                <p className="text-[10px] text-blue-600 dark:text-blue-400 uppercase font-black tracking-widest mb-1">Source Link</p>
                                <p className="text-xs text-muted-foreground font-mono truncate max-w-[200px] sm:max-w-xs">{url}</p>
                            </div>
                            <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 hover:scale-105 transition-all flex items-center gap-2"
                            >
                                Visit Link
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                            </a>
                        </div>

                        {tags && tags.length > 0 && (
                            <div className="space-y-2 border-y border-dashed py-4 border-border/50">
                                <p className="text-[10px] text-muted-foreground uppercase font-black tracking-widest">Applied Tags</p>
                                <div className="flex flex-wrap gap-2">
                                    {tags.map((t: string, i: number) => (
                                        <span key={i} className="px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-md text-[10px] font-bold border border-border/50 uppercase">
                                            {t}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="p-4 rounded-xl bg-card border border-border/50">
                            <p className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mb-2">Description / Details</p>
                            <p className="text-xs text-foreground/80 leading-relaxed font-medium whitespace-pre-wrap">
                                {desc !== 'N/A' ? desc : 'No further details provided by the submitter.'}
                            </p>
                        </div>
                    </div>
                );
            }}
        />
    );
}
