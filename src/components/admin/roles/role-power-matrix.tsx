'use client';

import React, { useMemo, useState } from 'react';
import {
    Shield,
    ChevronRight,
    Info,
    Lock,
    Unlock,
    Activity,
    Users,
    FileText,
    CreditCard,
    Zap
} from 'lucide-react';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/components/ui/table';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { permissionsConfig, Privilege, Role } from '@/config/permissions';
import { USER_ROLES } from '@/lib/roles';

/**
 * Role Power Matrix v11.0
 * Visual capability map for the SEDS Pakistan admin panel.
 */
export default function RolePowerMatrix() {
    const [hoveredPrivilege, setHoveredPrivilege] = useState<Privilege | null>(null);
    const [hoveredRole, setHoveredRole] = useState<string | null>(null);

    const roles = useMemo(() => {
        return Object.keys(USER_ROLES).sort();
    }, []);

    const privileges = useMemo(() => {
        return Object.keys(permissionsConfig) as Privilege[];
    }, []);

    // Categorize privileges for better scanning
    const categories = useMemo(() => {
        return {
            'Authority & Users': ['assignRoles', 'selfRoleChange', 'deleteUser', 'viewAuditLogs', 'listAuditLogs'],
            'Gamification': ['adjustUserPoints', 'adjustUserBadges', 'manageBadges'],
            'Applications': ['manageApplications', 'listApplications', 'manageAdminApplications'],
            'Projects & Tasks': ['manageProjects', 'manageTasks'],
            'Content': ['manageBlogs', 'manageOwnBlogs', 'manageEvents', 'manageWorkshops', 'manageAnnouncements', 'manageGallery', 'canManageGallery', 'canManagePages', 'managePagesContact'],
            'Organization': ['manageRoleDefinitions', 'manageTeamMembers', 'manageRoleHistory', 'manageChapters', 'manageOrganizations', 'listEventRegistrations']
        };
    }, []);

    const getPowerLevel = (role: string) => {
        if (role === 'superadmin') return 100;
        if (role === 'president_national') return 95;
        if (role.includes('vice_president') || role.includes('director')) return 80;
        if (role.includes('chair') || role.includes('head')) return 60;
        if (role === 'member') return 10;
        return 0;
    };

    const renderCell = (role: string, privilege: Privilege) => {
        const hasPerm = permissionsConfig[privilege].includes(role as any);
        const isHovered = hoveredPrivilege === privilege || hoveredRole === role;

        return (
            <TableCell
                key={`${role}-${privilege}`}
                className={cn(
                    "text-center p-2 transition-colors duration-200 border-x border-primary/5",
                    hasPerm ? "bg-primary/5" : "bg-transparent",
                    isHovered && "bg-primary/10"
                )}
            >
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="flex justify-center items-center cursor-help">
                                {hasPerm ? (
                                    <Shield className="w-5 h-5 text-primary drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" />
                                ) : (
                                    <Lock className="w-4 h-4 text-muted-foreground/30" />
                                )}
                            </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="bg-black/90 border-primary/20 text-foreground backdrop-blur-md">
                            <p className="font-bold text-xs uppercase tracking-wider mb-1">
                                {hasPerm ? "Authorized" : "Locked"}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                                {USER_ROLES[role as Role]} can {privilege.replace(/([A-Z])/g, ' $1').toLowerCase()}
                            </p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            </TableCell>
        );
    };

    return (
        <div className="w-full space-y-8 glass-morphism p-6 rounded-2xl border border-primary/20 backdrop-blur-xl animate-in fade-in duration-700">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-primary/10 pb-6">
                <div>
                    <h2 className="text-3xl font-black tracking-tighter text-gradient flex items-center gap-3">
                        <Zap className="text-primary animate-pulse" />
                        ROLE POWER MATRIX <span className="text-xs font-mono text-primary/50 tracking-normal font-normal">v11.0 NUCLEAR</span>
                    </h2>
                    <p className="text-muted-foreground text-sm mt-1 max-w-md">
                        Visual capability map for the 24 active administrative roles. Audit every privilege with absolute precision.
                    </p>
                </div>
                <div className="flex items-center gap-3 bg-background/80 p-3 rounded-xl border border-primary/10 backdrop-blur-md">
                    <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-primary shadow-[0_0_10px_rgba(var(--primary),0.8)]" />
                        <span className="text-[10px] uppercase font-bold text-muted-foreground">Authorized</span>
                    </div>
                    <div className="h-4 w-[1px] bg-primary/20 mx-2" />
                    <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full border border-primary/30" />
                        <span className="text-[10px] uppercase font-bold text-muted-foreground">Locked</span>
                    </div>
                </div>
            </div>

            <ScrollArea className="h-[70vh] rounded-xl border border-primary/10">
                <div className="relative overflow-auto">
                    <Table className="border-collapse">
                        <TableHeader className="bg-background/80 sticky top-0 z-20 backdrop-blur-md">
                            <TableRow className="border-b border-primary/20">
                                <TableHead className="w-[200px] bg-black/80 sticky left-0 z-30 border-r border-primary/20 backdrop-blur-xl">
                                    <div className="flex items-center gap-2 text-primary font-bold">
                                        <Activity className="w-4 h-4" />
                                        CAPABILITIES
                                    </div>
                                </TableHead>
                                {roles.map((role) => (
                                    <TableHead
                                        key={role}
                                        className={cn(
                                            "min-w-[120px] text-center transition-all duration-300",
                                            hoveredRole === role && "bg-primary/5 scale-105"
                                        )}
                                        onMouseEnter={() => setHoveredRole(role)}
                                        onMouseLeave={() => setHoveredRole(null)}
                                    >
                                        <div className="flex flex-col items-center gap-1 group">
                                            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest group-hover:text-primary transition-colors">
                                                {role}
                                            </span>
                                            <span className="text-xs font-bold whitespace-nowrap px-2">
                                                {USER_ROLES[role as Role]}
                                            </span>
                                            <div className="w-full h-1 bg-background/80 rounded-full mt-1 overflow-hidden">
                                                <div
                                                    className="h-full bg-primary animate-in slide-in-from-left duration-1000"
                                                    style={{ width: `${getPowerLevel(role)}%` }}
                                                />
                                            </div>
                                        </div>
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {Object.entries(categories).map(([category, catPrivileges]) => (
                                <React.Fragment key={category}>
                                    <TableRow className="bg-primary/5 border-y border-primary/10">
                                        <TableCell
                                            colSpan={roles.length + 1}
                                            className="py-2 px-4 text-[10px] font-black uppercase tracking-[0.2em] text-primary/70"
                                        >
                                            {category}
                                        </TableCell>
                                    </TableRow>
                                    {catPrivileges.map((privilege) => (
                                        <TableRow
                                            key={privilege}
                                            className={cn(
                                                "group transition-all hover:bg-muted",
                                                hoveredPrivilege === privilege && "bg-muted"
                                            )}
                                            onMouseEnter={() => setHoveredPrivilege(privilege as Privilege)}
                                            onMouseLeave={() => setHoveredPrivilege(null)}
                                        >
                                            <TableCell
                                                className="font-medium sticky left-0 z-10 bg-black/10 backdrop-blur-md border-r border-primary/20 py-4 group-hover:translate-x-1 transition-transform"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <ChevronRight className="w-3 h-3 text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    <div className="flex flex-col">
                                                        <span className="text-sm tracking-tight text-white/90 group-hover:text-primary transition-colors capitalize">
                                                            {privilege.replace(/([A-Z])/g, ' $1').toLowerCase()}
                                                        </span>
                                                        <span className="text-[10px] font-mono text-muted-foreground/60 uppercase">
                                                            {privilege}
                                                        </span>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            {roles.map((role) => renderCell(role, privilege as Privilege))}
                                        </TableRow>
                                    ))}
                                </React.Fragment>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </ScrollArea>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-primary/10">
                <div className="flex items-start gap-4 p-4 rounded-xl bg-muted border border-white/5">
                    <Shield className="w-8 h-8 text-primary shrink-0" />
                    <div>
                        <h4 className="font-bold text-sm">Strict Authorization</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                            All privileges are synchronized with Firestore Security Rules to prevent backend exploits.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-4 p-4 rounded-xl bg-muted border border-white/5">
                    <Activity className="w-8 h-8 text-primary shrink-0" />
                    <div>
                        <h4 className="font-bold text-sm">Force Refresh</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                            Changes trigger a global ID Token refresh (v11.0 Instant Auth) to update permissions immediately.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-4 p-4 rounded-xl bg-muted border border-white/5">
                    <Users className="w-8 h-8 text-primary shrink-0" />
                    <div>
                        <h4 className="font-bold text-sm">Role Definitions</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                            Admins can link these keys to full Role Definitions in the CMS for automatic documentation.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
