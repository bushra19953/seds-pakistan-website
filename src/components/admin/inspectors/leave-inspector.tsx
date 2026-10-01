import React from "react";
import GenericInspector from "./generic-inspector";
import { z } from "zod";

const leaveSchema = z.object({
    reason: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    coveringOfficerId: z.string().optional(),
    coveringOfficerName: z.string().optional(),
    status: z.string().optional(),
    notes: z.string().optional(),
    leaveType: z.string().optional(),
}).passthrough();

export default function LeaveInspector(props: any) {
    return (
        <GenericInspector
            {...props}
            title="LEAVE REQUEST"
            schema={leaveSchema}
            renderPayload={(data) => {
                const reason = data?.reason || "Not specified";
                const startDate = data?.startDate || "N/A";
                const endDate = data?.endDate || "N/A";
                const coveringOfficer = data?.coveringOfficerName || data?.coveringOfficerId || "None assigned";
                const notes = data?.notes || "No additional notes";
                const leaveType = data?.leaveType || "General Leave";

                return (
                    <div className="space-y-6">
                        <div className="bg-zinc-900 dark:bg-zinc-800 p-5 rounded-xl text-white shadow-lg overflow-hidden relative">
                            <p className="text-[10px] text-zinc-400 uppercase tracking-widest font-black mb-1">Leave Type</p>
                            <h4 className="text-xl font-bold">{leaveType}</h4>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="bg-muted/30 p-3 rounded-lg border border-border/40">
                                <p className="text-[10px] text-muted-foreground uppercase font-semibold">Start Date</p>
                                <p className="text-xs font-bold">{startDate}</p>
                            </div>
                            <div className="bg-muted/30 p-3 rounded-lg border border-border/40">
                                <p className="text-[10px] text-muted-foreground uppercase font-semibold">End Date</p>
                                <p className="text-xs font-bold">{endDate}</p>
                            </div>
                        </div>

                        <div className="bg-muted/30 p-3 rounded-lg border border-border/40">
                            <p className="text-[10px] text-muted-foreground uppercase font-semibold">Covering Officer</p>
                            <p className="text-xs font-bold">{coveringOfficer}</p>
                        </div>

                        <div className="space-y-4">
                            <div className="p-4 rounded-xl bg-card border border-border/50">
                                <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest mb-2">Reason</p>
                                <p className="text-xs text-foreground/80 leading-relaxed font-medium">{reason}</p>
                            </div>
                            <div className="p-4 rounded-xl bg-muted/20 border border-border/20">
                                <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest mb-2">Notes</p>
                                <p className="text-xs italic text-foreground/70 leading-relaxed">{notes}</p>
                            </div>
                        </div>
                    </div>
                );
            }}
        />
    );
}
