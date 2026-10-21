"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuPortal, } from "@/components/ui/dropdown-menu";
import { MoreHorizontal, UserCog, Award, AlertTriangle, Tag } from "lucide-react";
import AwardBadgeDialog from "./award-badge-dialog";
import IssueWarningDialog from "./issue-warning-dialog";
import { useAuthorization } from "@/hooks/use-authorization";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import AuthorityInspector from "@/components/admin/roles/authority-inspector";
import { useFirestore, useUser } from "@/firebase";
import { toast } from "@/hooks/use-toast";
import { doc } from 'firebase/firestore';
;
import { revokeRole, deleteRoleProfile } from "@/lib/role-management";
import { ConsentRequiredDialog } from "@/components/admin/governance/consent-required-dialog";
import { isConsentGateBlocked, type ConsentGateErrorBody } from "@/lib/client/consent-gate-error";
import { triggerAuthorityRefresh } from "@/lib/authority-refresh";
import { deleteDoc } from '@/lib/client/firestore-wrapper';
import { MaskedContact } from '@/components/privacy/masked-contact';

export type UserRow = {
  uid: string;
  displayName: string;
  email: string;
  role?: string | null;
  customTitle?: string | null;
  chapterId?: string | null;
  chapterName?: string | null;
  isOnVacation?: boolean;
};

// Smart hash logic for coloring string tags
function getStringColor(str: string): { bg: string, text: string, border: string } {
  const norm = str.toLowerCase().trim();
  if (norm === 'admin' || norm === 'president_national') return { bg: 'bg-red-500/10', text: 'text-red-500', border: 'border-red-500/20' };
  if (norm === 'member') return { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/20' };
  if (norm === 'guest') return { bg: 'bg-slate-500/10', text: 'text-muted-foreground', border: 'border-slate-500/20' };

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

function UserActionsCell({
  user,
  roleOptions,
  onChangeRole,
  onRestoreWorkload,
}: {
  user: UserRow;
  roleOptions: RoleOption[];
  onChangeRole: (uid: string, newRole: string, customTitle?: string) => Promise<void>;
  onRestoreWorkload: (uid: string) => Promise<void>;
}) {
  const [gateBlock, setGateBlock] = useState<ConsentGateErrorBody | null>(null);
  const [awardOpen, setAwardOpen] = useState<boolean>(false);
  const [warningOpen, setWarningOpen] = useState<boolean>(false);
  const [titleOpen, setTitleOpen] = useState<boolean>(false);
  const [titleDraft, setTitleDraft] = useState<string>('');
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
                      <CommandSeparator />
                      <CommandGroup>
                        <CommandItem
                          onSelect={() => {
                            setTitleDraft(user.customTitle || '');
                            setTitleOpen(true);
                          }}
                        >
                          <Tag className="mr-2 h-4 w-4" />
                          <span>Set custom title</span>
                        </CommandItem>
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
        currentCustomTitle={user.customTitle ?? null}
        onAssign={async (newRole, reason, customTitle) => {
          // The display title travels with the role assignment and is
          // persisted to users/{uid}.customTitle via the sync-user-role API
          // route (Admin SDK). It is never written into roles/{uid}.role.
          await onChangeRole(user.uid, newRole, customTitle);
          await triggerAuthorityRefresh(user.uid);
        }}
        onRevoke={async (reason) => {
          const firestore = (window as any).firebaseFirestore;
          if (!firestore) return;
          try {
            const ok = await revokeRole(firestore, user.uid, (window as any).currentAuthUid, reason);
            if (!ok) {
              toast({ variant: "destructive", title: "Revoke failed", description: "The role could not be revoked." });
              return;
            }
            await triggerAuthorityRefresh(user.uid);
            toast({ title: "Authority Revoked", description: "User has been reset to member status." });
          } catch (e) {
            // Phase 2: removing a Category B office without consent opens
            // the consent dialog instead of failing silently (spec B.6).
            if (isConsentGateBlocked(e)) {
              setGateBlock(e.body);
              return;
            }
            throw e;
          }
        }}
        onDelete={async (reason) => {
          const firestore = (window as any).firebaseFirestore;
          if (!firestore) return;
          if (confirm(`NUCLEAR OPTION: Are you sure you want to PERMANENTLY ERASE the role profile for ${user.displayName}?`)) {
            try {
              const ok = await deleteRoleProfile(firestore, user.uid, (window as any).currentAuthUid, reason);
              if (!ok) {
                toast({ variant: "destructive", title: "Delete failed", description: "The role profile could not be deleted." });
                return;
              }
              await triggerAuthorityRefresh(user.uid);
              toast({ title: "Role Erased", description: "User role profile has been physically deleted." });
            } catch (e) {
              if (isConsentGateBlocked(e)) {
                setGateBlock(e.body);
                return;
              }
              throw e;
            }
          }
        }}
      />

      <ConsentRequiredDialog
        open={!!gateBlock}
        body={gateBlock}
        onClose={() => setGateBlock(null)}
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

      <Dialog open={titleOpen} onOpenChange={setTitleOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set custom title</DialogTitle>
            <DialogDescription>
              Display-only title for {user.displayName}. It shows under the role
              badge and never changes what the person is allowed to do.
              Permissions still come from the canonical role ({user.role || 'guest'}).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="custom-title-input">Custom title</Label>
            <Input
              id="custom-title-input"
              placeholder="e.g. Administrative Apprentice on Probation"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              maxLength={80}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty and save to clear the current title.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTitleOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const trimmed = titleDraft.trim();
                await onChangeRole(user.uid, user.role || 'member', trimmed);
                setTitleOpen(false);
              }}
            >
              Save title
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function buildUserColumns(
  roleOptions: RoleOption[],
  onChangeRole: (uid: string, newRole: string, customTitle?: string) => Promise<void>,
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
              <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] uppercase font-bold text-muted-foreground tracking-widest border border-slate-500/20" title="On Vacation">
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
        // Privacy shielding (spec section 5): mask by default; chairs and
        // presidents can unmask via the eye toggle, which writes an audit log.
        return (
          <MaskedContact
            value={email}
            type="email"
            targetUid={(row.original as UserRow).uid}
          />
        );
      },
    },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) => {
        const roleStr = (row.getValue<string | null>("role") || "guest").toString();
        const colors = getStringColor(roleStr);
        const customTitle = (row.original as UserRow).customTitle;
        return (
          <div className="flex flex-col items-start gap-1">
            <span className={`rounded px-2.5 py-0.5 text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}>{roleStr}</span>
            {customTitle ? (
              <span className="text-[11px] leading-tight text-muted-foreground italic">{customTitle}</span>
            ) : null}
          </div>
        );
      },
    },
    {
      accessorKey: "chapterId",
      header: "Chapter",
      cell: ({ row }) => {
        const chapterName = (row.original as any).chapterName || row.getValue<string | null>("chapterId");
        if (!chapterName) return <span className="text-muted-foreground text-xs">—</span>;
        const colors = getStringColor(String(chapterName));
        return <span className={`rounded px-2.5 py-0.5 text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}>{String(chapterName)}</span>;
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
        // Privacy shielding (spec section 5): mask by default; chairs and
        // presidents can unmask via the eye toggle, which writes an audit log.
        return (
          <MaskedContact
            value={wa}
            type="phone"
            targetUid={(row.original as UserRow).uid}
          />
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <UserActionsCell
          user={row.original}
          roleOptions={roleOptions}
          onChangeRole={onChangeRole}
          onRestoreWorkload={onRestoreWorkload}
        />
      ),
    },
  ];
}
