'use client';

import React, { useMemo } from 'react';
import { Check, FileText, Clock, Send } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// =============================================================================
// TYPES
// =============================================================================

/**
 * One instruction brief delivered to an assignee.
 * The platform is the durable store: the brief survives even if the original
 * WhatsApp message disappears, so a lost chat never means a lost brief.
 */
export interface InstructionBrief {
    /** Unique brief id */
    id: string;
    /** Task this brief belongs to */
    taskId: string;
    /** Human-readable task title for the row */
    taskTitle: string;
    /** Brief version number (v1, v2, ...) so the user can tell which is latest */
    version: number;
    /** When the brief was received. Accepts Firestore Timestamps, Dates, or ISO strings. */
    receivedAt?: any;
    /** Read state */
    isRead: boolean;
    /** Optional explicit deep link to the task. Falls back to `/tasks/${taskId}`. */
    taskUrl?: string;
}

export interface InstructionInboxProps {
    /** Instruction briefs for the current user (any order; component sorts newest first) */
    instructions: InstructionBrief[];
    /** Called when the user marks a brief as read. Parent persists the state. */
    onMarkRead: (briefId: string) => void;
    /** Optional: called when the user asks for the brief to be resent (e.g. via WhatsApp or email) */
    onResend?: (briefId: string) => void;
    /** Show skeleton rows while the parent loads briefs */
    loading?: boolean;
    /** Custom class name */
    className?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function toDate(ts: any): Date | null {
    try {
        if (!ts) return null;
        return ts?.toDate ? ts.toDate() : new Date(ts);
    } catch {
        return null;
    }
}

function formatReceived(ts: any): string {
    const d = toDate(ts);
    if (!d) return 'Unknown date';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function taskLink(brief: InstructionBrief): string {
    if (brief.taskUrl && brief.taskUrl.trim()) return brief.taskUrl;
    return `/tasks/${brief.taskId}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * InstructionInbox - the in-platform instruction inbox.
 *
 * Assignees lose instruction briefs when WhatsApp disappearing messages delete
 * them. This inbox keeps every brief inside the platform, newest first, with
 * read/unread state and a direct link back to the task, so the brief is never
 * lost. Props-driven: no data fetching, no hardcoded users, no mock content.
 */
export function InstructionInbox({
    instructions,
    onMarkRead,
    onResend,
    loading = false,
    className,
}: InstructionInboxProps) {
    // Newest first by received date. Copied, never mutated in place.
    const sorted = useMemo(() => {
        return [...(instructions || [])].sort((a, b) => {
            const ta = toDate(a.receivedAt)?.getTime() || 0;
            const tb = toDate(b.receivedAt)?.getTime() || 0;
            return tb - ta;
        });
    }, [instructions]);

    const unreadCount = useMemo(
        () => sorted.filter((b) => b && !b.isRead).length,
        [sorted]
    );

    // ==========================================================================
    // RENDER
    // ==========================================================================

    if (loading) {
        return (
            <div className={`space-y-2 ${className || ''}`}>
                {[0, 1, 2].map((i) => (
                    <div key={i} className="border rounded-lg p-3 animate-pulse">
                        <div className="h-4 w-2/3 bg-muted rounded mb-2" />
                        <div className="h-3 w-1/3 bg-muted rounded" />
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className={`space-y-2 ${className || ''}`}>
            {/* Header */}
            <div className="flex items-center justify-between px-1">
                <span className="font-semibold flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    Instruction Inbox
                    {unreadCount > 0 && (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                            {unreadCount} unread
                        </Badge>
                    )}
                </span>
                <span className="text-xs text-muted-foreground">
                    Briefs are stored here, not in chat. They stay even if your messages disappear.
                </span>
            </div>

            {sorted.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground border rounded-lg">
                    No instruction briefs yet.
                </div>
            ) : (
                sorted.map((brief) => {
                    const read = brief.isRead === true;
                    return (
                        <div
                            key={brief.id}
                            className={`border rounded-lg p-3 text-sm transition-colors ${
                                read ? 'opacity-70 bg-muted/20' : 'bg-background hover:bg-muted/40 shadow-sm'
                            }`}
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <Link
                                            href={taskLink(brief)}
                                            className="font-medium hover:text-primary hover:underline line-clamp-1"
                                        >
                                            {brief.taskTitle || 'Untitled task'}
                                        </Link>
                                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                                            Brief v{brief.version}
                                        </Badge>
                                        {!read && (
                                            <span className="inline-block h-2 w-2 rounded-full bg-red-600" aria-label="Unread" />
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1.5">
                                        <Clock className="h-3 w-3" />
                                        Received {formatReceived(brief.receivedAt)}
                                    </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                    <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs">
                                        <Link href={taskLink(brief)}>Open task</Link>
                                    </Button>
                                    {!read && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => onMarkRead(brief.id)}
                                            className="h-7 px-2 text-xs"
                                        >
                                            <Check className="h-3 w-3 mr-1" />
                                            Mark read
                                        </Button>
                                    )}
                                    {onResend && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => onResend(brief.id)}
                                            className="h-7 px-2 text-xs"
                                        >
                                            <Send className="h-3 w-3 mr-1" />
                                            Resend
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })
            )}
        </div>
    );
}

export default InstructionInbox;
