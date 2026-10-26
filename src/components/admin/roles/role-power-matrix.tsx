'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
    Shield,
    ChevronRight,
    Lock,
    Activity,
    Users,
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ADMIN_PERMISSIONS, type PermissionKey } from '@/config/permission-registry';
import { USER_ROLES } from '@/lib/roles';
import { useFirestore } from '@/firebase';
import { getAllRoleDefinitionsCached, type RoleDefinition } from '@/lib/role-definitions';
import {
    MATRIX_CATEGORIES,
    MATRIX_PERMISSION_KEYS,
    buildMatrixRow,
    type MatrixCell,
    type MatrixDefinitionsBySlug,
} from '@/lib/role-power-matrix';

/**
 * Role Power Matrix
 * Visual capability map for the SEDS Pakistan admin panel.
 *
 * Honesty contract (2026-10-26): rows are the 46 PermissionKeys of
 * src/config/permission-registry.ts and nothing else. A cell is
 * resolved by src/lib/role-power-matrix.ts from the same inputs the
 * server resolver uses: a roleDefinitions permissions array is
 * authoritative when one exists for the role; otherwise the static
 * fallback in src/config/permissions.config.ts decides. The
 * permissions/{role} boolean docs (server tier 2) have no client
 * reader and are not shown; the banner below states that on screen.
 */
export default function RolePowerMatrix() {
    const firestore = useFirestore();
    const [hoveredKey, setHoveredKey] = useState<PermissionKey | null>(null);
    const [hoveredRole, setHoveredRole] = useState<string | null>(null);
    const [definitions, setDefinitions] = useState<MatrixDefinitionsBySlug | null>(null);
    const [definitionsState, setDefinitionsState] = useState<'loading' | 'ready' | 'error'>('loading');

    useEffect(() => {
        let cancelled = false;
        if (!firestore) return;
        getAllRoleDefinitionsCached(firestore)
            .then((rows: RoleDefinition[]) => {
                if (cancelled) return;
                const bySlug = new Map<string, RoleDefinition>();
                for (const row of rows) {
                    bySlug.set(row.role, row);
                    if (row.slug) bySlug.set(row.slug, row);
                }
                setDefinitions(bySlug);
                setDefinitionsState('ready');
            })
            .catch(() => {
                if (cancelled) return;
                setDefinitionsState('error');
            });
        return () => {
            cancelled = true;
        };
    }, [firestore]);

    const roles = useMemo(() => {
        return Object.keys(USER_ROLES).sort();
    }, []);

    const rowsByRole = useMemo(() => {
        const map = new Map<string, Record<PermissionKey, MatrixCell>>();
        for (const role of roles) {
            map.set(role, buildMatrixRow(role, definitions ?? undefined));
        }
        return map;
    }, [roles, definitions]);

    const powerPercent = (role: string) => {
        const row = rowsByRole.get(role);
        if (!row) return 0;
        const granted = MATRIX_PERMISSION_KEYS.filter((k) => row[k].granted).length;
        return Math.round((granted / MATRIX_PERMISSION_KEYS.length) * 100);
    };

    const renderCell = (role: string, key: PermissionKey) => {
        const cell = rowsByRole.get(role)?.[key] ?? { granted: false, source: 'static' as const };
        const hasPerm = cell.granted;
        const isHovered = hoveredKey === key || hoveredRole === role;
        const def = ADMIN_PERMISSIONS[key];

        return (
            <TableCell
                key={`${role}-${key}`}
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
                        <TooltipContent side="top" className="bg-black/90 border-primary/20 text-white backdrop-blur-md">
                            <p className="font-bold text-xs uppercase tracking-wider mb-1">
                                {hasPerm ? "Authorized" : "Locked"}
                            </p>
                            <p className="text-[10px] text-white/70">
                                {USER_ROLES[role]}: {def.label} ({key})
                            </p>
                            <p className="text-[10px] text-white/50">
                                Source: {cell.source === 'blanket'
                                    ? 'blanket role (holds every key)'
                                    : cell.source === 'definition'
                                        ? 'roleDefinitions array (tier 1, authoritative)'
                                        : 'static fallback config (tier 3)'}
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
                        ROLE POWER MATRIX <span className="text-xs font-mono text-primary/50 tracking-normal font-normal">registry keys, live definitions</span>
                    </h2>
                    <p className="text-muted-foreground text-sm mt-1 max-w-md">
                        Every one of the {MATRIX_PERMISSION_KEYS.length} permission keys the code
                        actually checks, for the {roles.length} catalog roles. Rows are the
                        PermissionKey registry; there are no legacy alias rows.
                    </p>
                    <p className="text-muted-foreground text-xs mt-2 max-w-xl">
                        {definitionsState === 'ready'
                            ? 'Cells resolve from roleDefinitions arrays (tier 1, authoritative) where a definition exists, otherwise the static fallback config (tier 3). The server-only permissions/{role} boolean docs (tier 2) are not read by this screen, so a grant held only there will not show here.'
                            : definitionsState === 'error'
                                ? 'Role definitions could not be loaded, so cells below show the static fallback config (tier 3) only. Do not read them as a role\u2019s full power until this screen reloads successfully.'
                                : 'Loading role definitions. Until they arrive, cells show the static fallback config (tier 3) only.'}
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
                                                {USER_ROLES[role]}
                                            </span>
                                            <div className="w-full h-1 bg-background/80 rounded-full mt-1 overflow-hidden">
                                                <div
                                                    className="h-full bg-primary animate-in slide-in-from-left duration-1000"
                                                    style={{ width: `${powerPercent(role)}%` }}
                                                />
                                            </div>
                                        </div>
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {MATRIX_CATEGORIES.map(({ category, keys }) => (
                                <React.Fragment key={category}>
                                    <TableRow className="bg-primary/5 border-y border-primary/10">
                                        <TableCell
                                            colSpan={roles.length + 1}
                                            className="py-2 px-4 text-[10px] font-black uppercase tracking-[0.2em] text-primary/70"
                                        >
                                            {category}
                                        </TableCell>
                                    </TableRow>
                                    {keys.map((key) => (
                                        <TableRow
                                            key={key}
                                            className={cn(
                                                "group transition-all hover:bg-muted",
                                                hoveredKey === key && "bg-muted"
                                            )}
                                            onMouseEnter={() => setHoveredKey(key)}
                                            onMouseLeave={() => setHoveredKey(null)}
                                        >
                                            <TableCell
                                                className="font-medium sticky left-0 z-10 bg-black/10 backdrop-blur-md border-r border-primary/20 py-4 group-hover:translate-x-1 transition-transform"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <ChevronRight className="w-3 h-3 text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    <div className="flex flex-col">
                                                        <span className="text-sm tracking-tight text-foreground/90 group-hover:text-primary transition-colors">
                                                            {ADMIN_PERMISSIONS[key].label}
                                                        </span>
                                                        <span className="text-[10px] font-mono text-muted-foreground/60">
                                                            {key}
                                                        </span>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            {roles.map((role) => renderCell(role, key))}
                                        </TableRow>
                                    ))}
                                </React.Fragment>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </ScrollArea>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-primary/10">
                <div className="flex items-start gap-4 p-4 rounded-xl bg-muted border border-border">
                    <Shield className="w-8 h-8 text-primary shrink-0" />
                    <div>
                        <h4 className="font-bold text-sm">What a cell means</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                            A shield means the server resolver would grant this key to this
                            role from its roleDefinitions array, or from the static fallback
                            when no definition array exists. Hover a cell to see which source decided it.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-4 p-4 rounded-xl bg-muted border border-border">
                    <Activity className="w-8 h-8 text-primary shrink-0" />
                    <div>
                        <h4 className="font-bold text-sm">What this screen does not show</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                            The permissions/&#123;role&#125; boolean docs (server tier 2), per-user
                            custom-role grants, chapter scoping, and Firestore Security Rules.
                            Enforcement is server-side; this screen is a view of role grants, not the gate itself.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-4 p-4 rounded-xl bg-muted border border-border">
                    <Users className="w-8 h-8 text-primary shrink-0" />
                    <div>
                        <h4 className="font-bold text-sm">Changing power</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                            Edit a role in the Role Registry or Role Privileges. Saving writes the
                            roleDefinitions array this matrix reads, so a saved change shows here on reload.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
