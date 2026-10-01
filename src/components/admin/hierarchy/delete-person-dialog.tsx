"use client";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { AlertTriangle } from 'lucide-react';

interface DeletePersonDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    person: { id: string; displayName: string } | null;
    onSuccess: () => void;
}

export function DeletePersonDialog({ open, onOpenChange, person, onSuccess }: DeletePersonDialogProps) {
    const handleDelete = () => {
        // Just call the callback - actual deletion is handled by parent with optimistic update
        onSuccess();
    };

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent className="bg-slate-900 border-slate-700 text-white">
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5 text-red-500" />
                        Remove {person?.displayName}?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-slate-400">
                        This will remove this person from the hierarchy. Any direct reports will be disconnected. This action cannot be undone.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel className="bg-transparent border-slate-600 hover:bg-slate-800">
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleDelete}
                        className="bg-red-600 hover:bg-red-700"
                    >
                        Remove
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
