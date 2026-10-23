'use client';

/**
 * THE per-role editor for the people-admin surfaces.
 *
 * One implementation, used by:
 * - the Role Registry tab on /admin/users (via RolePermissionEditorDrawer)
 * - the /admin/role-privileges page (inline panel)
 *
 * It edits BOTH data models that live on a role definition, in two
 * sections, and saves them in ONE call:
 * - "Permissions": boolean permission keys (ADMIN_PERMISSIONS), scope,
 *   allowed chapters, description (the model hasServerPermission enforces)
 * - "Sidebar access": allowedPaths + canAccessAdmin (the model the admin
 *   sidebar enforces)
 *
 * Every save goes through the gated POST /api/admin/role-permissions -
 * the server runs the Founder Consent gate and writes roleDefinitions +
 * role_permissions + the permissions mirror in a single batch. This
 * component NEVER writes those collections directly; its only direct
 * Firestore access is the read of the role definition (description /
 * category / isActive) and the chapters list.
 */

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { doc, getDoc, collection, getDocs, orderBy, query as firestoreQuery } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { useFirestore, useUser } from '@/firebase';
import { useToast } from '@/hooks/use-toast';
import { isSuperAdmin } from '@/lib/roles';
import {
  Shield, HelpCircle, Globe, Building2, Search, Check, CheckSquare, Square, Loader2, Save,
  LayoutDashboard, Settings, Users, Newspaper, Calendar, FolderKanban,
  CheckCircle, GitMerge, Briefcase, Award, UserPlus, BarChart2,
  Crown, ShoppingCart, Megaphone, BookOpen, Image, FileText, Target,
  Database, Sparkles, Clock, Network, Inbox, FileSpreadsheet, Phone,
  IdCard, AlertTriangle, FileLock, Mail,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ADMIN_PERMISSIONS, type PermissionKey, getRoleScope } from '@/config/permission-registry';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { ConsentRequestPicker } from '@/components/admin/governance/consent-request-picker';
import { ConsentRequiredDialog } from '@/components/admin/governance/consent-required-dialog';
import type { ConsentGateErrorBody } from '@/lib/client/consent-gate-error';
import { catalogTitle } from '@/lib/role-catalog';
import {
  RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES,
  isCustomRoleSlug,
  toCustomRoleDefinition,
} from '@/lib/custom-roles';
import { CustomRoleBadge } from '@/components/admin/roles/custom-role-badge';

// All sidebar items that can be toggled - matches admin-nav.ts
export const SIDEBAR_ITEMS = [
  { path: '/admin', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview' },
  { path: '/admin/site-settings', label: 'Site Settings', icon: Settings, group: 'Overview' },
  { path: '/admin/audit-logs', label: 'Audit Logs', icon: FileLock, group: 'Overview' },
  { path: '/admin/users', label: 'Users', icon: Users, group: 'People' },
  { path: '/admin/roles', label: 'Roles', icon: Shield, group: 'People' },
  { path: '/admin/discipline?tab=register', label: 'Defaulters', icon: AlertTriangle, group: 'People' },
  { path: '/admin/discipline?tab=settings', label: 'Warning Settings', icon: Settings, group: 'People' },
  { path: '/admin/submissions', label: 'Universal Inbox', icon: Inbox, group: 'Action Center' },
  { path: '/admin/blog', label: 'Blogs', icon: Newspaper, group: 'Content' },
  { path: '/admin/events', label: 'Events', icon: Calendar, group: 'Content' },
  { path: '/admin/crm?tab=sponsor-match', label: 'AI Sponsor Match', icon: Sparkles, group: 'Content' },
  { path: '/admin/announcements', label: 'Announcements', icon: Megaphone, group: 'Content' },
  { path: '/admin/pages', label: 'Pages', icon: FileText, group: 'Content' },
  { path: '/admin/pages/contact', label: 'Contact Page', icon: Phone, group: 'Content' },
  { path: '/admin/resources', label: 'Resources & Opportunities', icon: BookOpen, group: 'Content' },
  { path: '/admin/crm', label: 'CRM Console', icon: Target, group: 'Content' },
  { path: '/admin/gallery', label: 'Gallery', icon: Image, group: 'Content' },
  { path: '/admin/projects', label: 'Projects', icon: FolderKanban, group: 'Projects & Tasks' },
  { path: '/admin/tasks', label: 'Tasks', icon: CheckCircle, group: 'Projects & Tasks' },
  { path: '/admin/tasks?tab=missions', label: 'Workflows', icon: Network, group: 'Projects & Tasks' },
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
];

export const GROUPED_SIDEBAR_ITEMS = SIDEBAR_ITEMS.reduce((acc, item) => {
  if (!acc[item.group]) acc[item.group] = [];
  acc[item.group].push(item);
  return acc;
}, {} as Record<string, typeof SIDEBAR_ITEMS>);

const permissionGroups: Record<string, PermissionKey[]> = {};
Object.entries(ADMIN_PERMISSIONS).forEach(([key, def]) => {
  if (!permissionGroups[def.category]) {
    permissionGroups[def.category] = [];
  }
  permissionGroups[def.category].push(key as PermissionKey);
});

export interface RolePermissionEditorProps {
  roleSlug: string;
  roleName: string;
  /** Boolean permission keys (drawer model). */
  initialPermissions?: string[];
  initialScope?: 'global' | 'chapter';
  initialAllowedChapters?: string[];
  /** Sidebar paths (path model). */
  initialAllowedPaths?: string[];
  initialCanAccessAdmin?: boolean;
  /**
   * Custom-definition fields (data-model plan 6b). Callers that already
   * classified the row (the registry, via toCustomRoleDefinition) pass
   * them so the custom section renders before the doc read returns;
   * the loaded doc values win once the read completes.
   */
  initialIsCustom?: boolean;
  initialParentRoleKey?: string;
  initialChapterId?: string;
  initialDefaultTermDays?: number | null;
  canEdit?: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
}

export function RolePermissionEditor({
  roleSlug,
  roleName,
  initialPermissions = [],
  initialScope,
  initialAllowedChapters = [],
  initialAllowedPaths = [],
  initialCanAccessAdmin = true,
  initialIsCustom,
  initialParentRoleKey,
  initialChapterId,
  initialDefaultTermDays,
  canEdit = true,
  onSaved,
  onCancel,
}: RolePermissionEditorProps) {
  const [permissions, setPermissions] = useState<Set<string>>(new Set(initialPermissions));
  const [scope, setScope] = useState<'global' | 'chapter'>(initialScope || 'chapter');
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set(initialAllowedChapters));
  const [editPaths, setEditPaths] = useState<Set<string>>(new Set(initialAllowedPaths));
  const [editCanAccess, setEditCanAccess] = useState(initialCanAccessAdmin);
  const [chapters, setChapters] = useState<Array<{ id: string; name: string }>>([]);
  const [chapterSearch, setChapterSearch] = useState('');
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [description, setDescription] = useState('');
  const [loadingDescription, setLoadingDescription] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Phase 2 (spec B.5.4/B.6): catalog saves are gated. The loaded category
  // and isActive ride along in the save payload unchanged (complete-state
  // semantics); the picker collects the consent for this slug.
  const [loadedCategory, setLoadedCategory] = useState<string | undefined>(undefined);
  const [loadedIsActive, setLoadedIsActive] = useState<boolean | undefined>(undefined);
  // Custom-definition fields from the same doc read (plan 6b.1). null =
  // the read has not returned yet; loaded values win over the initial*
  // props field by field once it has.
  const [loadedCustom, setLoadedCustom] = useState<{
    isCustom?: boolean;
    parentRoleKey?: string;
    chapterId?: string;
    defaultTermDays?: number | null;
  } | null>(null);
  const [defReadDone, setDefReadDone] = useState(false);
  const [defaultTermDaysInput, setDefaultTermDaysInput] = useState<string>(
    initialDefaultTermDays != null ? String(initialDefaultTermDays) : '',
  );
  const [consentId, setConsentId] = useState<string | null>(null);
  const [gateBlock, setGateBlock] = useState<ConsentGateErrorBody | null>(null);
  const firestore = useFirestore();
  const { toast } = useToast();
  const { user, role: currentUserRole } = useUser() as any;

  // Load the current role definition (READ only) for the fields the
  // callers do not pass in: description, category, isActive. Matches the
  // field read by getAllRoleDefinitionsCached (description, falling
  // back to responsibilities).
  useEffect(() => {
    // Guard: Firestore doc() throws synchronously on an undefined path
    // segment, which would break the editor for a slugless doc.
    if (firestore && roleSlug) {
      setLoadingDescription(true);
      getDoc(doc(firestore, 'roleDefinitions', roleSlug))
        .then(snap => {
          const data = snap.data() as any;
          setDescription(data?.description || data?.responsibilities || '');
          setLoadedCategory(typeof data?.category === 'string' ? data.category : undefined);
          setLoadedIsActive(typeof data?.isActive === 'boolean' ? data.isActive : undefined);
          const loadedTermDays =
            typeof data?.defaultTermDays === 'number' &&
            Number.isInteger(data.defaultTermDays) &&
            data.defaultTermDays > 0
              ? data.defaultTermDays
              : null;
          setLoadedCustom({
            isCustom: typeof data?.isCustom === 'boolean' ? data.isCustom : undefined,
            parentRoleKey: typeof data?.parentRoleKey === 'string' ? data.parentRoleKey : undefined,
            chapterId: typeof data?.chapterId === 'string' ? data.chapterId : undefined,
            defaultTermDays: loadedTermDays,
          });
          setDefaultTermDaysInput(loadedTermDays != null ? String(loadedTermDays) : '');
        })
        .catch(err => console.error('Failed to fetch role description:', err))
        .finally(() => { setLoadingDescription(false); setDefReadDone(true); });
    }
  }, [firestore, roleSlug]);

  useEffect(() => {
    if (!firestore) return;
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
  }, [firestore]);

  // Custom session determination (plan 6b.1): the session is custom
  // iff the effective fields pass the shared four-part test - the test
  // itself is never re-implemented here. Effective = loaded doc values
  // once the read returns, initial* props before that.
  const effIsCustom = loadedCustom?.isCustom ?? initialIsCustom;
  const effParentRoleKey = loadedCustom?.parentRoleKey ?? initialParentRoleKey;
  const effChapterId = loadedCustom?.chapterId ?? initialChapterId;
  const customDef = toCustomRoleDefinition(roleSlug, {
    isCustom: effIsCustom,
    parentRoleKey: effParentRoleKey,
    chapterId: effChapterId,
    name: roleName,
    defaultTermDays: loadedCustom?.defaultTermDays ?? initialDefaultTermDays,
  });
  const isCustomSession = customDef !== null;
  // A doc that claims to be custom (isCustom flag or a custom_ slug)
  // but fails the four-part test is malformed: say so and fail closed
  // (the server rejects its saves with CUSTOM_DEFINITION_INVALID too).
  const isMalformedCustom =
    !isCustomSession &&
    (defReadDone || initialIsCustom !== undefined) &&
    (effIsCustom === true || isCustomRoleSlug(roleSlug));

  // Scope is server-forced to 'chapter' for custom definitions
  // (contracts 1.2); pin the control the moment the session is known
  // custom so the UI never offers a value the server would override.
  useEffect(() => {
    if (isCustomSession) setScope('chapter');
  }, [isCustomSession]);

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

  const togglePath = (path: string) => {
    if (!canEdit) return;
    setEditPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const togglePathGroup = (group: string) => {
    if (!canEdit) return;
    const groupPaths = GROUPED_SIDEBAR_ITEMS[group].map(i => i.path);
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
    const isTargetReserved = ['superadmin', 'founder_patron', 'president_national'].includes(roleSlug);
    const isUserExecutive = isSuperAdmin(currentUserRole, user?.uid || '');

    // Equality of Power: Only Executives (Superadmin/President) can modify reserved role configs
    if (isTargetReserved && !isUserExecutive) {
      toast({ variant: 'destructive', title: 'Access Denied', description: 'Reserved role configurations require executive authority.' });
      return;
    }

    if (!canEdit) {
      toast({ variant: 'destructive', title: 'Access Denied', description: 'You do not have permission to modify role configurations.' });
      return;
    }

    if (isMalformedCustom) {
      toast({ variant: 'destructive', title: 'Malformed Definition', description: 'This custom role definition is incomplete and cannot be saved. Delete it and create it again.' });
      return;
    }

    // Default term (custom sessions only): empty = null (no default);
    // anything else must be a positive integer of days (contracts 1.4).
    let parsedDefaultTermDays: number | null = null;
    if (isCustomSession) {
      const raw = defaultTermDaysInput.trim();
      if (raw !== '') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          toast({ variant: 'destructive', title: 'Invalid Default Term', description: 'Default term must be a whole number of days, or left empty for no default.' });
          return;
        }
        parsedDefaultTermDays = n;
      }
    }

    setIsSaving(true);
    try {
      // Phase 2 (spec B.5.3): ONE gated POST carrying the complete form
      // state for BOTH models. The server classifies the change, runs
      // the consent gate, and writes roleDefinitions + permissions +
      // role_permissions in a single batch. A gate 409 keeps this editor
      // open with every selection intact - nothing was applied, and
      // local state is never reset on a block.
      const auth = getAuth();
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error('Not signed in');
      const token = await currentUser.getIdToken();
      // Custom sessions (plan 6b.3/6b.4): the Reserved Powers are
      // stripped from the save set defensively - a stored doc that
      // somehow carries them must not re-send them (the route rejects
      // the whole save); saving is how an admin removes them. The four
      // custom fields round-trip verbatim so the server's immutability
      // check compares equal values; scope and allowedChapters carry
      // their server-forced values. Non-custom saves are byte-identical
      // to before.
      const savePermissionKeys = isCustomSession
        ? Array.from(permissions).filter(
            (k) => !(RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES as readonly string[]).includes(k),
          )
        : Array.from(permissions);
      const res = await fetch('/api/admin/role-permissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: roleSlug,
          label: roleName,
          permissionKeys: savePermissionKeys,
          allowedPaths: Array.from(editPaths),
          canAccessAdmin: editCanAccess,
          allowedChapters: isCustomSession && customDef ? [customDef.chapterId] : Array.from(selectedChapters),
          scope: isCustomSession ? 'chapter' : scope,
          description: description.trim(),
          category: loadedCategory,
          isActive: loadedIsActive,
          consentRequestId: consentId,
          ...(isCustomSession && customDef
            ? {
                isCustom: true,
                parentRoleKey: customDef.parentRoleKey,
                chapterId: customDef.chapterId,
                defaultTermDays: parsedDefaultTermDays,
              }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && (data as any)?.code === 'CONSENT_REQUIRED') {
          setGateBlock(data as ConsentGateErrorBody);
          return;
        }
        throw new Error((data as any)?.error || 'Save failed');
      }

      // Force auth token refresh to apply new claims locally
      await currentUser.getIdToken(true);

      toast({ title: 'Configuration Saved', description: `Role ${roleName} updated successfully.` });
      onSaved?.();
    } catch (error: any) {
      console.error('[RolePermissionEditor] Save Failed:', error);
      toast({
        variant: 'destructive',
        title: 'Save Failed',
        description: error?.message || 'An internal error occurred during transmission.',
      });
    } finally { setIsSaving(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1 pr-4">
        <div className="space-y-8 pb-6">
          {/* Custom role section (plan 6b.2): parent + chapter are
              immutable after create (contracts 1.2), so they render as
              read-only labelled values; only the default term edits. */}
          {isCustomSession && customDef && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-black uppercase tracking-tight text-primary">Custom Role</h3>
                <CustomRoleBadge />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Parent Role</Label>
                <p className="text-xs text-foreground">{catalogTitle(customDef.parentRoleKey)} ({customDef.parentRoleKey})</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Chapter</Label>
                <p className="text-xs text-foreground">
                  {chapters.find((c) => c.id === customDef.chapterId)?.name ?? customDef.chapterId}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Parent role and chapter are set when a custom role is created and cannot be changed.
                To move this role, delete it and create a new one under the right parent and chapter.
              </p>
              <div className="space-y-2">
                <Label htmlFor="custom-default-term-days" className="text-xs font-bold uppercase text-muted-foreground">
                  Default Term (days)
                </Label>
                <Input
                  id="custom-default-term-days"
                  type="number"
                  min={1}
                  step={1}
                  value={defaultTermDaysInput}
                  onChange={(e) => setDefaultTermDaysInput(e.target.value)}
                  disabled={!canEdit}
                  className="text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Days a new grant of this role lasts when no expiry date is picked at assignment.
                  Grants already made keep their own dates.
                </p>
              </div>
            </div>
          )}
          {isMalformedCustom && (
            <p className="text-xs text-destructive-text">
              This custom role definition is malformed: it is missing a valid parent role or chapter,
              so it cannot be edited or assigned. Delete it and create it again.
            </p>
          )}

          {/* Scope + description + chapters */}
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Visibility Scope</Label>
                <Badge variant="outline" className={`text-[9px] font-black uppercase ${scope === 'global' ? 'border-primary text-primary bg-primary/5' : 'border-amber-500 text-amber-500 bg-amber-500/5'}`}>
                  {scope === 'global' ? 'Global Access' : 'Chapter Restricted'}
                </Badge>
              </div>

              <RadioGroup value={scope} onValueChange={(v: any) => setScope(v)} className="grid grid-cols-2 gap-4">
                <div>
                  <RadioGroupItem value="global" id={`scope-global-${roleSlug}`} disabled={isCustomSession} className="peer sr-only" />
                  <Label htmlFor={`scope-global-${roleSlug}`} className="flex h-full cursor-pointer flex-col items-center justify-between rounded-xl border-2 border-border bg-card p-4 transition-all hover:bg-accent peer-data-[state=checked]:border-primary">
                    <Globe className={`mb-3 h-6 w-6 ${scope === 'global' ? 'text-primary' : 'text-muted-foreground'}`} />
                    <span className="text-[10px] font-black uppercase">Global</span>
                  </Label>
                </div>
                <div>
                  <RadioGroupItem value="chapter" id={`scope-chapter-${roleSlug}`} className="peer sr-only" />
                  <Label htmlFor={`scope-chapter-${roleSlug}`} className="flex h-full cursor-pointer flex-col items-center justify-between rounded-xl border-2 border-border bg-card p-4 transition-all hover:bg-accent peer-data-[state=checked]:border-amber-500">
                    <Building2 className={`mb-3 h-6 w-6 ${scope === 'chapter' ? 'text-amber-500' : 'text-muted-foreground'}`} />
                    <span className="text-[10px] font-black uppercase">Chapter</span>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Role Description</Label>
                {loadingDescription && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <Textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                disabled={!canEdit || loadingDescription}
                rows={4}
                placeholder="Describe what this role does day to day..."
                className="resize-y text-xs"
              />
              <p className="text-[10px] leading-tight text-muted-foreground">
                The AI task engine matches work steps against this text when suggesting assignees. Write what the role physically does, not just what it oversees.
              </p>
            </div>

            {/* Custom sessions never render the picker: allowedChapters
                is forced to [chapterId] server-side (contracts 1.2) and
                any wider value fails CUSTOM_CHAPTERS_WIDENED - offering
                the picker would let an admin build a save that always
                fails. The bound chapter shows in the Custom section. */}
            {scope === 'chapter' && !isCustomSession && (
              <div className="animate-in fade-in slide-in-from-top-2 space-y-3 duration-300">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] font-black uppercase text-muted-foreground">Chapter Assignment</Label>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setSelectedChapters(new Set(chapters.map(c => c.id)))} className="h-5 px-2 text-[8px] font-black uppercase text-primary hover:bg-primary/10">All</Button>
                    <Button variant="ghost" onClick={() => setSelectedChapters(new Set())} className="h-5 px-2 text-[8px] font-black uppercase text-muted-foreground hover:bg-accent">None</Button>
                  </div>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="h-9 pl-10 font-mono text-[10px]"
                    placeholder="SEARCH CHAPTERS..."
                    value={chapterSearch}
                    onChange={e => setChapterSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-48 overflow-y-auto rounded-xl border border-border p-2">
                  {loadingChapters ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
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
                            className={`flex items-center justify-between rounded-lg px-3 py-2 text-left transition-all ${isSelected ? 'bg-amber-500/10 text-foreground' : 'text-muted-foreground hover:bg-accent'}`}
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

          <Separator />

          {/* Permissions (boolean key model) */}
          <div className="space-y-8">
            <h3 className="text-sm font-black uppercase tracking-tight text-primary">Permissions</h3>
            {Object.entries(permissionGroups).map(([groupName, keys]) => {
              const allChecked = keys.every(k => permissions.has(k));
              const someChecked = keys.some(k => permissions.has(k)) && !allChecked;
              return (
                <div key={groupName} className="space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <h4 className="text-sm font-black uppercase tracking-tight text-primary">{groupName}</h4>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-bold uppercase text-muted-foreground">Batch Toggle</span>
                      <Switch checked={allChecked} onCheckedChange={(c) => handleGroupToggle(keys, c)} className={someChecked ? 'opacity-50' : ''} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {keys.map((key) => {
                      const def = ADMIN_PERMISSIONS[key];
                      // Reserved Powers in a custom session (plan 6b.4):
                      // the switch is locked - this is UX honesty, not
                      // the enforcement (the route rejects them, and
                      // the save strips them from the payload).
                      const lockReserved =
                        isCustomSession &&
                        (RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES as readonly string[]).includes(key);
                      return (
                        <div key={key} className="group flex items-center justify-between rounded-xl border border-border bg-card/50 p-3 transition-all hover:border-border/80">
                          <div className="min-w-0 flex-1">
                            <label htmlFor={`${roleSlug}-${key}`} className="mb-0.5 flex cursor-pointer items-center gap-2 text-xs font-bold">
                              {def.label}
                              <TooltipProvider delayDuration={50}><Tooltip>
                                <TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-muted-foreground" /></TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[200px] text-[10px]">{def.description}</TooltipContent>
                              </Tooltip></TooltipProvider>
                            </label>
                            <p className="text-[10px] leading-tight text-muted-foreground">{def.description}</p>
                            {lockReserved && (
                              <p className="text-xs text-muted-foreground">
                                Reserved Power - never available to custom roles. If this definition was
                                stored with it, saving removes it.
                              </p>
                            )}
                          </div>
                          <Switch id={`${roleSlug}-${key}`} checked={permissions.has(key)} disabled={lockReserved} onCheckedChange={(c) => handleToggle(key, c)} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <Separator />

          {/* Sidebar access (path model) */}
          <div className="space-y-6">
            <h3 className="text-sm font-black uppercase tracking-tight text-primary">Sidebar Access</h3>
            <div className="flex shrink-0 items-center gap-3 rounded-lg bg-accent/50 p-3">
              <Switch
                checked={editCanAccess}
                onCheckedChange={setEditCanAccess}
                disabled={!canEdit}
              />
              <Label className="font-medium">Can access admin panel</Label>
            </div>
            {Object.entries(GROUPED_SIDEBAR_ITEMS).map(([group, items]) => {
              const allSelected = items.every(i => editPaths.has(i.path));
              const someSelected = items.some(i => editPaths.has(i.path));
              return (
                <div key={group} className="animate-in fade-in slide-in-from-left-2 duration-300">
                  <div className="mb-3 flex items-center justify-between">
                    <button
                      onClick={() => togglePathGroup(group)}
                      className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-primary transition-opacity hover:opacity-80"
                    >
                      <div className={`flex h-4 w-4 items-center justify-center rounded border ${
                        allSelected ? 'border-primary bg-primary' : someSelected ? 'border-primary bg-primary/30' : 'border-muted-foreground'
                      }`}>
                        {allSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                        {someSelected && !allSelected && <div className="h-1.5 w-1.5 rounded-sm bg-primary" />}
                      </div>
                      {group}
                    </button>
                    <Badge variant="outline" className="text-[10px] opacity-50">
                      {items.filter(i => editPaths.has(i.path)).length} / {items.length}
                    </Badge>
                  </div>
                  <div className="ml-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {items.map((item) => {
                      const Icon = item.icon;
                      const isChecked = editPaths.has(item.path);
                      return (
                        <button
                          key={item.path}
                          onClick={() => togglePath(item.path)}
                          className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium transition-all ${
                            isChecked
                              ? 'border border-primary/40 bg-primary/10 text-foreground shadow-sm'
                              : 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                          }`}
                        >
                          <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition-colors ${
                            isChecked ? 'border-primary bg-primary' : 'border-muted-foreground/50'
                          }`}>
                            {isChecked && <Check className="h-3 w-3 text-primary-foreground" />}
                          </div>
                          <Icon className={`h-4 w-4 shrink-0 ${isChecked ? 'text-primary' : 'text-muted-foreground'}`} />
                          <span className="truncate">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>

      {/* Phase 2: Founder Consent for catalog changes (spec B.6) */}
      <div className="space-y-2 border-t border-border pt-4">
        <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
          Founder Consent (required for permission, scope, or sidebar changes)
        </Label>
        <ConsentRequestPicker
          matterKey="role_catalog"
          subjectRef={{ type: 'role_definition', slug: roleSlug, action: 'permissions' }}
          value={consentId}
          onChange={setConsentId}
          disabled={!canEdit}
        />
      </div>

      <div className="flex justify-end gap-3 border-t border-border pt-4">
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={isSaving} className="font-bold">Cancel</Button>
        )}
        <Button onClick={handleSave} disabled={isSaving || !canEdit || isMalformedCustom} className="min-w-[140px] font-black uppercase tracking-widest">
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </Button>
      </div>

      <ConsentRequiredDialog
        open={!!gateBlock}
        body={gateBlock}
        onClose={() => setGateBlock(null)}
      />
    </div>
  );
}

export interface RolePermissionEditorDrawerProps extends RolePermissionEditorProps {}

export function RolePermissionEditorDrawer(props: RolePermissionEditorDrawerProps) {
  const [open, setOpen] = useState(false);
  const { roleSlug, roleName } = props;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 border-primary/50 font-mono text-[10px] uppercase tracking-widest transition-colors hover:bg-primary/10">
          <Shield className="h-3 w-3 text-primary" />
          Configure Role
        </Button>
      </SheetTrigger>
      <SheetContent className="flex h-full w-full flex-col sm:max-w-xl">
        <SheetHeader className="border-b border-border pb-4">
          <SheetTitle className="flex items-center gap-2 font-mono text-2xl font-black">
            <Shield className="h-6 w-6 text-primary" />
            ROLE: {String(roleName || roleSlug || 'unknown').toUpperCase()}
          </SheetTitle>
          <SheetDescription className="font-mono text-[10px] uppercase text-muted-foreground">
            Administrative Authority & Visibility Scope
          </SheetDescription>
        </SheetHeader>
        {open && (
          <RolePermissionEditor
            key={roleSlug}
            {...props}
            initialScope={props.initialScope || getRoleScope(roleSlug)}
            onSaved={() => {
              props.onSaved?.();
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
