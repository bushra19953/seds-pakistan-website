import React from "react";
import { Badge } from "@/components/ui/badge";
import GenericInspector from "./generic-inspector";
import { z } from "zod";

const applicationSchema = z.object({
    roleAppliedFor: z.string().optional(),
    role_applied_for: z.string().optional(),
    position: z.string().optional(),
    github_url: z.string().optional(),
    portfolio_url: z.string().optional(),
    experience: z.string().optional(),
    notes: z.string().optional(),
    fullName: z.string().optional(),
    university: z.string().optional(),
    department: z.string().optional(),
    studyYear: z.string().optional(),
    skills: z.array(z.string()).optional(),
    interestAreas: z.array(z.string()).optional(),
    availability: z.string().optional(),
    resumeUpload: z.string().optional(),
    resume_url: z.string().optional(),
}).passthrough();

export default function ApplicationInspector(props: any) {
    return (
        <GenericInspector
            {...props}
            title="APPLICATION"
            schema={applicationSchema}
            renderPayload={(data) => {
                const role = data?.roleAppliedFor || data?.role_applied_for || data?.position || "Not Provided";
                const github = data?.github_url || data?.githubLink || "N/A";
                const portfolio = data?.portfolio_url || data?.portfolioLink || "N/A";
                const experience = data?.experience || "N/A";
                const notes = data?.notes || "None";
                const resume = data?.resumeUpload || data?.resume_url;

                const BadgeList = ({ label, items }: { label: string, items?: string[] }) => {
                    if (!items || items.length === 0) return null;
                    return (
                        <div className="space-y-2">
                            <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">{label}</p>
                            <div className="flex flex-wrap gap-1.5">
                                {items.map((item, i) => (
                                    <span key={i} className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded text-[10px] font-medium border border-border/50">
                                        {item}
                                    </span>
                                ))}
                            </div>
                        </div>
                    );
                };

                return (
                    <div className="space-y-6">
                        {/* Role Header */}
                        <div className="bg-zinc-900 dark:bg-zinc-800 p-5 rounded-xl text-white shadow-lg overflow-hidden relative">
                            <div className="absolute top-0 right-0 p-4 opacity-10">
                                <svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                            </div>
                            <p className="text-[10px] text-zinc-400 uppercase tracking-widest font-black mb-1">Applying For Position</p>
                            <h4 className="text-xl font-bold">{role}</h4>
                        </div>

                        {/* Academic Context */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div className="bg-muted/30 p-3 rounded-lg border border-border/40">
                                <p className="text-[10px] text-muted-foreground uppercase font-semibold">University</p>
                                <p className="text-xs font-bold truncate">{data?.university || 'Not Specified'}</p>
                            </div>
                            <div className="bg-muted/30 p-3 rounded-lg border border-border/40">
                                <p className="text-[10px] text-muted-foreground uppercase font-semibold">Dept / Major</p>
                                <p className="text-xs font-bold truncate">{data?.department || 'Not Specified'}</p>
                            </div>
                            <div className="bg-muted/30 p-3 rounded-lg border border-border/40">
                                <p className="text-[10px] text-muted-foreground uppercase font-semibold">Year</p>
                                <p className="text-xs font-bold">{data?.studyYear || 'N/A'}</p>
                            </div>
                        </div>

                        {/* Skills & Interests Tags */}
                        <div className="grid grid-cols-2 gap-4 border-y py-6 border-dashed">
                            <BadgeList label="Skills" items={data?.skills} />
                            <BadgeList label="Interests" items={data?.interestAreas} />
                        </div>

                        {/* Professional Links */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="group relative">
                                <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1.5 flex items-center gap-1">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                                    GitHub
                                </p>
                                <a
                                    href={github !== 'N/A' ? github : '#'}
                                    className={`text-xs block p-2 rounded border truncate ${github !== 'N/A' ? 'text-blue-500 hover:bg-blue-500/5 border-blue-500/20 font-medium' : 'text-muted-foreground/50 border-border/50'}`}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {github}
                                </a>
                            </div>
                            <div className="group relative">
                                <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1.5 flex items-center gap-1">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                                    Portfolio
                                </p>
                                <a
                                    href={portfolio !== 'N/A' ? portfolio : '#'}
                                    className={`text-xs block p-2 rounded border truncate ${portfolio !== 'N/A' ? 'text-blue-500 hover:bg-blue-500/5 border-blue-500/20 font-medium' : 'text-muted-foreground/50 border-border/50'}`}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {portfolio}
                                </a>
                            </div>
                        </div>

                        {/* Resume Call-to-Action */}
                        {resume && (
                            <div className="bg-zinc-100 dark:bg-zinc-900/50 p-4 rounded-xl flex items-center justify-between border border-border/50">
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase font-black">Credential Check</p>
                                    <p className="text-sm font-bold">Resume Document Linked</p>
                                </div>
                                <a
                                    href={resume}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="px-4 py-2 bg-zinc-900 text-white dark:bg-white dark:text-black rounded-lg text-xs font-bold hover:scale-105 transition-transform flex items-center gap-2"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>
                                    View Full CV
                                </a>
                            </div>
                        )}

                        {/* Long-Form Text Blocks */}
                        <div className="space-y-4">
                            <div className="p-4 rounded-xl bg-card border border-border/50">
                                <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest mb-2">Experience & Background</p>
                                <p className="text-xs text-foreground/80 leading-relaxed font-medium">
                                    {experience !== 'N/A' ? experience : 'Information not explicitly summarized by applicant.'}
                                </p>
                            </div>

                            <div className="p-4 rounded-xl bg-muted/20 border border-border/20">
                                <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest mb-2">Reviewer Notes / Cover Letter</p>
                                <p className="text-xs italic text-foreground/70 leading-relaxed">
                                    {notes !== 'None' ? notes : 'No additional notes provided.'}
                                </p>
                            </div>
                        </div>
                    </div>
                );
            }}
        />
    );
}
