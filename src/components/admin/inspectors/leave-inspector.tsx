import React from "react";
import GenericInspector from "./generic-inspector";
import { z } from "zod";

// Canonical leave docs store coveringOfficerId, coveringOfficerName, and
// notes as null when empty, and dates as YYYY-MM-DD strings. Accept nulls
// and any date shape so validation passes for real docs instead of falling
// back to raw data.
const leaveSchema = z.object({
    reason: z.string().nullish(),
    startDate: z.any().nullish(),
    endDate: z.any().nullish(),
    start_date: z.any().nullish(),
    end_date: z.any().nullish(),
    coveringOfficerId: z.string().nullish(),
    coveringOfficerName: z.string().nullish(),
    covering_officer_id: z.string().nullish(),
    status: z.string().nullish(),
    notes: z.string().nullish(),
    leaveType: z.string().nullish(),
    leave_type: z.string().nullish(),
}).passthrough();

// Dates are YYYY-MM-DD strings on canonical docs. Tolerate Firestore
// Timestamps, Dates, and millis too, so a legacy doc never crashes the
// drawer by rendering an object as a React child.
const formatLeaveDate = (value: any): string => {
    if (value === null || value === undefined || value === "") return "N/A";
    // YYYY-MM-DD strings render verbatim. Parsing them into a Date would
    // shift the day in timezones west of UTC, so never do that.
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    try {
        let d: any = value;
        if (d && typeof d.toDate === "function") d = d.toDate();
        else if (typeof d?.toMillis === "function") d = new Date(d.toMillis());
        else if (typeof d === "string" || typeof d === "number") d = new Date(d);
        if (d instanceof Date && !isNaN(d.getTime())) return d.toLocaleDateString();
    } catch (e) { /* fall through to string form */ }
    return String(value);
};

export default function LeaveInspector(props: any) {
    return (
        <GenericInspector
            {...props}
            title="LEAVE REQUEST"
            schema={leaveSchema}
            renderPayload={(data) => {
                const reason = data?.reason || "Not specified";
                const startDate = formatLeaveDate(data?.startDate ?? data?.start_date);
                const endDate = formatLeaveDate(data?.endDate ?? data?.end_date);
                const coveringOfficer = data?.coveringOfficerName || data?.coveringOfficerId || data?.covering_officer_id || "None assigned";
                const notes = data?.notes || "No additional notes";
                const leaveType = data?.leaveType || data?.leave_type || data?.type || "General Leave";

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
