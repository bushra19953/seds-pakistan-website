"use client";

import { useEffect, useMemo, useState } from 'react';
import { useUser } from '@/firebase';
import { hasSufficientRole } from '@/lib/roles';
import { hasPermission } from '@/config/permissions';
import { useRouter } from 'next/navigation';
import { getFirestore, collection, query, getDocs, doc, serverTimestamp, orderBy, getDoc } from 'firebase/firestore';
;
import { getFirebaseApp, useFirestore } from '@/firebase/provider';
import { logAuditEntry } from '@/lib/audit-logging';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loader2, Edit, Trash, PlusCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TableSkeleton } from '@/components/ui/loading-states';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

interface Chapter {
  id: string;
  name: string;
  slug: string;
  city?: string;
  country?: string;
  isActive?: boolean;
  createdAt?: any;
  updatedAt?: any;
  createdBy?: string;
}

export default function AdminChaptersPage() {
  const { user, role, isLoading: userLoading } = useUser();
  const router = useRouter();
  const { toast } = useToast();
  const firestore = useFirestore();

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [newChapterData, setNewChapterData] = useState<Partial<Chapter>>({ isActive: true });
  const [isSaving, setIsSaving] = useState(false);
  const [slugError, setSlugError] = useState<string>('');

  // Helper to create URL-friendly slugs
  function slugify(input: string): string {
    return (input || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }



  useEffect(() => {
    if (user && role) {
      fetchChapters();
    }
  }, [user, role]);

  const fetchChapters = async () => {
    setLoading(true);
    const db = getFirestore(getFirebaseApp());
    const chaptersCol = collection(db, 'chapters');
    const q = query(chaptersCol, orderBy('name', 'asc'));

    try {
      const querySnapshot = await getDocs(q);
      const fetched: Chapter[] = [];
      querySnapshot.forEach((d) => fetched.push({ id: d.id, ...(d.data() as any) }));
      setChapters(fetched);
    } catch (error) {
      console.error('Error fetching chapters:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to fetch chapters.' });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateChapter = () => {
    setEditingChapter(null);
    setNewChapterData({ name: '', slug: '', city: '', country: '', isActive: true });
    setSlugError('');
    setIsDialogOpen(true);
  };

  const handleEditChapter = (chapter: Chapter) => {
    setEditingChapter(chapter);
    setNewChapterData(chapter);
    setSlugError('');
    setIsDialogOpen(true);
  };

  const handleDeleteChapter = async (chapterId: string) => {
    if (!confirm(`Delete this chapter?\n\nThis will also remove chapterId from ALL associated members and revert any linked application. This cannot be undone.`)) return;

    try {
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch('/api/chapter-applications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ chapterId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      toast({ title: 'Chapter Deleted', description: `Chapter removed. ${data.usersUpdated || 0} member(s) disassociated.` });
      fetchChapters();
    } catch (error: any) {
      console.error('Error deleting chapter:', error);
      toast({ variant: 'destructive', title: 'Error', description: error.message || 'Failed to delete chapter.' });
    }
  };

  const handleSaveChapter = async () => {
    if (!newChapterData.name || !newChapterData.slug) {
      toast({ variant: 'destructive', title: 'Validation Error', description: 'Name and Slug are required.' });
      return;
    }
    if (slugError) {
      toast({ variant: 'destructive', title: 'Validation Error', description: slugError });
      return;
    }

    const db = getFirestore(getFirebaseApp());
    // On create, enforce slug-as-id for uniqueness. On edit, use existing id.
    const normalizedSlug = String(newChapterData.slug || '').trim().toLowerCase();
    const chapterRef = editingChapter ? doc(db, 'chapters', editingChapter.id) : doc(db, 'chapters', normalizedSlug);

    // If creating, ensure no doc with this slug id already exists.
    if (!editingChapter) {
      try {
        const existsSnap = await getDoc(chapterRef);
        if (existsSnap.exists()) {
          toast({ variant: 'destructive', title: 'Duplicate Slug', description: 'A chapter with this slug already exists.' });
          return;
        }
      } catch (_) {
        // continue on network hiccups, Firestore will still enforce uniqueness by doc id
      }
    }

    try {
      setIsSaving(true);
      // Do not send undefined values to Firestore. Build payload conditionally.
      const baseData: any = {
        name: newChapterData.name,
        slug: newChapterData.slug,
        city: newChapterData.city || '',
        country: newChapterData.country || '',
        isActive: newChapterData.isActive ?? true,
        updatedAt: serverTimestamp(),
      };

      const createOnlyData: any = editingChapter
        ? {}
        : {
            createdBy: user?.uid as string,
            createdAt: serverTimestamp(),
          };

      await setDoc(chapterRef, { ...baseData, ...createOnlyData }, { merge: true });
      await logAuditEntry(db, editingChapter ? 'chapter_updated' : 'chapter_created', user?.uid || '', chapterRef.id, {
        chapterId: chapterRef.id,
        name: newChapterData.name,
      });
      toast({ title: 'Success', description: `Chapter ${newChapterData.name} has been ${editingChapter ? 'updated' : 'created'}.` });
      setIsDialogOpen(false);
      fetchChapters();
    } catch (error) {
      console.error('Error saving chapter:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to save chapter.' });
    } finally {
      setIsSaving(false);
    }
  };


  return (
    <AuthorizationGate permission="canManageChapters">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-glow mb-2">Chapters Management</h1>
        <p className="text-muted-foreground">Create, edit, and delete chapters.</p>
      </div>
      <Card className="w-full bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Chapters</CardTitle>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/admin">Back to Admin</Link>
            </Button>
            <Button onClick={handleCreateChapter}><PlusCircle className="mr-2 h-4 w-4" /> Add New Chapter</Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <TableSkeleton rows={8} columns={5} />
          ) : chapters.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No chapters found.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {chapters.map((chapter) => (
                    <TableRow key={chapter.id}>
                      <TableCell className="font-medium">{chapter.name}</TableCell>
                      <TableCell>{chapter.slug}</TableCell>
                      <TableCell>{[chapter.city, chapter.country].filter(Boolean).join(', ') || '—'}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{chapter.isActive ? 'Active' : 'Inactive'}</Badge>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => handleEditChapter(chapter)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteChapter(chapter.id)}>
                          <Trash className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chapter Edit/Create Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editingChapter ? 'Edit Chapter' : 'Create New Chapter'}</DialogTitle>
            <DialogDescription>
              {editingChapter ? 'Make changes to the chapter.' : 'Add a new chapter to the database.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right">Name</Label>
              <Input
                id="name"
                value={newChapterData.name || ''}
                onChange={(e) => {
                  const nameVal = e.target.value;
                  const nextSlug = slugify(nameVal);
                  const shouldAutoFill = !editingChapter && (!newChapterData.slug || newChapterData.slug.length === 0);
                  setNewChapterData({
                    ...newChapterData,
                    name: nameVal,
                    slug: shouldAutoFill ? nextSlug : newChapterData.slug,
                  });
                  if (shouldAutoFill) {
                    const err = !nextSlug
                      ? 'Slug cannot be empty.'
                      : nextSlug.length < 2
                        ? 'Slug must be at least 2 characters.'
                        : nextSlug.length > 64
                          ? 'Slug must be 64 characters or fewer.'
                          : '';
                    setSlugError(err);
                  }
                }}
                className="col-span-3"
                placeholder="e.g., NUST Chapter"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="slug" className="text-right">Slug</Label>
              <Input
                id="slug"
                value={newChapterData.slug || ''}
                onChange={(e) => {
                  const cleaned = slugify(e.target.value);
                  setNewChapterData({ ...newChapterData, slug: cleaned });
                  const err = !cleaned
                    ? 'Slug cannot be empty.'
                    : cleaned.length < 2
                      ? 'Slug must be at least 2 characters.'
                      : cleaned.length > 64
                        ? 'Slug must be 64 characters or fewer.'
                        : '';
                  setSlugError(err);
                }}
                disabled={!!editingChapter}
                className="col-span-3"
                placeholder="nust"
              />
              <div className="col-span-4 px-4">
                <p className={`text-sm ${slugError ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {slugError
                    ? slugError
                    : editingChapter
                      ? 'Slug cannot be changed after creation.'
                      : 'Auto-generates from name; you can adjust before saving.'}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="city" className="text-right">City</Label>
              <Input
                id="city"
                value={newChapterData.city || ''}
                onChange={(e) => setNewChapterData({ ...newChapterData, city: e.target.value })}
                className="col-span-3"
                placeholder="Islamabad"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="country" className="text-right">Country</Label>
              <Input
                id="country"
                value={newChapterData.country || ''}
                onChange={(e) => setNewChapterData({ ...newChapterData, country: e.target.value })}
                className="col-span-3"
                placeholder="Pakistan"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">Active</Label>
              <div className="col-span-3">
                <Switch
                  checked={!!newChapterData.isActive}
                  onCheckedChange={(checked) => setNewChapterData({ ...newChapterData, isActive: checked })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)} disabled={isSaving}>Cancel</Button>
            <Button type="submit" onClick={handleSaveChapter} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>Save changes</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthorizationGate>
  );
}
