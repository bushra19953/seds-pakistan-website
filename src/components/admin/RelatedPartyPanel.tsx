'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';

/**
 * Related-party register panel (spec Part C 5.3, CH-19). Shared by the CRM
 * detail sheet and the sponsors-partners quick view so both surfaces edit
 * the same register fields through the same API.
 *
 * The Founder Consent date is DISPLAY ONLY: it is derived server-side
 * from the linked consent_requests record (Phase 2 adapter); there is
 * deliberately no date input for it. Money fields are not edited here:
 * they route through the approvals flow (crm_financial_edit). Activation
 * to Active routes through crm_status_active, which re-runs this gate
 * server-side at approval time.
 */

interface GateState {
  canActivate: boolean;
  missing: string[];
  founderConsentDate: string | null;
  triggerValuePkr: number;
}

interface DisclosureState {
  disclosedTo: string;
  disclosureDate: string;
  natureSummary: string;
  extentSummary: string;
  valueSummary: string;
}

interface BenchmarkingState {
  method: 'two_quotes' | 'written_justification';
  quotes: string;
  justification: string;
  boardReviewedAt: string;
}

const CHANNELS: Record<number, string> = {
  1: '1 - Executive Director remuneration',
  2: '2 - Platform / technical services',
  3: '3 - Facilities / equipment leases',
  4: '4 - Professional / advisory fees',
  5: '5 - IP / brand licensing',
};

export function RelatedPartyPanel({ partnerId, status }: { partnerId: string; status?: string }) {
  const { user } = useUser();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [isRelatedParty, setIsRelatedParty] = useState(false);
  const [isFounderEntity, setIsFounderEntity] = useState(false);
  const [channel, setChannel] = useState<string>('');
  const [consentRequestId, setConsentRequestId] = useState('');
  const [agreementRef, setAgreementRef] = useState('');
  const [boardApprovalDate, setBoardApprovalDate] = useState('');
  const [disclosure, setDisclosure] = useState<DisclosureState>({
    disclosedTo: 'national_general_secretary',
    disclosureDate: '',
    natureSummary: '',
    extentSummary: '',
    valueSummary: '',
  });
  const [benchmarking, setBenchmarking] = useState<BenchmarkingState>({
    method: 'two_quotes',
    quotes: '',
    justification: '',
    boardReviewedAt: '',
  });
  const [benchmarkingRequired, setBenchmarkingRequired] = useState(false);
  const [gate, setGate] = useState<GateState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user || !partnerId) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/partners/related-party?id=${encodeURIComponent(partnerId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setIsRelatedParty(data.isRelatedParty === true);
      setIsFounderEntity(data.isFounderCommercialEntity === true);
      const rp = data.relatedParty;
      if (rp) {
        setChannel(rp.channel ? String(rp.channel) : '');
        setConsentRequestId(rp.consentRequestId ?? '');
        setAgreementRef(rp.agreementRef ?? '');
        setBoardApprovalDate(rp.boardApprovalDate ?? '');
        if (rp.disclosure) {
          setDisclosure({
            disclosedTo: rp.disclosure.disclosedTo ?? 'national_general_secretary',
            disclosureDate: rp.disclosure.disclosureDate ?? '',
            natureSummary: rp.disclosure.natureSummary ?? '',
            extentSummary: rp.disclosure.extentSummary ?? '',
            valueSummary: rp.disclosure.valueSummary ?? '',
          });
        }
        if (rp.benchmarking) {
          setBenchmarking({
            method: rp.benchmarking.method ?? 'two_quotes',
            quotes: Array.isArray(rp.benchmarking.quoteDriveIds) ? rp.benchmarking.quoteDriveIds.join(', ') : '',
            justification: rp.benchmarking.justification ?? '',
            boardReviewedAt: rp.benchmarking.boardReviewedAt ?? '',
          });
        }
      }
      setBenchmarkingRequired((data.gate?.triggerValuePkr ?? 0) > 100000);
      setGate(data.gate ?? null);
    } finally {
      setLoading(false);
    }
  }, [user, partnerId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (changes: Record<string, unknown>) => {
    if (!user) return;
    setSaving(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/partners/related-party', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: partnerId, changes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      toast({ title: 'Related-party record updated' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Save failed', description: e instanceof Error ? e.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const saveDisclosure = () => save({ 'relatedParty.disclosure': disclosure });
  const saveBenchmarking = () =>
    save({
      'relatedParty.benchmarking': {
        contractValuePkr: gate?.triggerValuePkr ?? 0,
        method: benchmarking.method,
        quoteDriveIds: benchmarking.quotes.split(',').map((s) => s.trim()).filter(Boolean),
        justification: benchmarking.justification,
        boardReviewedAt: benchmarking.boardReviewedAt || null,
      },
    });

  const requestActivation = async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/finance/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          targetType: 'crm_status_active',
          targetId: partnerId,
          changePayload: { fromStatus: status ?? null, toStatus: 'Active' },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      toast({ title: 'Activation requested', description: 'A checker will run the related-party gate at approval time.' });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Request failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading related-party record…</div>;

  return (
    <div className="space-y-3 border rounded-md p-3">
      <div className="font-semibold text-sm">Related Party Register (CH-19)</div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`rp-flag-${partnerId}`}
          checked={isRelatedParty}
          disabled={saving}
          onChange={(e) => {
            setIsRelatedParty(e.target.checked);
            save({ isRelatedParty: e.target.checked });
          }}
        />
        <Label htmlFor={`rp-flag-${partnerId}`}>This counterparty is a related party</Label>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`rp-founder-${partnerId}`}
          checked={isFounderEntity}
          disabled={saving}
          onChange={(e) => {
            setIsFounderEntity(e.target.checked);
            save({ isFounderCommercialEntity: e.target.checked });
          }}
        />
        <Label htmlFor={`rp-founder-${partnerId}`}>Founder commercial entity</Label>
      </div>

      {isRelatedParty && (
        <div className="space-y-4">
          <div>
            <Label>Channel (Policy sec. 4)</Label>
            <Select
              value={channel}
              onValueChange={(v) => {
                setChannel(v);
                save({ 'relatedParty.channel': Number(v) });
              }}
            >
              <SelectTrigger><SelectValue placeholder="Select channel" /></SelectTrigger>
              <SelectContent>
                {Object.entries(CHANNELS).map(([n, label]) => (
                  <SelectItem key={n} value={n}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Consent request ID (Founder Consent)</Label>
            <Input
              value={consentRequestId}
              onChange={(e) => setConsentRequestId(e.target.value)}
              onBlur={() => save({ 'relatedParty.consentRequestId': consentRequestId || null })}
              placeholder="consent_requests document id"
            />
          </div>
          <div>
            <Label>Agreement reference (Exhibit A)</Label>
            <Input
              value={agreementRef}
              onChange={(e) => setAgreementRef(e.target.value)}
              onBlur={() => save({ 'relatedParty.agreementRef': agreementRef })}
              placeholder="Drive link or document reference"
            />
          </div>
          <div className="text-sm">
            Founder Consent date:{' '}
            <span className="font-mono">{gate?.founderConsentDate ?? 'not derived (no decided consent linked)'}</span>
            <span className="block text-xs text-muted-foreground">Derived from the consent record. It cannot be typed in.</span>
          </div>

          <div className="border-t pt-2 space-y-2">
            <div className="text-sm font-medium">Written disclosure (RP-04, to the National General Secretary)</div>
            <div>
              <Label>Disclosure date</Label>
              <Input type="date" value={disclosure.disclosureDate} onChange={(e) => setDisclosure((s) => ({ ...s, disclosureDate: e.target.value }))} />
            </div>
            <div>
              <Label>Nature of the interest</Label>
              <Input value={disclosure.natureSummary} onChange={(e) => setDisclosure((s) => ({ ...s, natureSummary: e.target.value }))} />
            </div>
            <div>
              <Label>Extent of the interest</Label>
              <Input value={disclosure.extentSummary} onChange={(e) => setDisclosure((s) => ({ ...s, extentSummary: e.target.value }))} />
            </div>
            <div>
              <Label>Commercial value summary</Label>
              <Input value={disclosure.valueSummary} onChange={(e) => setDisclosure((s) => ({ ...s, valueSummary: e.target.value }))} />
            </div>
            <Button size="sm" variant="outline" disabled={saving} onClick={saveDisclosure}>Save disclosure</Button>
          </div>

          {benchmarkingRequired && (
            <div className="border-t pt-2 space-y-2">
              <div className="text-sm font-medium">Benchmarking (RP-05, required above PKR 100,000)</div>
              <div>
                <Label>Method</Label>
                <Select value={benchmarking.method} onValueChange={(v) => setBenchmarking((s) => ({ ...s, method: v as BenchmarkingState['method'] }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="two_quotes">Two independent quotes</SelectItem>
                    <SelectItem value="written_justification">Written justification (50+ characters)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {benchmarking.method === 'two_quotes' ? (
                <div>
                  <Label>Quote Drive IDs (comma separated, at least two)</Label>
                  <Input value={benchmarking.quotes} onChange={(e) => setBenchmarking((s) => ({ ...s, quotes: e.target.value }))} />
                </div>
              ) : (
                <div>
                  <Label>Justification</Label>
                  <Input value={benchmarking.justification} onChange={(e) => setBenchmarking((s) => ({ ...s, justification: e.target.value }))} />
                </div>
              )}
              <div>
                <Label>Board review date</Label>
                <Input type="date" value={benchmarking.boardReviewedAt} onChange={(e) => setBenchmarking((s) => ({ ...s, boardReviewedAt: e.target.value }))} />
              </div>
              <Button size="sm" variant="outline" disabled={saving} onClick={saveBenchmarking}>Save benchmarking</Button>
              <div>
                <Label>Board approval date</Label>
                <Input
                  type="date"
                  value={boardApprovalDate}
                  onChange={(e) => setBoardApprovalDate(e.target.value)}
                  onBlur={() => save({ 'relatedParty.boardApprovalDate': boardApprovalDate || null })}
                />
              </div>
            </div>
          )}

          <div className="border-t pt-2">
            <div className="text-sm font-medium mb-1">Activation gate</div>
            {gate?.canActivate ? (
              <div className="text-sm text-green-500">All gate items satisfied.</div>
            ) : (
              <ul className="list-disc ml-5 text-sm text-amber-500">
                {(gate?.missing ?? []).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            {status !== 'Active' && (
              <Button size="sm" className="mt-2" onClick={requestActivation}>
                Request activation (approvals flow)
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
