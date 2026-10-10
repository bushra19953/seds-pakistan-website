"use client";

import { useState, useEffect } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';
import { useRouter } from 'next/navigation';
import { getFirestore, collection, query, where, getDocs, doc, serverTimestamp, Timestamp } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase/provider';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Edit, Trash, PlusCircle, ExternalLink } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { TableSkeleton } from '@/components/ui/loading-states';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import AnnouncementForm, { AnnouncementFormValues } from '@/components/admin/announcements/announcement-form';
import { addDoc } from 'firebase/firestore';
;
import { logAuditEntry } from '@/lib/audit-logging';
import Link from 'next/link';
import { format } from 'date-fns';
import { deleteDoc, setDoc, updateDoc } from '@/lib/client/firestore-wrapper';

// Unified Broadcasting Type
interface BroadcastItem {
  id: string;
  sourceType: 'EVENT' | 'STANDARD';
  title: string;
  status: string; // 'published' | 'draft' for STANDARD, event statuses for EVENT
  showInTicker: boolean;
  priority: number;
  audience?: string;
  expiresAt: string | null;
  created_at: number;
  originalData: any;
}

export default function AdminAnnouncementsPage() {
  const { user, role, isLoading: userLoading } = useUser();
  const router = useRouter();
  const { toast } = useToast();

  const [items, setItems] = useState<BroadcastItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<any | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);


  useEffect(() => {
    if (user) {
      fetchUnifiedFeed();
    }
  }, [user]);

  const fetchUnifiedFeed = async () => {
    setLoading(true);
    const db = getFirestore(getFirebaseApp());
    const announcementsRef = collection(db, 'announcements');
    const eventsRef = collection(db, 'events');

    try {
      const [announcementsSnap, eventsSnap] = await Promise.all([
        getDocs(query(announcementsRef)),
        getDocs(query(eventsRef, where('deleted', '!=', true)))
      ]);

      const aList: BroadcastItem[] = announcementsSnap.docs.map(doc => {
        const data = doc.data();
        let expiresAt = null;
        if (data.expiresAt?.toDate) expiresAt = data.expiresAt.toDate().toISOString();
        else if (data.expiresAt) expiresAt = new Date(data.expiresAt).toISOString();

        let publish_date = data.publish_date || '';
        if (data.publish_date?.toDate) {
          publish_date = data.publish_date.toDate().toISOString().split('T')[0];
        }

        return {
          id: doc.id,
          sourceType: 'STANDARD',
          title: data.title || 'Untitled',
          status: data.status || 'draft',
          // Standard announcements control ticker visibility mainly through 'status === published'
          showInTicker: data.status === 'published',
          priority: data.priority || 0,
          audience: data.audience || 'all',
          expiresAt,
          created_at: data.created_at?.toMillis ? data.created_at.toMillis() : Date.now(),
          originalData: { ...data, id: doc.id, publish_date }
        };
      });

      const eList: BroadcastItem[] = eventsSnap.docs.map(doc => {
        const data = doc.data();
        let expiresAt = null;
        // Default expiry to the event_date, or specific expiresAt if defined
        if (data.event_date?.toDate) expiresAt = data.event_date.toDate().toISOString();
        else if (data.event_date) expiresAt = new Date(data.event_date).toISOString();

        return {
          id: doc.id,
          sourceType: 'EVENT',
          title: data.title || 'Untitled Event',
          status: data.status || 'draft',
          // Events control ticker visibility via explicitly defined boolean 'showInTicker'
          showInTicker: data.status === 'published' && data.showInTicker !== false,
          priority: data.priority || 0,
          audience: 'all',
          expiresAt,
          created_at: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now(),
          originalData: { id: doc.id, ...data }
        };
      });

      // Master Sort by Priority (ASC), then created_at (DESC)
      const combined = [...aList, ...eList].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.created_at - a.created_at;
      });

      setItems(combined);
    } catch (error) {
      console.error("Error fetching master broadcast timeline:", error);
      toast({ variant: "destructive", title: "System Error", description: "Failed to load broadcast timeline." });
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTicker = async (item: BroadcastItem) => {
    const db = getFirestore(getFirebaseApp());
    try {
      if (item.sourceType === 'EVENT') {
        const ref = doc(db, 'events', item.id);
        const newShow = !item.showInTicker;
        await updateDoc(ref, { showInTicker: newShow });
        toast({ title: "Ticker Visibility Updated", description: `Event broadcast set to ${newShow ? 'Active' : 'Hidden'}.` });
      } else {
        const ref = doc(db, 'announcements', item.id);
        const newStatus = item.status === 'published' ? 'draft' : 'published';
        await updateDoc(ref, { status: newStatus });
        toast({ title: "Broadcast Status Updated", description: `Announcement set to ${newStatus}.` });
      }
      fetchUnifiedFeed();
    } catch (err) {
      console.error("Error toggling ticker", err);
      toast({ variant: "destructive", title: "Error", description: "Failed to update broadcast status." });
    }
  };

  const handleUpdatePriority = async (item: BroadcastItem, newVal: string) => {
    const newPriority = parseInt(newVal, 10);
    if (isNaN(newPriority)) return;
    if (newPriority === item.priority) return;

    const db = getFirestore(getFirebaseApp());
    try {
      const collectionName = item.sourceType === 'EVENT' ? 'events' : 'announcements';
      await updateDoc(doc(db, collectionName, item.id), { priority: newPriority });
      toast({ title: "Priority Updated", description: `Priority set to ${newPriority}` });
      fetchUnifiedFeed();
    } catch (err) {
      console.error("Error updating priority", err);
      toast({ variant: "destructive", title: "Error", description: "Failed to update priority." });
    }
  };

  const handleDeleteAnnouncement = async (id: string, title: string) => {
    setDeleteTarget({ id, title });
  };

  const confirmDeleteAnnouncement = async () => {
    if (!deleteTarget) return;
    const { id, title } = deleteTarget;
    setDeleteTarget(null);
    const db = getFirestore(getFirebaseApp());
    try {
      await deleteDoc(doc(db, 'announcements', id));
      await logAuditEntry(db, 'announcement_deleted', user?.uid || '', id, { title });
      toast({ title: "Purged", description: "Announcement erased from existence." });
      fetchUnifiedFeed();
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: "Deletion failed." });
    }
  };

  const openCreateDialog = () => {
    setEditingAnnouncement(null);
    setIsDialogOpen(true);
  };

  const openEditDialog = (item: BroadcastItem) => {
    setEditingAnnouncement(item.originalData);
    setIsDialogOpen(true);
  };

  const handleSubmitForm = async (values: AnnouncementFormValues) => {
    const db = getFirestore(getFirebaseApp());
    const targetRef = editingAnnouncement ? doc(db, 'announcements', editingAnnouncement.id) : doc(collection(db, 'announcements'));

    const slugFromTitle = (t: string) => t.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const announcementToSave: any = {
      title: values.title,
      content: values.content,
      audience: values.audience,
      status: values.status,
      publish_date: values.publish_date ? Timestamp.fromDate(new Date(values.publish_date)) : null,
      slug: values.slug || slugFromTitle(values.title),
      meta_title: values.meta_title || '',
      meta_description: values.meta_description || '',
      keywords: values.keywords || '',
      isFeatured: !!values.isFeatured,
      ctaText: values.ctaText || '',
      ctaLink: values.ctaLink || '',
      ctaExpiredText: values.ctaExpiredText || '',
      expiresAt: values.expiresAt ? Timestamp.fromDate(values.expiresAt) : null,
      priority: values.priority || 0,
      updated_at: serverTimestamp(),
    };

    try {
      if (editingAnnouncement) {
        await updateDoc(targetRef, announcementToSave);
        await logAuditEntry(db, 'announcement_updated', user?.uid || '', editingAnnouncement.id, { title: editingAnnouncement.title });
      } else {
        announcementToSave.created_at = serverTimestamp();
        announcementToSave.created_by = user?.uid;
        const newDoc = await addDoc(collection(db, 'announcements'), announcementToSave);
        await logAuditEntry(db, 'announcement_created', user?.uid || '', newDoc.id, { title: values.title });
      }
      fetchUnifiedFeed();
      setIsDialogOpen(false);
      toast({ title: 'Success', description: 'Announcement saved.' });
    } catch (error) {
      console.error("Save failed:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to deploy architecture.' });
    }
  };

  return (
    <AuthorizationGate permission="canManageAnnouncements">
      <>
        <div className="mb-8 border-b border-primary/20 pb-4">
          <h1 className="text-4xl font-bold text-glow mb-2 font-heading tracking-wider flex items-center gap-3">
            Master Broadcast Controller
          </h1>
          <p className="text-muted-foreground font-body">Unified WYSIWYG command center for the global scrolling ticker & featured banners.</p>
        </div>

        <Card className="w-full bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors shadow-2xl">
          <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-2xl text-primary font-heading tracking-wide">Unified Feed Array</CardTitle>
              <CardDescription className="font-body">Manage both STANDARD Announcements and premium EVENT broadcasts.</CardDescription>
            </div>
            <Button onClick={openCreateDialog} className="bg-blue-600 hover:bg-blue-500 text-white font-accent uppercase tracking-widest shadow-[0_0_15px_rgba(37,99,235,0.4)]">
              <PlusCircle className="mr-2 h-4 w-4" /> Add Standard Announcement
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={8} columns={6} />
            ) : items.length === 0 ? (
              <p className="text-center text-muted-foreground py-12 font-body italic">No broadcast data found in the arrays.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-primary/20 bg-card/50">
                <Table>
                  <TableHeader>
                    <TableRow className="border-primary/20 bg-muted/50 hover:bg-muted/50">
                      <TableHead className="font-accent tracking-widest text-primary/80">Source</TableHead>
                      <TableHead className="font-accent tracking-widest text-primary/80 w-[30%]">Title</TableHead>
                      <TableHead className="font-accent tracking-widest text-primary/80 text-center">Priority</TableHead>
                      <TableHead className="font-accent tracking-widest text-primary/80">TTL / Expiry</TableHead>
                      <TableHead className="font-accent tracking-widest text-primary/80 text-center">Broadcast Active</TableHead>
                      <TableHead className="font-accent tracking-widest text-primary/80 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id} className="border-primary/5 hover:bg-primary/5 transition-colors">
                        <TableCell>
                          <Badge
                            variant={item.sourceType === 'EVENT' ? 'default' : 'secondary'}
                            className={`font-accent tracking-widest uppercase text-[10px] ${item.sourceType === 'EVENT' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-700 text-muted-foreground'}`}
                          >
                            [{item.sourceType}]
                          </Badge>
                        </TableCell>
                        <TableCell className="font-bold text-foreground font-heading tracking-wide">
                          {item.title}
                          {item.status !== 'published' && <span className="ml-2 text-[10px] font-normal text-amber-500 border border-amber-500/30 px-1 py-0.5 rounded font-accent uppercase">Draft</span>}
                        </TableCell>
                        <TableCell className="text-center">
                          <Input
                            type="number"
                            min="0"
                            defaultValue={item.priority}
                            onBlur={(e) => handleUpdatePriority(item, e.target.value)}
                            className="w-16 h-8 text-center mx-auto bg-muted border-primary/30 focus-visible:ring-primary font-accent"
                            title="Lower number = Higher Priority"
                          />
                        </TableCell>
                        <TableCell className="font-body text-xs text-muted-foreground">
                          {item.expiresAt ? format(new Date(item.expiresAt), 'PP p') : <span className="italic opacity-50">Infinite</span>}
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex justify-center items-center">
                            <Switch
                              checked={item.showInTicker}
                              onCheckedChange={() => handleToggleTicker(item)}
                              className="data-[state=checked]:bg-emerald-500"
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                          {item.sourceType === 'EVENT' ? (
                            <Button variant="outline" size="sm" asChild className="border-primary/30 hover:bg-primary/20 text-blue-400 hover:text-blue-300 font-accent tracking-widest uppercase text-[10px]">
                              <Link href={`/admin/events/edit?id=${item.id}`} passHref>
                                Manage <ExternalLink className="ml-2 h-3 w-3" />
                              </Link>
                            </Button>
                          ) : (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => openEditDialog(item)} className="hover:bg-blue-500/20 hover:text-blue-400">
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => handleDeleteAnnouncement(item.id, item.title)} className="hover:bg-red-500/20 hover:text-red-400">
                                <Trash className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Announcement Edit/Create Dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="sm:max-w-[700px] border-primary/30 bg-card">
            <DialogHeader>
              <DialogTitle className="text-2xl font-heading text-primary tracking-wide">
                {editingAnnouncement ? 'Reconfigure Broadcast' : 'Deploy New Broadcast'}
              </DialogTitle>
              <DialogDescription className="font-body text-muted-foreground">
                {editingAnnouncement ? 'Modify the active announcement array properties.' : 'Inject a new standard announcement into the global feed.'}
              </DialogDescription>
            </DialogHeader>
            <AnnouncementForm
              initial={editingAnnouncement ? {
                title: editingAnnouncement.title,
                content: editingAnnouncement.content,
                audience: editingAnnouncement.audience || 'all',
                status: editingAnnouncement.status || 'draft',
                publish_date: editingAnnouncement.publish_date || '',
                slug: editingAnnouncement.slug || '',
                meta_title: editingAnnouncement.meta_title || '',
                meta_description: editingAnnouncement.meta_description || '',
                keywords: editingAnnouncement.keywords || '',
                isFeatured: editingAnnouncement.isFeatured ?? false,
                ctaText: editingAnnouncement.ctaText || '',
                ctaLink: editingAnnouncement.ctaLink || '',
                ctaExpiredText: editingAnnouncement.ctaExpiredText || '',
                priority: editingAnnouncement.priority || 0,
                expiresAt: editingAnnouncement.expiresAt
                  ? (editingAnnouncement.expiresAt?.toDate
                    ? editingAnnouncement.expiresAt.toDate()
                    : new Date(editingAnnouncement.expiresAt))
                  : undefined,
              } : undefined}
              onSubmit={handleSubmitForm}
              onCancel={() => setIsDialogOpen(false)}
            />
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Announcement</DialogTitle>
              <DialogDescription>
                WARNING: Permanent Deletion. Are you sure you want to delete "{deleteTarget?.title}"?
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="destructive" onClick={confirmDeleteAnnouncement}>Delete</Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    </AuthorizationGate>
  );
}
