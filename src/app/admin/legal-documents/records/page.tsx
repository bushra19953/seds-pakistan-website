'use client';

// Governance Records admin (Workstream D, spec 5.1). Thin client over
// /api/admin/governance-records: every rule (defaults, redaction
// guard, consent gate, status machine) is enforced server-side; this
// page renders state and surfaces server error text verbatim,
// especially the 422 consent/redaction responses an approver must see.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Download, Eye, FileWarning, Paperclip, Plus, RefreshCw } from 'lucide-react';

interface GovRecord {
  recordId: string;
  familyId: string;
  series: string;
  layer: number | null;
  title: string;
  version: number;
  status: string;
  adoptionStatus: string;
  effectiveStatus: string;
  accessLevel: string;
  redactionStatus: string;
  recordDate: string;
  fileName: string | null;
  sha256: string | null;
  hasFile: boolean;
  consentId: string | null;
}

const SERIES_OPTIONS = [
  'constitution_suite', 'policy', 'mou', 'minutes', 'resolution',
  'registrar_filing', 'fbr_receipt', 'benchmarking_pack', 'charter',
  'acceptance_letter', 'consent_record', 'other',
];

// Spec 6.1 seed families (the 10 governance documents). The checklist
// is a UI aid for the manual seeding act; presence is matched by slug
// against the families actually in the store. Seeding itself is done
// by creating each family's v1 here, one at a time, checked.
const SEED_FAMILIES = [
  { slug: 'master-architecture', series: 'constitution_suite', label: '00 Master Architecture' },
  { slug: 'constitution', series: 'constitution_suite', label: '01 Constitution' },
  { slug: 'role-catalog', series: 'policy', label: '02 Role Catalog' },
  { slug: 'reserved-powers-schedule', series: 'policy', label: '03 Reserved Powers Schedule' },
  { slug: 'decision-rights-schedule', series: 'policy', label: '04 Decision Rights Schedule' },
  { slug: 'finance-related-party-ip-policy', series: 'policy', label: '05 Finance / Related Party / IP Policy' },
  { slug: 'seds-earth-mou', series: 'mou', label: '06 SEDS Earth MOU' },
  { slug: 'procedure-manual', series: 'policy', label: '07 Procedure Manual' },
  { slug: 'annual-compliance-calendar', series: 'policy', label: '08 Annual Compliance Calendar' },
  { slug: 'build-checklist-implementation-roadmap', series: 'policy', label: '09 Build Checklist / Implementation Roadmap' },
];

export default function GovernanceRecordsPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [records, setRecords] = useState<GovRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [seriesFilter, setSeriesFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [accessFilter, setAccessFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GovRecord | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);

  // New record form state.
  const [form, setForm] = useState({
    mode: 'family' as 'family' | 'version',
    slug: '',
    series: 'constitution_suite',
    layer: '',
    familyId: '',
    title: '',
    recordDate: '',
    redactionStatus: 'UNREDACTED_DO_NOT_PUBLISH',
  });

  // Transition panel state.
  const [transition, setTransition] = useState({
    status: '',
    accessLevel: '',
    redactionStatus: '',
    consentId: '',
    reason: '',
  });

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await user?.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers || {}),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      return data;
    },
    [user],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (seriesFilter !== 'all') params.set('series', seriesFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (accessFilter !== 'all') params.set('accessLevel', accessFilter);
      if (query) params.set('q', query);
      const data = await api(`/api/admin/governance-records?${params}`);
      setRecords(data.records || []);
    } catch (e: any) {
      toast({ title: 'Could not load records', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [api, seriesFilter, statusFilter, accessFilter, query, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const families = useMemo(() => {
    const map = new Map<string, GovRecord[]>();
    for (const r of records) {
      const list = map.get(r.familyId) || [];
      list.push(r);
      map.set(r.familyId, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.version - a.version);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [records]);

  const seededSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const familyId of families.map(([f]) => f)) {
      const parts = familyId.split('-');
      slugs.add(parts.slice(2).join('-'));
    }
    return slugs;
  }, [families]);

  const createRecord = async () => {
    setServerMessage(null);
    try {
      const body: Record<string, unknown> =
        form.mode === 'family'
          ? {
              slug: form.slug,
              series: form.series,
              layer: form.layer === '' ? null : Number(form.layer),
              title: form.title,
              parties: [],
              recordDate: form.recordDate,
              redactionStatus: form.redactionStatus,
            }
          : {
              familyId: form.familyId,
              title: form.title || undefined,
              recordDate: form.recordDate,
              redactionStatus: form.redactionStatus,
            };
      const data = await api('/api/admin/governance-records', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast({ title: 'Record created', description: data.record.recordId });
      await load();
    } catch (e: any) {
      setServerMessage(e.message);
    }
  };

  const attachFile = async (record: GovRecord, file: File) => {
    setServerMessage(null);
    try {
      const token = await user?.getIdToken();
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
      const initRes = await fetch('/api/uploads/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ kind: 'governance', fileName: file.name, sizeBytes: file.size }),
      });
      const init = await initRes.json();
      if (!initRes.ok) throw new Error(init.error || 'Upload initiation failed');
      const putRes = await fetch(init.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': init.mimeType },
        body: file,
      });
      if (!putRes.ok) throw new Error('Drive upload failed');
      const putBody = await putRes.json().catch(() => ({}));
      const driveFileId = putBody.id;
      if (!driveFileId) throw new Error('Drive did not return a file id');
      const completeRes = await fetch('/api/uploads/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ kind: 'governance', driveFileId, sizeBytes: file.size }),
      });
      const complete = await completeRes.json();
      if (!completeRes.ok) throw new Error(complete.error || 'Upload completion failed');
      await api(`/api/admin/governance-records/${record.recordId}/attach`, {
        method: 'POST',
        body: JSON.stringify({ driveFileId }),
      });
      toast({ title: 'File attached', description: `${file.name} hashed and attached to ${record.recordId}` });
      await load();
    } catch (e: any) {
      setServerMessage(e.message);
    }
  };

  const viewFile = async (record: GovRecord) => {
    const token = await user?.getIdToken();
    const res = await fetch(`/api/governance-records/${record.recordId}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setServerMessage(data.error || `File request failed (${res.status})`);
      return;
    }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  };

  const applyTransition = async () => {
    if (!selected) return;
    setServerMessage(null);
    const body: Record<string, unknown> = {};
    if (transition.status) body.status = transition.status;
    if (transition.accessLevel) body.accessLevel = transition.accessLevel;
    if (transition.redactionStatus) body.redactionStatus = transition.redactionStatus;
    if (transition.consentId) body.consentId = transition.consentId;
    if (transition.reason) {
      body.reason = transition.reason;
      body.appendReasonToNotes = true;
    }
    try {
      const data = await api(
        `/api/admin/governance-records/${selected.recordId}/transition`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      toast({ title: 'Transition applied', description: selected.recordId });
      setSelected(data.record);
      await load();
    } catch (e: any) {
      // 422 consent/redaction text is the officer's instruction; show verbatim.
      setServerMessage(e.message);
    }
  };

  const exportCsv = async () => {
    const token = await user?.getIdToken();
    const res = await fetch('/api/admin/governance-records/export', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'governance-records-export.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AuthorizationGate permission="canManageGovernanceRecords">
      <div className="container mx-auto py-8 px-4 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Governance Records</h1>
            <p className="text-muted-foreground mt-1">
              The versioned store of record for the constitution suite, policies, the SEDS Earth MOU,
              minutes, resolutions and filings. Files live in the private Drive governance folder and
              are served only through the access-checked file route.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className="h-4 w-4 mr-2" /> Refresh
            </Button>
            <Button variant="outline" onClick={exportCsv}>
              <Download className="h-4 w-4 mr-2" /> Export CSV
            </Button>
          </div>
        </div>

        {serverMessage && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">
            <FileWarning className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
            <span>{serverMessage}</span>
          </div>
        )}

        <Card>
          <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Select value={seriesFilter} onValueChange={setSeriesFilter}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Series" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All series</SelectItem>
                {SERIES_OPTIONS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {['draft', 'approved', 'effective', 'superseded', 'archived'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={accessFilter} onValueChange={setAccessFilter}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Access" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All access levels</SelectItem>
                {['officer_only', 'board_council', 'members', 'public'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input placeholder="Title starts with..." value={query} onChange={(e) => setQuery(e.target.value)} className="w-56" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Records by family</CardTitle></CardHeader>
          <CardContent className="space-y-6">
            {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {!loading && families.length === 0 && (
              <p className="text-sm text-muted-foreground">No records yet. Create the first family below.</p>
            )}
            {families.map(([familyId, versions]) => (
              <div key={familyId}>
                <h3 className="font-mono text-sm font-semibold mb-2">{familyId}</h3>
                <div className="space-y-2">
                  {versions.map((r) => (
                    <div key={r.recordId} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                      <span className="font-medium">{r.title}</span>
                      <Badge variant="outline">v{r.version}</Badge>
                      <Badge>{r.status}</Badge>
                      <Badge variant="secondary">{r.accessLevel}</Badge>
                      <Badge variant="outline">{r.effectiveStatus}</Badge>
                      {r.redactionStatus === 'UNREDACTED_DO_NOT_PUBLISH' ? (
                        <Badge className="bg-red-600 text-white">DO NOT PUBLISH - UNREDACTED</Badge>
                      ) : (
                        <Badge variant="outline">{r.redactionStatus}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{r.recordDate}</span>
                      <span className="text-xs font-mono text-muted-foreground">
                        {r.sha256 ? `sha256 ${r.sha256.slice(0, 12)}...` : 'no file'}
                      </span>
                      <div className="ml-auto flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => { setSelected(r); setTransition({ status: '', accessLevel: '', redactionStatus: '', consentId: r.consentId || '', reason: '' }); }}>
                          Manage
                        </Button>
                        {r.hasFile && (
                          <Button size="sm" variant="outline" onClick={() => viewFile(r)}>
                            <Eye className="h-4 w-4 mr-1" /> View file
                          </Button>
                        )}
                        {!r.hasFile && (
                          <label className="inline-flex cursor-pointer items-center rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                            <Paperclip className="h-4 w-4 mr-1" /> Attach file
                            <input
                              type="file"
                              className="hidden"
                              accept=".pdf,.docx,.doc,.png,.jpg,.jpeg,.webp"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) attachFile(r, f);
                                e.target.value = '';
                              }}
                            />
                          </label>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {selected && (
          <Card>
            <CardHeader>
              <CardTitle>Manage: {selected.recordId}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Status and access changes need the approve permission; redaction and consent changes need
                the manage permission. Approving or publishing a constitution-suite, policy or MOU record
                requires a decided Founder Consent id (FIN-01). The server enforces all of this; its
                response text appears above verbatim.
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <Label>Status</Label>
                  <Select value={transition.status || 'unchanged'} onValueChange={(v) => setTransition({ ...transition, status: v === 'unchanged' ? '' : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unchanged">Unchanged ({selected.status})</SelectItem>
                      {['approved', 'effective', 'archived'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Access level</Label>
                  <Select value={transition.accessLevel || 'unchanged'} onValueChange={(v) => setTransition({ ...transition, accessLevel: v === 'unchanged' ? '' : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unchanged">Unchanged ({selected.accessLevel})</SelectItem>
                      {['officer_only', 'board_council', 'members', 'public'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Redaction status</Label>
                  <Select value={transition.redactionStatus || 'unchanged'} onValueChange={(v) => setTransition({ ...transition, redactionStatus: v === 'unchanged' ? '' : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unchanged">Unchanged</SelectItem>
                      {['not_required', 'redacted', 'UNREDACTED_DO_NOT_PUBLISH'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Founder Consent id</Label>
                  <Input value={transition.consentId} onChange={(e) => setTransition({ ...transition, consentId: e.target.value })} placeholder="consents doc id" />
                </div>
                <div className="col-span-2">
                  <Label>Reason (appended to notes)</Label>
                  <Input value={transition.reason} onChange={(e) => setTransition({ ...transition, reason: e.target.value })} />
                </div>
              </div>
              <Button onClick={applyTransition}>Apply transition</Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>New record</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button variant={form.mode === 'family' ? 'default' : 'outline'} onClick={() => setForm({ ...form, mode: 'family' })}>
                <Plus className="h-4 w-4 mr-1" /> New family (v1)
              </Button>
              <Button variant={form.mode === 'version' ? 'default' : 'outline'} onClick={() => setForm({ ...form, mode: 'version' })}>
                <Plus className="h-4 w-4 mr-1" /> New version
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {form.mode === 'family' ? (
                <>
                  <div><Label>Slug</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="e.g. finance-policy" /></div>
                  <div>
                    <Label>Series</Label>
                    <Select value={form.series} onValueChange={(v) => setForm({ ...form, series: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{SERIES_OPTIONS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div><Label>Layer (suite only)</Label><Input value={form.layer} onChange={(e) => setForm({ ...form, layer: e.target.value })} placeholder="0, 1, 2 or blank" /></div>
                </>
              ) : (
                <div>
                  <Label>Family</Label>
                  <Select value={form.familyId} onValueChange={(v) => setForm({ ...form, familyId: v })}>
                    <SelectTrigger><SelectValue placeholder="Pick a family" /></SelectTrigger>
                    <SelectContent>{families.map(([f]) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
              <div><Label>Title</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
              <div><Label>Record date</Label><Input type="date" value={form.recordDate} onChange={(e) => setForm({ ...form, recordDate: e.target.value })} /></div>
              <div>
                <Label>Redaction status</Label>
                <Select value={form.redactionStatus} onValueChange={(v) => setForm({ ...form, redactionStatus: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UNREDACTED_DO_NOT_PUBLISH">UNREDACTED - DO NOT PUBLISH</SelectItem>
                    <SelectItem value="redacted">Redacted copy</SelectItem>
                    <SelectItem value="not_required">No redaction needed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Access level is always officer_only at creation, and version, hash and Drive fields are
              server-assigned. Change access later through Manage, where the redaction guard and consent
              gate run.
            </p>
            <Button onClick={createRecord}>Create record</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Seed checklist (spec 6.1)</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              The 10 governance documents, seeded by hand from the files Zubair holds, each as v1 of its
              family, marked UNREDACTED_DO_NOT_PUBLISH (they include the Founder CNIC) until redacted
              copies are uploaded as new versions. Nothing on this page writes seed data automatically.
            </p>
            <ul className="space-y-1 text-sm">
              {SEED_FAMILIES.map((f) => (
                <li key={f.slug} className="flex items-center gap-2">
                  <Badge variant={seededSlugs.has(f.slug) ? 'default' : 'outline'}>
                    {seededSlugs.has(f.slug) ? 'seeded' : 'pending'}
                  </Badge>
                  <span>{f.label}</span>
                  <span className="text-muted-foreground">({f.series})</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
