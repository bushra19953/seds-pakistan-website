'use client';

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { doc, serverTimestamp, getDoc, collection, getDocs, orderBy, query as firestoreQuery } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { useFirestore, useUser } from "@/firebase";
import { useToast } from "@/hooks/use-toast";
import { USER_ROLES, type UserRole, FOUNDER_UID, isSuperAdmin } from '@/lib/roles';
import { Shield, Info, HelpCircle, Globe, Building2, Sparkles, RefreshCw, Search, Check, CheckSquare, Square, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { setDoc } from '@/lib/client/firestore-wrapper';
import { ADMIN_PERMISSIONS, type PermissionKey, getRoleScope } from '@/config/permission-registry';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { normalizeRoleSlug } from '@/lib/unified-roles';

const permissionGroups: Record<string, PermissionKey[]> = {};
Object.entries(ADMIN_PERMISSIONS).forEach(([key, def]) => {
    if (!permissionGroups[def.category]) {
        permissionGroups[def.category] = [];
    }
    permissionGroups[def.category].push(key as PermissionKey);
});

const SLUG_TO_CANONICAL_ROLE: Record<string, UserRole> = Object.fromEntries(
    Object.entries(USER_ROLES).map(([roleKey, displayName]) => [normalizeRoleSlug(displayName), roleKey as UserRole])
);

const allGroupedKeys = Object.keys(ADMIN_PERMISSIONS) as PermissionKey[];

interface RolePrivilegesDrawerProps {
    roleSlug: string;
    roleName: string;
    initialPermissions?: string[]; 
    initialScope?: 'global' | 'chapter';
    initialAllowedChapters?: string[];
    canEdit?: boolean;
}

export function RolePrivilegesDrawer({ roleSlug, roleName, initialPermissions = [], initialScope, initialAllowedChapters = [], canEdit = true }: RolePrivilegesDrawerProps) {
    const [open, setOpen] = useState(false);
    const [permissions, setPermissions] = useState<Set<string>>(new Set(initialPermissions));
    const [scope, setScope] = useState<'global' | 'chapter'>(initialScope || 'chapter');
    const [isSaving, setIsSaving] = useState(false);
    const [chapters, setChapters] = useState<Array<{ id: string; name: string }>>([]);
    const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set(initialAllowedChapters));
    const [chapterSearch, setChapterSearch] = useState('');
    const [loadingChapters, setLoadingChapters] = useState(false);
    const [description, setDescription] = useState('');
    const [loadingDescription, setLoadingDescription] = useState(false);
    const firestore = useFirestore();
    const { toast } = useToast();

    useEffect(() => {
        if (open) {
            setPermissions(new Set(initialPermissions));
            setScope(initialScope || getRoleScope(roleSlug));
            setSelectedChapters(new Set(initialAllowedChapters));
            setDescription('');
        }
    }, [open, initialPermissions, initialScope, initialAllowedChapters, roleSlug]);

    // Load the current role description so it can be viewed and edited here
    // instead of in the database console. Matches the field read by
    // getAllRoleDefinitionsCached (description, falling back to responsibilities).
    useEffect(() => {
        // Guard: Firestore doc() throws synchronously on an undefined path
        // segment, which would break the drawer for a slugless doc.
        if (open && firestore && roleSlug) {
            setLoadingDescription(true);
            getDoc(doc(firestore, 'roleDefinitions', roleSlug))
                .then(snap => {
                    const data = snap.data() as any;
                    setDescription(data?.description || data?.responsibilities || '');
                })
                .catch(err => console.error('Failed to fetch role description:', err))
                .finally(() => setLoadingDescription(false));
        }
    }, [open, firestore, roleSlug]);

    useEffect(() => {
        if (open && firestore) {
            setLoadingChapters(true);
            const fetchChapters = async () => {
                try {
                    const snap = await getDocs(firestoreQuery(collection(firestore, 'chapters'), orderBy('name', 'asc')));
                    const list = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));
                    setChapters(list);
                } catch (err) { console.error('Failed to fetch chapters:', err); }
                finally { setLoadingChapters(false); }
            };
            fetchChapters();
        }
    }, [open, firestore]);

    const handleToggle = (key: string, checked: boolean) => {
        if (!canEdit) return;
        setPermissions(prev => {
            const next = new Set(prev);
            if (checked) next.add(key);
            else next.delete(key);
            return next;
        });
    };

    const handleGroupToggle = (groupKeys: string[], checked: boolean) => {
        if (!canEdit) return;
        setPermissions(prev => {
            const next = new Set(prev);
            groupKeys.forEach(key => {
                if (checked) next.add(key);
                else next.delete(key);
            });
            return next;
        });
    };

    const isReserved = ['superadmin', 'president_national'].includes(roleSlug);
    const { user, role: currentUserRole } = useUser() as any;
    const isFounder = user?.uid === FOUNDER_UID;

    const handleSave = async () => {
        const isTargetReserved = ['superadmin', 'president_national'].includes(roleSlug);
        const isUserExecutive = isSuperAdmin(currentUserRole, user?.uid || '');

        // Equality of Power: Only Executives (Superadmin/President) can modify reserved role configs
        if (isTargetReserved && !isUserExecutive) {
            toast({ variant: "destructive", title: "Access Denied", description: "Reserved role configurations require executive authority." });
            return;
        }

        if (!canEdit) {
            toast({ variant: "destructive", title: "Access Denied", description: "You do not have permission to modify role configurations." });
            return;
        }

        setIsSaving(true);
        try {
            const permsArray = Array.from(permissions);
            const allowedChaptersArray = Array.from(selectedChapters);
            
            // 1. Save Role Definition
            await setDoc(doc(firestore, 'roleDefinitions', roleSlug), {
                permissions: permsArray,
                scope: scope,
                allowedChapters: allowedChaptersArray,
                description: description.trim(),
                updatedAt: serverTimestamp(),
            }, { merge: true });

            // Ensure boolean map is fully populated for ALL keys to avoid Rule evaluation errors
            const booleanMap: Record<string, boolean | string | string[]> = { 
                _scope: scope, 
                _allowedChapters: allowedChaptersArray 
            };
            allGroupedKeys.forEach(p => { 
                booleanMap[p] = permissions.has(p); 
            });

            // 2. Sync to PERMISSIONS collection
            // We save to the slug as the primary key
            await setDoc(doc(firestore, 'permissions', roleSlug), booleanMap, { merge: true });
            
            // If target is reserved, Founder can always overwrite, but we keep slugs clean
            const targetRoleKey = SLUG_TO_CANONICAL_ROLE[roleSlug] || roleSlug;

            // 3. Sync to ROLE_PERMISSIONS (Registry view)
            await setDoc(doc(firestore, 'role_permissions', roleSlug), {
                ...booleanMap,
                permissions: permsArray,
                label: roleName,
                allowedPaths: allowedChaptersArray,
                updatedAt: serverTimestamp(),
            }, { merge: true });

            // 4. Force auth token refresh to apply new claims locally
            const auth = getAuth();
            if (auth.currentUser) await auth.currentUser.getIdToken(true);

            toast({ title: "Configuration Saved", description: `Role ${roleName} updated successfully.` });
            setOpen(false);
        } catch (error: any) {
            console.error("[RolePrivileges] Save Failed:", error);
            toast({ 
                variant: "destructive", 
                title: "Save Failed", 
                description: error?.code === 'permission-denied' 
                    ? "Security protocol rejected the write. Check Firestore Rules."
                    : "An internal error occurred during transmission."
            });
        } finally { setIsSaving(false); }
    };

    return (
        <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 border-primary/50 hover:bg-primary/10 transition-colors font-mono uppercase tracking-widest text-[10px]">
                    <Shield className="h-3 w-3 text-primary" />
                    Configure Role
                </Button>
            </SheetTrigger>
            <SheetContent className="w-full sm:max-w-xl flex flex-col h-full bg-slate-950 border-l border-slate-800">
                <SheetHeader className="pb-4 border-b border-slate-800">
                    <SheetTitle className="text-2xl font-black font-mono flex items-center gap-2 text-foreground">
                        <Shield className="h-6 w-6 text-primary" />
                        ROLE: {String(roleName || roleSlug || 'unknown').toUpperCase()}
                    </SheetTitle>
                    <SheetDescription className="text-muted-foreground font-mono text-[10px] uppercase">
                        Administrative Authority & Visibility Scope
                    </SheetDescription>
                </SheetHeader>

                <div className="p-6 bg-slate-900/50 border-b border-slate-800 space-y-6">
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Visibility Scope</Label>
                            <Badge variant="outline" className={`text-[9px] font-black uppercase ${scope === 'global' ? 'border-primary text-primary bg-primary/5' : 'border-amber-500 text-amber-500 bg-amber-500/5'}`}>
                                {scope === 'global' ? 'Global Access' : 'Chapter Restricted'}
                            </Badge>
                        </div>
                        
                        <RadioGroup value={scope} onValueChange={(v: any) => setScope(v)} className="grid grid-cols-2 gap-4">
                            <div>
                                <RadioGroupItem value="global" id="scope-global" className="peer sr-only" />
                                <Label htmlFor="scope-global" className="flex flex-col items-center justify-between rounded-xl border-2 border-slate-800 bg-slate-950 p-4 hover:bg-card peer-data-[state=checked]:border-primary transition-all cursor-pointer h-full text-foreground">
                                    <Globe className={`mb-3 h-6 w-6 ${scope === 'global' ? 'text-primary' : 'text-slate-600'}`} />
                                    <span className="text-[10px] font-black uppercase">Global</span>
                                </Label>
                            </div>
                            <div>
                                <RadioGroupItem value="chapter" id="scope-chapter" className="peer sr-only" />
                                <Label htmlFor="scope-chapter" className="flex flex-col items-center justify-between rounded-xl border-2 border-slate-800 bg-slate-950 p-4 hover:bg-card peer-data-[state=checked]:border-amber-500 transition-all cursor-pointer h-full text-foreground">
                                    <Building2 className={`mb-3 h-6 w-6 ${scope === 'chapter' ? 'text-amber-500' : 'text-slate-600'}`} />
                                    <span className="text-[10px] font-black uppercase">Chapter</span>
                                </Label>
                            </div>
                        </RadioGroup>
                    </div>

                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Role Description</Label>
                            {loadingDescription && <Loader2 className="h-3 w-3 animate-spin text-slate-600" />}
                        </div>
                        <Textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            disabled={!canEdit || loadingDescription}
                            rows={4}
                            placeholder="DESCRIBE WHAT THIS ROLE DOES DAY TO DAY..."
                            className="bg-slate-950 border-slate-800 text-xs text-foreground placeholder:text-slate-600 resize-y"
                        />
                        <p className="text-[10px] text-muted-foreground leading-tight">
                            The AI task engine matches work steps against this text when suggesting assignees. Write what the role physically does, not just what it oversees.
                        </p>
                    </div>

                    {scope === 'chapter' && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                            <div className="flex items-center justify-between">
                                <Label className="text-[10px] font-black uppercase text-muted-foreground">Chapter Assignment</Label>
                                <div className="flex gap-2">
                                    <Button variant="ghost" onClick={() => setSelectedChapters(new Set(chapters.map(c => c.id)))} className="h-5 px-2 text-[8px] font-black uppercase text-primary hover:bg-primary/10">All</Button>
                                    <Button variant="ghost" onClick={() => setSelectedChapters(new Set())} className="h-5 px-2 text-[8px] font-black uppercase text-muted-foreground hover:bg-slate-500/10">None</Button>
                                </div>
                            </div>
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                <Input 
                                    className="h-9 bg-slate-950 border-slate-800 pl-10 text-[10px] font-mono text-foreground placeholder:text-muted-foreground" 
                                    placeholder="SEARCH CHAPTERS..." 
                                    value={chapterSearch}
                                    onChange={e => setChapterSearch(e.target.value)}
                                />
                            </div>
                            <div className="bg-slate-950 border border-slate-800 rounded-xl max-h-48 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-slate-800">
                                {loadingChapters ? (
                                    <div className="flex items-center justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-slate-700" /></div>
                                ) : (
                                    <div className="grid grid-cols-1 gap-1">
                                        {chapters.filter(c => c.name.toLowerCase().includes(chapterSearch.toLowerCase())).map(c => {
                                            const isSelected = selectedChapters.has(c.id);
                                            return (
                                                <button
                                                    key={c.id}
                                                    onClick={() => setSelectedChapters(prev => {
                                                        const next = new Set(prev);
                                                        if (next.has(c.id)) next.delete(c.id);
                                                        else next.add(c.id);
                                                        return next;
                                                    })}
                                                    className={`flex items-center justify-between px-3 py-2 rounded-lg transition-all text-left ${isSelected ? 'bg-amber-500/10 text-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                                                >
                                                    <span className="text-[11px] font-bold uppercase">{c.name}</span>
                                                    {isSelected ? <CheckSquare className="h-3.5 w-3.5 text-amber-500" /> : <Square className="h-3.5 w-3.5 opacity-20" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                </div>

                <ScrollArea className="flex-1 -mx-6 px-6 py-4">
                    <div className="space-y-8 pb-8">
                        {Object.entries(permissionGroups).map(([groupName, keys]) => {
                            const allChecked = keys.every(k => permissions.has(k));
                            const someChecked = keys.some(k => permissions.has(k)) && !allChecked;
                            return (
                                <div key={groupName} className="space-y-4">
                                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                                        <h3 className="text-sm font-black uppercase tracking-tighter text-primary">{groupName}</h3>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[9px] font-bold text-muted-foreground uppercase">Batch Toggle</span>
                                            <Switch checked={allChecked} onCheckedChange={(c) => handleGroupToggle(keys, c)} className={someChecked ? "opacity-50" : ""} />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 gap-2">
                                        {keys.map((key) => {
                                            const def = ADMIN_PERMISSIONS[key];
                                            return (
                                                <div key={key} className="flex items-center justify-between p-3 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-all group">
                                                    <div className="flex-1 min-w-0 text-foreground">
                                                        <label htmlFor={`${roleSlug}-${key}`} className="text-xs font-bold flex items-center gap-2 mb-0.5 cursor-pointer">
                                                            {def.label}
                                                            <TooltipProvider delayDuration={50}><Tooltip>
                                                                <TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-slate-600" /></TooltipTrigger>
                                                                <TooltipContent side="top" className="max-w-[200px] text-[10px] bg-card border-slate-800 text-foreground">{def.description}</TooltipContent>
                                                            </Tooltip></TooltipProvider>
                                                        </label>
                                                        <p className="text-[10px] text-muted-foreground leading-tight">{def.description}</p>
                                                    </div>
                                                    <Switch id={`${roleSlug}-${key}`} checked={permissions.has(key)} onCheckedChange={(c) => handleToggle(key, c)} />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </ScrollArea>

                <div className="pt-4 border-t border-slate-800 flex justify-end gap-3 bg-slate-950 p-6">
                    <Button variant="outline" onClick={() => setOpen(false)} disabled={isSaving} className="font-bold text-foreground">CANCEL</Button>
                    <Button onClick={handleSave} disabled={isSaving} className="min-w-[140px] bg-primary text-black font-black uppercase tracking-widest">
                        {isSaving ? "TRANSMITTING..." : "SAVE CONFIGURATION"}
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
}
