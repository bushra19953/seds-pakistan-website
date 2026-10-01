"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuPortal, } from "@/components/ui/dropdown-menu";
import { MoreHorizontal, UserCog, Award, AlertTriangle } from "lucide-react";
import AwardBadgeDialog from "./award-badge-dialog";
import IssueWarningDialog from "./issue-warning-dialog";
import { useAuthorization } from "@/hooks/use-authorization";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import AuthorityInspector from "@/components/admin/roles/authority-inspector";
import { useFirestore, useUser } from "@/firebase";
import { useToast } from "@/hooks/use-toast";
import { doc } from 'firebase/firestore';
;
import { revokeRole, deleteRoleProfile } from "@/lib/role-management";
import { triggerAuthorityRefresh } from "@/lib/authority-refresh";
import { deleteDoc } from '@/lib/client/firestore-wrapper';

export type UserRow = {
  uid: string;
  displayName: string;
  email: string;
  role?: string | null;
  isOnVacation?: boolean;
};

// Smart hash logic for coloring string tags
function getStringColor(str: string): { bg: string, text: string, border: string } {
  const norm = str.toLowerCase().trim();
  if (norm === 'admin' || norm === 'president_national') return { bg: 'bg-red-500/10', text: 'text-red-500', border: 'border-red-500/20' };
  if (norm === 'member') return { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/20' };
  if (norm === 'guest') return { bg: 'bg-slate-500/10', text: 'text-slate-400', border: 'border-slate-500/20' };

  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = norm.charCodeAt(i) + ((hash << 5) - hash);
  }

  const colors = [
    { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
    { bg: 'bg-violet-500/10', text: 'text-violet-500', border: 'border-violet-500/20' },
    { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
    { bg: 'bg-pink-500/10', text: 'text-pink-500', border: 'border-pink-500/20' },
    { bg: 'bg-cyan-500/10', text: 'text-cyan-500', border: 'border-cyan-500/20' },
    { bg: 'bg-rose-500/10', text: 'text-rose-500', border: 'border-rose-500/20' },
  ];

  return colors[Math.abs(hash) % colors.length];
}

export type RoleOption = {
  key: string;
  label: string;
};

export function buildUserColumns(
  roleOptions: RoleOption[],
  onChangeRole: (uid: string, newRole: string) => Promise<void>,
  onRestoreWorkload: (uid: string) => Promise<void>
): ColumnDef<UserRow>[] {
  return [
    {
      accessorKey: "displayName",
      header: "Display Name",
      cell: ({ row }) => {
        const name = row.getValue<string>("displayName");
        const isVacationing = row.original.isOnVacation;
        return (
          <div className="flex items-center gap-2">
            <span className={`font-medium ${isVacationing ? "text-muted-foreground opacity-70" : "text-foreground"}`}>
              {name || "—"}
            </span>
            {isVacationing && (
              <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] uppercase font-bold text-slate-500 tracking-widest border border-slate-500/20" title="On Vacation">
                Zzz
              </span>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "email",
      header: "Email",
      cell: ({ row }) => {
        const email = row.getValue<string>("email");
        if (!email) return <span className="text-muted-foreground">—</span>;
        return (
          <div className="flex items-center gap-2 group cursor-pointer w-fit" onClick={() => navigator.clipboard.writeText(email)}>
            <span className="text-muted-foreground transition-colors group-hover:text-foreground">{email}</span>
            <Button variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity" title="Copy Email">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-muted-foreground"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
            </Button>
          </div>
        );
      },
    },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) => {
        const roleStr = (row.getValue<string | null>("role") || "guest").toString();
        const colors = getStringColor(roleStr);
        return <span className={`rounded px-2.5 py-0.5 text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}>{roleStr}</span>;
      },
    },
    {
      accessorKey: "whatsapp",
      header: "WhatsApp",
      cell: ({ row }) => {
        // Support both field names for compatibility
        const val = row.original as any;
        const wa = val.whatsapp || val.whatsappNumber;
        if (!wa) return <span className="text-muted-foreground text-xs">—</span>;
        return (
          <div className="flex items-center gap-2 group">
            <span className="font-mono text-xs text-green-400">{wa}</span>
            <Button variant="ghost" size="icon" className="h-4 w-4 opacity-0 group-hover:opacity-100" onClick={() => {
              navigator.clipboard.writeText(wa);
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-muted-foreground"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
            </Button>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const user = row.original;
        const [awardOpen, setAwardOpen] = useState<boolean>(false);
        const [warningOpen, setWarningOpen] = useState<boolean>(false);
        const { isAuthorized: canManageRoles } = useAuthorization('canManageRoles');
        const { isAuthorized: canManageBadges } = useAuthorization('canManageBadges');
        const { isAuthorized: canManageUsers } = useAuthorization('canManageUsers');

        const isVacationing = !!user.isOnVacation;

        return (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  aria-label="Open actions"
                  disabled={isVacationing}
                  title={isVacationing ? "Actions are disabled while user is on vacation" : undefined}
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {canManageRoles && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <UserCog className="mr-2 h-4 w-4" />
                      <span>Change Role</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent className="p-0 w-64">
                        <Command>
                          <CommandInput placeholder="Search roles" />
                          <CommandList>
                            <CommandGroup>
                              {roleOptions.map((opt) => (
                                <CommandItem key={opt.key} onSelect={() => onChangeRole(user.uid, opt.key)}>
                                  {opt.label}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                )}

                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!canManageBadges} onClick={() => canManageBadges && setAwardOpen(true)}>
                  <Award className="mr-2 h-4 w-4" />
                  <span>{canManageBadges ? 'Award Badge' : 'Award Badge (no permission)'}</span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canManageUsers} onClick={() => canManageUsers && setWarningOpen(true)}>
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  <span>{canManageUsers ? 'Issue Warning' : 'Issue Warning (no permission)'}</span>
                </DropdownMenuItem>
                {/* RESTORE WORKLOAD ENGINE - Continuity & Resumption */}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onRestoreWorkload(user.uid)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2 h-4 w-4 text-emerald-500"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 21v-5h5" /></svg>
                  <span className="text-emerald-500 font-medium">Restore Workload</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <AuthorityInspector
              userUid={user.uid}
              userName={user.displayName}
              currentRole={user.role || 'guest'}
              roleOptions={roleOptions}
              onAssign={async (newRole, reason) => {
                await onChangeRole(user.uid, newRole);
                await triggerAuthorityRefresh(user.uid);
              }}
              onRevoke={async (reason) => {
                const firestore = (window as any).firebaseFirestore;
                if (!firestore) return;
                await revokeRole(firestore, user.uid, (window as any).currentAuthUid, reason);
                await triggerAuthorityRefresh(user.uid);
                toast({ title: "Authority Revoked", description: "User has been reset to member status." });
              }}
              onDelete={async (reason) => {
                const firestore = (window as any).firebaseFirestore;
                if (!firestore) return;
                if (confirm(`NUCLEAR OPTION: Are you sure you want to PERMANENTLY ERASE the role profile for ${user.displayName}?`)) {
                  await deleteRoleProfile(firestore, user.uid, (window as any).currentAuthUid, reason);
                  await triggerAuthorityRefresh(user.uid);
                  toast({ title: "Role Erased", description: "User role profile has been physically deleted." });
                }
              }}
            />

            <AwardBadgeDialog
              open={awardOpen}
              onOpenChange={setAwardOpen}
              userUid={user.uid}
              userName={user.displayName}
            />
            <IssueWarningDialog
              open={warningOpen}
              onOpenChange={setWarningOpen}
              userUid={user.uid}
              userName={user.displayName}
            />
          </>
        );
      },
    },
  ];
}
