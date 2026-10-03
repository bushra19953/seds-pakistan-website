"use client";

import Image from "next/image";

import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ResponsiveDialogContent from "@/components/ui/responsive-dialog-content";
import { useUser } from "@/firebase";
import { useToast } from "@/hooks/use-toast";
import { hasPermission } from "@/config/permissions";
import { useRouter } from "next/navigation";
import { useCollection } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";

export const dynamic = 'force-dynamic';

type GalleryAsset = {
  id: string;
  title: string;
  assetUrl: string;
  thumbnailUrl?: string | null;
  description: string;
  status: "published" | "draft";
  createdBy?: string;
  createdAt?: any;
  updatedAt?: any;
};

export default function AdminGalleryPage() {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const { toast } = useToast();
  const firestore = null as any;

  const [form, setForm] = useState<Partial<GalleryAsset>>({ status: "published" });
  const [editing, setEditing] = useState<GalleryAsset | null>(null);
  const [openDialog, setOpenDialog] = useState(false);
  const [saving, setSaving] = useState(false);

  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  React.useEffect(() => {
    let cancelled = false;
    async function listAssets() {
      try {
        setLoading(true);
        const res = await fetch('/api/gallery-assets?status=all', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setAssets((json.items || []).map((x: any) => ({ id: x.id, ...x })));
      } catch (e) {
        toast({ variant: 'destructive', title: 'Error', description: 'Failed to load assets' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    listAssets();
    return () => { cancelled = true; };
  }, []);


  const startCreate = () => {
    setEditing(null);
    setForm({ title: "", assetUrl: "", thumbnailUrl: "", description: "", status: "published" });
    setOpenDialog(true);
  };

  const startEdit = (asset: GalleryAsset) => {
    setEditing(asset);
    setForm({ ...asset });
    setOpenDialog(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this asset?")) return;
    try {
      const res = await fetch(`/api/gallery-assets/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('Delete failed');
      setAssets(prev => prev.filter(a => a.id !== id));
      toast({ title: "Deleted", description: "Asset removed" });
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: "Failed to delete asset" });
    }
  };

  const saveAsset = async () => {
    if (!form.title || !form.assetUrl || !form.description) {
      toast({ variant: "destructive", title: "Validation error", description: "Title, Asset URL, Description required" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: form.title,
        assetUrl: form.assetUrl,
        thumbnailUrl: form.thumbnailUrl || null,
        description: form.description,
        status: (form.status as any) || "published",
      } as any;
      if (editing) {
        const res = await fetch(`/api/gallery-assets/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Update failed');
      } else {
        const res = await fetch('/api/gallery-assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Create failed');
      }
      setOpenDialog(false);
      toast({ title: editing ? "Updated" : "Created", description: "Asset saved" });
      const res = await fetch('/api/gallery-assets?status=all', { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        setAssets((json.items || []).map((x: any) => ({ id: x.id, ...x })));
      }
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: "Failed to save asset" });
    } finally {
      setSaving(false);
    }
  };


  return (
    <AuthorizationGate permission="canManageGallery">
      <div className="container mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle>Gallery Management</CardTitle>
            <CardDescription>Manage 3D assets via URL. No file uploads.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-6">
              <Button onClick={startCreate}>Add New Asset</Button>
            </div>
            {loading ? (
              <p>Loading assets...</p>
            ) : assets.length === 0 ? (
              <p className="text-muted-foreground">No assets yet. Click &quot;Add New Asset&quot;.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Thumbnail</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {assets.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          {a.thumbnailUrl ? (
                            <Image src={String(a.thumbnailUrl)} alt={a.title} width={48} height={48} className="h-12 w-12 object-cover rounded" />
                          ) : (
                            <div className="h-12 w-12 rounded bg-muted" />
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{a.title}</TableCell>
                        <TableCell><Badge variant="secondary">{a.status}</Badge></TableCell>
                        <TableCell>{(() => {
                          const d: any = (a as any).updatedAt;
                          try {
                            if (!d) return "N/A";
                            if (d?.seconds) return new Date(d.seconds * 1000).toLocaleString();
                            const nd = new Date(d);
                            return isNaN(nd.getTime()) ? "N/A" : nd.toLocaleString();
                          } catch { return "N/A"; }
                        })()}</TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={() => startEdit(a)}>Edit</Button>
                            <Button variant="destructive" size="sm" onClick={() => handleDelete(a.id)}>Delete</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog open={openDialog} onOpenChange={setOpenDialog}>
          <ResponsiveDialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Asset" : "Add New Asset"}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                <Label className="sm:text-right">Title</Label>
                <Input
                  value={form.title || ""}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="sm:col-span-3"
                  placeholder="SEDS-SAT-1 Final Model"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                <Label className="sm:text-right">Model URL</Label>
                <Input
                  value={form.assetUrl || ""}
                  onChange={(e) => setForm({ ...form, assetUrl: e.target.value })}
                  className="sm:col-span-3"
                  placeholder="https://hosted/models/seds-sat.glb"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                <Label className="sm:text-right">Thumbnail URL</Label>
                <Input
                  value={form.thumbnailUrl || ""}
                  onChange={(e) => setForm({ ...form, thumbnailUrl: e.target.value })}
                  className="sm:col-span-3"
                  placeholder="https://hosted/thumbnails/seds-sat.png"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                <Label className="sm:text-right">Description</Label>
                <Textarea
                  value={form.description || ""}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="sm:col-span-3 min-h-28"
                  placeholder="Brief description of the 3D asset"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
                <Label className="sm:text-right">Status</Label>
                <select
                  value={form.status || 'published'}
                  onChange={(e) => setForm({ ...form, status: e.target.value as any })}
                  className="sm:col-span-3 rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpenDialog(false)} disabled={saving}>Cancel</Button>
              <Button onClick={saveAsset} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
            </DialogFooter>
          </ResponsiveDialogContent>
        </Dialog>
      </div>
    </AuthorizationGate>
  );
}
