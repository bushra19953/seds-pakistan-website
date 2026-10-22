'use client';

/**
 * Role Privileges - the deep-linkable page hosting the ONE per-role
 * editor (RolePermissionEditor, shared with the Role Registry tab on
 * /admin/users). This page owns the role list and the definition
 * lifecycle dialogs (create / delete); editing a role's permissions,
 * scope, allowed chapters, and sidebar access all happens in the
 * shared editor, which saves ONLY through the gated
 * POST /api/admin/role-permissions. No direct Firestore writes here.
 */

import { useState, useEffect, useCallback } from 'react';
import { useUser } from '@/firebase/auth/use-user';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Shield, Plus, Trash2, Loader2, ChevronRight } from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { RolePermissionEditor } from '@/components/admin/roles/role-permission-editor';
import { ConsentRequestPicker } from '@/components/admin/governance/consent-request-picker';
import { ConsentRequiredDialog } from '@/components/admin/governance/consent-required-dialog';
import type { ConsentGateErrorBody } from '@/lib/client/consent-gate-error';

interface RolePermDoc {
  id: string;
  role: string;
  label: string;
  allowedPaths: string[];
  canAccessAdmin: boolean;
  // The GET merge also carries the drawer-model fields when stored.
  permissions?: string[];
  scope?: 'global' | 'chapter';
  allowedChapters?: string[];
}

export default function RolePrivilegesPage() {
  const { user } = useUser();
  const { showSuccessToast, showErrorToast } = useEnhancedToast();
  const [roles, setRoles] = useState<RolePermDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRole, setSelectedRole] = useState<RolePermDoc | null>(null);
  const [saving, setSaving] = useState(false);

  // Phase 2 consent state (spec B.6): catalog writes carry a decided
  // Founder Consent; a gate 409 opens the shared blocked dialog.
  const [createConsentId, setCreateConsentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RolePermDoc | null>(null);
  const [deleteConsentId, setDeleteConsentId] = useState<string | null>(null);
  const [gateBlock, setGateBlock] = useState<ConsentGateErrorBody | null>(null);

  // Create new role state
  const [createOpen, setCreateOpen] = useState(false);
  const [newRoleSlug, setNewRoleSlug] = useState('');
  const [newRoleLabel, setNewRoleLabel] = useState('');

  const fetchRoles = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/role-permissions', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setRoles(data.roles || []);
    } catch (err) {
      showErrorToast('Failed to load role permissions');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  const selectRole = (role: RolePermDoc) => {
    setSelectedRole(role);
  };

  const handleCreate = async () => {
    if (!user || !newRoleSlug.trim() || !newRoleLabel.trim()) return;
    setSaving(true);
    try {
      const token = await user.getIdToken();
      const slug = newRoleSlug.trim().toLowerCase().replace(/\s+/g, '_');
      const res = await fetch('/api/admin/role-permissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: slug,
          label: newRoleLabel.trim(),
          allowedPaths: ['/admin'], // Start with just dashboard
          canAccessAdmin: true,
          consentRequestId: createConsentId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.code === 'CONSENT_REQUIRED') {
          setGateBlock(data as ConsentGateErrorBody);
          return;
        }
        throw new Error('Failed to create');
      }
      showSuccessToast(`Role "${newRoleLabel}" created`);
      setCreateOpen(false);
      setNewRoleSlug('');
      setNewRoleLabel('');
      await fetchRoles();
    } catch (err) {
      showErrorToast('Failed to create role');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (role: RolePermDoc) => {
    if (!user || role.role === 'superadmin') return;
    // Phase 2: deletion is gated - collect the consent in the dialog first.
    setDeleteConsentId(null);
    setPendingDelete(role);
  };

  const confirmDelete = async () => {
    if (!user || !pendingDelete) return;
    const role = pendingDelete;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/role-permissions', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: role.role, consentRequestId: deleteConsentId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.code === 'CONSENT_REQUIRED') {
          setGateBlock(data as ConsentGateErrorBody);
          return;
        }
        throw new Error('Failed to delete');
      }
      showSuccessToast(`Role "${role.label}" deleted`);
      if (selectedRole?.role === role.role) setSelectedRole(null);
      setPendingDelete(null);
      setDeleteConsentId(null);
      await fetchRoles();
    } catch (err) {
      showErrorToast('Failed to delete role');
    }
  };

  return (
    <AuthorizationGate permission="canManagePermissions">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              Role Permissions
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Control which admin sidebar sections each role can see. Create new roles or modify existing ones.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> New Role
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Role List */}
          <div className="lg:col-span-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Roles</CardTitle>
                <CardDescription>Click a role to edit its sidebar access</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {loading ? (
                  <div className="p-4 space-y-3">
                    {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                  </div>
                ) : roles.length === 0 ? (
                  <div className="p-6 text-center text-muted-foreground">
                    <p>No roles configured yet.</p>
                    <p className="text-xs mt-1">Click &quot;New Role&quot; to create one. Until then, the hardcoded defaults are used.</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[calc(100vh-350px)] min-h-[500px]">
                    {roles.map((role) => (
                      <button
                        key={role.id}
                        onClick={() => selectRole(role)}
                        className={`w-full flex items-center justify-between px-4 py-3 text-left border-b border-border/50 hover:bg-accent/50 transition-colors ${
                          selectedRole?.role === role.role ? 'bg-accent' : ''
                        }`}
                      >
                        <div>
                          <div className="font-medium text-sm">{role.label}</div>
                          <div className="text-xs text-muted-foreground">{role.role}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">
                            {role.allowedPaths.length} pages
                          </Badge>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    ))}
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right: the shared per-role editor */}
          <div className="lg:col-span-8">
            {!selectedRole ? (
              <Card>
                <CardContent className="flex items-center justify-center h-[400px] text-muted-foreground">
                  Select a role from the left to edit its permissions
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <div>
                    <CardTitle className="text-lg">{selectedRole.label}</CardTitle>
                    <CardDescription>Permissions, scope, and sidebar access for this role</CardDescription>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(selectedRole)}
                    disabled={selectedRole.role === 'superadmin'}
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> Delete
                  </Button>
                </CardHeader>
                <CardContent>
                  <RolePermissionEditor
                    key={selectedRole.role}
                    roleSlug={selectedRole.role}
                    roleName={selectedRole.label}
                    initialPermissions={selectedRole.permissions || []}
                    initialScope={selectedRole.scope}
                    initialAllowedChapters={selectedRole.allowedChapters || []}
                    initialAllowedPaths={selectedRole.allowedPaths || []}
                    initialCanAccessAdmin={selectedRole.canAccessAdmin}
                    onSaved={fetchRoles}
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Create Role Dialog */}
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Role</DialogTitle>
              <DialogDescription>
                Create a role and then toggle which admin pages it can access.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Role ID (lowercase, no spaces)</Label>
                <Input
                  placeholder="e.g., media_lead"
                  value={newRoleSlug}
                  onChange={(e) => setNewRoleSlug(e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''))}
                />
                <p className="text-xs text-muted-foreground">This is the internal identifier. Cannot be changed later.</p>
              </div>
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input
                  placeholder="e.g., Media Lead"
                  value={newRoleLabel}
                  onChange={(e) => setNewRoleLabel(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Founder Consent (creating a role is a Reserved Matter)</Label>
                <ConsentRequestPicker
                  matterKey="role_catalog"
                  subjectRef={{
                    type: 'role_definition',
                    slug: newRoleSlug.trim().toLowerCase().replace(/\s+/g, '_'),
                    action: 'create',
                  }}
                  value={createConsentId}
                  onChange={setCreateConsentId}
                />
              </div>
              <Button
                onClick={handleCreate}
                disabled={!newRoleSlug.trim() || !newRoleLabel.trim() || saving}
                className="w-full"
              >
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                Create Role
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Phase 2: gated delete confirmation (spec B.6) */}
        <Dialog
          open={!!pendingDelete}
          onOpenChange={(open) => {
            if (!open) {
              setPendingDelete(null);
              setDeleteConsentId(null);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete role &quot;{pendingDelete?.label}&quot;?</DialogTitle>
              <DialogDescription>
                Deleting a role definition is a Reserved Matter and cannot be
                undone. Select the decided Founder Consent for this deletion,
                or file a request first.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              {pendingDelete && (
                <ConsentRequestPicker
                  matterKey="role_catalog"
                  subjectRef={{ type: 'role_definition', slug: pendingDelete.role, action: 'delete' }}
                  value={deleteConsentId}
                  onChange={setDeleteConsentId}
                />
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setPendingDelete(null);
                    setDeleteConsentId(null);
                  }}
                >
                  Cancel
                </Button>
                <Button variant="destructive" className="flex-1" onClick={confirmDelete}>
                  Delete With Consent
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <ConsentRequiredDialog
          open={!!gateBlock}
          body={gateBlock}
          onClose={() => setGateBlock(null)}
        />
      </div>
    </AuthorizationGate>
  );
}
