"use client";

import { useEffect, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "lucide-react";

interface DepartPersonDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    people: Array<{ id: string; displayName: string }>;
    onConfirm: (reason: string) => void;
}

const MIN_REASON_LENGTH = 10;

export function DepartPersonDialog({ open, onOpenChange, people, onConfirm }: DepartPersonDialogProps) {
    const [reason, setReason] = useState("");

    useEffect(() => {
        if (open) setReason("");
    }, [open ]);

    const trimmed = reason.trim();
    const valid = trimmed.length >= MIN_REASON_LENGTH;
    const single = people.length === 1 ? people[0] : null;

    const handleConfirm = () => {
        if (!valid) return;
        onConfirm(trimmed);
    };

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent className="bg-card border-slate-700 text-foreground">
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5 text-red-500" />
                        {single ? `Mark ${single.displayName} as departed?` : `Mark ${people.length} people as departed?`}
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-muted-foreground">
                        They will be marked departed and removed from the chart. Their direct reports are disconnected and their open positions end. The account and its history are kept, and a departed member can be reinstated later.
                    </AlertDialogDescription>
                </AlertDialogHeader>

                {!single && people.length > 0 && (
                    <ul className="max-h-32 overflow-y-auto text-sm text-muted-foreground list-disc pl-5">
                        {people.map(p => (
                            <li key={p.id}>{p.displayName}</li>
                        ))}
                    </ul>
                )}

                <div className="space-y-2">
                    <Label htmlFor="depart-reason">Reason (required)</Label>
                    <Textarea
                        id="depart-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why is this member departing?"
                        className="bg-muted border-slate-600"
                        rows={3}
                    />
                    <p className="text-xs text-muted-foreground">
                        {trimmed.length}/{MIN_REASON_LENGTH} characters minimum. The reason is written to the audit log.
                    </p>
                </div>

                <AlertDialogFooter>
                    <AlertDialogCancel className="bg-transparent border-slate-600 hover:bg-muted">
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleConfirm}
                        disabled={!valid}
                        className="bg-red-600 hover:bg-red-700 disabled:opacity-50"
                    >
                        Mark departed
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
