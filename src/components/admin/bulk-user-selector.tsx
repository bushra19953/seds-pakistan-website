"use client";

import Image from "next/image";

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Users, CheckSquare, Square, Download, RefreshCw, Filter, X } from "lucide-react";
import { useUser } from "@/firebase";

export interface EligibleUser {
    uid: string;
    displayName: string;
    email: string;
    photoURL?: string;
    role?: string;
    roleLabel?: string;
    position?: string;
    chapterId?: string;
    chapterName?: string;
}

interface RoleOption {
    key: string;
    label: string;
}

interface ChapterOption {
    id: string;
    name: string;
}

interface BulkUserSelectorProps {
    selectedUserIds: string[];
    onSelectionChange: (ids: string[]) => void;
    disabled?: boolean;
}

export function BulkUserSelector({ selectedUserIds, onSelectionChange, disabled = false }: BulkUserSelectorProps) {
    const { user } = useUser();
    const [users, setUsers] = useState<EligibleUser[]>([]);
    const [roles, setRoles] = useState<RoleOption[]>([]);
    const [chapters, setChapters] = useState<ChapterOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Filters
    const [searchQuery, setSearchQuery] = useState("");
    const [roleFilter, setRoleFilter] = useState<string>("_all");
    const [chapterFilter, setChapterFilter] = useState<string>("_all");

    // Fetch users from API
    const fetchUsers = useCallback(async () => {
        if (!user) return;

        setLoading(true);
        setError(null);

        try {
            const token = await user.getIdToken();
            const params = new URLSearchParams();
            params.set('limit', '500'); // Get all users

            const res = await fetch(`/api/v1/users/certificate-eligible?${params}`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to fetch users');
            }

            const data = await res.json();
            setUsers(data.users || []);
            setRoles(data.roles || []);
            setChapters(data.chapters || []);
        } catch (err: any) {
            setError(err.message || 'Failed to load users');
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        fetchUsers();
    }, [fetchUsers]);

    // Filter users based on search and filters
    const filteredUsers = useMemo(() => {
        let result = [...users];

        // Search filter (fuzzy name + email)
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            result = result.filter(u =>
                u.displayName.toLowerCase().includes(q) ||
                u.email.toLowerCase().includes(q) ||
                u.email.toLowerCase() === q
            );
        }

        // Role filter
        if (roleFilter && roleFilter !== "_all") {
            result = result.filter(u => u.role === roleFilter);
        }

        // Chapter filter
        if (chapterFilter && chapterFilter !== "_all") {
            result = result.filter(u => u.chapterId === chapterFilter);
        }

        return result;
    }, [users, searchQuery, roleFilter, chapterFilter]);

    // Selection helpers
    const allVisibleSelected = useMemo(() => {
        if (filteredUsers.length === 0) return false;
        return filteredUsers.every(u => selectedUserIds.includes(u.uid));
    }, [filteredUsers, selectedUserIds]);

    const someVisibleSelected = useMemo(() => {
        return filteredUsers.some(u => selectedUserIds.includes(u.uid));
    }, [filteredUsers, selectedUserIds]);

    const handleSelectAll = () => {
        const newIds = new Set(selectedUserIds);
        filteredUsers.forEach(u => newIds.add(u.uid));
        onSelectionChange(Array.from(newIds));
    };

    const handleDeselectAll = () => {
        const visibleIds = new Set(filteredUsers.map(u => u.uid));
        onSelectionChange(selectedUserIds.filter(id => !visibleIds.has(id)));
    };

    const handleToggle = (uid: string) => {
        if (selectedUserIds.includes(uid)) {
            onSelectionChange(selectedUserIds.filter(id => id !== uid));
        } else {
            onSelectionChange([...selectedUserIds, uid]);
        }
    };

    const handleClearFilters = () => {
        setSearchQuery("");
        setRoleFilter("_all");
        setChapterFilter("_all");
    };

    const hasActiveFilters = searchQuery.trim() || roleFilter !== "_all" || chapterFilter !== "_all";

    // Export to CSV
    const handleExportCSV = () => {
        const rows = [["UID", "Name", "Email", "Role", "Chapter"]];
        filteredUsers.forEach(u => {
            rows.push([u.uid, u.displayName, u.email, u.roleLabel || u.role || "", u.chapterName || ""]);
        });
        const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `certificate-eligible-users-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
    };

    if (loading) {
        return (
            <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 text-center border rounded-lg border-destructive/30 bg-destructive/5">
                <p className="text-sm text-destructive mb-2">{error}</p>
                <Button size="sm" variant="outline" onClick={fetchUsers}>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Retry
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Search and Filters */}
            <div className="space-y-3">
                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search by name or email..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                        disabled={disabled}
                    />
                </div>

                {/* Filter Row */}
                <div className="flex flex-wrap gap-2">
                    <div className="flex-1 min-w-[150px]">
                        <Select value={roleFilter} onValueChange={setRoleFilter} disabled={disabled}>
                            <SelectTrigger className="w-full">
                                <Filter className="h-4 w-4 mr-2 text-muted-foreground" />
                                <SelectValue placeholder="Filter by role" />
                            </SelectTrigger>
                            <SelectContent className="max-h-64">
                                <SelectItem value="_all">All Roles ({users.length})</SelectItem>
                                {roles.map(r => (
                                    <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex-1 min-w-[150px]">
                        <Select value={chapterFilter} onValueChange={setChapterFilter} disabled={disabled}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="Filter by chapter" />
                            </SelectTrigger>
                            <SelectContent className="max-h-64">
                                <SelectItem value="_all">All Chapters</SelectItem>
                                {chapters.map(c => (
                                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {hasActiveFilters && (
                        <Button variant="ghost" size="icon" onClick={handleClearFilters} title="Clear filters">
                            <X className="h-4 w-4" />
                        </Button>
                    )}
                </div>
            </div>

            {/* Selection Actions Bar */}
            <div className="flex items-center justify-between px-3 py-2 bg-muted/30 rounded-lg border">
                <div className="flex items-center gap-3">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                        <strong className="text-primary">{selectedUserIds.length}</strong> of{" "}
                        <strong>{filteredUsers.length}</strong> selected
                        {users.length !== filteredUsers.length && (
                            <span className="text-muted-foreground"> ({users.length} total)</span>
                        )}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={allVisibleSelected ? handleDeselectAll : handleSelectAll}
                        disabled={disabled || filteredUsers.length === 0}
                    >
                        {allVisibleSelected ? (
                            <>
                                <Square className="h-4 w-4 mr-1.5" />
                                Deselect All
                            </>
                        ) : (
                            <>
                                <CheckSquare className="h-4 w-4 mr-1.5" />
                                Select All ({filteredUsers.length})
                            </>
                        )}
                    </Button>

                    <Button size="sm" variant="ghost" onClick={handleExportCSV} title="Export to CSV">
                        <Download className="h-4 w-4" />
                    </Button>

                    <Button size="sm" variant="ghost" onClick={fetchUsers} title="Refresh">
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* User List */}
            <div className="border rounded-lg overflow-hidden max-h-[400px] overflow-y-auto">
                {filteredUsers.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">
                        <Users className="h-10 w-10 mx-auto mb-3 opacity-50" />
                        <p className="font-medium">No users found</p>
                        <p className="text-sm">Try adjusting your search or filters</p>
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-muted/50 sticky top-0">
                            <tr className="border-b">
                                <th className="w-10 p-3">
                                    <Checkbox
                                        checked={allVisibleSelected}
                                        onCheckedChange={() => allVisibleSelected ? handleDeselectAll() : handleSelectAll()}
                                        aria-label="Select all"
                                        disabled={disabled}
                                    />
                                </th>
                                <th className="text-left p-3 font-medium">User</th>
                                <th className="text-left p-3 font-medium hidden md:table-cell">Role</th>
                                <th className="text-left p-3 font-medium hidden lg:table-cell">Chapter</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredUsers.map((user) => {
                                const isSelected = selectedUserIds.includes(user.uid);
                                return (
                                    <tr
                                        key={user.uid}
                                        className={`border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors ${isSelected ? "bg-primary/5" : ""
                                            }`}
                                        onClick={() => !disabled && handleToggle(user.uid)}
                                    >
                                        <td className="p-3">
                                            <Checkbox
                                                checked={isSelected}
                                                onCheckedChange={() => handleToggle(user.uid)}
                                                onClick={(e) => e.stopPropagation()}
                                                disabled={disabled}
                                            />
                                        </td>
                                        <td className="p-3">
                                            <div className="flex items-center gap-3">
                                                {user.photoURL ? (
                                                    <Image src={user.photoURL} alt="" width={32} height={32} className="w-8 h-8 rounded-full object-cover" />
                                                ) : (
                                                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                                                        {user.displayName.charAt(0).toUpperCase()}
                                                    </div>
                                                )}
                                                <div className="min-w-0">
                                                    <div className="font-medium truncate">{user.displayName}</div>
                                                    <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-3 hidden md:table-cell">
                                            {user.roleLabel || user.role ? (
                                                <Badge variant="outline" className="text-xs">
                                                    {user.roleLabel || user.role}
                                                </Badge>
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </td>
                                        <td className="p-3 hidden lg:table-cell">
                                            {user.chapterName ? (
                                                <span className="text-xs">{user.chapterName}</span>
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

export default BulkUserSelector;
