"use client";

import React, { useEffect, useState } from "react";
import { useFirestore } from "@/firebase";
import {
  RELATIONSHIP_TYPES,
  STATUS_OPTIONS,
  SPONSORSHIP_TIERS,
  type PartnerRecord,
  createPartner,
  updatePartner,
  deletePartner,
} from "@/lib/partners";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { extractTextFromPdf } from "@/lib/pdf-utils";
import { Trash } from "lucide-react";
import { MultiSelect } from "@/components/ui/multi-select";
import { Checkbox } from "@/components/ui/checkbox";
import { ConsentRequestPicker } from "@/components/admin/governance/consent-request-picker";
import { ConsentRequiredDialog } from "@/components/admin/governance/consent-required-dialog";
import { isConsentGateBlocked, type ConsentGateErrorBody } from "@/lib/client/consent-gate-error";
import type { ConsentSubjectRef } from "@/lib/server/consent-gate-types";

// Default AI model for server-routed AI calls. The admin model preference
// is stored in the browser under "genai.model" (not a secret).
const DEFAULT_AI_MODEL = "gemini-2.5-flash";

const EMPTY_FORM: PartnerRecord = {
  organizationName: "",
  relationshipType: "Sponsor",
  status: "Prospect",
  sponsorshipTier: undefined,
  primaryContact: {},
  financials: {},
  agreementIntelligence: undefined,
  integrationPoints: "",
  associatedEventIds: [],
};

function historyToText(record: PartnerRecord | null): string {
  if (!record || !Array.isArray(record.interactionHistory)) return "";
  return record.interactionHistory.map(it => `${it.author || '—'}: ${it.note}`).join('\n');
}

/**
 * Full organisation create/edit form for sponsors_partners records.
 * Ported from the retired /admin/sponsors-partners page into the CRM
 * Console: full org fields, agreement-PDF AI analysis, delete, and the
 * flagged-record Founder Consent save flow (spec B.6). All writes go
 * through createPartner/updatePartner/deletePartner -> /api/admin/partners.
 */
export function PartnerFormDialog({
  open,
  onOpenChange,
  record,
  eventOptions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  record: PartnerRecord | null;
  eventOptions: { label: string; value: string }[];
}) {
  const db = useFirestore();
  const { toast } = useToast();
  const editing = record;

  const [form, setForm] = useState<PartnerRecord>(EMPTY_FORM);
  const [historyText, setHistoryText] = useState("");
  const [initialHistoryText, setInitialHistoryText] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  // Phase 2 consent flow (spec B.6): flagged saves collect Founder Consent.
  const [partnerConsentOpen, setPartnerConsentOpen] = useState(false);
  const [partnerConsentId, setPartnerConsentId] = useState<string | null>(null);
  const [gateBlock, setGateBlock] = useState<ConsentGateErrorBody | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        ...editing,
        integrationPoints: editing.integrationPoints || "",
        sponsorshipTier: editing.sponsorshipTier || undefined,
        associatedEventIds: editing.associatedEventIds || [],
      });
      const text = historyToText(editing);
      setHistoryText(text);
      setInitialHistoryText(text);
    } else {
      setForm(EMPTY_FORM);
      setHistoryText("");
      setInitialHistoryText("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const partnerConsentSubject: ConsentSubjectRef = editing?.id
    ? {
        type: "partner_record",
        recordId: editing.id,
        collection: "sponsors_partners",
        action: "update",
      }
    : {
        type: "partner_record",
        recordId: null,
        organizationName: form.organizationName,
        collection: "sponsors_partners",
        action: "create",
      };

  const handleSave = async (consentRequestId?: string | null) => {
    // Phase 2 (spec B.3c.4): saving a record whose resulting state is
    // flagged collects Founder Consent first. The sponsor_partner_flagged
    // matter ships in record mode, so this is audit-first by design.
    const resultingFlagged = form.isRelatedParty === true || form.carriesConditions === true;
    if (resultingFlagged && !consentRequestId) {
      setPartnerConsentId(null);
      setPartnerConsentOpen(true);
      return;
    }
    // Only send interactionHistory when the admin actually edited it:
    // the legacy textarea round-trip collapses the whole history into a
    // single note, so an untouched field must not clobber stored entries.
    const payload: PartnerRecord = { ...form };
    if (historyText !== initialHistoryText) {
      payload.interactionHistory = historyText ? [{ note: historyText }] : [];
    } else if (!editing) {
      payload.interactionHistory = [];
    } else {
      delete payload.interactionHistory;
    }
    try {
      if (editing?.id) {
        await updatePartner(db, editing.id, payload, { consentRequestId: consentRequestId ?? null });
        toast({ title: "Updated", description: "Organization updated successfully." });
      } else {
        const id = await createPartner(db, payload, { consentRequestId: consentRequestId ?? null });
        toast({ title: "Created", description: `Organization created (ID: ${id}).` });
      }
      onOpenChange(false);
    } catch (e: any) {
      if (isConsentGateBlocked(e)) {
        setGateBlock(e.body);
        return;
      }
      toast({ title: "Error", description: e?.message || "Failed to save record.", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!editing?.id) return;
    const ok = window.confirm("Delete this organization? This cannot be undone.");
    if (!ok) return;
    try {
      await deletePartner(db, editing.id);
      toast({ title: "Deleted", description: "Organization removed." });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Failed to delete record.", variant: "destructive" });
    }
  };

  const handleAnalyze = async () => {
    if (!editing?.id || !editing.agreementContractUrl) {
      toast({ title: "Error", description: "Save the partner and add a contract URL first.", variant: "destructive" });
      return;
    }
    setAnalyzing(true);
    try {
      const apiKey = ""; // AI key is managed server-side via GEMINI_API_KEY.
      const model = localStorage.getItem("genai.model") || DEFAULT_AI_MODEL;

      // Extract text client-side to bypass server restrictions
      const agreementText = await extractTextFromPdf(editing.agreementContractUrl!);

      const res = await fetch("/api/admin/partners/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerId: editing.id,
          agreementText,
          apiKey,
          model,
          context: form.strategicContext // Send the manual context
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");

      toast({ title: "Success", description: "Agreement analyzed successfully." });
      setForm({ ...form, agreementIntelligence: data.intelligence });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
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
                      onClick={handleAnalyze}
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
                value={historyText}
                onChange={(e) => setHistoryText(e.target.value)}
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

            {/* Phase 2 governance flags (Finance Policy s.7; spec B.3c.4).
                Flagged records are Reserved Matters: saving one collects
                Founder Consent. */}
            <div className="md:col-span-2 space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <Label className="text-amber-400">Governance Flags</Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="partner-related-party"
                  checked={form.isRelatedParty === true}
                  onCheckedChange={(checked) => setForm({ ...form, isRelatedParty: checked === true })}
                />
                <Label htmlFor="partner-related-party" className="font-normal">
                  Related-party arrangement (a SEDS officer, the Founder, a Governor, or their families or businesses are on the other side)
                </Label>
              </div>
              {form.isRelatedParty === true && (
                <div>
                  <Label>Related-Party Nature</Label>
                  <Input
                    value={form.relatedPartyNature || ""}
                    onChange={(e) => setForm({ ...form, relatedPartyNature: e.target.value })}
                    placeholder="e.g., Sponsor employs the National Treasurer"
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <Checkbox
                  id="partner-carries-conditions"
                  checked={form.carriesConditions === true}
                  onCheckedChange={(checked) => setForm({ ...form, carriesConditions: checked === true })}
                />
                <Label htmlFor="partner-carries-conditions" className="font-normal">
                  Carries conditions or deliverables promised
                </Label>
              </div>
              {(form.isRelatedParty === true || form.carriesConditions === true) && (
                <p className="text-xs text-amber-400">
                  This record is flagged: saving it requires Founder Consent
                  under the sponsor/partner Reserved Matter.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            {editing?.id && (
              <Button variant="destructive" onClick={handleDelete} className="mr-auto">
                <Trash className="h-4 w-4 mr-1" /> Delete
              </Button>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => handleSave()}>{editing ? "Save Changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phase 2: Founder Consent collection for flagged saves (spec B.6) */}
      <Dialog open={partnerConsentOpen} onOpenChange={setPartnerConsentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Founder Consent Required</DialogTitle>
            <DialogDescription>
              This sponsor/partner record is flagged (related party or carries
              conditions), a Reserved Matter. Select the decided Founder
              Consent for this record, or file a request first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <ConsentRequestPicker
              matterKey="sponsor_partner_flagged"
              subjectRef={partnerConsentSubject}
              value={partnerConsentId}
              onChange={setPartnerConsentId}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setPartnerConsentOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  setPartnerConsentOpen(false);
                  await handleSave(partnerConsentId);
                }}
              >
                Save With Consent
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <ConsentRequiredDialog
        open={!!gateBlock}
        body={gateBlock}
        onClose={() => setGateBlock(null)}
      />
    </>
  );
}
