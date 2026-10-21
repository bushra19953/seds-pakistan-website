'use client';

import React, { useState, useMemo } from 'react';
import {
    ShieldAlert,
    ShieldCheck,
    Trash2,
    AlertTriangle,
    Info,
    ArrowRight,
    Fingerprint,
    FileWarning,
    MessageSquareQuote,
    Unlock,
    Lock,
    Activity
} from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogTrigger
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { permissionsConfig, Privilege, Role } from '@/config/permissions';
import { USER_ROLES } from '@/lib/roles';

interface AuthorityInspectorProps {
    userUid: string;
    userName: string;
    currentRole: string;
    roleOptions: { key: string; label: string }[];
    /** Current custom display title on the user profile, if one is set. */
    currentCustomTitle?: string | null;
    onAssign: (newRole: string, reason: string, customTitle?: string) => Promise<void>;
    onRevoke: (reason: string) => Promise<void>;
    /**
     * Mark the member Departed (soft delete). Member hard delete is
     * retired (Workstream F): departure is a reversible status change
     * via POST /api/admin/users/[uid]/depart, never a physical erase.
     */
    onDepart: (reason: string) => Promise<void>;
}

/**
 * Authority Inspector v11.0
 * Granular power management with privilege diffing and mandatory justification.
 */
export default function AuthorityInspector({
    userUid,
    userName,
    currentRole,
    roleOptions,
    currentCustomTitle,
    onAssign,
    onRevoke,
    onDepart
}: AuthorityInspectorProps) {
    const [selectedRole, setSelectedRole] = useState<string | null>(null);
    const [customTitle, setCustomTitle] = useState('');
    const [justification, setJustification] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [activeTab, setActiveTab] = useState<'assign' | 'revoke' | 'depart'>('assign');

    // Calculate privilege diff if a new role is selected
    const privilegeDiff = useMemo(() => {
        if (!selectedRole || selectedRole === currentRole) return null;

        const currentPerms = (Object.keys(permissionsConfig) as Privilege[]).filter(
            p => permissionsConfig[p].includes(currentRole as any)
        );
        const newPerms = (Object.keys(permissionsConfig) as Privilege[]).filter(
            p => permissionsConfig[p].includes(selectedRole as any)
        );

        const gained = newPerms.filter(p => !currentPerms.includes(p));
        const lost = currentPerms.filter(p => !newPerms.includes(p));

        return { gained, lost };
    }, [selectedRole, currentRole]);

    const handleAction = async () => {
        if (!justification.trim() || justification.length < 10) return;

        setIsProcessing(true);
        try {
            if (activeTab === 'assign' && selectedRole) {
                const trimmedTitle = customTitle.trim();
                await onAssign(selectedRole, justification, trimmedTitle ? trimmedTitle : undefined);
            } else if (activeTab === 'revoke') {
                await onRevoke(justification);
            } else if (activeTab === 'depart') {
                await onDepart(justification);
            }
        } finally {
            setIsProcessing(false);
            setJustification('');
            setSelectedRole(null);
            setCustomTitle('');
        }
    };

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 border-primary/20 hover:bg-primary/10 hover:border-primary/40 transition-all font-mono text-[10px] tracking-widest uppercase">
                    <Fingerprint className="w-3 h-3 text-primary" />
                    AUTHORITY
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl bg-black/95 border-primary/20 text-foreground backdrop-blur-2xl shadow-[0_0_50px_rgba(var(--primary),0.15)] overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent" />

                <DialogHeader className="p-6">
                    <div className="flex justify-between items-start">
                        <div>
                            <DialogTitle className="text-2xl font-black tracking-tighter flex items-center gap-3">
                                <ShieldAlert className="text-primary w-6 h-6" />
                                AUTHORITY INSPECTOR
                            </DialogTitle>
                            <DialogDescription className="text-muted-foreground mt-1">
                                Inspecting authority for <span className="text-foreground font-bold">{userName}</span> (UID: {userUid.slice(0, 8)}...)
                            </DialogDescription>
                        </div>
                        <Badge variant="outline" className="border-primary/30 text-primary font-mono bg-primary/5 uppercase tracking-tighter">
                            Current: {USER_ROLES[currentRole as Role] || currentRole}
                        </Badge>
                    </div>
                    {currentCustomTitle && (
                        <p className="mt-2 text-xs text-muted-foreground">
                            Display title: <span className="text-foreground font-semibold">{currentCustomTitle}</span>
                        </p>
                    )}
                </DialogHeader>

                <div className="grid grid-cols-4 border-y border-primary/10">
                    <button
                        onClick={() => setActiveTab('assign')}
                        className={cn(
                            "p-4 text-xs font-bold uppercase tracking-widest transition-all",
                            activeTab === 'assign' ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:bg-muted"
                        )}
                    >
                        GRANT / APPOINT
                    </button>
                    <button
                        onClick={() => setActiveTab('revoke')}
                        className={cn(
                            "p-4 text-xs font-bold uppercase tracking-widest transition-all",
                            activeTab === 'revoke' ? "bg-orange-500/10 text-orange-400 border-b-2 border-orange-500" : "text-muted-foreground hover:bg-muted"
                        )}
                    >
                        REVOKE POWER
                    </button>
                    <button
                        onClick={() => setActiveTab('depart')}
                        className={cn(
                            "p-4 text-xs font-bold uppercase tracking-widest transition-all",
                            activeTab === 'depart' ? "bg-red-500/10 text-red-500 border-b-2 border-red-500" : "text-muted-foreground hover:bg-muted"
                        )}
                    >
                        MARK DEPARTED
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    {activeTab === 'assign' && (
                        <div className="space-y-4 animate-in slide-in-from-left duration-300">
                            <div className="space-y-2">
                                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Select New Designation</Label>
                                <Select value={selectedRole || ''} onValueChange={setSelectedRole}>
                                    <SelectTrigger className="bg-background/80 border-primary/20 text-foreground h-12 focus:ring-primary/40">
                                        <SelectValue placeholder="Chose target authority level..." />
                                    </SelectTrigger>
                                    <SelectContent className="bg-black/95 border-primary/20 text-foreground backdrop-blur-md max-h-[300px]">
                                        {roleOptions.map((opt) => (
                                            <SelectItem key={opt.key} value={opt.key} disabled={opt.key === currentRole} className="focus:bg-primary/20">
                                                {opt.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Custom Title (optional)</Label>
                                <Input
                                    placeholder="Administrative Apprentice on Probation"
                                    className="bg-background/80 border-primary/20 text-foreground h-12 focus:ring-primary/40"
                                    value={customTitle}
                                    onChange={(e) => setCustomTitle(e.target.value)}
                                    maxLength={80}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    Display name only. Permissions still come from the canonical designation selected above.
                                </p>
                            </div>

                            {privilegeDiff && (
                                <div className="grid grid-cols-2 gap-4 p-4 rounded-xl bg-muted border border-white/5 animate-in fade-in duration-500">
                                    <div className="space-y-3">
                                        <h4 className="text-[10px] font-black tracking-widest text-primary flex items-center gap-2">
                                            <Unlock className="w-3 h-3" /> PRIVILEGES GAINED
                                        </h4>
                                        <div className="flex flex-wrap gap-2">
                                            {privilegeDiff.gained.length > 0 ? privilegeDiff.gained.map(p => (
                                                <Badge key={p} variant="outline" className="bg-green-500/10 border-green-500/30 text-green-400 text-[9px] lowercase font-mono">
                                                    + {p}
                                                </Badge>
                                            )) : <span className="text-[10px] text-muted-foreground/40 italic">None gained</span>}
                                        </div>
                                    </div>
                                    <div className="space-y-3">
                                        <h4 className="text-[10px] font-black tracking-widest text-orange-400 flex items-center gap-2">
                                            <Lock className="w-3 h-3" /> PRIVILEGES LOST
                                        </h4>
                                        <div className="flex flex-wrap gap-2">
                                            {privilegeDiff.lost.length > 0 ? privilegeDiff.lost.map(p => (
                                                <Badge key={p} variant="outline" className="bg-orange-500/10 border-orange-500/30 text-orange-400 text-[9px] lowercase font-mono">
                                                    - {p}
                                                </Badge>
                                            )) : <span className="text-[10px] text-muted-foreground/40 italic">None lost</span>}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'revoke' && (
                        <div className="space-y-4 animate-in slide-in-from-top duration-300">
                            <div className="flex items-start gap-4 p-4 rounded-xl bg-orange-500/10 border border-orange-500/20">
                                <AlertTriangle className="w-6 h-6 text-orange-400 shrink-0" />
                                <div>
                                    <h4 className="font-bold text-sm text-orange-400 uppercase tracking-tighter">Authority Revocation Procedure</h4>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        This action will immediately strip <span className="text-foreground font-bold">{userName}</span> of their current rank and reset them to <span className="text-foreground font-bold">General Member</span> status.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'depart' && (
                        <div className="space-y-4 animate-in slide-in-from-right duration-300">
                            <div className="flex items-start gap-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                                <ShieldAlert className="w-6 h-6 text-red-500 shrink-0" />
                                <div>
                                    <h4 className="font-bold text-sm text-red-500 uppercase tracking-tighter">Mark Member Departed</h4>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        This marks the member <span className="text-foreground font-bold">Departed</span> (soft delete): their record, history and audit trail are retained, open positions are ended, and direct reports are unlinked. Nothing is physically erased, and the member can be reinstated later.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                                <MessageSquareQuote className="w-3 h-3" /> Mandatory Justification
                            </Label>
                            <span className={cn("text-[9px] font-mono", justification.length < 10 ? "text-red-500" : "text-primary")}>
                                {justification.length} / 200 chars min
                            </span>
                        </div>
                        <Textarea
                            placeholder="Why is this authority level being changed? (Audit required)"
                            className="bg-background/80 border-primary/20 text-foreground min-h-[100px] resize-none focus:ring-primary/40"
                            value={justification}
                            onChange={(e) => setJustification(e.target.value)}
                            maxLength={500}
                        />
                    </div>
                </div>

                <DialogFooter className="p-6 bg-muted border-t border-primary/10">
                    <Button variant="ghost" onClick={() => { setSelectedRole(null); setCustomTitle(''); setJustification(''); }} className="text-muted-foreground hover:text-foreground">
                        Cancel
                    </Button>
                    <Button
                        disabled={
                            isProcessing ||
                            justification.length < 10 ||
                            (activeTab === 'assign' && (!selectedRole || selectedRole === currentRole))
                        }
                        onClick={handleAction}
                        className={cn(
                            "gap-2 px-8 transition-all duration-500",
                            activeTab === 'assign' && "bg-primary hover:bg-primary/90 text-black font-black",
                            activeTab === 'revoke' && "bg-orange-600 hover:bg-orange-700 text-foreground",
                            activeTab === 'depart' && "bg-red-600 hover:bg-red-700 text-foreground"
                        )}
                    >
                        {isProcessing ? (
                            <Activity className="w-4 h-4 animate-spin" />
                        ) : (
                            <>
                                {activeTab === 'assign' && <ShieldCheck className="w-4 h-4" />}
                                {activeTab === 'revoke' && <Unlock className="w-4 h-4" />}
                                {activeTab === 'depart' && <Trash2 className="w-4 h-4" />}
                                {activeTab === 'assign' ? "CONFIRM APPOINTMENT" : activeTab === 'revoke' ? "STRIP AUTHORITY" : "MARK DEPARTED"}
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
