"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Search, Plus, Loader2, Check, UserPlus, MapPin } from 'lucide-react';
import { getAuth } from 'firebase/auth';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';

interface UserSuggestion {
    id: string;
    displayName: string;
    email: string;
    photoURL: string | null;
    role: string;
    chapterId: string | null;
    managerId: string | null;
    isInChapter: boolean;
    exactMatch?: boolean;
}

interface SmartUserSearchProps {
    chapterId: string;
    onAddUser: (user: UserSuggestion) => void;
    onCreateNew: (email?: string) => void;
    onFilterChange: (query: string) => void;
    onFocusNode: (nodeId: string) => void; // NEW: zoom to node
}

export function SmartUserSearch({
    chapterId,
    onAddUser,
    onCreateNew,
    onFilterChange,
    onFocusNode
}: SmartUserSearchProps) {
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
    const [loading, setLoading] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const [addingId, setAddingId] = useState<string | null>(null);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<NodeJS.Timeout>();
    const { showSuccessToast, showErrorToast, showInfoToast } = useEnhancedToast();

    const getToken = async () => (await getAuth().currentUser?.getIdToken()) || null;

    // Search users
    const searchUsers = useCallback(async (q: string) => {
        if (!q || q.length < 2) {
            setSuggestions([]);
            return;
        }

        setLoading(true);
        try {
            const token = await getToken();
            const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}&chapterId=${chapterId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (res.ok) {
                const data = await res.json();
                setSuggestions(data.users || []);
            }
        } catch (err) {
            console.error('Search failed:', err);
        } finally {
            setLoading(false);
        }
    }, [chapterId]);

    // Debounced search
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);

        if (query.length >= 2) {
            debounceRef.current = setTimeout(() => searchUsers(query), 300);
        } else {
            setSuggestions([]);
        }

        // Also filter existing nodes
        onFilterChange(query);

        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [query, searchUsers, onFilterChange]);

    // Handle click on user - either zoom to them OR add them
    const handleUserAction = async (user: UserSuggestion) => {
        if (user.isInChapter) {
            // ZOOM TO NODE - user already in chapter
            onFocusNode(user.id);
            showSuccessToast(`Found: ${user.displayName} (highlighted)`);
            setQuery('');
            setShowDropdown(false);
            setSuggestions([]);
            return;
        }

        // ADD TO CHAPTER - user not in chapter, needs to be added
        setAddingId(user.id);
        try {
            const token = await getToken();
            const res = await fetch('/api/admin/hierarchy/add-existing', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: user.id,
                    chapterId: chapterId === 'all' ? null : chapterId,
                    managerId: null // Add as root for now
                })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to add');
            }

            const data = await res.json();
            showSuccessToast(`${user.displayName} added to chapter`);

            // Notify parent to add node with the PERSISTED data
            onAddUser({
                ...user,
                ...data.user,
                isInChapter: true
            });

            setQuery('');
            setShowDropdown(false);
            setSuggestions([]);

        } catch (err) {
            showErrorToast(err instanceof Error ? err.message : 'Failed to add user');
        } finally {
            setAddingId(null);
        }
    };

    // Handle Enter key
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            setShowDropdown(false);
            setQuery('');
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightIndex(prev => Math.min(prev + 1, suggestions.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIndex(prev => Math.max(prev - 1, -1));
        } else if (e.key === 'Enter') {
            e.preventDefault();

            if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
                handleUserAction(suggestions[highlightIndex]);
            } else if (highlightIndex === suggestions.length) {
                onCreateNew(query);
                setQuery('');
                setShowDropdown(false);
            } else if (suggestions.length > 0) {
                // Auto-select first match
                handleUserAction(suggestions[0]);
            } else if (query.includes('@')) {
                // No results but looks like email - offer to create
                onCreateNew(query);
                setQuery('');
                setShowDropdown(false);
            }
        }
    };

    // Click outside to close
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
                inputRef.current && !inputRef.current.contains(e.target as Node)) {
                setShowDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    return (
        <div className="relative">
            <div className="relative flex gap-2">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        ref={inputRef}
                        placeholder="Search or add by name/email..."
                        className="pl-9 bg-slate-900/90 border-slate-700 text-white"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setShowDropdown(true);
                            setHighlightIndex(-1);
                        }}
                        onFocus={() => query.length >= 2 && setShowDropdown(true)}
                        onKeyDown={handleKeyDown}
                    />
                    {loading && (
                        <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                </div>
                <Button
                    size="icon"
                    variant="outline"
                    className="bg-slate-900/90 border-slate-700"
                    onClick={() => onCreateNew(query || undefined)}
                    title="Create new person"
                >
                    <Plus className="h-4 w-4" />
                </Button>
            </div>

            {/* Suggestions Dropdown */}
            {showDropdown && (query.length >= 2 || suggestions.length > 0) && (
                <div
                    ref={dropdownRef}
                    className="absolute top-full mt-1 left-0 right-10 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 max-h-80 overflow-auto"
                >
                    {suggestions.length === 0 && !loading && (
                        <div className="p-4 text-center text-muted-foreground">
                            <p className="text-sm">No users found</p>
                            {query.includes('@') && (
                                <Button
                                    variant="link"
                                    className="text-primary mt-2"
                                    onClick={() => { onCreateNew(query); setShowDropdown(false); }}
                                >
                                    <UserPlus className="h-4 w-4 mr-1" /> Create &quot;{query}&quot;
                                </Button>
                            )}
                        </div>
                    )}

                    {suggestions.map((user, idx) => (
                        <button
                            key={user.id}
                            className={`w-full flex items-center gap-3 p-3 hover:bg-slate-800 transition-colors text-left ${highlightIndex === idx ? 'bg-slate-800' : ''
                                }`}
                            onClick={() => handleUserAction(user)}
                            disabled={addingId === user.id}
                        >
                            <Avatar className="h-9 w-9">
                                <AvatarImage src={user.photoURL || undefined} />
                                <AvatarFallback className="bg-slate-700 text-white text-xs">
                                    {user.displayName?.charAt(0)?.toUpperCase() || '?'}
                                </AvatarFallback>
                            </Avatar>

                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium text-white text-sm truncate">
                                        {user.displayName}
                                    </span>
                                    {user.exactMatch && (
                                        <Badge variant="outline" className="text-[10px] px-1">Exact</Badge>
                                    )}
                                </div>
                                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                            </div>

                            {addingId === user.id ? (
                                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            ) : user.isInChapter ? (
                                <Badge variant="secondary" className="text-[10px] shrink-0 bg-green-500/20 text-green-400 border-green-500/30">
                                    <MapPin className="h-3 w-3 mr-1" /> Find
                                </Badge>
                            ) : (
                                <Badge className="bg-primary text-black text-[10px] shrink-0">
                                    <Plus className="h-3 w-3 mr-1" /> Add
                                </Badge>
                            )}
                        </button>
                    ))}

                    {/* Create new option */}
                    {query.length >= 2 && (
                        <button
                            className={`w-full flex items-center gap-3 p-3 hover:bg-slate-800 border-t border-slate-700 ${highlightIndex === suggestions.length ? 'bg-slate-800' : ''
                                }`}
                            onClick={() => { onCreateNew(query); setShowDropdown(false); }}
                        >
                            <div className="h-9 w-9 rounded-full bg-primary/20 flex items-center justify-center">
                                <UserPlus className="h-4 w-4 text-primary" />
                            </div>
                            <span className="text-sm text-primary">Create new person{query.includes('@') ? ` (${query})` : ''}</span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
