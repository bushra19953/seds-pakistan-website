'use client';

import { useState, useEffect, useCallback } from 'react';
import { useUser } from '@/firebase/auth/use-user';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  Shield, Plus, Trash2, Save, Loader2, Check, X, ChevronRight,
  LayoutDashboard, Settings, Users, Newspaper, Calendar, FolderKanban,
  CheckCircle, GitMerge, Briefcase, Award, Building2, UserPlus, BarChart2,
  Crown, ShoppingCart, Megaphone, BookOpen, Image, FileText, Target,
  Database, Sparkles, Clock, Network, Inbox, FileSpreadsheet, Coins, Phone,
  IdCard, AlertTriangle, FileLock, Mail
} from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

// All sidebar items that can be toggled — matches admin-nav.ts
const SIDEBAR_ITEMS = [
  { path: '/admin', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview' },
  { path: '/admin/site-settings', label: 'Site Settings', icon: Settings, group: 'Overview' },
  { path: '/admin/audit-logs', label: 'Audit Logs', icon: FileLock, group: 'Overview' },
  { path: '/admin/users', label: 'Users', icon: Users, group: 'People' },
  { path: '/admin/roles', label: 'Roles', icon: Shield, group: 'People' },
  { path: '/admin/defaulters', label: 'Defaulters', icon: AlertTriangle, group: 'People' },
  { path: '/admin/warning-settings', label: 'Warning Settings', icon: Settings, group: 'People' },
  { path: '/admin/submissions', label: 'Universal Inbox', icon: Inbox, group: 'Action Center' },
  { path: '/admin/blog', label: 'Blogs', icon: Newspaper, group: 'Content' },
  { path: '/admin/events', label: 'Events', icon: Calendar, group: 'Content' },
  { path: '/admin/events/sponsor-match', label: 'AI Sponsor Match', icon: Sparkles, group: 'Content' },
  { path: '/admin/announcements', label: 'Announcements', icon: Megaphone, group: 'Content' },
  { path: '/admin/pages', label: 'Pages', icon: FileText, group: 'Content' },
  { path: '/admin/pages/contact', label: 'Contact Page', icon: Phone, group: 'Content' },
  { path: '/admin/resources', label: 'Resources & Opportunities', icon: BookOpen, group: 'Content' },
  { path: '/admin/crm', label: 'CRM Console', icon: Target, group: 'Content' },
  { path: '/admin/gallery', label: 'Gallery', icon: Image, group: 'Content' },
  { path: '/admin/projects', label: 'Projects', icon: FolderKanban, group: 'Projects & Tasks' },
  { path: '/admin/tasks', label: 'Tasks', icon: CheckCircle, group: 'Projects & Tasks' },
  { path: '/admin/workflows', label: 'Workflows', icon: Network, group: 'Projects & Tasks' },
  { path: '/admin/timeline', label: 'Timeline', icon: Clock, group: 'Programs' },
  { path: '/admin/hierarchy', label: 'Org Chart', icon: GitMerge, group: 'Organization' },
  { path: '/admin/positions', label: 'Positions', icon: Briefcase, group: 'Organization' },
  { path: '/admin/skills', label: 'Skills', icon: Sparkles, group: 'Organization' },
  { path: '/admin/badges', label: 'Badges', icon: Award, group: 'Organization' },
  { path: '/admin/certificates', label: 'Certificates', icon: IdCard, group: 'Organization' },
  { path: '/admin/chapters', label: 'Chapters', icon: Building2, group: 'Organization' },
  { path: '/admin/organizations', label: 'Organizations', icon: Users, group: 'Organization' },
  { path: '/admin/applications', label: 'Induction Apps', icon: UserPlus, group: 'Operations' },
  { path: '/admin/chapter-applications', label: 'Chapter Applications', icon: Building2, group: 'Operations' },
  { path: '/admin/forms', label: 'Forms', icon: FileSpreadsheet, group: 'Operations' },
  { path: '/admin/backup-restore', label: 'Backup & Restore', icon: Database, group: 'Operations' },
  { path: '/admin/analytics', label: 'Analytics', icon: BarChart2, group: 'Operations' },
  { path: '/admin/superadmin', label: 'Superadmin', icon: Crown, group: 'Administration' },
  { path: '/admin/role-privileges', label: 'Role Privileges', icon: Shield, group: 'Administration' },
  { path: '/admin/email-logs', label: 'Email Logs', icon: Mail, group: 'Administration' },
  { path: '/admin/store', label: 'Store', icon: ShoppingCart, group: 'Administration' },
  { path: '/admin/seed', label: 'Financial Setup', icon: Coins, group: 'Administration' },
];

// Group sidebar items
const GROUPED_ITEMS = SIDEBAR_ITEMS.reduce((acc, item) => {
  if (!acc[item.group]) acc[item.group] = [];
  acc[item.group].push(item);
  return acc;
}, {} as Record<string, typeof SIDEBAR_ITEMS>);

interface RolePermDoc {
  id: string;
  role: string;
  label: string;
  allowedPaths: string[];
  canAccessAdmin: boolean;
}

export default function RolePrivilegesPage() {
  const { user } = useUser();
  const { showSuccessToast, showErrorToast } = useEnhancedToast();
  const [roles, setRoles] = useState<RolePermDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRole, setSelectedRole] = useState<RolePermDoc | null>(null);
  const [editPaths, setEditPaths] = useState<Set<string>>(new Set());
  const [editCanAccess, setEditCanAccess] = useState(true);
  const [saving, setSaving] = useState(false);

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
    setEditPaths(new Set(role.allowedPaths));
    setEditCanAccess(role.canAccessAdmin);
  };

  const togglePath = (path: string) => {
    setEditPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleGroup = (group: string) => {
    const groupPaths = GROUPED_ITEMS[group].map(i => i.path);
    const allSelected = groupPaths.every(p => editPaths.has(p));
    setEditPaths(prev => {
      const next = new Set(prev);
      groupPaths.forEach(p => {
        if (allSelected) next.delete(p);
        else next.add(p);
      });
      return next;
    });
  };

  const handleSave = async () => {
    if (!user || !selectedRole) return;
    setSaving(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/role-permissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: selectedRole.role,
          label: selectedRole.label,
          allowedPaths: Array.from(editPaths),
          canAccessAdmin: editCanAccess,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      showSuccessToast(`Permissions saved for ${selectedRole.label}`);
      await fetchRoles();
    } catch (err) {
      showErrorToast('Failed to save permissions');
    } finally {
      setSaving(false);
    }
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
        }),
      });
      if (!res.ok) throw new Error('Failed to create');
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
    if (!confirm(`Delete role "${role.label}"? This cannot be undone.`)) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/role-permissions', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: role.role }),
      });
      if (!res.ok) throw new Error('Failed to delete');
      showSuccessToast(`Role "${role.label}" deleted`);
      if (selectedRole?.role === role.role) setSelectedRole(null);
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

          {/* Right: Permission Editor */}
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
                    <CardDescription>Toggle which sidebar pages this role can see</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(selectedRole)}
                      disabled={selectedRole.role === 'superadmin'}
                    >
                      <Trash2 className="h-4 w-4 mr-1" /> Delete
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving}>
                      {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                      Save
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-3 mb-4 p-3 rounded-lg bg-accent/50 shrink-0">
                    <Switch
                      checked={editCanAccess}
                      onCheckedChange={setEditCanAccess}
                    />
                    <Label className="font-medium">Can access admin panel</Label>
                  </div>

                  <ScrollArea className="h-[calc(100vh-350px)] min-h-[500px] pr-4">
                    <div className="space-y-8 pb-20">
                      {Object.entries(GROUPED_ITEMS).map(([group, items]) => {
                        const allSelected = items.every(i => editPaths.has(i.path));
                        const someSelected = items.some(i => editPaths.has(i.path));
                        return (
                          <div key={group} className="animate-in fade-in slide-in-from-left-2 duration-300">
                            <div className="flex items-center justify-between mb-3">
                              <button
                                onClick={() => toggleGroup(group)}
                                className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-primary hover:opacity-80 transition-opacity"
                              >
                                <div className={`h-4 w-4 rounded border flex items-center justify-center ${
                                  allSelected ? 'bg-primary border-primary' : someSelected ? 'bg-primary/30 border-primary' : 'border-muted-foreground'
                                }`}>
                                  {allSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                                  {someSelected && !allSelected && <div className="h-1.5 w-1.5 bg-primary rounded-sm" />}
                                </div>
                                {group}
                              </button>
                              <Badge variant="outline" className="text-[10px] opacity-50">
                                {items.filter(i => editPaths.has(i.path)).length} / {items.length}
                              </Badge>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 ml-2">
                              {items.map((item) => {
                                const Icon = item.icon;
                                const isChecked = editPaths.has(item.path);
                                return (
                                  <button
                                    key={item.path}
                                    onClick={() => togglePath(item.path)}
                                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                                      isChecked
                                        ? 'bg-primary/10 text-foreground border border-primary/40 shadow-sm'
                                        : 'text-muted-foreground hover:bg-accent hover:text-foreground border border-transparent'
                                    }`}
                                  >
                                    <div className={`h-4 w-4 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                                      isChecked ? 'bg-primary border-primary' : 'border-muted-foreground/50'
                                    }`}>
                                      {isChecked && <Check className="h-3 w-3 text-primary-foreground" />}
                                    </div>
                                    <Icon className={`h-4 w-4 shrink-0 ${isChecked ? 'text-primary' : 'text-muted-foreground'}`} />
                                    <span className="truncate">{item.label}</span>
                                  </button>
                                );
                              })}
                            </div>
                            {group !== 'Administration' && <Separator className="mt-6 opacity-30" />}
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
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
      </div>
    </AuthorizationGate>
  );
}
