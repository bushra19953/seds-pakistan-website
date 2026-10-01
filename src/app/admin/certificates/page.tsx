"use client";

import { useEffect, useMemo, useState } from "react";
import { useFirestore, useUser } from "@/firebase";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  getDocs,
  doc,
  getDoc,
  where,
  Timestamp,
} from "firebase/firestore";
import { useRole } from "@/hooks/use-role";
import { useAuthorization } from "@/hooks/use-authorization";
import { UserRole, USER_ROLES } from "@/lib/roles";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Progress } from "@/components/ui/progress";
import { useEnhancedToast } from "@/hooks/use-enhanced-toast";
import { format } from "date-fns";
import type { Certificate } from "@/types";
import UserSelectionCombobox from "@/components/admin/user-selection-combobox";
import { BulkUserSelector } from "@/components/admin/bulk-user-selector";
import { Edit3, Trash2, Ban, Users, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import Link from "next/link";

type MinimalUser = { uid: string; displayName?: string; email?: string };

export default function CertificatesAdminPage() {
  const firestore = useFirestore();
  const { user, isLoading: userLoading } = useUser();
  const { role, loading: roleLoading } = useRole(user?.uid || null);
  const { showToast } = useEnhancedToast();

  const [certs, setCerts] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [users, setUsers] = useState<MinimalUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [issuing, setIssuing] = useState(false);
  // v2 fields
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [chapterFilter, setChapterFilter] = useState<string>("");
  const [chapters, setChapters] = useState<Array<{ id: string; name: string }>>([]);
  const [rolesOptions, setRolesOptions] = useState<Array<{ key: string; label: string }>>(
    Object.entries(USER_ROLES).map(([key, label]) => ({ key, label }))
  );
  const [certificateType, setCertificateType] = useState<string>("Award of Achievement");
  const [templateId, setTemplateId] = useState<string>("");
  const [templateUrl, setTemplateUrl] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [issueDatePicker, setIssueDatePicker] = useState<Date | undefined>(new Date());
  const [expirationDatePicker, setExpirationDatePicker] = useState<Date | undefined>(undefined);
  const [issuingAuthority, setIssuingAuthority] = useState<string>("SEDS Pakistan");
  // Edit dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingCert, setEditingCert] = useState<Certificate | null>(null);
  const [editTitle, setEditTitle] = useState<string>("");
  const [editDescription, setEditDescription] = useState<string>("");
  const [editCertificateType, setEditCertificateType] = useState<string>("Award of Achievement");
  const [editTemplateId, setEditTemplateId] = useState<string>("");
  const [editTemplateUrl, setEditTemplateUrl] = useState<string>("");
  const [editIssuingAuthority, setEditIssuingAuthority] = useState<string>("SEDS Pakistan");
  const [editIssueDatePicker, setEditIssueDatePicker] = useState<Date | undefined>(undefined);
  const [editExpirationDatePicker, setEditExpirationDatePicker] = useState<Date | undefined>(undefined);
  const [editStatus, setEditStatus] = useState<string>("issued");

  // Bulk issuance state
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<string[]>([]);
  const [bulkIssuing, setBulkIssuing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkResults, setBulkResults] = useState<Array<{ userId: string; userName: string; code: string; success: boolean; error?: string }>>([]);

  const { isAuthorized: canAdmin, isLoading: authLoading } = useAuthorization("canManageCertificates");

  useEffect(() => {
    if (!firestore) return;
    const q = query(collection(firestore, 'certificates'), orderBy('issueDate', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const list: Certificate[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id: d.id,
          userId: data.userId,
          userName: data.userName,
          eventName: data.eventName,
          achievement: data.achievement,
          // v2+ optional fields
          title: data.title,
          description: data.description,
          certificateType: data.certificateType,
          templateId: data.templateId,
          templateUrl: data.templateUrl,
          issuingAuthority: data.issuingAuthority,
          issueDate: data.issueDate,
          code: data.code,
          status: data.status,
          expiresAt: data.expiresAt,
        } as Certificate;
      });
      setCerts(list);
      setLoading(false);
    });
    return () => unsub();
  }, [firestore]);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        if (!firestore) return;
        const snap = await getDocs(collection(firestore, 'users'));
        const list: MinimalUser[] = snap.docs.map((d) => {
          const data: any = d.data();
          return { uid: d.id, displayName: data.displayName || data.name || 'User', email: data.email };
        });
        // sort by displayName
        list.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
        setUsers(list);
      } catch (e) {
        console.error('Failed to load users', e);
      }
    };
    loadUsers();
  }, [firestore]);

  // Load chapters for filtering (server API)
  useEffect(() => {
    const loadChapters = async () => {
      try {
        const res = await fetch('/api/v1/chapters');
        if (!res.ok) throw new Error('Failed to load chapters');
        const data = await res.json();
        const rows = (data?.chapters || []).map((c: any) => ({ id: c.id, name: c.name || c.slug || c.id }));
        rows.sort((a: any, b: any) => a.name.localeCompare(b.name));
        setChapters(rows);
      } catch (e) {
        // Fallback: client Firestore if server API fails
        try {
          if (!firestore) return;
          const snap = await getDocs(collection(firestore, 'chapters'));
          const rows = snap.docs.map((d) => {
            const data: any = d.data();
            const name = (data?.name as string) || (data?.slug as string) || d.id;
            return { id: d.id, name };
          });
          rows.sort((a, b) => a.name.localeCompare(b.name));
          setChapters(rows);
        } catch { }
      }
    };
    loadChapters();
  }, [firestore]);

  // Load roles for filtering (server API)
  useEffect(() => {
    const loadRoles = async () => {
      try {
        const res = await fetch('/api/v1/roles');
        if (!res.ok) throw new Error('Failed to load roles');
        const data = await res.json();
        const roles = Array.isArray(data?.roles) ? data.roles : [];
        if (roles.length) {
          setRolesOptions(roles);
        }
      } catch (e) {
        // Fallback to USER_ROLES already set in initial state
      }
    };
    loadRoles();
  }, []);

  const generateCode = async (): Promise<string> => {
    const attempt = () => `${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-6)}`.toUpperCase();
    for (let i = 0; i < 5; i++) {
      const code = attempt();
      const q = query(collection(firestore, 'certificates'), where('code', '==', code));
      const snap = await getDocs(q);
      if (snap.empty) return code;
    }
    // fallback
    return `${cryptoRandom()}-${Date.now().toString(36).slice(-6)}`.toUpperCase();
  };

  const cryptoRandom = () => {
    // fallback random string
    return Math.random().toString(36).slice(2, 10);
  };

  const handleIssue = async () => {
    try {
      if (issuing) return; // Guard against rapid re-clicks or re-renders
      if (!user) throw new Error('Not authenticated');
      if (!canAdmin) throw new Error('Insufficient privileges');
      const uid = selectedUserId.trim();
      const t = title.trim();
      if (!uid || !t) {
        showToast({ variant: 'destructive', title: 'Missing Fields', description: 'Please select a user and enter the achievement/title.' });
        return;
      }
      setIssuing(true);
      const token = await user.getIdToken();
      const payload = {
        userId: uid,
        title: t,
        description: description || undefined,
        certificateType,
        templateId: templateId || undefined,
        templateUrl: templateUrl || undefined,
        issuingAuthority: issuingAuthority || undefined,
        issueDate: issueDatePicker ? issueDatePicker.toISOString() : undefined,
        expiresAt: expirationDatePicker ? expirationDatePicker.toISOString() : undefined,
      };
      console.log('[certificates:admin] Issuing payload', payload);
      const res = await fetch('/api/v1/certificates/issue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Issue failed');
      }
      const data = await res.json();
      console.log('Certificate issued via API', data);
      setDialogOpen(false);
      setSelectedUserId('');
      setTitle('');
      setDescription('');
      setCertificateType('Award of Achievement');
      setTemplateId('');
      setTemplateUrl('');
      setIssueDatePicker(new Date());
      setExpirationDatePicker(undefined);
      showToast({ title: 'Certificate Issued', description: 'A unique verification code has been generated.' });
    } catch (error: any) {
      console.error('Issue failed', error);
      showToast({ variant: 'destructive', title: 'Issue Failed', description: error?.message || 'Please try again.' });
    } finally {
      setIssuing(false);
    }
  };

  // Bulk issue handler
  const handleBulkIssue = async () => {
    try {
      if (!user) throw new Error('Not authenticated');
      if (!canAdmin) throw new Error('Insufficient privileges');
      if (bulkSelectedIds.length === 0) {
        showToast({ variant: 'destructive', title: 'No Users Selected', description: 'Please select at least one user.' });
        return;
      }
      const t = title.trim();
      if (!t) {
        showToast({ variant: 'destructive', title: 'Missing Title', description: 'Please enter a certificate title.' });
        return;
      }

      setBulkIssuing(true);
      setBulkProgress(10);
      setBulkResults([]);

      const token = await user.getIdToken();
      const payload = {
        userIds: bulkSelectedIds,
        certificateData: {
          title: t,
          description: description || undefined,
          certificateType,
          templateId: templateId || undefined,
          templateUrl: templateUrl || undefined,
          issuingAuthority: issuingAuthority || undefined,
          issueDate: issueDatePicker ? issueDatePicker.toISOString() : undefined,
          expiresAt: expirationDatePicker ? expirationDatePicker.toISOString() : undefined,
        },
      };

      setBulkProgress(30);

      const res = await fetch('/api/v1/certificates/bulk-issue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      setBulkProgress(80);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Bulk issue failed');
      }

      const data = await res.json();
      setBulkProgress(100);
      setBulkResults(data.results || []);

      const issued = data.issued || 0;
      const failed = data.failed || 0;

      if (issued > 0 && failed === 0) {
        showToast({
          title: `✅ ${issued} Certificates Issued`,
          description: `All certificates have been successfully issued. Time: ${data.elapsed}`,
        });
      } else if (issued > 0 && failed > 0) {
        showToast({
          variant: 'destructive',
          title: `${issued} Issued, ${failed} Failed`,
          description: 'Some certificates could not be issued. Check results for details.',
        });
      } else {
        showToast({
          variant: 'destructive',
          title: 'Issue Failed',
          description: 'No certificates were issued. Check your selection and try again.',
        });
      }

      // Reset form on success
      if (issued > 0) {
        setBulkSelectedIds([]);
        setTitle('');
        setDescription('');
        setCertificateType('Award of Achievement');
        setTemplateId('');
        setTemplateUrl('');
      }
    } catch (error: any) {
      console.error('Bulk issue failed', error);
      showToast({ variant: 'destructive', title: 'Bulk Issue Failed', description: error?.message || 'Please try again.' });
    } finally {
      setBulkIssuing(false);
    }
  };

  const openEdit = (c: Certificate) => {
    setEditingCert(c);
    setEditDialogOpen(true);
    setEditTitle(c.title || c.achievement || "");
    setEditDescription(c.description || "");
    setEditCertificateType(c.certificateType || "Award of Achievement");
    setEditTemplateId(c.templateId || "");
    setEditTemplateUrl((c as any).templateUrl || "");
    setEditIssuingAuthority(c.issuingAuthority || "SEDS Pakistan");
    const toDate = (ts: any): Date | undefined => {
      try {
        if (ts && typeof ts?.toDate === 'function') return ts.toDate();
        if (ts instanceof Date) return ts;
        return undefined;
      } catch { return undefined; }
    };
    setEditIssueDatePicker(toDate(c.issueDate));
    setEditExpirationDatePicker(toDate(c.expiresAt));
    setEditStatus(c.status || 'issued');
  };

  const handleUpdate = async () => {
    try {
      if (!user) throw new Error('Not authenticated');
      if (!canAdmin) throw new Error('Insufficient privileges');
      if (!editingCert?.id) throw new Error('Invalid certificate');
      const token = await user.getIdToken();
      const payload: any = {
        title: editTitle || undefined,
        description: editDescription || undefined,
        certificateType: editCertificateType || undefined,
        templateId: editTemplateId || undefined,
        templateUrl: editTemplateUrl || undefined,
        issuingAuthority: editIssuingAuthority || undefined,
        issueDate: editIssueDatePicker ? editIssueDatePicker.toISOString() : undefined,
        expiresAt: editExpirationDatePicker ? editExpirationDatePicker.toISOString() : undefined,
        status: editStatus || undefined,
      };
      const res = await fetch(`/api/v1/certificates/${editingCert.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Update failed');
      }
      setEditDialogOpen(false);
      setEditingCert(null);
      showToast({ title: 'Certificate Updated', description: 'Changes saved successfully.' });
    } catch (e: any) {
      console.error('Update failed', e);
      showToast({ variant: 'destructive', title: 'Update Failed', description: e?.message || 'Please try again.' });
    }
  };

  const handleRevoke = async (c: Certificate) => {
    try {
      if (!user) throw new Error('Not authenticated');
      if (!canAdmin) throw new Error('Insufficient privileges');
      if (!c.id) throw new Error('Invalid certificate');
      const token = await user.getIdToken();
      const res = await fetch(`/api/v1/certificates/${c.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ status: 'revoked' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Revoke failed');
      }
      showToast({ title: 'Certificate Revoked', description: 'Status set to revoked.' });
    } catch (e: any) {
      console.error('Revoke failed', e);
      showToast({ variant: 'destructive', title: 'Revoke Failed', description: e?.message || 'Please try again.' });
    }
  };

  const handleDelete = async (c: Certificate) => {
    try {
      if (!user) throw new Error('Not authenticated');
      if (!canAdmin) throw new Error('Insufficient privileges');
      if (!c.id) throw new Error('Invalid certificate');
      const confirmDelete = window.confirm('Delete this certificate permanently?');
      if (!confirmDelete) return;
      const token = await user.getIdToken();
      const res = await fetch(`/api/v1/certificates/${c.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Delete failed');
      }
      showToast({ title: 'Certificate Deleted', description: 'The record has been removed.' });
    } catch (e: any) {
      console.error('Delete failed', e);
      showToast({ variant: 'destructive', title: 'Delete Failed', description: e?.message || 'Please try again.' });
    }
  };

  if (userLoading || authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!canAdmin) {
    return (
      <div className="container mx-auto px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Access Restricted</CardTitle>
            <CardDescription>You do not have permission to manage certificates.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageCertificates">
    <div className="container mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Certificates</h1>
        <div className="flex items-center gap-2">
          <Link href="/admin/store">
            <Button variant="outline">Store Settings</Button>
          </Link>
          <Button variant="outline" onClick={() => setBulkDialogOpen(true)}>
            <Users className="h-4 w-4 mr-2" />
            Bulk Issue
          </Button>
          <Button onClick={() => setDialogOpen(true)}>Issue New Certificate</Button>
        </div>
      </div>


      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle className="font-heading text-xl">Issued Certificates</CardTitle>
          <CardDescription className="font-body">All certificates issued across the organization</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : !certs.length ? (
            <p className="text-muted-foreground">No certificates have been issued yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-4">Holder</th>
                    <th className="py-2 pr-4">Achievement/Event</th>
                    <th className="py-2 pr-4">Code</th>
                    <th className="py-2 pr-4">Issued</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {certs.map((c) => (
                    <tr key={c.id} className="border-b hover:bg-muted/40">
                      <td className="py-2 pr-4">{c.userName}</td>
                      <td className="py-2 pr-4">{c.achievement || c.eventName || '-'}</td>
                      <td className="py-2 pr-4 font-mono">{c.code}</td>
                      <td className="py-2 pr-4">{c.issueDate && 'toDate' in c.issueDate ? format((c.issueDate as any).toDate(), 'PPP') : '-'}</td>
                      <td className="py-2 pr-4">{c.status || 'issued'}</td>
                      <td className="py-2 pr-4">
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => openEdit(c)} title="Edit"><Edit3 className="h-4 w-4" /></Button>
                          <Button size="sm" variant="outline" onClick={() => handleRevoke(c)} title="Revoke"><Ban className="h-4 w-4" /></Button>
                          <Button size="sm" variant="destructive" onClick={() => handleDelete(c)} title="Delete"><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Certificate Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Certificate</DialogTitle>
            <DialogDescription>Update certificate details and status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="font-body">Certificate Type</Label>
                <Select value={editCertificateType} onValueChange={(v) => setEditCertificateType(v)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Award of Achievement">Award of Achievement</SelectItem>
                    <SelectItem value="Certificate of Participation">Certificate of Participation</SelectItem>
                    <SelectItem value="Role Designation">Role Designation</SelectItem>
                    <SelectItem value="Certificate of Appreciation">Certificate of Appreciation</SelectItem>
                    <SelectItem value="Letter of Invitation">Letter of Invitation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="font-body">Status</Label>
                <Select value={editStatus} onValueChange={(v) => setEditStatus(v)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="issued">Issued</SelectItem>
                    <SelectItem value="revoked">Revoked</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="font-body">Visual Template</Label>
                <Select value={editTemplateId} onValueChange={(v) => setEditTemplateId(v)}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select a template" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="classic">Classic</SelectItem>
                    <SelectItem value="modern">Modern</SelectItem>
                    <SelectItem value="minimal">Minimal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="font-body">Certificate Image URL</Label>
                <Input value={editTemplateUrl} onChange={(e) => setEditTemplateUrl(e.target.value)} placeholder="https://…" />
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <Label className="font-body">Achievement / Title</Label>
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
              </div>
              <div>
                <Label className="font-body">Description / Citation</Label>
                <Textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="font-body">Date of Issuance</Label>
                <DatePicker selected={editIssueDatePicker} onSelect={setEditIssueDatePicker} />
              </div>
              <div>
                <Label className="font-body">Expiration Date</Label>
                <DatePicker selected={editExpirationDatePicker} onSelect={setEditExpirationDatePicker} />
              </div>
            </div>

            <div>
              <Label className="font-body">Issuing Authority</Label>
              <Input value={editIssuingAuthority} onChange={(e) => setEditIssuingAuthority(e.target.value)} />
            </div>

            <div className="flex gap-2">
              <Button onClick={handleUpdate} className="font-accent">Save Changes</Button>
              <Button variant="outline" onClick={() => setEditDialogOpen(false)} className="font-body">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue Certificate</DialogTitle>
            <DialogDescription>Guide through selecting the user, choosing type and details.</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* User selection with filters */}
            <div className="space-y-3">
              <Label className="font-body">User</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Filter by Role</Label>
                  <Select value={roleFilter || "_all"} onValueChange={(v) => setRoleFilter(v === "_all" ? "" : v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="All roles" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      <SelectItem value="_all">All roles</SelectItem>
                      {rolesOptions.map((r) => (
                        <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Filter by Chapter</Label>
                  <Select value={chapterFilter || "_all"} onValueChange={(v) => setChapterFilter(v === "_all" ? "" : v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="All chapters" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      <SelectItem value="_all">All chapters</SelectItem>
                      {chapters.filter((c) => c.id && String(c.id).trim() !== "").map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <UserSelectionCombobox
                selectedUid={selectedUserId || null}
                onSelect={(uid) => setSelectedUserId(uid)}
                placeholder="Search by name or email..."
                preferredRole={roleFilter || undefined}
                chapterId={chapterFilter || undefined}
                showAllToggle
              />
            </div>

            {/* Certificate type & template */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="font-body">Certificate Type</Label>
                <Select value={certificateType} onValueChange={(v) => setCertificateType(v)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Award of Achievement">Award of Achievement</SelectItem>
                    <SelectItem value="Certificate of Participation">Certificate of Participation</SelectItem>
                    <SelectItem value="Role Designation">Role Designation</SelectItem>
                    <SelectItem value="Certificate of Appreciation">Certificate of Appreciation</SelectItem>
                    <SelectItem value="Letter of Invitation">Letter of Invitation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="font-body">Visual Template</Label>
                <Select value={templateId} onValueChange={(v) => setTemplateId(v)}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select a template" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="classic">Classic</SelectItem>
                    <SelectItem value="modern">Modern</SelectItem>
                    <SelectItem value="minimal">Minimal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* External image URL for visual template (optional) */}
            <div>
              <Label className="font-body">Certificate Image URL (optional)</Label>
              <Input
                value={templateUrl}
                onChange={(e) => setTemplateUrl(e.target.value)}
                placeholder="https://example.com/path/to/certificate-image.jpg"
              />
              <p className="text-xs text-muted-foreground mt-1">Provide a public http/https image link for the certificate preview.</p>
            </div>

            {/* Title & description */}
            <div className="space-y-3">
              <div>
                <Label className="font-body">Achievement / Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Hackathon Winner 2025 or Chapter Lead" />
              </div>
              <div>
                <Label className="font-body">Description / Citation (optional)</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g., For outstanding performance and innovative thinking in the annual hackathon." />
              </div>
            </div>

            {/* Dates */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="font-body">Date of Issuance</Label>
                <DatePicker selected={issueDatePicker} onSelect={setIssueDatePicker} />
              </div>
              <div>
                <Label className="font-body">Expiration Date (Optional)</Label>
                <DatePicker selected={expirationDatePicker} onSelect={setExpirationDatePicker} />
              </div>
            </div>

            {/* Issuing authority */}
            <div>
              <Label className="font-body">Issuing Authority</Label>
              <Input value={issuingAuthority} onChange={(e) => setIssuingAuthority(e.target.value)} placeholder="e.g., The Executive Board" />
            </div>

            <div className="flex gap-2">
              <Button onClick={handleIssue} disabled={issuing || !selectedUserId || !title.trim()} className="font-accent">
                {issuing ? 'Issuing…' : 'Issue Certificate'}
              </Button>
              <Button variant="outline" onClick={() => setDialogOpen(false)} className="font-body">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Issue Dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={(open) => { if (!bulkIssuing) setBulkDialogOpen(open); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Bulk Issue Certificates
            </DialogTitle>
            <DialogDescription>
              Select multiple users and issue certificates with shared details. Supports up to 100 users per batch.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* User Selection */}
            <div className="space-y-2">
              <Label className="font-body text-base">1. Select Recipients</Label>
              <BulkUserSelector
                selectedUserIds={bulkSelectedIds}
                onSelectionChange={setBulkSelectedIds}
                disabled={bulkIssuing}
              />
            </div>

            {/* Certificate Details */}
            <div className="space-y-4 border-t pt-4">
              <Label className="font-body text-base">2. Certificate Details (applied to all)</Label>

              {/* Type & Template */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="font-body text-sm">Certificate Type</Label>
                  <Select value={certificateType} onValueChange={setCertificateType} disabled={bulkIssuing}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Award of Achievement">Award of Achievement</SelectItem>
                      <SelectItem value="Certificate of Participation">Certificate of Participation</SelectItem>
                      <SelectItem value="Role Designation">Role Designation</SelectItem>
                      <SelectItem value="Certificate of Appreciation">Certificate of Appreciation</SelectItem>
                      <SelectItem value="Letter of Invitation">Letter of Invitation</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="font-body text-sm">Visual Template</Label>
                  <Select value={templateId} onValueChange={setTemplateId} disabled={bulkIssuing}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Select a template" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="classic">Classic</SelectItem>
                      <SelectItem value="modern">Modern</SelectItem>
                      <SelectItem value="minimal">Minimal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Title & Description */}
              <div className="space-y-3">
                <div>
                  <Label className="font-body text-sm">Achievement / Title *</Label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g., Hackathon Winner 2025 or Chapter Lead"
                    disabled={bulkIssuing}
                  />
                </div>
                <div>
                  <Label className="font-body text-sm">Description / Citation (optional)</Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g., For outstanding performance and innovative thinking..."
                    disabled={bulkIssuing}
                  />
                </div>
              </div>

              {/* Dates & Authority */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label className="font-body text-sm">Date of Issuance</Label>
                  <DatePicker selected={issueDatePicker} onSelect={setIssueDatePicker} />
                </div>
                <div>
                  <Label className="font-body text-sm">Expiration (Optional)</Label>
                  <DatePicker selected={expirationDatePicker} onSelect={setExpirationDatePicker} />
                </div>
                <div>
                  <Label className="font-body text-sm">Issuing Authority</Label>
                  <Input
                    value={issuingAuthority}
                    onChange={(e) => setIssuingAuthority(e.target.value)}
                    placeholder="e.g., The Executive Board"
                    disabled={bulkIssuing}
                  />
                </div>
              </div>
            </div>

            {/* Progress & Results */}
            {bulkIssuing && (
              <div className="space-y-2 p-4 bg-muted/30 rounded-lg border">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm font-medium">Issuing {bulkSelectedIds.length} certificates...</span>
                </div>
                <Progress value={bulkProgress} className="h-2" />
              </div>
            )}

            {bulkResults.length > 0 && !bulkIssuing && (
              <div className="space-y-2 p-4 bg-muted/30 rounded-lg border max-h-48 overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Results</span>
                  <span className="text-xs text-muted-foreground">
                    {bulkResults.filter(r => r.success).length} succeeded, {bulkResults.filter(r => !r.success).length} failed
                  </span>
                </div>
                <div className="space-y-1">
                  {bulkResults.map((r, i) => (
                    <div key={i} className={`flex items-center gap-2 text-xs py-1 px-2 rounded ${r.success ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                      {r.success ? (
                        <CheckCircle2 className="h-3 w-3 text-green-500" />
                      ) : (
                        <AlertCircle className="h-3 w-3 text-red-500" />
                      )}
                      <span className="truncate flex-1">{r.userName}</span>
                      {r.success && <code className="text-xs font-mono">{r.code}</code>}
                      {r.error && <span className="text-red-400">{r.error}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-4 border-t">
              <div className="text-sm text-muted-foreground">
                {bulkSelectedIds.length > 0 ? (
                  <span className="text-primary font-medium">{bulkSelectedIds.length} users selected</span>
                ) : (
                  <span>No users selected</span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => { setBulkDialogOpen(false); setBulkResults([]); setBulkProgress(0); }}
                  disabled={bulkIssuing}
                >
                  {bulkResults.length > 0 ? 'Close' : 'Cancel'}
                </Button>
                <Button
                  onClick={handleBulkIssue}
                  disabled={bulkIssuing || bulkSelectedIds.length === 0 || !title.trim()}
                  className="min-w-[160px]"
                >
                  {bulkIssuing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Issuing...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Issue to {bulkSelectedIds.length || 0} Users
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </AuthorizationGate>
  );
}
