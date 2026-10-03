'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFirestore, useUser, useCollection } from '@/firebase';
import { FOUNDER_UID, getRoleDisplayName, isSuperAdmin } from '@/lib/roles';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/ui/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { TableSkeleton } from '@/components/ui/loading-states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

import { collection, doc, serverTimestamp, query, onSnapshot } from 'firebase/firestore';
import { logAuditEntry } from '@/lib/audit-logging';
import { useToast } from '@/hooks/use-toast';
import { USER_ROLES } from '@/lib/roles';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { RolePrivilegesDrawer } from '@/components/admin/roles/role-privileges-drawer';
import Fuse from 'fuse.js';
import { Search, Loader2, Trash2, Plus, Globe, Shield, Zap } from 'lucide-react';
import { setDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';
import { getUnifiedRoleOptions, normalizeRoleSlug, RoleOption } from '@/lib/unified-roles';
import { ADMIN_PERMISSIONS } from '@/config/permission-registry';
import { assignRole } from '@/lib/role-management';
import type { EnhancedUserRole } from '@/lib/rbac-types';

const getRoleBadgeStyle = (role: string | null) => {
  if (!role) return 'bg-muted/50 text-muted-foreground border-border';
  const r = role.toLowerCase();
  if (['superadmin', 'president_national', 'vice_president', 'general_secretary', 'president_chapter'].includes(r)) {
    return 'bg-amber-500/10 text-amber-500 border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.2)]';
  }
  if (['rover_team', 'rocketry_team', 'projects_director', 'competition_team'].includes(r)) {
    return 'bg-orange-500/10 text-orange-400 border-orange-500/20';
  }
  if (['member', 'guest'].includes(r)) {
    return 'bg-muted/50 text-muted-foreground border-border';
  }
  return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
};

const getPowerBadgeColor = (percentage: number) => {
  if (percentage === 0) return 'bg-slate-500/10 text-muted-foreground border-slate-500/20';
  if (percentage < 25) return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
  if (percentage < 75) return 'bg-orange-500/10 text-orange-500 border-orange-500/20';
  return 'bg-amber-500/10 text-amber-500 border-amber-500/20 shadow-[0_0_8px_rgba(245,158,11,0.1)]';
};

export default function RoleManagementPage() {
  const { user, isLoading } = useUser();
  const { isAuthorized: canManageRoles } = useAuthorization('canManageRoles');
  const { isAuthorized: canManagePermissions } = useAuthorization('canManagePermissions');
  const { isAuthorized: canAssignRoles } = useAuthorization('canManageRoles'); // or 'assignRoles' if that's the key
  const { isAuthorized: canViewAllChapters } = useAuthorization('canViewHierarchy');
  
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isChangingChapter, setIsChangingChapter] = useState(false);
  const [rdSearch, setRdSearch] = useState('');
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<string>('All');
  const [chaptersList, setChaptersList] = useState<Array<{ id: string; name: string }>>([]);
  const [globalUserCount, setGlobalUserCount] = useState<number>(0);
  const [userPage, setUserPage] = useState(1);
  const [roleDefPage, setRoleDefPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDescription, setNewRoleDescription] = useState('');
  const [newRoleCategory, setNewRoleCategory] = useState('Committee');
  const [creatingRole, setCreatingRole] = useState(false);
  const [selectedRole, setSelectedRole] = useState<string>('All');
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const userPageSize = 10;
  const roleDefPageSize = 50;

  useEffect(() => {
    if (searchInput !== userSearch) {
      setIsTyping(true);
      const timer = setTimeout(() => {
        setUserSearch(searchInput);
        setIsTyping(false);
        setUserPage(1);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [searchInput, userSearch]);

  useEffect(() => {
    if (!firestore) return;
    const fetchChapters = async () => {
      try {
        const { getDocs } = await import('firebase/firestore');
        const snap = await getDocs(collection(firestore, 'chapters'));
        const list = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));
        setChaptersList(list.sort((a, b) => a.name.localeCompare(b.name)));
      } catch (err) { console.error(err); }
    };
    fetchChapters();
  }, [firestore]);

  useEffect(() => {
    if (user && (user as any).chapterId && selectedChapter === 'All') setSelectedChapter((user as any).chapterId);
  }, [user]);

  const rolesCollectionRef = useMemoFirebase(() => collection(firestore, 'roles'), [firestore]);
  const roleDefinitionsCollectionRef = useMemoFirebase(() => collection(firestore, 'roleDefinitions'), [firestore]);

  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setUsersLoading(true);
    const fetchFilteredUsers = async () => {
      try {
        const idToken = await user?.getIdToken();
        const roleQuery = selectedRole !== 'All' ? `&role=${selectedRole}` : '';
        const url = `/api/admin/users?q=${encodeURIComponent(userSearch)}&chapterId=${selectedChapter}${roleQuery}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) throw new Error('Failed to fetch users');
        const data = await res.json();
        if (!active) return;
        setUsers(data.users || []);
        setUsersError(null);
      } catch (err: any) {
        if (active) setUsersError(err);
      } finally {
        if (active) setUsersLoading(false);
      }
    };
    if (user) fetchFilteredUsers();
    return () => { active = false; };
  }, [userSearch, selectedChapter, selectedRole, user]);



  useEffect(() => {
    if (!firestore) return;
    const unsubscribe = onSnapshot(query(collection(firestore, 'users')), (snap) => {
      setGlobalUserCount(snap.size);
    });
    return () => unsubscribe();
  }, [firestore]);

  const rolesQueryRef = user ? rolesCollectionRef : null;
  const { data: roles, loading: rolesLoading, error: rolesError } = useCollection(rolesQueryRef, { listen: true });
  const { data: roleDefinitions, loading: roleDefsLoading, error: roleDefsError } = useCollection(roleDefinitionsCollectionRef, { listen: true });

  // Sync role options whenever definitions change
  useEffect(() => {
    if (!firestore) return;
    const mounted = true;
    (async () => {
      // Pass current target UID to see reserved roles if the user is the Founder
      const opts = await getUnifiedRoleOptions(firestore, user?.uid);
      if (mounted) setRoleOptions(opts);
    })();
  }, [firestore, roleDefinitions, user?.uid]);


  const handleRoleChange = async (userId: string, newRole: string) => {
    if (!userId || !newRole) return;
    try {
      setUpdatingUserId(userId);
      const success = await assignRole(
        firestore, 
        userId, 
        // Role options are dynamic (hardcoded + Firestore definitions); assignRole normalizes the slug.
        newRole as EnhancedUserRole, 
        user?.uid || '', 
        "Role updated via Command Center"
      );
      
      if (success) {
        toast({ title: "Role Updated", description: "User role has been synchronized across all systems." });
      } else {
        throw new Error('Security protocol rejected the assignment.');
      }
    } catch (error: any) {
      console.error("[RoleManagement] Assignment Failed:", error);
      toast({ 
          variant: "destructive", 
          title: "Update Failed", 
          description: error.message || 'Failed to synchronize user role.' 
      });
    } finally { setUpdatingUserId(null); }
  };

  const slugify = (str: string) => normalizeRoleSlug(str);

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

    // 2. Build Base Dynamic Roles list
    const dynamicRoles = (roleDefinitions || []).map((rd: any) => ({
      ...rd,
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

    // Hierarchical Sorting:
    // 1. Permissions Count (Desc)
    // 2. Scope (Global First)
    // 3. Name (Asc)
    return list.sort((a: any, b: any) => {
      const pDiff = (b.permissions?.length || 0) - (a.permissions?.length || 0);
      if (pDiff !== 0) return pDiff;

      if (a.scope === 'global' && b.scope !== 'global') return -1;
      if (a.scope !== 'global' && b.scope === 'global') return 1;

      return (a.name || '').localeCompare(b.name || '');
    });
  }, [roleDefinitions, rdSearch]);

  const paginatedUsers = useMemo(() => {
    const list = users || [];
    const start = (userPage - 1) * userPageSize;
    return list.slice(start, start + userPageSize);
  }, [users, userPage]);

  const paginatedRoleDefs = useMemo(() => {
    const start = (roleDefPage - 1) * roleDefPageSize;
    return filteredRoleDefs.slice(start, start + roleDefPageSize);
  }, [filteredRoleDefs, roleDefPage]);

  const userRolesMap = roles?.reduce((acc, roleDoc) => {
    const key = (roleDoc as any).id ?? (roleDoc as any).uid;
    if (key) acc[key] = roleDoc.role;
    return acc;
  }, {} as Record<string, string>) || {};

  // Merge hardcoded USER_ROLES with dynamic Firestore roleDefinitions
  const availableRoles = roleOptions;

  const { role: currentUserRole } = useAuthorization();
  const isSuper = isSuperAdmin(currentUserRole, user?.uid || '');

  const handleCreateRole = async () => {
    if (!newRoleName.trim()) return;
    setCreatingRole(true);
    try {
      const slug = normalizeRoleSlug(newRoleName.trim());
      if (!slug) throw new Error('Invalid role name');

      // PREVENT DUPLICATES: Check if normalized slug already exists
      const existing = roleOptions.find(opt => opt.key === slug);
      if (existing) {
        throw new Error(`Role "${existing.label}" (${slug}) already exists.`);
      }

      await setDoc(doc(firestore, 'roleDefinitions', slug), {
        slug,
        name: newRoleName.trim(),
        description: newRoleDescription.trim(),
        category: newRoleCategory,
        permissions: [],
        scope: 'chapter',
        isActive: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      toast({ title: "Role Created", description: `"${newRoleName.trim()}" is now available for assignment. Configure its permissions next.` });
      setCreateOpen(false);
      setNewRoleName('');
      setNewRoleDescription('');
      setNewRoleCategory('Committee');
    } catch (error: any) {
      toast({ variant: "destructive", title: "Creation Failed", description: error.message });
    } finally { setCreatingRole(false); }
  };

  const handleDeleteRole = async (slug: string, name: string) => {
    if (!window.confirm(`NUCLEAR OPTION: Delete '${name}'? All users with this role will revert to 'member'.`)) return;
    try {
      const idToken = await user?.getIdToken();
      const res = await fetch(`/api/admin/roles/${slug}`, { method: 'DELETE', headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error('Failed to delete role');
      toast({ title: "Role Deleted", description: "Role removed and users reverted." });
    } catch (error: any) { toast({ variant: "destructive", title: "Deletion Failed", description: error.message }); }
  };

  if ((rolesLoading && !roles) || isLoading) {
    return <div className="flex h-screen items-center justify-center bg-black"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <AuthorizationGate permission="canManageRoles">
      <div className="relative flex min-h-screen flex-col bg-background">
        <StarryBackground />
        <div className="fixed top-0 left-0 right-0 z-50 bg-background/90 backdrop-blur-3xl border-b border-primary/20 px-8 py-4 flex justify-between items-center shadow-lg">
          <h1 className="text-2xl font-black font-mono text-glow tracking-tighter uppercase text-white">COMMAND CENTER</h1>
          <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5">
              <span className="text-muted-foreground">Users</span><span className="text-primary">{globalUserCount}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5">
              <span className="text-muted-foreground">Assigned</span><span className="text-primary">{Object.keys(userRolesMap).length}</span>
            </div>
            <Badge variant={canAssignRoles ? 'default' : 'secondary'} className="py-1.5 px-4 rounded-full border-0 uppercase tracking-widest text-[10px]">{canAssignRoles ? 'Admin Access' : 'View Only'}</Badge>
          </div>
        </div>

        <main className="flex-1 container mx-auto pt-24 pb-6 px-4 flex flex-col gap-6">
          <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_1fr] gap-8">
            <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
              <CardHeader className="flex flex-col md:flex-row items-center justify-between border-b border-primary/10 pb-4 gap-4">
                <CardTitle className="text-lg font-mono font-extrabold text-primary/90 uppercase">User Directory</CardTitle>
                <div className="flex flex-wrap items-center gap-2 bg-slate-950 p-1 rounded-lg border border-white/5">
                  <Select value={selectedChapter} onValueChange={setSelectedChapter}>
                    <SelectTrigger className="w-[130px] h-8 text-[10px] bg-transparent border-0"><SelectValue placeholder="Chapter" /></SelectTrigger>
                    <SelectContent className="bg-slate-900 border-slate-800">{canViewAllChapters && <SelectItem value="All">All Chapters</SelectItem>}{chaptersList.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={selectedRole} onValueChange={setSelectedRole}>
                    <SelectTrigger className="w-[130px] h-8 text-[10px] bg-transparent border-0"><SelectValue placeholder="Role" /></SelectTrigger>
                    <SelectContent className="bg-slate-900 border-slate-800">
                      <SelectItem value="All">All Roles</SelectItem>
                      {roleOptions.map(opt => <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                    <input type="text" placeholder="Search by name/mail/phone..." className="bg-transparent pl-7 pr-2 py-1 text-[10px] w-48 outline-none" value={searchInput} onChange={e => setSearchInput(e.target.value)} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0 relative">
                {(isChangingChapter || usersLoading) && !isTyping && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/40 backdrop-blur-[1px]">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  </div>
                )}
                <div className={`transition-opacity duration-200 ${(isTyping || usersLoading) ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
                  <Table>
                    <TableHeader className="bg-slate-900/50">
                      <TableRow className="border-primary/10">
                        <TableHead className="text-[10px] uppercase font-black tracking-widest pl-6">Personnel / Contact</TableHead>
                        <TableHead className="text-[10px] uppercase font-black tracking-widest">Designation</TableHead>
                        <TableHead className="text-right text-[10px] uppercase font-black tracking-widest pr-6">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users.length === 0 && !usersLoading && !isTyping ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center py-8 text-muted-foreground font-mono text-xs uppercase">
                            No personnel found
                          </TableCell>
                        </TableRow>
                      ) : (
                        <>
                          {users.length > 0 ? (
                            paginatedUsers.map((u: any) => {
                              const uid = u.id || u.uid;
                              const uRole = userRolesMap[uid] || 'member';
                              const isFounder = uid === FOUNDER_UID;
                              
                              return (
                                <TableRow key={uid} className={`border-primary/5 hover:bg-primary/5 transition-colors group ${isFounder ? 'bg-primary/5' : ''}`}>
                                  <TableCell className="py-3 pl-6">
                                    <div className="flex flex-col gap-1">
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-xs text-white group-hover:text-primary transition-colors">{u.displayName || 'Unknown User'}</span>
                                        {uid === user?.uid && (
                                          <Badge variant="outline" className="text-[8px] bg-primary/20 border-primary/30 text-primary py-0 h-4 font-black">
                                            CORE
                                          </Badge>
                                        )}
                                        {isFounder && (
                                          <Badge variant="outline" className="text-[8px] bg-amber-500/20 border-amber-500/30 text-amber-500 py-0 h-4 font-black uppercase tracking-tighter">
                                            CORE FOUNDER
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="flex flex-col text-[10px] font-mono">
                                        <span className="text-muted-foreground line-clamp-1 lowercase">{u.email}</span>
                                        <div className="flex items-center gap-1.5 mt-0.5">
                                          <span className="text-[9px] text-primary font-bold tracking-tight bg-primary/5 px-1.5 py-0.5 rounded border border-primary/10">
                                            {u.whatsapp || 'NO CONTACT'}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline" className={`text-[9px] uppercase font-black rounded-full ${getRoleBadgeStyle(uRole)}`}>
                                      {getRoleDisplayName(uRole, uid)}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-right pr-6">
                                    {canAssignRoles && (
                                      <Select 
                                        value={uRole} 
                                        onValueChange={(v) => handleRoleChange(uid, v)}
                                        disabled={isFounder}
                                      >
                                        <SelectTrigger className={`w-[140px] h-7 text-[9px] font-bold uppercase ml-auto bg-slate-950 border-slate-800 ${isFounder ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="bg-slate-900 border-slate-800 max-h-[300px]">
                                          {roleOptions
                                            .filter(opt => {
                                              // 'superadmin' and 'president_national' are restricted
                                              if (opt.key === 'president_national') return isFounder;
                                              if (opt.key === 'superadmin') return isSuper;
                                              return true;
                                            })
                                            .map((opt) => (
                                              <SelectItem 
                                                key={opt.key} 
                                                value={opt.key} 
                                                className="text-[9px] uppercase font-bold"
                                              >
                                                {opt.label}
                                              </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    )}
                                  </TableCell>
                                </TableRow>
                              );
                            })
                          ) : (
                            Array.from({ length: 5 }).map((_, i) => (
                              <TableRow key={`skeleton-${i}`} className="border-primary/5 opacity-20">
                                <TableCell className="py-3 pl-6">
                                  <div className="h-8 w-32 bg-slate-800 animate-pulse rounded" />
                                </TableCell>
                                <TableCell>
                                  <div className="h-6 w-20 bg-slate-800 animate-pulse rounded-full" />
                                </TableCell>
                                <TableCell>
                                  <div className="h-7 w-24 bg-slate-800 animate-pulse rounded ml-auto" />
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>


            <div className="flex flex-col gap-6 sticky top-24">
              {canManageRoles && (
                <Card className="bg-card/80 backdrop-blur-sm border-primary/20 overflow-hidden">
                  <CardHeader className="bg-slate-900/50 border-b border-primary/10">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg font-mono font-black text-primary/90 uppercase">Role Registry</CardTitle>
                      <div className="flex items-center gap-2">
                        <Badge className="text-[9px] font-black">{filteredRoleDefs.length} ENTRIES</Badge>
                        <Button size="sm" onClick={() => setCreateOpen(true)} className="h-7 text-[9px] font-black uppercase gap-1">
                          <Plus className="h-3 w-3" /> New Role
                        </Button>
                      </div>
                    </div>
                    <input type="text" placeholder="Filter Registry..." className="mt-4 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-[10px] font-mono outline-none focus:border-primary/50" value={rdSearch} onChange={e => setRdSearch(e.target.value)} />
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="max-h-[600px] overflow-y-auto">
                      <Table>
                        <TableBody>
                          {paginatedRoleDefs.map((rd: any) => {
                            const totalPerms = Object.keys(ADMIN_PERMISSIONS).length;
                            const assignedPerms = rd.permissions?.length || 0;
                            const powerPercentage = (assignedPerms / totalPerms) * 100;
                            const isGlobal = rd.scope === 'global';

                            return (
                              <TableRow key={rd.slug} className="border-primary/5 hover:bg-primary/5 group transition-colors">
                                <TableCell className="py-4 pl-6">
                                  <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono font-bold text-xs text-white uppercase">{rd.name}</span>
                                      <Badge variant="outline" className={`h-4 px-1.5 text-[8px] border-0 flex items-center gap-1 ${isGlobal ? 'bg-indigo-500/10 text-indigo-400' : 'bg-slate-500/10 text-muted-foreground'}`}>
                                        {isGlobal ? <Globe className="h-2 w-2" /> : <Shield className="h-2 w-2" />}
                                        {isGlobal ? 'NATIONAL' : 'LOCAL'}
                                      </Badge>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-[8px] uppercase tracking-[0.2em] text-muted-foreground font-black">{rd.category}</span>
                                      <Badge variant="outline" className={`h-3.5 px-1.5 text-[7px] font-black tracking-widest uppercase rounded-full ${getPowerBadgeColor(powerPercentage)}`}>
                                        <Zap className="h-2 w-2 mr-1 inline-block" />
                                        LVL {assignedPerms}/{totalPerms}
                                      </Badge>
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right pr-6">
                                  <div className="flex justify-end gap-2">
                                    <RolePrivilegesDrawer 
                                      roleSlug={rd.slug} 
                                      roleName={rd.name} 
                                      initialPermissions={rd.permissions || []} 
                                      initialScope={rd.scope}
                                      initialAllowedChapters={rd.allowedChapters || []}
                                      canEdit={canManagePermissions}
                                    />
                                    {isSuper && !['superadmin', 'member'].includes(rd.slug) && (
                                      <Button variant="ghost" size="sm" onClick={() => handleDeleteRole(rd.slug, rd.name)} className="h-8 w-8 p-0 text-red-500 hover:text-red-400 hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></Button>
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
                      <div className="flex items-center justify-between px-6 py-4 border-t border-primary/10 bg-slate-900/50">
                        <Button variant="outline" size="sm" onClick={() => setRoleDefPage(p => Math.max(1, p - 1))} disabled={roleDefPage === 1} className="h-7 text-[9px] font-black uppercase">Previous</Button>
                        <span className="text-[9px] font-mono font-bold text-muted-foreground uppercase">Page {roleDefPage} of {Math.ceil(filteredRoleDefs.length / roleDefPageSize)}</span>
                        <Button variant="outline" size="sm" onClick={() => setRoleDefPage(p => p + 1)} disabled={roleDefPage >= Math.ceil(filteredRoleDefs.length / roleDefPageSize)} className="h-7 text-[9px] font-black uppercase">Next</Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </main>

        {/* Create Role Dialog */}
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="bg-slate-950 border-slate-800">
            <DialogHeader>
              <DialogTitle className="text-white font-mono font-black uppercase">Create New Role</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Define a new role, then configure its permissions after creation.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label className="text-white text-xs font-bold uppercase">Role Name</Label>
                <Input
                  placeholder="e.g., Media Lead, Finance Officer"
                  value={newRoleName}
                  onChange={e => setNewRoleName(e.target.value)}
                  className="bg-slate-900 border-slate-800 text-white"
                />
                <p className="text-[10px] text-muted-foreground">
                  Slug: <span className="font-mono text-primary">{newRoleName.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_') || '...'}</span>
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-white text-xs font-bold uppercase">Description</Label>
                <Textarea
                  placeholder="What this role is responsible for..."
                  value={newRoleDescription}
                  onChange={e => setNewRoleDescription(e.target.value)}
                  className="bg-slate-900 border-slate-800 text-white h-20"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-white text-xs font-bold uppercase">Category</Label>
                <Select value={newRoleCategory} onValueChange={setNewRoleCategory}>
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-slate-900 border-slate-800">
                    <SelectItem value="Leadership">Leadership</SelectItem>
                    <SelectItem value="Committee">Committee</SelectItem>
                    <SelectItem value="Technical">Technical Team</SelectItem>
                    <SelectItem value="Operations">Operations</SelectItem>
                    <SelectItem value="Custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleCreateRole}
                disabled={!newRoleName.trim() || creatingRole}
                className="w-full font-black uppercase tracking-widest"
              >
                {creatingRole ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                Create Role
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Footer />
      </div>
    </AuthorizationGate>
  );
}
