"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useUser } from '@/firebase';
import { useRouter } from 'next/navigation';
import { getFirestore, collection, query, getDocs, doc, serverTimestamp, FieldValue } from 'firebase/firestore';
;
import { useCollection } from '@/firebase';
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
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import ResponsiveDialogContent from '@/components/ui/responsive-dialog-content';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';
import MultiSelectUserCombobox from "@/components/admin/multi-select-user-combobox";
import { TableSkeleton } from '@/components/ui/loading-states';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import ImageUploader from '@/components/admin/image-uploader';
import { Checkbox } from '@/components/ui/checkbox';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';

// Temporarily disable ReactQuill to prevent crashes during audit
// const ReactQuill = dynamic(() => import('react-quill'), { ssr: false });
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import UserSelectionCombobox from "@/components/admin/user-selection-combobox";
import { deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';

// Project category tags used for filtering on /projects
const PROJECT_CATEGORIES = ['technical', 'logistics', 'sponsorship', 'ethics', 'outreach'] as const;

function typeFromTags(tags?: string[]): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  const lower = tags.map(t => t.toLowerCase());
  return PROJECT_CATEGORIES.find(cat => lower.includes(cat));
}

function updateTagsWithType(tags: string[] | undefined, type: string): string[] {
  const base = (tags || []).filter(t => !PROJECT_CATEGORIES.includes(t.toLowerCase() as any));
  return [...base, type];
}

interface Project {
  id: string;
  title: string;
  slug: string;
  description: string;
  team: string[]; // UIDs of team members
  teamLeaderId: string; // UID of the team leader
  media?: string[]; // Array of URLs to cover images or media
  github_repo?: string;
  docs_url?: string;
  status: string;
  tags?: string[];
  showOnHomepage?: boolean;
  created_at?: any; // legacy
  updated_at?: any; // legacy
  createdBy?: string; // new
  createdAt?: any; // new
  updatedAt?: any; // new
  video_url?: string;
}

export default function AdminProjectsPage() {
  const { user, isLoading: userLoading } = useUser();
  const router = useRouter();
  const { toast } = useToast();
  const firestore = useFirestore();

  const { isAuthorized: canManageProjects } = useAuthorization('canManageProjects');

  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [newProjectData, setNewProjectData] = useState<Partial<Project>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Memoize collection reference to prevent infinite re-renders
  const usersCollectionRef = useMemoFirebase(() => collection(firestore, 'users'), [firestore]);
  const { data: usersData, loading: usersLoading } = useCollection(usersCollectionRef);
  const users = usersData?.map((doc: any) => ({ uid: doc.id, ...doc })) || [];

  useEffect(() => {
    if (user && canManageProjects) {
      fetchProjects();
    }
  }, [user, canManageProjects]);

  // Auto-generate slug from title if slug is empty
  useEffect(() => {
    const title = (newProjectData.title || '').toString();
    const slug = (newProjectData.slug || '').toString();
    if (title && (!slug || slug.trim().length === 0)) {
      setNewProjectData(prev => ({ ...prev, slug: slugify(title) }));
    }
  }, [newProjectData.title]);

  const fetchProjects = async () => {
    setLoadingProjects(true);
    const db = getFirestore(getFirebaseApp());
    const projectsCol = collection(db, 'projects');
    const q = query(projectsCol);

    try {
      const querySnapshot = await getDocs(q);
      const fetchedProjects: Project[] = [];
      querySnapshot.forEach((doc) => {
        fetchedProjects.push({ id: doc.id, ...doc.data() } as Project);
      });
      setProjects(fetchedProjects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch projects.",
      });
    } finally {
      setLoadingProjects(false);
    }
  };

  const handleCreateProject = () => {
    if (!canManageProjects) {
      toast({ variant: 'destructive', title: 'Unauthorized', description: 'Only project admins can create projects.' });
      return;
    }
    setEditingProject(null);
    setNewProjectData({ title: '', slug: '', description: '', team: [], status: 'active', showOnHomepage: true });
    setIsDialogOpen(true);
  };

  const handleEditProject = (project: Project) => {
    setEditingProject(project);
    setNewProjectData(project);
    setIsDialogOpen(true);
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!confirm("Are you sure you want to delete this project?")) return;

    const db = getFirestore(getFirebaseApp());
    const projectRef = doc(db, 'projects', projectId);

    try {
      const projectToDelete = projects.find(p => p.id === projectId);
      if (!projectToDelete) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Project not found.",
        });
        return;
      }

      // Restrict deletion to project admins only (matches Firestore rules)
      if (!canManageProjects) {
        toast({
          variant: "destructive",
          title: "Unauthorized",
          description: "Only project admins can delete projects.",
        });
        return;
      }

      await deleteDoc(projectRef);
      await logAuditEntry(db, 'project_deleted', user?.uid || '', projectId, { projectId });
      toast({
        title: "Project Deleted",
        description: "Project has been successfully deleted.",
      });
      fetchProjects();
    } catch (error) {
      console.error("Error deleting project:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete project.",
      });
    }
  };

  const handleSaveProject = async () => {
    if (!newProjectData.title || !newProjectData.slug || !newProjectData.description) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Title, Slug, and Description are required.",
      });
      return;
    }

    // Ensure leader is within selected team members
    const teamList = Array.isArray(newProjectData.team) ? newProjectData.team : [];
    if (newProjectData.teamLeaderId && !teamList.includes(newProjectData.teamLeaderId)) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Team leader must be one of the selected team members.",
      });
      return;
    }

    const db = getFirestore(getFirebaseApp());
    const projectRef = editingProject ? doc(db, 'projects', editingProject.id) : doc(collection(db, 'projects'));

    try {
      setIsSaving(true);
      // Ensure a category tag is persisted even if user didn't change the selector
      const selectedType = typeFromTags(newProjectData.tags as string[] | undefined) || 'technical';
      const ensuredTags = updateTagsWithType(newProjectData.tags as string[] | undefined, selectedType);

      // Derive summary by stripping HTML and truncating
      const summary = (() => {
        const html = (newProjectData.description || '') as string;
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return text.slice(0, 280);
      })();

      // Map fields to Firestore rules schema while preserving legacy fields
      const dataToSave = {
        // Core fields
        title: newProjectData.title,
        slug: newProjectData.slug,
        description: newProjectData.description,
        summary,
        status: newProjectData.status || 'active',
        tags: ensuredTags,
        // URLs and media
        media: Array.isArray(newProjectData.media) ? newProjectData.media : [],
        imageUrl: Array.isArray(newProjectData.media) && newProjectData.media.length > 0 ? newProjectData.media[0] : null,
        video_url: newProjectData.video_url || '',
        githubUrl: newProjectData.github_repo || '',
        documentationUrl: newProjectData.docs_url || '',
        // Team
        teamLeaderId: newProjectData.teamLeaderId || (user?.uid as string),
        teamMemberIds: Array.isArray(newProjectData.team) ? newProjectData.team : [],
        showOnHomepage: !!newProjectData.showOnHomepage,
        // Audit fields (no undefined values)
        ...(editingProject ? {} : { createdBy: user?.uid as string, createdAt: serverTimestamp(), created_at: serverTimestamp() }),
        updatedAt: serverTimestamp(),
        updated_at: serverTimestamp(),
        // Legacy field preservation to avoid breaking readers
        team: Array.isArray(newProjectData.team) ? newProjectData.team : [],
        github_repo: newProjectData.github_repo || '',
        docs_url: newProjectData.docs_url || '',
        // On create, initialize counters required by rules
        ...(editingProject ? {} : { taskCount: 0, completedTaskCount: 0 }),
      } as any;
      await setDoc(projectRef, dataToSave, { merge: true });

      await logAuditEntry(db, editingProject ? 'project_updated' : 'project_created', user?.uid || '', projectRef.id, {
        projectId: projectRef.id,
        title: newProjectData.title
      });

      toast({
        title: "Success",
        description: `Project ${newProjectData.title} has been ${editingProject ? 'updated' : 'created'}.`,
      });
      setIsDialogOpen(false);
      fetchProjects();
    } catch (error) {
      console.error("Error saving project:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save project.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (userLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading project management...</p>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageProjects">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-glow mb-2">Project Management</h1>
        <p className="text-muted-foreground">Create, edit, and delete projects.</p>
      </div>
      <Card className="w-full bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Projects</CardTitle>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/admin/tasks">View Tasks</Link>
            </Button>
            <Button onClick={handleCreateProject}><PlusCircle className="mr-2 h-4 w-4" /> Add New Project</Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingProjects ? (
            <TableSkeleton rows={8} columns={5} />
          ) : projects.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No projects found.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Created By</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Team Leader</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">{project.title}</TableCell>
                      <TableCell>{project.slug}</TableCell>
                      <TableCell>{users.find((u: any) => u.uid === (project as any).createdBy)?.displayName || (project as any).createdBy || 'Unknown'}</TableCell>
                      <TableCell>{(() => {
                        const d: any = (project as any).createdAt || (project as any).created_at;
                        try {
                          if (!d) return 'N/A';
                          if (d?.seconds) return new Date(d.seconds * 1000).toLocaleString();
                          const nd = new Date(d);
                          return isNaN(nd.getTime()) ? 'N/A' : nd.toLocaleString();
                        } catch { return 'N/A'; }
                      })()}</TableCell>
                      <TableCell><Badge variant="secondary">{project.status}</Badge></TableCell>
                      <TableCell>{users.find((u: any) => u.uid === project.teamLeaderId)?.displayName || 'N/A'}</TableCell>
                      <TableCell>
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/admin/tasks?projectId=${project.id}`}>Tasks</Link>
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleEditProject(project)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteProject(project.id)}>
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
      {/* ... Rest of JSX ... */}

      {/* Project Edit/Create Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <ResponsiveDialogContent>
          <DialogHeader>
            <DialogTitle>{editingProject ? 'Edit Project' : 'Create New Project'}</DialogTitle>
            <DialogDescription>
              {editingProject ? 'Make changes to the project here.' : 'Add a new project to the database.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
              <Label htmlFor="title" className="sm:text-right">Title</Label>
              <Input
                id="title"
                value={newProjectData.title || ''}
                onChange={(e) => setNewProjectData({ ...newProjectData, title: e.target.value })}
                className="sm:col-span-3"
                placeholder="e.g., SEDS-SAT-1 CubeSat"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
              <Label htmlFor="slug" className="sm:text-right">Slug</Label>
              <Input
                id="slug"
                value={newProjectData.slug || ''}
                onChange={(e) => setNewProjectData({ ...newProjectData, slug: e.target.value })}
                className="sm:col-span-3"
                placeholder="seds-sat-1"
              />
              <div className="sm:col-span-4 text-xs text-muted-foreground -mt-2 sm:ml-[calc(25%+0.5rem)]">Auto-generated from title; you can edit.</div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
              <Label htmlFor="description" className="sm:text-right">Description</Label>
              <Textarea
                id="description"
                value={newProjectData.description || ''}
                onChange={(e) => setNewProjectData({ ...newProjectData, description: e.target.value })}
                className="sm:col-span-3 min-h-32"
                placeholder="Describe the project goals, scope, and progress..."
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">Project Type</Label>
              <Select
                value={typeFromTags(newProjectData.tags) || 'technical'}
                onValueChange={(value) => setNewProjectData(prev => ({
                  ...prev,
                  tags: updateTagsWithType(prev.tags as string[] | undefined, value)
                }))}
              >
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="col-span-4 text-xs text-muted-foreground -mt-2 ml-[calc(25%+0.5rem)]">Used to power category filters on the Projects page.</div>
              {(newProjectData.tags && newProjectData.tags.length > 0) && (
                <div className="col-span-4 ml-[calc(25%+0.5rem)]">
                  <div className="flex flex-wrap gap-2">
                    {newProjectData.tags?.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-4 items-center gap-4 mt-12">
              <Label htmlFor="status" className="text-right">Status</Label>
              <Select
                value={newProjectData.status || 'active'}
                onValueChange={(value) => setNewProjectData({ ...newProjectData, status: value })}
              >
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="draft">Draft (Hidden)</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="media" className="text-right">Media URLs (comma-separated)</Label>
              <Input
                id="media"
                value={newProjectData.media?.join(', ') || ''}
                onChange={(e) => setNewProjectData({ ...newProjectData, media: e.target.value.split(',').map(url => url.trim()) })}
                className="col-span-3"
                placeholder="https://image1.jpg, https://image2.png"
              />
              <div className="col-span-4 text-xs text-muted-foreground -mt-2 ml-[calc(25%+0.5rem)]">Paste one or more URLs separated by commas.</div>
            </div>


            <div className="grid grid-cols-4 items-center gap-4 border-t border-border/50 pt-4 mt-4">
              <Label htmlFor="video_url" className="text-right font-medium text-red-500">YouTube Video</Label>
              <Input
                id="video_url"
                value={newProjectData.video_url || ''}
                onChange={(e) => setNewProjectData({ ...newProjectData, video_url: e.target.value })}
                className="col-span-3"
                placeholder="https://www.youtube.com/watch?v=..."
              />
              <div className="col-span-4 text-xs text-muted-foreground -mt-2 ml-[calc(25%+0.5rem)]">Paste a YouTube URL to embed a video on the project page.</div>
            </div>

            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="showOnHomepage" className="text-right">Appear on Landing Page</Label>
              <div className="flex items-center space-x-2 col-span-3">
                <Checkbox
                  id="showOnHomepage"
                  checked={!!newProjectData.showOnHomepage}
                  onCheckedChange={(checked) => setNewProjectData({ ...newProjectData, showOnHomepage: !!checked })}
                />
                <label htmlFor="showOnHomepage" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  Visible in &quot;Our Impact in Action&quot; gallery
                </label>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
              <Label htmlFor="github_repo" className="sm:text-right">GitHub Repository</Label>
              <Input
                id="github_repo"
                value={newProjectData.github_repo || ''}
                onChange={(e) => setNewProjectData({ ...newProjectData, github_repo: e.target.value })}
                className="sm:col-span-3"
                placeholder="https://github.com/org/repo"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
              <Label htmlFor="docs_url" className="sm:text-right">Documentation URL</Label>
              <Input
                id="docs_url"
                value={newProjectData.docs_url || ''}
                onChange={(e) => setNewProjectData({ ...newProjectData, docs_url: e.target.value })}
                className="sm:col-span-3"
                placeholder="https://docs.example.com/project"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
              <Label htmlFor="teamMembers" className="sm:text-right">Team Members</Label>
              <div className="sm:col-span-3">
                <MultiSelectUserCombobox
                  value={newProjectData.team || []}
                  onChange={(selected) => setNewProjectData({ ...newProjectData, team: selected })}
                />
                <div className="text-xs text-muted-foreground mt-2">Use search or filter by university or role to quickly find members.</div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 items-center gap-4">
              <Label htmlFor="teamLeader" className="sm:text-right">Team Leader</Label>
              <div className="sm:col-span-3">
                <UserSelectionCombobox
                  selectedUid={newProjectData.teamLeaderId || null}
                  onSelect={(uid) => setNewProjectData({ ...newProjectData, teamLeaderId: uid })}
                  restrictToIds={newProjectData.team || []}
                  placeholder="Select a team leader"
                />
                <div className="text-xs text-muted-foreground mt-2">Only members selected above can be chosen as leader. Use search to locate quickly.</div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)} disabled={isSaving}>Cancel</Button>
            <Button type="submit" onClick={handleSaveProject} disabled={isSaving}>
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
        </ResponsiveDialogContent>
      </Dialog>
    </AuthorizationGate>
  );
}
// Slug helper to auto-generate from title
function slugify(input: string) {
  return (input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
