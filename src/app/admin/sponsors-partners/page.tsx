"use client";

import Image from "next/image";

import React, { useMemo, useState, useEffect } from "react";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { useFirestore, useCollection } from "@/firebase";
import { query, orderBy, serverTimestamp, collection, getDocs } from "firebase/firestore";
import { useAuthorization } from "@/hooks/use-authorization";
import { useMemoFirebase } from "@/lib/use-memo-firebase";
import {
  partnersCollection,
  RELATIONSHIP_TYPES,
  STATUS_OPTIONS,
  SPONSORSHIP_TIERS,
  type PartnerRecord,
  createPartner,
  updatePartner,
  deletePartner,
} from "@/lib/partners";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { extractTextFromPdf } from "@/lib/pdf-utils";
import { Edit, Trash, PlusCircle, Sparkles, BrainCircuit, Lightbulb, X, Copy, Save, Loader2, MessageSquare } from "lucide-react";
import { MultiSelect } from "@/components/ui/multi-select";
import { Badge } from "@/components/ui/badge";

// Default AI model for server-routed AI calls. The admin model preference
// is stored in the browser under "genai.model" (not a secret).
const DEFAULT_AI_MODEL = "gemini-1.5-flash";

export default function AdminSponsorsPartnersPage() {
  const db = useFirestore();
  const { toast } = useToast();
  const { isAuthorized, isLoading } = useAuthorization("canManageSponsorsPartners");

  // Negotiation State
  const [negotiationOpen, setNegotiationOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [negotiationAnalysis, setNegotiationAnalysis] = useState<any>(null);
  const [analyzingReply, setAnalyzingReply] = useState(false);
  const [savingNegotiation, setSavingNegotiation] = useState(false);

  // Only build the Firestore query when authorization is confirmed.
  // This avoids triggering unauthorized reads that spam console with permission errors.
  const partnersQuery = useMemoFirebase(() => {
    if (isLoading || !isAuthorized) return null;
    try {
      return query(partnersCollection(db));
    } catch {
      return null;
    }
  }, [db, isAuthorized, isLoading]);

  // Fetch events for the dropdown (one-time fetch)
  const [events, setEvents] = useState<any[]>([]);
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const q = query(collection(db, 'events'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (e) {
        console.error("Failed to fetch events for dropdown", e);
      }
    };
    if (db) fetchEvents();
  }, [db]);

  const eventOptions = useMemo(() => {
    return (events || []).map((e: any) => ({ label: e.title, value: e.id }));
  }, [events]);

  // Client-side sort for now to avoid index requirements
  const { data: partners, loading } = useCollection<PartnerRecord>(partnersQuery, { listen: true });

  const [statusFilter, setStatusFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PartnerRecord | null>(null);
  const [form, setForm] = useState<PartnerRecord>({
    organizationName: "",
    relationshipType: "Sponsor",
    status: "Prospect",
    sponsorshipTier: undefined,
    primaryContact: {},
    financials: {},
    agreementIntelligence: undefined,
    integrationPoints: "",
    associatedEventIds: [],
  });

  const [analyzing, setAnalyzing] = useState(false);

  const [selected, setSelected] = useState<PartnerRecord | null>(null);
  const [newInteractionNote, setNewInteractionNote] = useState("");

  const filtered = useMemo(() => {
    const list = partners || [];
    return list
      .filter((p) => (statusFilter && statusFilter !== "__ALL__" ? p.status === statusFilter : true))
      .filter((p) => (typeFilter && typeFilter !== "__ALL__" ? p.relationshipType === typeFilter : true))
      .filter((p) =>
        search
          ? (p.organizationName || "").toLowerCase().includes(search.toLowerCase()) ||
          (p.primaryContact?.name || "").toLowerCase().includes(search.toLowerCase())
          : true
      )
      .sort((a, b) => (a.organizationName || "").localeCompare(b.organizationName || ""));
  }, [partners, statusFilter, typeFilter, search]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      organizationName: "",
      relationshipType: "Sponsor",
      status: "Prospect",
      sponsorshipTier: undefined,
      primaryContact: {},
      financials: {},
      integrationPoints: "",
      associatedEventIds: [],
    });
    setIsDialogOpen(true);
  };

  const openEdit = (record: PartnerRecord) => {
    setEditing(record);
    setForm({
      ...record,
      integrationPoints: record.integrationPoints || "",
      sponsorshipTier: record.sponsorshipTier || undefined,
      associatedEventIds: record.associatedEventIds || [],
    });
    setIsDialogOpen(true);
  };

  const logInteraction = async () => {
    if (!selected?.id) return;
    const note = newInteractionNote.trim();
    if (!note) {
      toast({ title: "Empty note", description: "Enter an interaction note.", variant: "destructive" });
      return;
    }
    try {
      const next = [
        ...((selected.interactionHistory as any) || []),
        { note, author: "admin", timestamp: serverTimestamp() },
      ];
      await updatePartner(db, selected.id, { interactionHistory: next });
      setNewInteractionNote("");
      toast({ title: "Logged", description: "Interaction added." });
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Failed to log interaction.", variant: "destructive" });
    }
  };

  const handleSave = async () => {
    try {
      if (editing?.id) {
        await updatePartner(db, editing.id, form);
        toast({ title: "Updated", description: "Organization updated successfully." });
      } else {
        const id = await createPartner(db, form);
        toast({ title: "Created", description: `Organization created (ID: ${id}).` });
      }
      setIsDialogOpen(false);
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Failed to save record.", variant: "destructive" });
    }
  };

  const handleDelete = async (id?: string) => {
    if (!id) return;
    const ok = window.confirm("Delete this organization? This cannot be undone.");
    if (!ok) return;
    try {
      await deletePartner(db, id);
      toast({ title: "Deleted", description: "Organization removed." });
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Failed to delete record.", variant: "destructive" });
    }
  };

  const handleAnalyze = async (record: PartnerRecord) => {
    if (!record.id || !record.agreementContractUrl) {
      toast({ title: "Error", description: "Save the partner and add a contract URL first.", variant: "destructive" });
      return;
    }
    setAnalyzing(true);
    try {
      const apiKey = ""; // AI key is managed server-side via GEMINI_API_KEY.
      const model = localStorage.getItem("genai.model") || DEFAULT_AI_MODEL;

      // Extract text client-side to bypass server restrictions
      const agreementText = await extractTextFromPdf(record.agreementContractUrl!);

      const res = await fetch("/api/admin/partners/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerId: record.id,
          agreementText,
          apiKey,
          model,
          context: form.strategicContext // Send the manual context
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");

      toast({ title: "Success", description: "Agreement analyzed successfully." });
      // Ideally refresh data here, but Firestore hook should pick it up if we close/reopen or if it's real-time
      if (editing?.id === record.id) {
        setEditing({ ...editing, agreementIntelligence: data.intelligence });
        setForm({ ...form, agreementIntelligence: data.intelligence });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAnalyzeReply = async () => {
    if (!replyText || !selected) return;

    setAnalyzingReply(true);
    setNegotiationAnalysis(null);
    try {
      const apiKey = ""; // AI key is managed server-side via GEMINI_API_KEY.
      const model = localStorage.getItem("genai.model") || DEFAULT_AI_MODEL;

      const res = await fetch("/api/ai/analyze-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replyText,
          partnerName: selected.organizationName,
          history: selected.interactionHistory,
          strategicContext: selected.strategicContext,
          apiKey,
          model
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");

      setNegotiationAnalysis(data);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setAnalyzingReply(false);
    }
  };

  const saveNegotiationToHistory = async () => {
    if (!selected || !negotiationAnalysis || !replyText || !selected.id) return;

    setSavingNegotiation(true);
    try {
      const note = `[NEGOTIATION COPILOT]\nTheir Reply: "${replyText}"\n\nDiagnosis: ${negotiationAnalysis.diagnosis}\nStrategy: ${negotiationAnalysis.strategy_applied}\n\nSuggested Response:\n${negotiationAnalysis.suggested_response}`;

      const history = selected.interactionHistory || [];
      const newHistory = [
        ...history,
        {
          note,
          author: "AI Copilot",
          timestamp: serverTimestamp()
        }
      ];

      await updatePartner(db, selected.id, { interactionHistory: newHistory });

      // Update local state (optimistic)
      // Note: The real-time listener will eventually update this, but for immediate feedback:
      setSelected({ ...selected, interactionHistory: newHistory as any });

      toast({ title: "Logged", description: "Negotiation analysis logged to history." });
    } catch (e: any) {
      console.error("Log negotiation error:", e);
      toast({ title: "Error", description: `Failed to log negotiation: ${e.message}`, variant: "destructive" });
    } finally {
      setSavingNegotiation(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: "Text copied to clipboard." });
  };

  const openNegotiation = () => {
    if (!selected) return;
    setReplyText("");
    setNegotiationAnalysis(null);
    setNegotiationOpen(true);
  };

  return (
    <AuthorizationGate permission="canManageSponsorsPartners">
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-glow mb-2">Sponsors & Partners</h1>
          <p className="text-muted-foreground">Centralized management of strategic relationships. Superadmin-only access.</p>
        </div>

        <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader className="flex items-center justify-between">
            <div>
              <CardTitle>Organizations</CardTitle>
              <CardDescription>Sortable, filterable list with at-a-glance details.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={async () => {
                try {
                  const res = await fetch('/api/admin/partners/export');
                  if (!res.ok) throw new Error('Export failed');
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'partners.csv';
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (e: any) {
                  toast({ title: 'Error', description: e?.message || 'Failed to export CSV', variant: 'destructive' });
                }
              }}>Export to CSV</Button>
              <Button onClick={openCreate}>
                <PlusCircle className="h-4 w-4 mr-2" /> Add Organization
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading && (
              <div className="h-24 flex items-center justify-center text-muted-foreground">Loading…</div>
            )}
            <div className="flex flex-wrap gap-3 mb-4">
              <div className="w-48">
                <Label>Status</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__ALL__">All</SelectItem>
                    {STATUS_OPTIONS
                      .filter((s) => s && String(s).trim() !== "")
                      .map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-64">
                <Label>Relationship Type</Label>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__ALL__">All</SelectItem>
                    {RELATIONSHIP_TYPES
                      .filter((t) => t && String(t).trim() !== "")
                      .map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <Label>Search</Label>
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Organization or contact" />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">Logo</TableHead>
                      <TableHead>Organization</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead>Pledged</TableHead>
                      <TableHead>Primary Contact</TableHead>
                      <TableHead className="text-center">AI Ready</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow><TableCell colSpan={7} className="h-24 text-center">Loading…</TableCell></TableRow>
                    ) : filtered && filtered.length > 0 ? (
                      filtered.map((p) => (
                        <TableRow key={p.id} onClick={() => setSelected(p)} className={selected?.id === p.id ? 'bg-primary/10' : ''}>
                          <TableCell>
                            {p.logoUrl ? (
                              <Image src={p.logoUrl} alt={p.organizationName} width={32} height={32} className="w-8 h-8 object-contain rounded bg-white" />
                            ) : (
                              <div className="w-8 h-8 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">?</div>
                            )}
                          </TableCell>
                          <TableCell className="font-medium">{p.organizationName}</TableCell>
                          <TableCell>{p.status}</TableCell>
                          <TableCell>{p.relationshipType}</TableCell>
                          <TableCell>{p.sponsorshipTier || '—'}</TableCell>
                          <TableCell>{p.financials?.pledgedAmount ?? 0}</TableCell>
                          <TableCell>{p.primaryContact?.name || '—'}</TableCell>
                          <TableCell className="text-center">
                            {p.agreementIntelligence || p.strategicContext ? (
                              <Sparkles className="h-4 w-4 text-yellow-400 mx-auto" />
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right space-x-2">
                            <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                              <Edit className="h-4 w-4 mr-1" /> Edit
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => handleDelete(p.id)}>
                              <Trash className="h-4 w-4 mr-1" /> Delete
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={7} className="h-24 text-center">No organizations found.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="lg:col-span-1">
                <Card className="bg-muted/20">
                  <CardHeader>
                    <div className="flex items-center gap-4">
                      {selected?.logoUrl && (
                        <Image src={selected.logoUrl} alt={selected.organizationName} width={64} height={64} className="w-16 h-16 object-contain rounded border bg-white" />
                      )}
                      <div>
                        <CardTitle>Quick View</CardTitle>
                        <CardDescription>{selected ? selected.organizationName : 'Select a row to view details'}</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {selected && (
                      <div className="space-y-3">
                        <div className="text-sm">Status: {selected.status}</div>
                        <div className="text-sm">Type: {selected.relationshipType}</div>
                        <div className="text-sm">Tier: {selected.sponsorshipTier || '—'}</div>
                        <div className="text-sm">Pledged: {selected.financials?.pledgedAmount ?? 0}</div>
                        <div className="text-sm">Received: {selected.financials?.amountReceived ?? 0}</div>
                        <div className="text-sm">Agreement Date: {selected.financials?.agreementDate || '—'}</div>
                        <div className="text-sm">Contact: {selected.primaryContact?.name || '—'} {selected.primaryContact?.email ? `• ${selected.primaryContact?.email}` : ''}</div>
                        <div className="text-sm">Website: {selected.website || '—'}</div>
                        <div className="text-sm">Contract: {selected.agreementContractUrl || '—'}</div>
                        <div className="text-sm">
                          <strong>Associated Events:</strong>
                          {selected.associatedEventIds && selected.associatedEventIds.length > 0 ? (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {selected.associatedEventIds.map(id => {
                                const evt = events?.find((e: any) => e.id === id);
                                return <Badge key={id} variant="outline">{evt?.title || 'Unknown Event'}</Badge>;
                              })}
                            </div>
                          ) : ' —'}
                        </div>
                        {selected.agreementIntelligence && (
                          <div className="border rounded p-2 bg-accent/10">
                            <div className="font-semibold mb-1">Agreement Intelligence</div>
                            <div className="text-xs space-y-1">
                              <div><strong>Key Clauses:</strong> {selected.agreementIntelligence.key_clauses?.length} found</div>
                              <div><strong>Deliverables:</strong> {selected.agreementIntelligence.deliverables_promised?.length} items</div>
                            </div>
                          </div>
                        )}
                        {selected.strategicContext && (
                          <div className="border rounded p-2 bg-blue-500/10 border-blue-500/20">
                            <div className="font-semibold mb-1 text-blue-400">Strategic Context</div>
                            <div className="text-xs italic line-clamp-3" title={selected.strategicContext}>
                              &quot;{selected.strategicContext}&quot;
                            </div>
                          </div>
                        )}
                        <div className="space-y-2">
                          <Label>Log New Interaction</Label>
                          <Textarea value={newInteractionNote} onChange={(e) => setNewInteractionNote(e.target.value)} />
                          <Button size="sm" onClick={logInteraction}>Log</Button>
                          <Button size="sm" variant="secondary" onClick={openNegotiation} className="w-full mt-2">
                            <BrainCircuit className="h-4 w-4 mr-2 text-purple-500" /> Open Negotiation Copilot
                          </Button>
                        </div>
                        <div>
                          <Label>Activity Feed</Label>
                          <div className="border rounded-md p-2 h-40 overflow-auto">
                            {selected.interactionHistory && selected.interactionHistory.length > 0 ? (
                              [...selected.interactionHistory].slice().reverse().map((it, idx) => (
                                <div key={idx} className="text-sm py-1">
                                  <div className="font-medium">{it.author || '—'}</div>
                                  <div>{it.note}</div>
                                </div>
                              ))
                            ) : (
                              <div className="text-sm text-muted-foreground">No interactions logged.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </CardContent>
        </Card>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="sm:max-w-[700px]">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Organization" : "Add Organization"}</DialogTitle>
              <DialogDescription>
                Enter required details. Files (logo/contract) use URL fields for now; storage integration can follow.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
              <div className="md:col-span-2">
                <Label>Organization Name</Label>
                <Input
                  value={form.organizationName}
                  onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
                  placeholder="e.g., SpaceTech Labs"
                />
              </div>

              <div>
                <Label>Relationship Type</Label>
                <Select
                  value={form.relationshipType}
                  onValueChange={(v) => setForm({ ...form, relationshipType: v as any })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RELATIONSHIP_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as any })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Sponsorship Tier (if Sponsor)</Label>
                <Select
                  value={form.sponsorshipTier ?? "none"}
                  onValueChange={(v) =>
                    setForm({ ...form, sponsorshipTier: (v === "none" ? undefined : (v as any)) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {SPONSORSHIP_TIERS
                      .filter((t) => t && String(t).trim() !== "")
                      .map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Website (URL)</Label>
                <Input
                  value={form.website || ""}
                  onChange={(e) => setForm({ ...form, website: e.target.value })}
                  placeholder="https://example.com"
                />
              </div>

              <div>
                <Label>Logo URL</Label>
                <Input
                  value={form.logoUrl || ""}
                  onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                  placeholder="https://.../logo.png"
                />
              </div>

              <div>
                <Label>Agreement Contract URL (PDF)</Label>
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Input
                      value={form.agreementContractUrl || ""}
                      onChange={(e) => setForm({ ...form, agreementContractUrl: e.target.value })}
                      placeholder="https://.../contract.pdf"
                    />
                    {editing?.id && form.agreementContractUrl && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleAnalyze(editing)}
                        disabled={analyzing}
                      >
                        {analyzing ? "Analyzing..." : "Analyze"}
                      </Button>
                    )}
                  </div>
                  <Textarea
                    placeholder="Paste relevant history, context, or 'word on the street' here. This will be saved and used by the AI for all future pitches and negotiations."
                    value={form.strategicContext || ""}
                    onChange={(e) => setForm({ ...form, strategicContext: e.target.value })}
                    className="h-24 text-xs font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    * Saved to &quot;Strategic Context&quot;. Used for Analysis, Pitch Generation, and Negotiation.
                  </p>
                </div>
              </div>

              <div>
                <Label>Primary Contact Name</Label>
                <Input
                  value={form.primaryContact?.name || ""}
                  onChange={(e) => setForm({ ...form, primaryContact: { ...form.primaryContact, name: e.target.value } })}
                />
              </div>
              <div>
                <Label>Primary Contact Email</Label>
                <Input
                  type="email"
                  value={form.primaryContact?.email || ""}
                  onChange={(e) => setForm({ ...form, primaryContact: { ...form.primaryContact, email: e.target.value } })}
                />
              </div>
              <div>
                <Label>Primary Contact Phone</Label>
                <Input
                  value={form.primaryContact?.phone || ""}
                  onChange={(e) => setForm({ ...form, primaryContact: { ...form.primaryContact, phone: e.target.value } })}
                />
              </div>
              <div>
                <Label>Primary Contact Role</Label>
                <Input
                  value={form.primaryContact?.role || ""}
                  onChange={(e) => setForm({ ...form, primaryContact: { ...form.primaryContact, role: e.target.value } })}
                />
              </div>

              <div>
                <Label>Pledged Amount</Label>
                <Input
                  type="number"
                  value={form.financials?.pledgedAmount?.toString() || ""}
                  onChange={(e) => setForm({ ...form, financials: { ...form.financials, pledgedAmount: Number(e.target.value || 0) } })}
                />
              </div>
              <div>
                <Label>Amount Received</Label>
                <Input
                  type="number"
                  value={form.financials?.amountReceived?.toString() || ""}
                  onChange={(e) => setForm({ ...form, financials: { ...form.financials, amountReceived: Number(e.target.value || 0) } })}
                />
              </div>
              <div>
                <Label>Agreement Date</Label>
                <Input
                  type="date"
                  value={form.financials?.agreementDate || ""}
                  onChange={(e) => setForm({ ...form, financials: { ...form.financials, agreementDate: e.target.value } })}
                />
              </div>

              <div className="md:col-span-2">
                <Label>Interaction History</Label>
                <Textarea
                  value={Array.isArray(form.interactionHistory)
                    ? form.interactionHistory.map(it => `${it.author || '—'}: ${it.note}`).join('\n')
                    : String(form.interactionHistory || '')}
                  onChange={(e) => setForm({
                    ...form,
                    interactionHistory: e.target.value
                      ? [{ note: e.target.value }]
                      : []
                  })}
                  placeholder="Running log (meetings, calls, emails)"
                />
              </div>
              <div className="md:col-span-2">
                <Label>Integration Points</Label>
                <Textarea
                  value={form.integrationPoints || ""}
                  onChange={(e) => setForm({ ...form, integrationPoints: e.target.value })}
                  placeholder="e.g., Logo on T-shirt, featured blog posts, event mentions"
                />
              </div>

              <div className="md:col-span-2">
                <Label>Associated Events</Label>
                <MultiSelect
                  options={eventOptions}
                  selected={form.associatedEventIds || []}
                  onSelectedChange={(selected) => setForm({ ...form, associatedEventIds: selected })}
                  placeholder="Select events..."
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave}>{editing ? "Save Changes" : "Create"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Negotiation Dialog */}
        {negotiationOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
            <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-background border-primary/20 shadow-2xl">
              <CardHeader className="sticky top-0 bg-background z-10 border-b">
                <div className="flex justify-between items-center">
                  <CardTitle className="flex items-center gap-2">
                    <BrainCircuit className="h-5 w-5 text-purple-500" />
                    Negotiation Copilot: {selected?.organizationName}
                  </CardTitle>
                  <Button variant="ghost" size="icon" onClick={() => setNegotiationOpen(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <CardDescription>
                  Paste their email/reply below. The AI will diagnose the barrier and craft a strategic counter-move.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-6">
                <div className="space-y-2">
                  <Label>Their Reply</Label>
                  <Textarea
                    placeholder="Paste the email or message you received..."
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    className="h-32"
                  />
                </div>

                <Button
                  onClick={handleAnalyzeReply}
                  disabled={analyzingReply || !replyText}
                  className="w-full"
                >
                  {analyzingReply ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Diagnosing Barrier...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" /> Analyze & Generate Counter-Move
                    </>
                  )}
                </Button>

                {negotiationAnalysis && (
                  <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                        <h4 className="font-bold text-red-500 text-sm uppercase mb-1">Diagnosis</h4>
                        <p className="text-sm">{negotiationAnalysis.diagnosis}</p>
                      </div>
                      <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                        <h4 className="font-bold text-green-500 text-sm uppercase mb-1">Strategy Applied</h4>
                        <p className="text-sm">{negotiationAnalysis.strategy_applied}</p>
                      </div>
                    </div>

                    <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                      <h4 className="font-bold text-blue-500 text-sm uppercase mb-1 flex items-center gap-2">
                        <Lightbulb className="h-4 w-4" /> Coaching Tip
                      </h4>
                      <p className="text-sm italic">{negotiationAnalysis.coaching_tip}</p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <Label>Suggested Response</Label>
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => copyToClipboard(negotiationAnalysis.suggested_response)}>
                            <Copy className="h-4 w-4 mr-2" /> Copy
                          </Button>
                          <Button size="sm" variant="outline" onClick={saveNegotiationToHistory} disabled={savingNegotiation}>
                            {savingNegotiation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                            Log to History
                          </Button>
                        </div>
                      </div>
                      <div
                        className="p-4 rounded-md border bg-muted/30 font-mono text-sm whitespace-pre-wrap"
                        dangerouslySetInnerHTML={{ __html: negotiationAnalysis.suggested_response.replace(/\n/g, '<br/>') }}
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </AuthorizationGate>
  );
}
