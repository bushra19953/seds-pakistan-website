"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ArrowRight, ArrowRightLeft } from 'lucide-react';

interface RelationshipTypeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    subordinateName: string;
    managerName: string;
    onSelect: (type: 'direct' | 'dotted') => void;
}

export function RelationshipTypeDialog({
    open,
    onOpenChange,
    subordinateName,
    managerName,
    onSelect
}: RelationshipTypeDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md bg-slate-900 border-slate-700 text-white">
                <DialogHeader>
                    <DialogTitle>Select Reporting Type</DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                        How does <span className="font-semibold text-white">{subordinateName}</span> report to <span className="font-semibold text-white">{managerName}</span>?
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-3 py-4">
                    <button
                        onClick={() => onSelect('direct')}
                        className="flex items-center gap-4 p-4 rounded-lg border-2 border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors text-left"
                    >
                        <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                            <ArrowRight className="h-6 w-6 text-emerald-400" />
                        </div>
                        <div>
                            <h4 className="font-semibold text-emerald-400">Direct Report</h4>
                            <p className="text-xs text-muted-foreground">Primary manager, solid line</p>
                        </div>
                    </button>

                    <button
                        onClick={() => onSelect('dotted')}
                        className="flex items-center gap-4 p-4 rounded-lg border-2 border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 transition-colors text-left"
                    >
                        <div className="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center">
                            <ArrowRightLeft className="h-6 w-6 text-amber-400" />
                        </div>
                        <div>
                            <h4 className="font-semibold text-amber-400">Dotted Line</h4>
                            <p className="text-xs text-muted-foreground">Secondary/matrix manager, dashed line</p>
                        </div>
                    </button>
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
