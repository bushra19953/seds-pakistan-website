import React from "react";
import GenericInspector from "./generic-inspector";
import { z } from "zod";

const formSchema = z.object({
    formTitle: z.string().optional(),
    answers: z.any().optional(),
    answers_json: z.any().optional()
}).passthrough();

export default function FormInspector(props: any) {
    return (
        <GenericInspector
            {...props}
            title="FORM RESPONSE"
            schema={formSchema}
            renderPayload={(data) => {
                const title = data?.formTitle || "Unknown Form";
                const answers = data?.answers || data?.answers_json || {};

                return (
                    <div className="space-y-4">
                        <div className="bg-muted/40 p-4 rounded-lg">
                            <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Form Completed</p>
                            <p className="text-lg font-medium text-foreground">{title}</p>
                        </div>

                        <div className="space-y-3">
                            <p className="text-[10px] text-muted-foreground uppercase font-black tracking-[0.2em]">Response Dataset</p>
                            {Object.keys(answers).length > 0 ? (
                                Object.entries(answers).map(([q, a], i) => (
                                    <div key={i} className="group border border-border/50 p-4 rounded-xl bg-gradient-to-br from-card to-muted/20 shadow-sm hover:shadow-md transition-all duration-300">
                                        <p className="text-xs font-black mb-2 text-foreground/60 uppercase tracking-tight flex items-center gap-2">
                                            <span className="w-4 h-4 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-black flex items-center justify-center text-[8px]">{i + 1}</span>
                                            {q.replace(/_/g, ' ')}
                                        </p>
                                        <p className="text-sm text-foreground font-medium leading-relaxed bg-background/50 p-3 rounded-lg border border-border/30">
                                            {typeof a === 'string' && a.startsWith('http') ? (
                                                <a href={a} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline flex items-center gap-1">
                                                    {a}
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                                                </a>
                                            ) : (
                                                String(a)
                                            )}
                                        </p>
                                    </div>
                                ))
                            ) : (
                                <div className="border-2 border-dashed p-12 rounded-xl text-sm italic text-muted-foreground text-center">
                                    No response data found. The form might have been submitted without answers.
                                </div>
                            )}
                        </div>
                    </div>
                );
            }}
        />
    );
}
