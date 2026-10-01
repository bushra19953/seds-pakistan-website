"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, UserMinus, Trash2, Link2Off, X, Users } from 'lucide-react';

const NO_MANAGER = "__NONE__";

interface BulkActionToolbarProps {
    selectedCount: number;
    allUsers: Array<{ id: string; displayName: string }>;
    onClearSelection: () => void;
    onReassignManager: (managerId: string | null) => Promise<void>;
    onDisconnectAll: () => Promise<void>;
    onDeleteSelected: () => Promise<void>;
}

export function BulkActionToolbar({
    selectedCount,
    allUsers,
    onClearSelection,
    onReassignManager,
    onDisconnectAll,
    onDeleteSelected
}: BulkActionToolbarProps) {
    const [loading, setLoading] = useState<string | null>(null);
    const [selectedManager, setSelectedManager] = useState(NO_MANAGER);

    if (selectedCount < 2) return null;

    const handleReassign = async () => {
        setLoading('reassign');
        try {
            const managerId = selectedManager === NO_MANAGER ? null : selectedManager;
            await onReassignManager(managerId);
        } finally {
            setLoading(null);
        }
    };

    const handleDisconnect = async () => {
        setLoading('disconnect');
        try {
            await onDisconnectAll();
        } finally {
            setLoading(null);
        }
    };

    const handleDelete = async () => {
        if (!confirm(`Delete ${selectedCount} selected people? This cannot be undone.`)) return;
        setLoading('delete');
        try {
            await onDeleteSelected();
        } finally {
            setLoading(null);
        }
    };

    return (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 bg-slate-900/95 backdrop-blur border border-primary/50 rounded-xl px-4 py-3 shadow-2xl flex items-center gap-4 animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center gap-2 text-primary">
                <Users className="h-4 w-4" />
                <span className="font-semibold text-sm">{selectedCount} selected</span>
            </div>

            <div className="h-6 w-px bg-slate-700" />

            {/* Reassign Manager */}
            <div className="flex items-center gap-2">
                <Select value={selectedManager} onValueChange={setSelectedManager}>
                    <SelectTrigger className="w-40 h-8 text-xs bg-slate-800 border-slate-600">
                        <SelectValue placeholder="Assign to..." />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-600 max-h-48">
                        <SelectItem value={NO_MANAGER}>No Manager</SelectItem>
                        {allUsers.filter(u => u.id).map((u) => (
                            <SelectItem key={u.id} value={u.id}>{u.displayName}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleReassign}
                    disabled={!!loading}
                    className="h-8"
                >
                    {loading === 'reassign' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Reassign'}
                </Button>
            </div>

            <div className="h-6 w-px bg-slate-700" />

            {/* Disconnect All */}
            <Button
                size="sm"
                variant="outline"
                onClick={handleDisconnect}
                disabled={!!loading}
                className="h-8 border-amber-500/50 text-amber-400 hover:bg-amber-500/20"
            >
                {loading === 'disconnect' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Link2Off className="h-3 w-3 mr-1" />}
                Disconnect
            </Button>

            {/* Delete Selected */}
            <Button
                size="sm"
                variant="outline"
                onClick={handleDelete}
                disabled={!!loading}
                className="h-8 border-red-500/50 text-red-400 hover:bg-red-500/20"
            >
                {loading === 'delete' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Trash2 className="h-3 w-3 mr-1" />}
                Delete
            </Button>

            <div className="h-6 w-px bg-slate-700" />

            {/* Clear Selection */}
            <Button
                size="icon"
                variant="ghost"
                onClick={onClearSelection}
                className="h-8 w-8 text-slate-400 hover:text-white"
                title="Clear selection (Esc)"
            >
                <X className="h-4 w-4" />
            </Button>
        </div>
    );
}
