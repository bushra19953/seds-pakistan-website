"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
    Loader2,
    Check,
    X,
    ExternalLink,
    User,
    Calendar,
    RefreshCw,
    Edit3,
} from "lucide-react";
import { useUser } from "@/firebase/auth/use-user";

export type ColumnType = 'text' | 'link' | 'badge' | 'user' | 'date' | 'longText' | 'number';

export interface ColumnDef<T> {
    key: keyof T | string;
    label: string;
    type: ColumnType;
    badgeMap?: Record<string, { label: string; classNames?: string }>;
    userMap?: { displayNameKey: keyof T; emailKey?: keyof T };
    linkMap?: { urlKey: keyof T; displayKey?: keyof T };
    render?: (row: T) => React.ReactNode;
}

export interface EditFieldDef {
    key: string;
    label: string;
    type: 'text' | 'url' | 'number' | 'date' | 'textarea' | 'boolean' | 'select';
    options?: { value: string; label: string }[];
    required?: boolean;
}

export interface ActionDef {
    type: 'approve' | 'reject';
    label: string;
    requiresNote?: boolean;
    defaultPointsMap?: Record<string, number>; // Maps a row property (e.g. "type") to a default points value
    defaultPointsKey?: string; // Which row property to check for the map (e.g. 'type' -> 'competition')
    extraFields?: EditFieldDef[];
}

export interface AdminApprovalTableProps<T extends { id: string; status: string }> {
    collectionName: string;
    title: string;
    description?: string;
    columns: ColumnDef<T>[];
    actions: ActionDef[];
    bulkActions?: boolean;
    editableFields?: EditFieldDef[];
    initialStatus?: string;
    onRefresh?: () => void;
}

export function AdminApprovalTable<T extends { id: string; status: string;[key: string]: any }>({
    collectionName,
    title,
    description,
    columns,
    actions,
    bulkActions = true,
    editableFields = [],
    initialStatus = 'pending',
    onRefresh
}: AdminApprovalTableProps<T>) {
    const { toast } = useToast();
    const { user } = useUser(); // Needed to retrieve session token
    const [data, setData] = useState<T[]>([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<string>(initialStatus);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // Review Dialog State
    const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
    const [reviewMode, setReviewMode] = useState<'single' | 'bulk'>('single');
    const [reviewingId, setReviewingId] = useState<string | null>(null);
    const [reviewAction, setReviewAction] = useState<ActionDef | null>(null);
    const [actionLoading, setActionLoading] = useState(false);

    // Form States
    const [reviewNotes, setReviewNotes] = useState('');
    const [pointsToAward, setPointsToAward] = useState(0);
    const [extraFieldsState, setExtraFieldsState] = useState<Record<string, any>>({});

    // Inline Edit State
    const [isEditingData, setIsEditingData] = useState(false);
    const [editFormState, setEditFormState] = useState<Record<string, any>>({});

    const fetchData = useCallback(async (forceTokenRefresh = false) => {
        setLoading(true);
        try {
            const token = await user?.getIdToken(forceTokenRefresh);
            if (!token) return;

            const res = await fetch(`/api/admin/universal-review?collection=${collectionName}&status=${statusFilter}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const result = await res.json();

            if (res.ok && result.success) {
                setData(result.data || []);
                setSelectedIds(new Set()); // Clear selection on fetch
            } else {
                toast({ title: "Error", description: result.error || "Failed to load data", variant: "destructive" });
            }
        } catch (error: any) {
            console.error('Fetch error:', error);
            toast({ title: "Network Error", description: "Failed to connect to server.", variant: "destructive" });
        } finally {
            setLoading(false);
        }
    }, [collectionName, statusFilter, user, toast]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleSelectAll = (checked: boolean) => {
        if (checked) {
            setSelectedIds(new Set(data.filter(r => r.status === 'pending').map(r => r.id)));
        } else {
            setSelectedIds(new Set());
        }
    };

    const handleSelectRow = (id: string, checked: boolean) => {
        const next = new Set(selectedIds);
        if (checked) next.add(id);
        else next.delete(id);
        setSelectedIds(next);
    };

    const openReviewDialog = (id: string | null, actionType: 'approve' | 'reject', mode: 'single' | 'bulk') => {
        const actionDef = actions.find(a => a.type === actionType);
        if (!actionDef) return;

        setReviewingId(id);
        setReviewAction(actionDef);
        setReviewMode(mode);
        setIsEditingData(false);

        // Reset forms
        setReviewNotes('');
        setExtraFieldsState({});
        setEditFormState({});

        if (mode === 'single' && id) {
            const row = data.find(r => r.id === id);
            if (row) {
                // Initialize default points based on map
                if (actionDef.type === 'approve' && actionDef.defaultPointsMap && actionDef.defaultPointsKey) {
                    const mappedVal = row[actionDef.defaultPointsKey] as string;
                    setPointsToAward(actionDef.defaultPointsMap[mappedVal] || 10);
                } else {
                    setPointsToAward(10);
                }

                // Initialize edit form
                const initialEdits: Record<string, any> = {};
                editableFields.forEach(f => {
                    initialEdits[f.key] = row[f.key] ?? '';
                });
                setEditFormState(initialEdits);

                // Initialize extra fields based on action config (e.g. addToCompetitions checkbox default false)
                if (actionDef.extraFields) {
                    const extras: Record<string, any> = {};
                    actionDef.extraFields.forEach(f => {
                        extras[f.key] = f.type === 'boolean' ? false : '';
                    });
                    setExtraFieldsState(extras);
                }
            }
        } else if (mode === 'bulk') {
            setPointsToAward(10); // Standard default for bulk, or calculate average
            if (actionDef.extraFields) {
                const extras: Record<string, any> = {};
                actionDef.extraFields.forEach(f => {
                    extras[f.key] = f.type === 'boolean' ? false : '';
                });
                setExtraFieldsState(extras);
            }
        }

        setReviewDialogOpen(true);
    };

    const handleExecuteReview = async () => {
        if (!reviewAction) return;
        const targetIds = reviewMode === 'single' ? [reviewingId!] : Array.from(selectedIds);
        if (targetIds.length === 0) return;

        setActionLoading(true);
        try {
            const token = await user?.getIdToken();
            const payload = {
                collection: collectionName,
                ids: targetIds,
                action: reviewAction.type,
                notes: reviewNotes,
                points: reviewAction.type === 'approve' ? pointsToAward : undefined,
                updatedData: isEditingData ? editFormState : undefined,
                extraFields: extraFieldsState
            };

            const res = await fetch('/api/admin/universal-review', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            if (!res.ok) throw new Error(result.error || "Review execution failed");

            toast({ title: 'Success', description: result.message || `Processed ${targetIds.length} items.` });
            setReviewDialogOpen(false);
            fetchData();
            if (onRefresh) onRefresh();

        } catch (error: any) {
            toast({ title: "Failed", description: error.message, variant: "destructive" });
        } finally {
            setActionLoading(false);
        }
    };

    const renderColumnData = (row: T, col: ColumnDef<T>) => {
        if (col.render) return col.render(row);

        const val = row[col.key as keyof T];

        switch (col.type) {
            case 'text':
                return <span className="text-sm font-medium">{val as string}</span>;
            case 'longText':
                return <p className="text-xs text-muted-foreground line-clamp-2">{val as string}</p>;
            case 'badge':
                if (col.badgeMap && typeof val === 'string') {
                    const badgeInfo = col.badgeMap[val] || col.badgeMap['default'] || { label: val, classNames: 'bg-muted text-muted-foreground' };
                    return <Badge variant="outline" className={badgeInfo.classNames}>{badgeInfo.label}</Badge>;
                }
                return <Badge variant="outline">{String(val)}</Badge>;
            case 'link':
                if (col.linkMap) {
                    const url = row[col.linkMap.urlKey as keyof T] as string;
                    const display = col.linkMap.displayKey ? (row[col.linkMap.displayKey as keyof T] as string) : url;
                    if (!url) return null;
                    return (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-600 hover:underline text-xs truncate max-w-[200px]">
                            <ExternalLink className="h-3 w-3 flex-shrink-0" />
                            <span className="truncate">{display}</span>
                        </a>
                    );
                }
                return null;
            case 'user':
                if (col.userMap) {
                    const name = row[col.userMap.displayNameKey as keyof T] as string;
                    return (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <User className="h-3 w-3" />
                            <span>{name}</span>
                        </div>
                    );
                }
                return null;
            case 'date':
                if (!val) return null;
                return (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        <span>{new Date(val as string).toLocaleDateString()}</span>
                    </div>
                );
            case 'number':
                return <span className="font-mono">{Number(val).toLocaleString()}</span>;
            default:
                return <span>{String(val)}</span>;
        }
    };

    const hasPending = data.some(r => r.status === 'pending');
    const allPendingSelected = hasPending && Array.from(selectedIds).length === data.filter(r => r.status === 'pending').length;

    return (
        <Card className="shadow-lg border-primary/10">
            <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-muted/5 border-b pb-4">
                <div>
                    <CardTitle className="text-xl font-mono tracking-tight">{title}</CardTitle>
                    {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
                </div>
                <div className="flex items-center gap-2">
                    {/* Bulk Actions Toolbar */}
                    {bulkActions && selectedIds.size > 0 && (
                        <div className="flex items-center gap-2 mr-4 bg-primary/5 p-1 rounded-md border border-primary/20 animate-in fade-in zoom-in-95">
                            <span className="text-xs font-semibold px-2">{selectedIds.size} selected</span>
                            {actions.map(a => (
                                <Button
                                    key={a.type}
                                    size="sm"
                                    variant={a.type === 'approve' ? 'default' : 'destructive'}
                                    className="h-7 text-xs"
                                    onClick={() => openReviewDialog(null, a.type, 'bulk')}
                                >
                                    {a.type === 'approve' ? <Check className="h-3 w-3 mr-1" /> : <X className="h-3 w-3 mr-1" />}
                                    Bulk {a.label}
                                </Button>
                            ))}
                        </div>
                    )}

                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="w-32 h-9 text-xs font-mono">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="approved">Approved</SelectItem>
                            <SelectItem value="rejected">Rejected</SelectItem>
                            <SelectItem value="all">All</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => fetchData(true)} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="p-0">
                {loading ? (
                    <div className="flex justify-center items-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
                    </div>
                ) : data.length === 0 ? (
                    <div className="text-center py-12">
                        <p className="text-muted-foreground font-mono text-sm">No records found for &apos;{statusFilter}&apos;.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-border">
                        {/* Table Header with Select All */}
                        {bulkActions && statusFilter === 'pending' && (
                            <div className="flex items-center p-3 sm:px-4 bg-muted/10">
                                <Checkbox
                                    checked={allPendingSelected}
                                    onCheckedChange={handleSelectAll}
                                    className="mr-3"
                                />
                                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Select All Pending</span>
                            </div>
                        )}

                        {/* Rows */}
                        {data.map((row) => (
                            <div key={row.id} className="p-4 sm:p-5 flex flex-col sm:flex-row gap-4 hover:bg-muted/5 transition-colors">
                                {bulkActions && row.status === 'pending' && (
                                    <div className="pt-2">
                                        <Checkbox
                                            checked={selectedIds.has(row.id)}
                                            onCheckedChange={(c) => handleSelectRow(row.id, c === true)}
                                        />
                                    </div>
                                )}

                                <div className="flex-1 min-w-0 grid gap-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {columns.filter(c => c.type === 'badge').map(c =>
                                            <React.Fragment key={c.key as string}>{renderColumnData(row, c)}</React.Fragment>
                                        )}
                                        {columns.filter(c => c.type === 'text').map(c =>
                                            <React.Fragment key={c.key as string}>{renderColumnData(row, c)}</React.Fragment>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-3 flex-wrap mt-1">
                                        {columns.filter(c => ['user', 'date', 'link'].includes(c.type)).map(c =>
                                            <React.Fragment key={c.key as string}>{renderColumnData(row, c)}</React.Fragment>
                                        )}
                                    </div>

                                    {columns.filter(c => c.type === 'longText').map(c =>
                                        <React.Fragment key={c.key as string}>{renderColumnData(row, c)}</React.Fragment>
                                    )}
                                </div>

                                {/* Row Actions */}
                                {row.status === 'pending' && (
                                    <div className="flex sm:flex-col gap-2 flex-shrink-0 justify-start sm:justify-center">
                                        {actions.map(a => (
                                            <Button
                                                key={a.type}
                                                size="sm"
                                                variant={a.type === 'approve' ? 'outline' : 'ghost'}
                                                className={`h-8 w-full justify-start ${a.type === 'approve' ? 'text-green-600 border-green-200 hover:bg-green-50' : 'text-red-500 hover:text-red-600 hover:bg-red-50'}`}
                                                onClick={() => openReviewDialog(row.id, a.type, 'single')}
                                            >
                                                {a.type === 'approve' ? <Check className="h-4 w-4 mr-2" /> : <X className="h-4 w-4 mr-2" />}
                                                {a.label}
                                            </Button>
                                        ))}
                                    </div>
                                )}
                                {row.status === 'approved' && (
                                    <div className="flex items-center px-3 text-sm font-medium text-green-600 bg-green-50 rounded-lg">
                                        Approved {row.pointsAwarded ? `(+${row.pointsAwarded})` : ''}
                                    </div>
                                )}
                                {row.status === 'rejected' && (
                                    <div className="flex items-center px-3 text-sm font-medium text-red-600 bg-red-50 rounded-lg">
                                        Rejected
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>

            {/* Configurable Review Dialog */}
            <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
                <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            {reviewAction?.type === 'approve' ? <Check className="text-green-500" /> : <X className="text-red-500" />}
                            {reviewAction?.label} {reviewMode === 'bulk' ? `(${selectedIds.size} items)` : ''}
                        </DialogTitle>
                        <DialogDescription>
                            {reviewMode === 'single' && reviewingId
                                ? `You are reviewing an individual record.`
                                : `You are performing a bulk action on ${selectedIds.size} records.`}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-5 mt-4">
                        {/* Inline Data Editor (Single Approval Only) */}
                        {reviewMode === 'single' && reviewAction?.type === 'approve' && editableFields.length > 0 && (
                            <div className="border border-border/50 rounded-lg p-4 bg-muted/20">
                                <div className="flex items-center justify-between mb-3 border-b pb-2">
                                    <h4 className="text-sm font-semibold flex items-center gap-1.5"><Edit3 className="h-4 w-4" /> Edit Record Data</h4>
                                    <Checkbox
                                        id="enableEdit"
                                        checked={isEditingData}
                                        onCheckedChange={(c) => setIsEditingData(c === true)}
                                    />
                                </div>

                                {isEditingData ? (
                                    <div className="grid gap-3 animate-in fade-in slide-in-from-top-1">
                                        {editableFields.map(field => (
                                            <div key={field.key} className="grid gap-1.5">
                                                <Label className="text-xs text-muted-foreground uppercase">{field.label}</Label>
                                                {field.type === 'textarea' ? (
                                                    <Textarea
                                                        value={editFormState[field.key] || ''}
                                                        onChange={e => setEditFormState(prev => ({ ...prev, [field.key]: e.target.value }))}
                                                        className="h-20 text-sm"
                                                    />
                                                ) : field.type === 'select' && field.options ? (
                                                    <Select
                                                        value={editFormState[field.key] || ''}
                                                        onValueChange={v => setEditFormState(prev => ({ ...prev, [field.key]: v }))}
                                                    >
                                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                                        <SelectContent>
                                                            {field.options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                                                        </SelectContent>
                                                    </Select>
                                                ) : (
                                                    <Input
                                                        type={field.type}
                                                        value={editFormState[field.key] || ''}
                                                        onChange={e => setEditFormState(prev => ({ ...prev, [field.key]: e.target.value }))}
                                                        className="h-8 text-sm"
                                                    />
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground cursor-pointer" onClick={() => setIsEditingData(true)}>
                                        Check the box above to fix typos (links, titles, etc.) before approving.
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Action Extra Fields (e.g. Points, Add to Repo map) */}
                        {reviewAction?.type === 'approve' && (
                            <>
                                <div className="grid gap-2">
                                    <Label className="font-semibold">Points to Award</Label>
                                    <Input
                                        type="number"
                                        value={pointsToAward}
                                        onChange={(e) => setPointsToAward(Number(e.target.value))}
                                        min={0}
                                        className="w-32"
                                    />
                                    <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                                        {reviewMode === 'bulk' ? 'Will be applied to ALL selected users' : 'Points given to user immediately'}
                                    </p>
                                </div>

                                {reviewAction.extraFields?.map(field => (
                                    field.type === 'boolean' ? (
                                        <div key={field.key} className="flex items-center gap-2 p-3 bg-muted/30 rounded-md border border-border/50">
                                            <Checkbox
                                                id={field.key}
                                                checked={extraFieldsState[field.key] === true}
                                                onCheckedChange={c => setExtraFieldsState(p => ({ ...p, [field.key]: c === true }))}
                                            />
                                            <Label htmlFor={field.key} className="cursor-pointer font-medium">{field.label}</Label>
                                        </div>
                                    ) : null
                                ))}
                            </>
                        )}

                        {/* Review Notes (Required for Reject) */}
                        <div className="grid gap-2">
                            <Label className={`font-semibold ${reviewAction?.requiresNote ? "text-destructive" : ""}`}>
                                {reviewAction?.type === 'reject' ? 'Rejection Reason (Sent to User)' : 'Internal Notes (Optional)'}
                                {reviewAction?.requiresNote && " *"}
                            </Label>
                            <Textarea
                                value={reviewNotes}
                                onChange={(e) => setReviewNotes(e.target.value)}
                                placeholder={reviewAction?.type === 'reject' ? "Please explain why..." : "Optional..."}
                                className="resize-none"
                                rows={3}
                            />
                        </div>

                        <div className="flex gap-2 justify-end pt-2">
                            <Button variant="ghost" onClick={() => setReviewDialogOpen(false)}>Cancel</Button>
                            <Button
                                onClick={handleExecuteReview}
                                disabled={actionLoading || (reviewAction?.requiresNote && !reviewNotes.trim())}
                                variant={reviewAction?.type === 'approve' ? 'default' : 'destructive'}
                                className="min-w-[120px]"
                            >
                                {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {reviewMode === 'bulk' ? `Confirm Bulk ${reviewAction?.label}` : `Confirm ${reviewAction?.label}`}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
