"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { collection, query, orderBy, getDocs, doc, serverTimestamp, getDoc } from 'firebase/firestore';
;
import { useFirestore, useUser } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import Image from "next/image";
import { useEnhancedToast } from "@/hooks/use-enhanced-toast";
import { Badge } from "@/components/ui/badge";
import { Plus, Save, Trash2, Edit3, X } from "lucide-react";
import { setDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';

type BadgeDoc = {
  slug: string;
  name: string;
  description?: string;
  imageUrl?: string;
  pointsRequired: number;
  isActive?: boolean;
  createdAt?: any;
  updatedAt?: any;
  createdBy?: string;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"()]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 120);
}

export default function BadgesAdminPage() {
  const firestore = useFirestore();
  const { user, role, isLoading } = useUser();
  const { showErrorToast, showSuccessToast } = useEnhancedToast();


  const [badges, setBadges] = useState<BadgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [form, setForm] = useState<BadgeDoc>({ slug: "", name: "", description: "", imageUrl: "", pointsRequired: 0, isActive: true });
  const [isSaving, setIsSaving] = useState(false);

  const resetForm = () => setForm({ slug: "", name: "", description: "", imageUrl: "", pointsRequired: 0, isActive: true });

  const loadBadges = useCallback(async () => {
    setLoading(true);
    try {
      const q = query(collection(firestore, "badges"), orderBy("pointsRequired", "asc"));
      const snap = await getDocs(q);
      const list: BadgeDoc[] = snap.docs.map(d => ({ slug: d.data().slug, name: d.data().name, description: d.data().description, imageUrl: d.data().imageUrl, pointsRequired: d.data().pointsRequired || 0, isActive: d.data().isActive !== false, createdAt: d.data().createdAt, updatedAt: d.data().updatedAt, createdBy: d.data().createdBy }));
      setBadges(list);
    } catch (e) {
      console.error("Failed to load badges", e);
      showErrorToast("Failed to load badges");
    } finally {
      setLoading(false);
    }
  }, [firestore, showErrorToast]);

  useEffect(() => { loadBadges(); }, [loadBadges]);


  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: name === "pointsRequired" ? Number(value) || 0 : value }));
  };

  const onToggleActive = (checked: boolean) => setForm(prev => ({ ...prev, isActive: checked }));

  const startCreate = () => { setEditingSlug(null); resetForm(); };

  const startEdit = async (slug: string) => {
    try {
      const d = await getDoc(doc(firestore, "badges", slug));
      if (!d.exists()) return;
      const data = d.data() as BadgeDoc;
      setForm({ slug: data.slug, name: data.name, description: data.description || "", imageUrl: data.imageUrl || "", pointsRequired: data.pointsRequired || 0, isActive: data.isActive !== false });
      setEditingSlug(slug);
    } catch (e) {
      console.error("Failed to load badge", e);
      showErrorToast("Failed to load badge for editing");
    }
  };

  const saveBadge = async () => {
    if (!user) return;
    if (!form.name.trim()) { showErrorToast("Name is required"); return; }
    const slug = editingSlug || slugify(form.name);
    const payload: BadgeDoc = {
      slug,
      name: form.name.trim(),
      description: (form.description || "").trim(),
      imageUrl: (form.imageUrl || "").trim(),
      pointsRequired: Math.max(0, Math.floor(form.pointsRequired || 0)),
      isActive: form.isActive !== false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: user.uid,
    };

    try {
      setIsSaving(true);
      if (!editingSlug) {
        // Ensure slug uniqueness by using slug as doc ID
        const ref = doc(firestore, "badges", slug);
        const existing = await getDoc(ref);
        if (existing.exists()) { showErrorToast("A badge with this slug already exists"); setIsSaving(false); return; }
        await setDoc(ref, payload);
        showSuccessToast("Badge created");
      } else {
        // Update existing; slug is immutable per rules
        await updateDoc(doc(firestore, "badges", slug), payload as any);
        showSuccessToast("Badge updated");
      }
      resetForm();
      setEditingSlug(null);
      await loadBadges();
    } catch (e) {
      console.error("Failed to save badge", e);
      showErrorToast("Failed to save badge");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteBadge = async (slug: string) => {
    if (!confirm("Delete this badge?")) return;
    try {
      await deleteDoc(doc(firestore, "badges", slug));
      showSuccessToast("Badge deleted");
      await loadBadges();
    } catch (e) {
      console.error("Failed to delete badge", e);
      showErrorToast("Failed to delete badge");
    }
  };

  return (
    <AuthorizationGate permission="canManageBadges">
    <div className="container mx-auto px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Achievement Badges</CardTitle>
              <CardDescription>Manage badge definitions and point thresholds</CardDescription>
            </div>
            <Button variant="default" onClick={startCreate}><Plus className="h-4 w-4 mr-2" />New Badge</Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Editor */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" value={form.name} onChange={onChange} placeholder="e.g. Rising Star" />
            </div>
            <div>
              <Label htmlFor="pointsRequired">Points Required</Label>
              <Input id="pointsRequired" name="pointsRequired" type="number" min={0} value={form.pointsRequired} onChange={onChange} />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" name="description" value={form.description} onChange={onChange} rows={3} />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="imageUrl">Image URL</Label>
              <Input id="imageUrl" name="imageUrl" value={form.imageUrl || ""} onChange={onChange} placeholder="https://..." />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.isActive !== false} onCheckedChange={onToggleActive} id="isActive" />
              <Label htmlFor="isActive">Active</Label>
            </div>
            <div className="flex gap-2">
              <Button onClick={saveBadge} disabled={isSaving}><Save className="h-4 w-4 mr-2" />{editingSlug ? "Update Badge" : "Create Badge"}</Button>
              {editingSlug && <Button variant="outline" onClick={() => { setEditingSlug(null); resetForm(); }}><X className="h-4 w-4 mr-2" />Cancel</Button>}
            </div>
          </div>

          {/* List */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Points</TableHead>
                <TableHead>Image</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && <TableRow><TableCell colSpan={5}>Loading…</TableCell></TableRow>}
              {!loading && badges.length === 0 && <TableRow><TableCell colSpan={5}>No badges yet</TableCell></TableRow>}
              {!loading && badges.map(b => (
                <TableRow key={b.slug}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell>{b.pointsRequired}</TableCell>
                  <TableCell>
                    {b.imageUrl ? (
                      <Image src={b.imageUrl} alt={b.name} width={32} height={32} className="rounded" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{b.isActive !== false ? "Active" : "Inactive"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => startEdit(b.slug)}><Edit3 className="h-4 w-4 mr-1" />Edit</Button>
                      <Button variant="destructive" size="sm" onClick={() => deleteBadge(b.slug)}><Trash2 className="h-4 w-4 mr-1" />Delete</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
    </AuthorizationGate>
  );
}
