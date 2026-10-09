"use client";

import { useState, useEffect } from 'react';
// Uses persistent layout at app/admin/layout.tsx
import { useUser } from '@/firebase';
import { hasSufficientRole, isPresident, isSuperAdmin } from '@/lib/roles';
import { useRouter } from 'next/navigation';
import { getFirestore, collection, query, getDocs, doc, serverTimestamp, orderBy, Timestamp } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Edit, Trash, PlusCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { TableSkeleton } from '@/components/ui/loading-states';
// Removed StarryBackground; persistent admin layout provides background
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import ResponsiveDialogContent from '@/components/ui/responsive-dialog-content';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox'; // Import Checkbox component
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

interface TimelineItem {
  id: string;
  title: string;
  description: string;
  date: string;
  icon?: string;
  link?: string;
  isPublished: boolean;
  position: number; // Add position for ordering
  created_at: any;
  updated_at: any;
}

// Helper to format a Date to YYYY-MM-DD for input/quick display
const formatDateInput = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export default function AdminTimelinePage() {
  const { user, role, isLoading: userLoading } = useUser();
  const router = useRouter();
  const { toast } = useToast();

  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>([]);
  const [loadingTimelineItems, setLoadingTimelineItems] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<TimelineItem | null>(null);
  const [newItemData, setNewItemData] = useState<Partial<TimelineItem>>({});

  const fetchTimelineItems = async () => {
    setLoadingTimelineItems(true);
    const db = getFirestore(getFirebaseApp());
    const timelineCol = collection(db, 'timeline');
    const q = query(timelineCol, orderBy('position', 'asc'));

    try {
      const querySnapshot = await getDocs(q);
      const fetchedItems: TimelineItem[] = [];
      querySnapshot.forEach((snap) => {
        const data = snap.data() as any;
        const dateStr = data?.date?.toDate ? formatDateInput(data.date.toDate()) : String(data?.date ?? '');
        fetchedItems.push({
          id: snap.id,
          title: data.title ?? '',
          description: data.description ?? '',
          date: dateStr,
          icon: data.icon ?? 'Wrench',
          link: data.link ?? '',
          isPublished: !!data.isPublished,
          position: typeof data.position === 'number' ? data.position : 0,
          created_at: data.created_at ?? null,
          updated_at: data.updated_at ?? null,
        });
      });
      setTimelineItems(fetchedItems);
    } catch (error) {
      console.error("Error fetching timeline items:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch timeline items.",
      });
    } finally {
      setLoadingTimelineItems(false);
    }
  };

  useEffect(() => {
    if (user && role) {
      fetchTimelineItems();
    }
  }, [user, role]);

  const handleCreateItem = () => {
    setEditingItem(null);
    setNewItemData({ title: '', description: '', date: '', icon: 'Wrench', link: '', isPublished: true, position: timelineItems.length });
    setIsDialogOpen(true);
  };

  const handleEditItem = (item: TimelineItem) => {
    setEditingItem(item);
    setNewItemData(item);
    setIsDialogOpen(true);
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!confirm("Are you sure you want to delete this timeline item?")) return;
    const db = getFirestore(getFirebaseApp());
    const itemRef = doc(db, 'timeline', itemId);
    try {
      await deleteDoc(itemRef);
      toast({ title: "Success", description: "Timeline item has been deleted." });
      fetchTimelineItems();
    } catch (error) {
      console.error("Error deleting timeline item:", error);
      toast({ variant: "destructive", title: "Error", description: "Failed to delete timeline item." });
    }
  };

  const handleSaveItem = async () => {
    if (!newItemData.title || !newItemData.description || !newItemData.date) {
      toast({ variant: "destructive", title: "Validation Error", description: "Title, Description, and Date are required." });
      return;
    }
    const db = getFirestore(getFirebaseApp());
    const itemRef = editingItem ? doc(db, 'timeline', editingItem.id) : doc(collection(db, 'timeline'));
    try {
      const dateObj = new Date(String(newItemData.date));
      const dataToSave = {
        title: newItemData.title,
        description: newItemData.description,
        date: Timestamp.fromDate(dateObj),
        year: dateObj.getFullYear(),
        isPublished: newItemData.isPublished ?? true,
        position: typeof newItemData.position === 'number' ? newItemData.position : timelineItems.length,
        icon: newItemData.icon ?? 'Wrench',
        link: newItemData.link ?? '',
        updated_at: serverTimestamp(),
        ...(editingItem ? {} : { created_at: serverTimestamp() }),
      };
      await setDoc(itemRef, dataToSave, { merge: true });
      toast({ title: "Success", description: `Timeline item ${newItemData.title} has been ${editingItem ? 'updated' : 'created'}.` });
      setIsDialogOpen(false);
      fetchTimelineItems();
    } catch (error) {
      console.error("Error saving timeline item:", error);
      toast({ variant: "destructive", title: "Error", description: "Failed to save timeline item." });
    }
  };

  return (
    <AuthorizationGate permission="canManageTimeline">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-foreground mb-2">Timeline Management</h1>
        <p className="text-muted-foreground">Create, edit, and delete timeline items.</p>
      </div>
      <Card className="w-full bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Timeline</CardTitle>
          <Button onClick={handleCreateItem}><PlusCircle className="mr-2 h-4 w-4" /> Add New Item</Button>
        </CardHeader>
        <CardContent>
          {loadingTimelineItems ? (
            <TableSkeleton rows={8} columns={4} />
          ) : timelineItems.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No timeline items found.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Published</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {timelineItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.title}</TableCell>
                      <TableCell>{item.date}</TableCell>
                      <TableCell>{item.isPublished ? 'Yes' : 'No'}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" onClick={() => handleEditItem(item)}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDeleteItem(item.id)}>
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

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <ResponsiveDialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{editingItem ? 'Edit Timeline Item' : 'Create New Timeline Item'}</DialogTitle>
            <DialogDescription>
              {editingItem ? 'Make changes to the timeline item here.' : 'Add a new timeline item to the database.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="title" className="text-right">Title</Label>
              <Input
                id="title"
                value={newItemData.title || ''}
                onChange={(e) => setNewItemData({ ...newItemData, title: e.target.value })}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="description" className="text-right">Description</Label>
              <Textarea
                id="description"
                value={newItemData.description || ''}
                onChange={(e) => setNewItemData({ ...newItemData, description: e.target.value })}
                className="col-span-3"
                rows={3}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="date" className="text-right">Date</Label>
              <Input
                id="date"
                type="date"
                value={newItemData.date || ''}
                onChange={(e) => setNewItemData({ ...newItemData, date: e.target.value })}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="icon" className="text-right">Icon</Label>
              <Select value={newItemData.icon || 'Wrench'} onValueChange={(value) => setNewItemData({ ...newItemData, icon: value })}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Choose an icon" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Wrench">Wrench</SelectItem>
                  <SelectItem value="RadioTower">RadioTower</SelectItem>
                  <SelectItem value="Code">Code</SelectItem>
                  <SelectItem value="Rocket">Rocket</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="link" className="text-right">Reference Link</Label>
              <Input
                id="link"
                type="url"
                placeholder="https://example.com"
                value={newItemData.link || ''}
                onChange={(e) => setNewItemData({ ...newItemData, link: e.target.value })}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="position" className="text-right">Position</Label>
              <Input
                id="position"
                type="number"
                value={newItemData.position || 0}
                onChange={(e) => setNewItemData({ ...newItemData, position: parseInt(e.target.value) })}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="isPublished" className="text-right">Published</Label>
              <Checkbox
                id="isPublished"
                checked={newItemData.isPublished || false}
                onCheckedChange={(checked) => setNewItemData({ ...newItemData, isPublished: checked as boolean })}
                className="col-span-3"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" onClick={handleSaveItem}>Save changes</Button>
          </DialogFooter>
        </ResponsiveDialogContent>
      </Dialog>
    </AuthorizationGate>
  );
}
