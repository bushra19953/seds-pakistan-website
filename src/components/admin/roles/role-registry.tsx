'use client';

/**
 * Role Registry - the role catalog half of the old /admin/roles page,
 * now the "Role Registry" tab on /admin/users.
 *
 * What it owns: the merged registry list (static USER_ROLES catalog with
 * roleDefinitions docs on top), registry search + pagination, role
 * definition create/delete, and the per-role Configure action, which
 * opens the shared RolePermissionEditor.
 *
 * What it deliberately does NOT own: a user directory. Per-user role
 * assignment lives in the Directory tab (UserTable) - this component
 * never fetches /api/admin/users and never assigns roles.
 *
 * Definition lifecycle goes ONLY through the gated
 * /api/admin/role-permissions API (POST create, DELETE delete), which
 * runs the Founder Consent gate and writes roleDefinitions +
 * role_permissions + the permissions mirror atomically. There is no
 * direct client write to any of those collections here; the
 * roleDefinitions listener below is a read.
 */

import { useEffect, useState, useMemo } from 'react';
import { useFirestore, useUser, useCollection } from '@/firebase';
import { isSuperAdmin } from '@/lib/roles';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

import { collection, getDocs, orderBy, query, query as firestoreQuery } from 'firebase/firestore';
import { isCatalogRoleKey, normalizeToCanonical, ABOLISHED_KEYS } from '@/lib/role-catalog';
import { useToast } from '@/hooks/use-toast';
import { USER_ROLES } from '@/lib/roles';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { RolePermissionEditorDrawer } from '@/components/admin/roles/role-permission-editor';
import { CustomRoleBadge } from '@/components/admin/roles/custom-role-badge';
import { catalogTitle } from '@/lib/role-catalog';
import { toCustomRoleDefinition } from '@/lib/custom-roles';
import Fuse from 'fuse.js';
import { Loader2, Trash2, Plus, Globe, Shield, Zap } from 'lucide-react';
import { useAuthorization } from '@/hooks/use-authorization';
import { getUnifiedRoleOptions, normalizeRoleSlug, RoleOption } from '@/lib/unified-roles';
import { ADMIN_PERMISSIONS } from '@/config/permission-registry';
import { ConsentRequestPicker } from '@/components/admin/governance/consent-request-picker';
import { ConsentRequiredDialog } from '@/components/admin/governance/consent-required-dialog';
import { isConsentGateBlocked, type ConsentGateErrorBody } from '@/lib/client/consent-gate-error';

const getPowerBadgeColor = (percentage: number) => {
  if (percentage === 0) return 'bg-slate-500/10 text-muted-foreground border-slate-500/20';
  if (percentage < 25) return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
  if (percentage < 75) return 'bg-orange-500/10 text-orange-500 border-orange-500/20';
  return 'bg-amber-500/10 text-amber-500 border-amber-500/20 shadow-[0_0_8px_rgba(245,158,11,0.1)]';
};

export default function RoleRegistry() {
  const { user } = useUser();
  const { isAuthorized: canManageRoles } = useAuthorization('canManageRoles');
  const { isAuthorized: canManagePermissions } = useAuthorization('canManagePermissions');
  const { role: currentUserRole } = useAuthorization();

  const firestore = useFirestore();
  const { toast } = useToast();
  const [rdSearch, setRdSearch] = useState('');
  const [roleDefPage, setRoleDefPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDescription, setNewRoleDescription] = useState('');
  const [newRoleCategory, setNewRoleCategory] = useState('Committee');
  const [newRoleParentKey, setNewRoleParentKey] = useState('');
  const [newRoleChapterId, setNewRoleChapterId] = useState('');
  const [chapters, setChapters] = useState<Array<{ id: string; name: string }>>([]);
  const [creatingRole, setCreatingRole] = useState(false);
  const [createConsentId, setCreateConsentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ slug: string; name: string } | null>(null);
  const [deleteConsentId, setDeleteConsentId] = useState<string | null>(null);
  const [deletingRole, setDeletingRole] = useState(false);
  const [gateBlock, setGateBlock] = useState<ConsentGateErrorBody | null>(null);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [chapterFilter, setChapterFilter] = useState<string>('all');
  const [chapterList, setChapterList] = useState<Array<{ id: string; name: string }>>([]);
  const roleDefPageSize = 50;

  const chapterNameById = useMemo(
    () => new Map(chapterList.map((c) => [c.id, c.name])),
    [chapterList],
  );

  // Chapters lookup for custom-row labels and the chapter filter.
  // One-shot read mirroring the permission editor's pattern; used ONLY
  // for custom rows. A failure leaves the list empty (labels fall back
  // to chapter ids) - it never blocks the registry.
  useEffect(() => {
    if (!firestore) return;
    let mounted = true;
    (async () => {
      try {
        const snap = await getDocs(firestoreQuery(collection(firestore, 'chapters'), orderBy('name', 'asc')));
        const list = snap.docs.map((d: any) => ({ id: d.id, name: d.data().name || d.id }));
        if (mounted) setChapterList(list);
      } catch (err) { console.error('Failed to fetch chapters:', err); }
    })();
    return () => {
      mounted = false;
    };
  }, [firestore]);

  const roleDefinitionsCollectionRef = useMemoFirebase(() => collection(firestore, 'roleDefinitions'), [firestore]);
  const { data: roleDefinitions, loading: roleDefsLoading } = useCollection(roleDefinitionsCollectionRef, { listen: true });

  // Sync role options whenever definitions change
  useEffect(() => {
    if (!firestore) return;
    let mounted = true;
    (async () => {
      // Pass current target UID to see reserved roles if the user is the Founder
      const opts = await getUnifiedRoleOptions(firestore, user?.uid);
      if (mounted) setRoleOptions(opts);
    })();
    return () => {
      mounted = false;
    };
  }, [firestore, roleDefinitions, user?.uid]);

  // Chapters for the create dialog's chapter picker. The doc id is the
  // chapterId the route validates against the chapters collection.
  useEffect(() => {
    if (!createOpen || !firestore) return;
    let mounted = true;
    (async () => {
      try {
        const snap = await getDocs(query(collection(firestore, 'chapters'), orderBy('name', 'asc')));
        if (mounted) {
          setChapters(snap.docs.map(d => ({ id: d.id, name: (d.data() as any)?.name || d.id })));
        }
      } catch (err) {
        console.error('Failed to load chapters:', err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [createOpen, firestore]);

  const filteredRoleDefs = useMemo(() => {
    // 1. Build Base System Roles list from USER_ROLES
    const systemRoles = Object.keys(USER_ROLES).map(key => ({
      slug: normalizeRoleSlug(key),
      name: USER_ROLES[key],
      category: 'System',
      permissions: [], // Permissions are hardcoded in config but registry shows [] for now
      scope: 'global',
      isSystem: true
    }));

    // 2. Build Base Dynamic Roles list. Each dynamic row is classified
    // ONCE through the shared four-part test (src/lib/custom-roles.ts):
    // customDef is non-null only for a valid custom definition. Junk
    // docs (pakistan-president, super-admin, ...) fail the test by
    // construction and render exactly as before, with no custom
    // marking (invariant 10). The test is never re-implemented inline.
    const dynamicRoles = (roleDefinitions || []).map((rd: any) => ({
      ...rd,
      customDef: toCustomRoleDefinition(rd.slug ?? rd.id, rd),
      isSystem: false
    }));

    // 3. Merge: Dynamic overwrites System if slugs match
    const mergeMap = new Map<string, any>();
    systemRoles.forEach(r => mergeMap.set(r.slug, r));
    dynamicRoles.forEach(r => mergeMap.set(r.slug, r));

    const combined = Array.from(mergeMap.values());

    let list = [];
    if (!rdSearch) {
      list = [...combined];
    } else {
      const fuse = new Fuse(combined, { keys: ['name', 'category', 'slug'], threshold: 0.3 });
      list = fuse.search(rdSearch).map((r) => r.item);
    }

    // Chapter scoping: with a chapter selected, custom rows belonging
    // to another chapter are hidden. System rows and non-custom
    // dynamic rows always remain - they are global reference entries,
    // not chapter property. Default 'all' = the list as it was.
    if (chapterFilter !== 'all') {
      list = list.filter((r: any) => !r.customDef || r.customDef.chapterId === chapterFilter);
    }

    // Hierarchical Sorting:
    // 1. Permissions Count (Desc)
    // 2. Scope (Global First)
    // 3. Name (Asc)
    return list.sort((a: any, b: any) => {
      const pDiff = (b.permissions?.length || 0) - (a.permissions?.length || 0);
      if (pDiff !== 0) return pDiff;

      if (a.scope === 'global' && b.scope !== 'global') return -1;
      if (a.scope !== 'global' && b.scope === 'global') return 1;

      // Coerce names to strings: a truthy non-string name in a roleDefinitions
      // doc would make localeCompare throw and crash the whole page.
      return String(a.name ?? '').localeCompare(String(b.name ?? ''));
    });
  }, [roleDefinitions, rdSearch, chapterFilter]);

  const paginatedRoleDefs = useMemo(() => {
    const start = (roleDefPage - 1) * roleDefPageSize;
    return filteredRoleDefs.slice(start, start + roleDefPageSize);
  }, [filteredRoleDefs, roleDefPage]);

  const isSuper = isSuperAdmin(currentUserRole, user?.uid || '');
  // This dialog creates custom roles only (Custom Roles Fix Program):
  // the final slug is built here, client-side, so the slug preview, the
  // duplicate check and the consent picker's filed subject all name the
  // stored slug exactly (the server validates it, never rebuilds it).
  const newRoleBaseSlug = normalizeRoleSlug(newRoleName.trim());
  const newRoleSlug = newRoleBaseSlug ? `custom_${newRoleBaseSlug}` : '';

  const handleCreateRole = async () => {
    if (!newRoleName.trim() || !user) return;
    setCreatingRole(true);
    try {
      const slug = newRoleSlug;
      if (!slug) throw new Error('Invalid role name');

      if (!newRoleParentKey || !newRoleChapterId) {
        throw new Error('Pick a parent role and a chapter first.');
      }

      // PREVENT DUPLICATES: Check if normalized slug already exists
      const existing = roleOptions.find(opt => opt.key === slug);
      if (existing) {
        throw new Error(`Role "${existing.label}" (${slug}) already exists.`);
      }
      const existingDef = (roleDefinitions || []).find((rd: any) => (rd.slug ?? rd.id) === slug);
      if (existingDef) {
        throw new Error(`A role definition "${slug}" already exists.`);
      }
      // Anti-squat, client side (the route is the enforcement point):
      // the name after the custom_ prefix must not echo a catalog key,
      // a legacy token or an abolished key.
      if (
        isCatalogRoleKey(newRoleBaseSlug) ||
        ABOLISHED_KEYS.includes(newRoleBaseSlug) ||
        normalizeToCanonical(newRoleBaseSlug) !== null
      ) {
        throw new Error('That name echoes an existing catalog role. Pick a different name.');
      }
      // Reserved stems (contracts ADDENDUM R6): a name whose first token
      // is founder / president / superadmin is refused by the route too.
      if (['founder', 'president', 'superadmin'].includes(newRoleBaseSlug.split('_')[0])) {
        throw new Error('That name starts with a reserved word. Pick a different name.');
      }

      // Gated API only (Phase 2, spec B.5.3): the server runs the
      // Founder Consent gate for the 'create' action and writes all
      // three stores in one batch. This dialog creates custom_ roles
      // under a parent catalog role for one chapter; the server
      // validates the slug, the parent, the chapter and the
      // reserved-key ceiling (a custom role can never hold
      // canManagePermissions or canManageRoles).
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/role-permissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: slug,
          label: newRoleName.trim(),
          description: newRoleDescription.trim(),
          category: newRoleCategory,
          isCustom: true,
          parentRoleKey: newRoleParentKey,
          chapterId: newRoleChapterId,
          permissionKeys: [],
          allowedChapters: [newRoleChapterId],
          scope: 'chapter',
          isActive: true,
          consentRequestId: createConsentId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if ((data as any)?.code === 'CONSENT_REQUIRED') {
          setGateBlock(data as ConsentGateErrorBody);
          return;
        }
        throw new Error((data as any)?.error || 'Failed to create role');
      }
      toast({ title: 'Role Created', description: `"${newRoleName.trim()}" is now available for assignment. Configure its permissions next.` });
      setCreateOpen(false);
      setNewRoleName('');
      setNewRoleDescription('');
      setNewRoleCategory('Committee');
      setNewRoleParentKey('');
      setNewRoleChapterId('');
      setCreateConsentId(null);
    } catch (error: any) {
      if (isConsentGateBlocked(error)) {
        setGateBlock(error.body);
        return;
      }
      toast({ variant: 'destructive', title: 'Creation Failed', description: error.message });
    } finally { setCreatingRole(false); }
  };

  const confirmDeleteRole = async () => {
    if (!pendingDelete || !user) return;
    setDeletingRole(true);
    try {
      // Gated API only: DELETE /api/admin/role-permissions removes
      // roleDefinitions + role_permissions + the permissions mirror in
      // one batch after the Founder Consent gate. Catalog roles cannot
      // be deleted through it (the catalog is closed, spec A.7).
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/role-permissions', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: pendingDelete.slug, consentRequestId: deleteConsentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if ((data as any)?.code === 'CONSENT_REQUIRED') {
          setGateBlock(data as ConsentGateErrorBody);
          return;
        }
        throw new Error((data as any)?.error || 'Failed to delete role');
      }
      toast({ title: 'Role Deleted', description: 'Role definition and its permission mirrors removed.' });
      setPendingDelete(null);
      setDeleteConsentId(null);
    } catch (error: any) {
      if (isConsentGateBlocked(error)) {
        setGateBlock(error.body);
        return;
      }
      toast({ variant: 'destructive', title: 'Deletion Failed', description: error.message });
    } finally { setDeletingRole(false); }
  };

  if (!canManageRoles) {
    return (
      <Card className="border-primary/20 bg-card/80">
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            The Role Registry needs the canManageRoles permission. The Directory tab remains available to you.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden border-primary/20 bg-card/80 backdrop-blur-sm">
        <CardHeader className="border-b border-primary/10 bg-card/50">
          <div className="flex items-center justify-between">
            <CardTitle className="font-mono text-lg font-black uppercase text-primary/90">Role Registry</CardTitle>
            <div className="flex items-center gap-2">
              <Badge className="text-[9px] font-black">{filteredRoleDefs.length} ENTRIES</Badge>
              <Button size="sm" onClick={() => setCreateOpen(true)} className="h-7 gap-1 text-[9px] font-black uppercase">
                <Plus className="h-3 w-3" /> New Role
              </Button>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <Label htmlFor="registry-chapter-filter" className="text-xs font-bold uppercase text-foreground">Chapter</Label>
            <Select value={chapterFilter} onValueChange={(v) => { setChapterFilter(v); setRoleDefPage(1); }}>
              <SelectTrigger id="registry-chapter-filter" className="w-full border-border bg-card text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-card">
                <SelectItem value="all">All chapters</SelectItem>
                {chapterList.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <input type="text" placeholder="Filter Registry..." className="mt-4 w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-[10px] outline-none focus:border-primary/50" value={rdSearch} onChange={e => { setRdSearch(e.target.value); setRoleDefPage(1); }} />
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[600px] overflow-y-auto">
            <Table>
              <TableBody>
                {roleDefsLoading && paginatedRoleDefs.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-8 text-center">
                      <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                    </TableCell>
                  </TableRow>
                ) : paginatedRoleDefs.map((rd: any) => {
                  const totalPerms = Object.keys(ADMIN_PERMISSIONS).length;
                  const assignedPerms = rd.permissions?.length || 0;
                  const powerPercentage = (assignedPerms / totalPerms) * 100;
                  const isGlobal = rd.scope === 'global';

                  return (
                    <TableRow key={rd.slug || rd.id || rd.name} className="group border-primary/5 transition-colors hover:bg-primary/5">
                      <TableCell className="py-4 pl-6">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold uppercase text-foreground">{typeof rd.name === 'string' ? rd.name : String(rd.slug ?? 'Unnamed role')}</span>
                            <Badge variant="outline" className={`flex h-4 items-center gap-1 border-0 px-1.5 text-[8px] ${isGlobal ? 'bg-indigo-500/10 text-indigo-400' : 'bg-slate-500/10 text-muted-foreground'}`}>
                              {isGlobal ? <Globe className="h-2 w-2" /> : <Shield className="h-2 w-2" />}
                              {isGlobal ? 'NATIONAL' : 'LOCAL'}
                            </Badge>
                            {rd.customDef && <CustomRoleBadge />}
                            {rd.isActive === false && <Badge variant="outline">Inactive</Badge>}
                          </div>
                          {rd.customDef && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Under: {catalogTitle(rd.customDef.parentRoleKey)}</span>
                              <span>{chapterNameById.get(rd.customDef.chapterId) ?? rd.customDef.chapterId}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-muted-foreground">{typeof rd.category === 'string' ? rd.category : ''}</span>
                            <Badge variant="outline" className={`h-3.5 rounded-full px-1.5 text-[7px] font-black uppercase tracking-widest ${getPowerBadgeColor(powerPercentage)}`}>
                              <Zap className="mr-1 inline-block h-2 w-2" />
                              LVL {assignedPerms}/{totalPerms}
                            </Badge>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <div className="flex justify-end gap-2">
                          <RolePermissionEditorDrawer
                            roleSlug={rd.slug}
                            roleName={rd.name}
                            initialPermissions={rd.permissions || []}
                            initialScope={rd.scope}
                            initialAllowedChapters={rd.allowedChapters || []}
                            initialAllowedPaths={rd.allowedPaths || []}
                            initialCanAccessAdmin={rd.canAccessAdmin !== false}
                            initialIsCustom={rd.customDef ? true : undefined}
                            initialParentRoleKey={rd.customDef?.parentRoleKey}
                            initialChapterId={rd.customDef?.chapterId}
                            initialDefaultTermDays={rd.customDef?.defaultTermDays}
                            canEdit={canManagePermissions}
                          />
                          {isSuper && !['superadmin', 'member'].includes(rd.slug) && (
                            <Button variant="ghost" size="sm" onClick={() => { setDeleteConsentId(null); setPendingDelete({ slug: rd.slug, name: typeof rd.name === 'string' ? rd.name : String(rd.slug ?? '') }); }} className="h-8 w-8 p-0 text-red-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-4 w-4" /></Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {filteredRoleDefs.length > roleDefPageSize && (
            <div className="flex items-center justify-between border-t border-primary/10 bg-card/50 px-6 py-4">
              <Button variant="outline" size="sm" onClick={() => setRoleDefPage(p => Math.max(1, p - 1))} disabled={roleDefPage === 1} className="h-7 text-[9px] font-black uppercase">Previous</Button>
              <span className="font-mono text-[9px] font-bold uppercase text-muted-foreground">Page {roleDefPage} of {Math.ceil(filteredRoleDefs.length / roleDefPageSize)}</span>
              <Button variant="outline" size="sm" onClick={() => setRoleDefPage(p => p + 1)} disabled={roleDefPage >= Math.ceil(filteredRoleDefs.length / roleDefPageSize)} className="h-7 text-[9px] font-black uppercase">Next</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Role Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-border bg-card">
          <DialogHeader>
            <DialogTitle className="font-mono font-black uppercase text-foreground">Create New Role</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Define a new role, then configure its permissions after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="custom-role-name" className="text-xs font-bold uppercase text-foreground">Role Name</Label>
              <Input
                id="custom-role-name"
                placeholder="e.g., Media Lead, Finance Officer"
                value={newRoleName}
                onChange={e => setNewRoleName(e.target.value)}
                className="border-border bg-card text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                Slug: <span className="font-mono text-primary">{newRoleSlug || '...'}</span>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-role-description" className="text-xs font-bold uppercase text-foreground">Description</Label>
              <Textarea
                id="custom-role-description"
                placeholder="What this role is responsible for..."
                value={newRoleDescription}
                onChange={e => setNewRoleDescription(e.target.value)}
                className="h-20 border-border bg-card text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-role-category" className="text-xs font-bold uppercase text-foreground">Category</Label>
              <Select value={newRoleCategory} onValueChange={setNewRoleCategory}>
                <SelectTrigger id="custom-role-category" className="border-border bg-card text-foreground"><SelectValue /></SelectTrigger>
                <SelectContent className="border-border bg-card">
                  <SelectItem value="Leadership">Leadership</SelectItem>
                  <SelectItem value="Committee">Committee</SelectItem>
                  <SelectItem value="Technical">Technical Team</SelectItem>
                  <SelectItem value="Operations">Operations</SelectItem>
                  <SelectItem value="Custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-role-parent" className="text-xs font-bold uppercase text-foreground">Parent Role</Label>
              <Select value={newRoleParentKey} onValueChange={setNewRoleParentKey}>
                <SelectTrigger id="custom-role-parent" className="border-border bg-card text-foreground">
                  <SelectValue placeholder="Pick the catalog role this role sits under" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card">
                  {roleOptions.map(opt => (
                    <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-role-chapter" className="text-xs font-bold uppercase text-foreground">Chapter</Label>
              <Select value={newRoleChapterId} onValueChange={setNewRoleChapterId}>
                <SelectTrigger id="custom-role-chapter" className="border-border bg-card text-foreground">
                  <SelectValue placeholder="Pick the chapter this role belongs to" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card">
                  {chapters.map(ch => (
                    <SelectItem key={ch.id} value={ch.id}>{ch.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chapters.length === 0 && (
                <p className="text-xs text-muted-foreground">Loading chapters...</p>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase text-foreground">Founder Consent (creating a role is a Reserved Matter)</Label>
              <ConsentRequestPicker
                matterKey="role_catalog"
                subjectRef={{ type: 'role_definition', slug: newRoleSlug, action: 'create' }}
                value={createConsentId}
                onChange={setCreateConsentId}
              />
            </div>
            <Button
              onClick={handleCreateRole}
              disabled={!newRoleName.trim() || !newRoleParentKey || !newRoleChapterId || creatingRole}
              className="w-full font-black uppercase tracking-widest"
            >
              {creatingRole ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Create Role
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Role Dialog (gated API, Founder Consent first) */}
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setDeleteConsentId(null);
          }
        }}
      >
        <DialogContent className="border-border bg-card">
          <DialogHeader>
            <DialogTitle className="font-mono font-black uppercase text-foreground">
              Delete role &quot;{pendingDelete?.name}&quot;?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Deleting a role definition is a Reserved Matter and cannot be
              undone. The definition and its permission mirrors are removed
              together. Select the decided Founder Consent for this
              deletion, or file a request first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {pendingDelete && (
              <ConsentRequestPicker
                matterKey="role_catalog"
                subjectRef={{ type: 'role_definition', slug: pendingDelete.slug, action: 'delete' }}
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
              <Button variant="destructive" className="flex-1 font-black uppercase tracking-widest" onClick={confirmDeleteRole} disabled={deletingRole}>
                {deletingRole ? 'Deleting...' : 'Delete With Consent'}
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
  );
}
