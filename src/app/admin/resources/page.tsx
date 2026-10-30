"use client";

import React, { useMemo, useState } from "react";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Edit, Trash, PlusCircle } from "lucide-react";
import { USER_ROLES, type UserRole } from "@/lib/roles";
import { getChapters } from "@/lib/firebase/firestore";

// Sponsors & Partners are managed in the CRM Console (/admin/crm); the
// partners tab below links there instead of embedding the retired page.
import Link from "next/link";

// Competitions
import { useFirestore, useCollection } from "@/firebase";
import { query } from 'firebase/firestore';
;
import { useMemoFirebase } from "@/lib/use-memo-firebase";
import { serverWrite } from '@/lib/client/server-write';
import { useClientSupaSurface } from "@/lib/client-supa-flags";

import {
  competitionsCollection,
  type CompetitionRecord,
  createCompetition,
  updateCompetition,
  deleteCompetition,
} from "@/lib/competitions";

// Competition write/read failures surface as cryptic Firestore errors by default.
// This maps them to plain messages so a rules failure is never a silent failure.
function competitionErrorMessage(e: any, action: string): string {
  if ((e as any)?.code === "permission-denied") {
    return "Permission denied. Your account cannot change competitions. Ask an admin to confirm your canManageResources access and that the competitions rule is deployed, then try again.";
  }
  return (e as any)?.message || `Failed to ${action} competition.`;
}

export default function AdminResourcesPage() {
  return (
    <AuthorizationGate permission="canManageResources">
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-glow mb-2">Resources & Opportunities</h1>
          <p className="text-muted-foreground">Unified hub for managing strategic relationships and opportunities.</p>
        </div>

        <Tabs defaultValue="partners" className="w-full">
          <TabsList>
            <TabsTrigger value="partners">Sponsors & Partners</TabsTrigger>
            <TabsTrigger value="competitions">Competitions</TabsTrigger>
          </TabsList>

          <TabsContent value="partners" className="pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Sponsors & Partners</CardTitle>
                <CardDescription>
                  Sponsor and partner organisations are managed in the CRM Console:
                  pipeline, full organisation records, agreement analysis, and the
                  AI Sponsor Match tab all live there now.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild>
                  <Link href="/admin/crm">Open CRM Console</Link>
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="competitions" className="pt-4">
            <CompetitionsTab />
          </TabsContent>
        </Tabs>
      </div>
    </AuthorizationGate>
  );
}

function CompetitionsTab() {
  const db = useFirestore();
  const { toast } = useToast();

  const col = useMemoFirebase(() => competitionsCollection(db), [db]);
  const competitionsQuery = useMemoFirebase(() => {
    try { return query(col); } catch { return null as any; }
  }, [col]);
  const liveAdminOn = useClientSupaSurface('live-admin');
  const { data: competitions, loading, error: competitionsError } = useCollection<CompetitionRecord>(competitionsQuery, { listen: !liveAdminOn });

  const [search, setSearch] = useState("");

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CompetitionRecord | null>(null);
  const [form, setForm] = useState<CompetitionRecord>({
    title: "",
    description: "",
    featuredImage: "",
    rulebook: "",
    startDate: "",
    endDate: "",
    isPublic: false,
  });

  // Targeted Notification state
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [notifyFor, setNotifyFor] = useState<CompetitionRecord | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<UserRole[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<string[]>([]);
  const [chapters, setChapters] = useState<Array<{ id: string; name: string }>>([]);
  const [candidateUsers, setCandidateUsers] = useState<Array<{ uid: string; displayName?: string; chapterId?: string; role?: UserRole }>>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [notifyTitle, setNotifyTitle] = useState("");
  const [notifyBody, setNotifyBody] = useState("");
  const [notifyLink, setNotifyLink] = useState("");

  React.useEffect(() => {
    (async () => {
      try {
        const list = await getChapters(db);
        setChapters(list.map((c) => ({ id: c.id!, name: (c as any).name })));
      } catch (e) {
        console.warn("Failed to load chapters", e);
      }
    })();
  }, [db]);

  const filtered = useMemo(() => {
    const list = competitions || [];
    return list
      .filter((c) => (search ? (c.title || "").toLowerCase().includes(search.toLowerCase()) : true))
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }, [competitions, search]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      title: "",
      description: "",
      featuredImage: "",
      rulebook: "",
      startDate: "",
      endDate: "",
      isPublic: false,
    });
    setIsDialogOpen(true);
  };

  const openEdit = (record: CompetitionRecord) => {
    setEditing(record);
    setForm({ ...record });
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      if (!form.title || !form.description || !form.featuredImage || !form.startDate || !form.endDate) {
        toast({ title: "Missing fields", description: "Please complete all required fields.", variant: "destructive" });
        return;
      }
      if (editing?.id) {
        await updateCompetition(db, editing.id, form);
        toast({ title: "Updated", description: "Competition updated successfully." });
      } else {
        const id = await createCompetition(db, form);
        toast({ title: "Created", description: `Competition created (ID: ${id}).` });
      }
      setIsDialogOpen(false);
    } catch (e: any) {
      toast({ title: editing?.id ? "Could not update competition" : "Could not create competition", description: competitionErrorMessage(e, "save"), variant: "destructive" });
    }
  };

  const handleDelete = async (id?: string) => {
    if (!id) return;
    const ok = window.confirm("Delete this competition? This cannot be undone.");
    if (!ok) return;
    try {
      await deleteCompetition(db, id);
      toast({ title: "Deleted", description: "Competition removed." });
    } catch (e: any) {
      toast({ title: "Could not delete competition", description: competitionErrorMessage(e, "delete"), variant: "destructive" });
    }
  };

  const openNotify = async (record: CompetitionRecord) => {
    setNotifyFor(record);
    setSelectedRoles([]);
    setSelectedChapters([]);
    setCandidateUsers([]);
    setSelectedUserIds([]);
    setNotifyTitle(record.title ? `Opportunity: ${record.title}` : "Opportunity Notification");
    setNotifyBody("Hello! We thought you might be interested in this competition.");
    setNotifyLink("");
    setNotifyOpen(true);
  };

  const refreshCandidates = async () => {
    try {
      // RBT2-B2: the candidate scan moved server-side to
      // POST /api/admin/resources/candidates (users/roles seams,
      // seam-first). It used to run here in the browser: a full
      // getDocs(users) per click (257 reads unfiltered) plus one
      // roles query per selected role. The route applies the exact
      // same chapter/role selection and returns the same candidate
      // shape — displayName + role/chapter only; contact fields
      // (email) are NOT mapped, they live in the gated
      // users/{uid}/private/contact doc. The notify action below
      // needs no email: it posts only userIds + the notification
      // content to /api/admin/resources/notify.
      const res = await serverWrite('/api/admin/resources/candidates', 'POST', {
        chapterIds: selectedChapters,
        roles: selectedRoles,
      });
      const filtered = Array.isArray(res.body?.users) ? res.body.users : [];
      setCandidateUsers(filtered);
      setSelectedUserIds([]);
    } catch (e: any) {
      toast({ title: "Could not load candidates", description: competitionErrorMessage(e, "load candidates"), variant: "destructive" });
    }
  };

  const toggleUserSelection = (uid: string) => {
    setSelectedUserIds((prev) => (prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid]));
  };

  const sendNotifications = async () => {
    if (!notifyFor) return;
    if (selectedUserIds.length === 0) {
      toast({ title: "No recipients", description: "Select at least one user.", variant: "destructive" });
      return;
    }
    try {
      // WS10 (notifications residual #3): routed through
      // POST /api/admin/resources/notify — the server route performs
      // the Firestore add per recipient AND the fs_group_notifications
      // mirror the client write never had.
      await serverWrite('/api/admin/resources/notify', 'POST', {
        userIds: selectedUserIds,
        notification: {
          title: notifyTitle || (notifyFor.title ? `Opportunity: ${notifyFor.title}` : "Opportunity"),
          body: notifyBody || "",
          link: notifyLink || "",
          competitionId: notifyFor.id || null,
        },
      });
      toast({ title: "Sent", description: `Notifications sent to ${selectedUserIds.length} user(s).` });
      setNotifyOpen(false);
    } catch (e: any) {
      toast({ title: "Could not send notifications", description: competitionErrorMessage(e, "send notifications"), variant: "destructive" });
    }
  };

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
      <CardHeader className="flex items-center justify-between">
        <div>
          <CardTitle>Competitions</CardTitle>
          <CardDescription>Manage competitions and opportunities for members.</CardDescription>
        </div>
        <Button onClick={openCreate}>
          <PlusCircle className="h-4 w-4 mr-2" /> Create Competition
        </Button>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex-1 min-w-[200px]">
            <Label>Search</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title" />
          </div>
        </div>

        {competitionsError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <span className="font-medium">Could not load competitions. </span>
            {competitionErrorMessage(competitionsError, "load")}
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>End</TableHead>
                <TableHead>Public</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center">Loading…</TableCell></TableRow>
              ) : filtered && filtered.length > 0 ? (
                filtered.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.title}</TableCell>
                    <TableCell>{c.startDate || "—"}</TableCell>
                    <TableCell>{c.endDate || "—"}</TableCell>
                    <TableCell>{c.isPublic ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(c)}>
                        <Edit className="h-4 w-4 mr-1" /> Edit
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleDelete(c.id)}>
                        <Trash className="h-4 w-4 mr-1" /> Delete
                      </Button>
                      <Button variant="default" size="sm" onClick={() => openNotify(c)}>
                        Notify Participants
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">No competitions found.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="sm:max-w-[700px]">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Competition" : "Create Competition"}</DialogTitle>
              <DialogDescription>Fill in the competition details. File uploads use URL fields for now.</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
              <div className="md:col-span-2">
                <Label>Title</Label>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>

              <div className="md:col-span-2">
                <Label>Description</Label>
                <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>

              <div className="md:col-span-2">
                <Label>Featured Image URL</Label>
                <Input value={form.featuredImage} onChange={(e) => setForm({ ...form, featuredImage: e.target.value })} placeholder="https://.../image.jpg" />
              </div>

              <div className="md:col-span-2">
                <Label>Rulebook URL (PDF)</Label>
                <Input value={form.rulebook || ""} onChange={(e) => setForm({ ...form, rulebook: e.target.value })} placeholder="https://.../rules.pdf" />
              </div>

              <div>
                <Label>Start Date</Label>
                <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </div>
              <div>
                <Label>End Date</Label>
                <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </div>

              <div>
                <Label>Public</Label>
                <Select value={(form.isPublic ? "true" : "false")} onValueChange={(v) => setForm({ ...form, isPublic: v === "true" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">No</SelectItem>
                    <SelectItem value="true">Yes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave}>{editing ? "Save Changes" : "Create"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Targeted Notification Modal */}
        <Dialog open={notifyOpen} onOpenChange={setNotifyOpen}>
          <DialogContent className="sm:max-w-[900px]">
            <DialogHeader>
              <DialogTitle>Notify Participants</DialogTitle>
              <DialogDescription>
                Filter by role and chapter, select recipients, and send a notification.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 py-2">
              <div>
                <Label>Roles</Label>
                <Select value="__noop__" onValueChange={(v) => {
                  if (v === "__noop__") return;
                  const role = v as UserRole;
                  setSelectedRoles((prev) => (prev.includes(role) ? prev : [...prev, role]));
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Add role filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__noop__">Select…</SelectItem>
                    {Object.keys(USER_ROLES).map((key) => (
                      <SelectItem key={key} value={key}>{(USER_ROLES as any)[key]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedRoles.map((r) => (
                    <Button key={r} variant="secondary" size="sm" onClick={() => setSelectedRoles((prev) => prev.filter((x) => x !== r))}>{(USER_ROLES as any)[r]} ×</Button>
                  ))}
                </div>
              </div>

              <div>
                <Label>Chapters</Label>
                <Select value="__noop__" onValueChange={(v) => {
                  if (v === "__noop__") return;
                  setSelectedChapters((prev) => (prev.includes(v) ? prev : [...prev, v]));
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Add chapter filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__noop__">Select…</SelectItem>
                    {chapters.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedChapters.map((c) => (
                    <Button key={c} variant="secondary" size="sm" onClick={() => setSelectedChapters((prev) => prev.filter((x) => x !== c))}>{c} ×</Button>
                  ))}
                </div>
              </div>

              <div className="flex items-end">
                <Button onClick={refreshCandidates}>Search Candidates</Button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <Label>Recipients</Label>
                <div className="border rounded-md p-3 h-64 overflow-auto">
                  {candidateUsers.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No candidates loaded. Apply filters and search.</div>
                  ) : (
                    candidateUsers.map((u) => (
                      <div key={u.uid} className="flex items-center justify-between py-1">
                        <div>
                          <div className="font-medium">{u.displayName || u.uid}</div>
                          <div className="text-xs text-muted-foreground">{[u.role, u.chapterId].filter(Boolean).join(" • ")}</div>
                        </div>
                        <div>
                          <input type="checkbox" checked={selectedUserIds.includes(u.uid)} onChange={() => toggleUserSelection(u.uid)} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <Label>Notification Content</Label>
                <div className="space-y-3 mt-2">
                  <div>
                    <Label>Title</Label>
                    <Input value={notifyTitle} onChange={(e) => setNotifyTitle(e.target.value)} />
                  </div>
                  <div>
                    <Label>Message</Label>
                    <Textarea value={notifyBody} onChange={(e) => setNotifyBody(e.target.value)} />
                  </div>
                  <div>
                    <Label>Link (optional)</Label>
                    <Input value={notifyLink} onChange={(e) => setNotifyLink(e.target.value)} placeholder="https://..." />
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setNotifyOpen(false)}>Cancel</Button>
              <Button onClick={sendNotifications}>Send Notifications</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </CardContent>
    </Card>
  );
}
