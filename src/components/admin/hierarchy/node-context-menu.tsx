"use client";

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Edit3, Trash2, UserPlus, Link2 } from 'lucide-react';

interface NodeContextMenuProps {
    children: React.ReactNode;
    onEdit: () => void;
    onDelete: () => void;
    onAddReport: () => void;
    onChangeManager: () => void;
}

export function NodeContextMenu({ children, onEdit, onDelete, onAddReport, onChangeManager }: NodeContextMenuProps) {
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                {children}
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48 bg-card border-slate-700 text-foreground">
                <ContextMenuItem onClick={onEdit} className="focus:bg-muted focus:text-foreground cursor-pointer">
                    <Edit3 className="h-4 w-4 mr-2" />
                    Edit Person
                </ContextMenuItem>
                <ContextMenuItem onClick={onAddReport} className="focus:bg-muted focus:text-foreground cursor-pointer">
                    <UserPlus className="h-4 w-4 mr-2" />
                    Add Direct Report
                </ContextMenuItem>
                <ContextMenuItem onClick={onChangeManager} className="focus:bg-muted focus:text-foreground cursor-pointer">
                    <Link2 className="h-4 w-4 mr-2" />
                    Change Manager
                </ContextMenuItem>
                <ContextMenuSeparator className="bg-slate-700" />
                <ContextMenuItem onClick={onDelete} className="focus:bg-red-900 focus:text-red-200 text-red-400 cursor-pointer">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Remove from Hierarchy
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
