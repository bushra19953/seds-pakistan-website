"use client";

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { getAuth } from 'firebase/auth';
import { USER_ROLES } from '@/lib/roles';

const NO_MANAGER = "__NONE__";

interface NewPersonData {
    id: string;
    displayName: string;
    email: string;
    role: string;
    managerId: string | null;
}

interface AddPersonModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    chapterId: string;
    existingUsers: Array<{ id: string; displayName: string }>;
    onSuccess: (newPerson?: NewPersonData) => void;
    initialEmail?: string;
}

export function AddPersonModal({ open, onOpenChange, chapterId, existingUsers, onSuccess, initialEmail = '' }: AddPersonModalProps) {
    const [loading, setLoading] = useState(false);
    const [form, setForm] = useState({
        displayName: '',
        email: initialEmail,
        role: 'member',
        managerId: NO_MANAGER
    });
    const { showSuccessToast, showErrorToast } = useEnhancedToast();

    // Sync initialEmail when modal opens
    useEffect(() => {
        if (open && initialEmail) {
            setForm(f => ({ ...f, email: initialEmail }));
        }
    }, [open, initialEmail]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!form.displayName.trim() || !form.email.trim()) {
            showErrorToast('Name and email are required');
            return;
        }

        setLoading(true);
        try {
            const auth = getAuth();
            const token = await auth.currentUser?.getIdToken();
            const actualManagerId = form.managerId === NO_MANAGER ? null : form.managerId;

            const res = await fetch('/api/admin/hierarchy/user', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    displayName: form.displayName.trim(),
                    email: form.email.trim().toLowerCase(),
                    role: form.role,
                    chapterId: chapterId === 'all' ? null : chapterId,
                    managerId: actualManagerId
                })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to create user');
            }

            const data = await res.json();

            showSuccessToast('Person added successfully');

            // Return new person data for optimistic insert
            onSuccess({
                id: data.id,
                displayName: form.displayName.trim(),
                email: form.email.trim().toLowerCase(),
                role: form.role,
                managerId: actualManagerId
            });

            // Reset form
            setForm({ displayName: '', email: '', role: 'member', managerId: NO_MANAGER });

        } catch (err) {
            showErrorToast(err instanceof Error ? err.message : 'Failed to add person');
        } finally {
            setLoading(false);
        }
    };

    const roleOptions = Object.entries(USER_ROLES)
        .filter(([key]) => key && key.trim().length > 0)
        .map(([key, label]) => ({ value: key, label: String(label) }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md bg-card border-slate-700 text-foreground">
                <DialogHeader>
                    <DialogTitle>Add New Team Member</DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                        Add a new person to the organization hierarchy.
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="name">Full Name *</Label>
                        <Input
                            id="name"
                            value={form.displayName}
                            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                            placeholder="John Doe"
                            className="bg-muted border-slate-600"
                            required
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="email">Email *</Label>
                        <Input
                            id="email"
                            type="email"
                            value={form.email}
                            onChange={(e) => setForm({ ...form, email: e.target.value })}
                            placeholder="john@example.com"
                            className="bg-muted border-slate-600"
                            required
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="role">Role</Label>
                        <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                            <SelectTrigger className="bg-muted border-slate-600">
                                <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                            <SelectContent className="bg-muted border-slate-600">
                                {roleOptions.map((r) => (
                                    <SelectItem key={r.value} value={r.value}>
                                        {r.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="manager">Reports To</Label>
                        <Select value={form.managerId} onValueChange={(v) => setForm({ ...form, managerId: v })}>
                            <SelectTrigger className="bg-muted border-slate-600">
                                <SelectValue placeholder="Select manager" />
                            </SelectTrigger>
                            <SelectContent className="bg-muted border-slate-600 max-h-60">
                                <SelectItem value={NO_MANAGER}>No manager (top level)</SelectItem>
                                {existingUsers
                                    .filter(u => u.id && u.id.trim().length > 0)
                                    .map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.displayName || u.id}
                                        </SelectItem>
                                    ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <DialogFooter className="pt-4">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Add Person
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
