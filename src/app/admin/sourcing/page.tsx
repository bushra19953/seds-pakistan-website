'use client';

import React, { useState, useEffect } from 'react';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { 
  Compass, 
  Search, 
  RefreshCw, 
  Clock, 
  Cpu, 
  DollarSign, 
  FileText, 
  Download, 
  ExternalLink, 
  Send, 
  ShieldCheck, 
  UserCheck, 
  AlertCircle,
  X,
  CheckCircle2,
  Phone,
  Mail,
  Building,
  Calendar,
  Layers,
  Wrench,
  Loader2
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';

interface SourcingInquiry {
  id: string;
  fullName: string;
  university: string;
  email: string;
  phone: string;
  affiliation: string;
  category: string;
  material: string;
  quantity: string;
  deadline?: string;
  tolerances?: string;
  ndaAgreed: boolean;
  fileDownloadUrl?: string;
  fileName?: string;
  fileSizeBytes?: number;
  status: 'pending_dfm_review' | 'dfm_assigned' | 'quote_ready' | 'in_production' | 'delivered';
  assignedEngineer?: string;
  quoteAmount?: string;
  leadTimeDays?: string;
  dfmNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export default function AdminSourcingPage() {
  const { toast } = useToast();
  const [inquiries, setInquiries] = useState<SourcingInquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedInquiry, setSelectedInquiry] = useState<SourcingInquiry | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isSendingQuote, setIsSendingQuote] = useState(false);

  // Modal edit form state
  const [editStatus, setEditStatus] = useState<string>('pending_dfm_review');
  const [assignedEngineer, setAssignedEngineer] = useState<string>('');
  const [quoteAmount, setQuoteAmount] = useState<string>('');
  const [leadTimeDays, setLeadTimeDays] = useState<string>('10–14 Days');
  const [dfmNotes, setDfmNotes] = useState<string>('');

  const fetchInquiries = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sourcing/inquiries');
      if (!res.ok) throw new Error('Failed to load sourcing inquiries');
      const data = await res.json();
      setInquiries(data.inquiries || []);
    } catch (err: any) {
      console.error(err);
      toast({
        title: 'Error Loading Inquiries',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInquiries();
  }, []);

  const openReviewModal = (inquiry: SourcingInquiry) => {
    setSelectedInquiry(inquiry);
    setEditStatus(inquiry.status || 'pending_dfm_review');
    setAssignedEngineer(inquiry.assignedEngineer || '');
    setQuoteAmount(inquiry.quoteAmount || '');
    setLeadTimeDays(inquiry.leadTimeDays || '10–14 Days');
    setDfmNotes(inquiry.dfmNotes || '');
  };

  const handleUpdateInquiry = async () => {
    if (!selectedInquiry) return;
    setIsUpdating(true);
    try {
      const res = await fetch(`/api/sourcing/inquiries/${selectedInquiry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: editStatus,
          assignedEngineer,
          quoteAmount,
          leadTimeDays,
          dfmNotes,
        }),
      });

      if (!res.ok) throw new Error('Failed to update inquiry');
      
      toast({
        title: '✓ Inquiry Updated',
        description: 'Status and engineer assignment recorded successfully.',
      });

      // Refresh list & update selected
      await fetchInquiries();
      setSelectedInquiry((prev) => prev ? {
        ...prev,
        status: editStatus as any,
        assignedEngineer,
        quoteAmount,
        leadTimeDays,
        dfmNotes,
      } : null);
    } catch (err: any) {
      toast({
        title: 'Update Failed',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSendQuoteEmail = async () => {
    if (!selectedInquiry) return;
    if (!quoteAmount.trim() && !dfmNotes.trim()) {
      toast({
        title: 'Quote Amount or DFM Notes Required',
        description: 'Please type a Quote Amount (e.g. $420 USD) or DFM Feasibility Notes before dispatching the email.',
        variant: 'destructive',
      });
      return;
    }

    setIsSendingQuote(true);
    try {
      const res = await fetch(`/api/sourcing/inquiries/${selectedInquiry.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteAmount,
          leadTimeDays,
          dfmNotes,
          notifyApplicant: true,
        }),
      });

      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(resData.error || 'Failed to dispatch quote email');
      }

      toast({
        title: '✓ DFM Quote Email Dispatched',
        description: `Official quote and engineering notes emailed to ${selectedInquiry.email}`,
      });

      setEditStatus('quote_ready');
      await fetchInquiries();
      if (selectedInquiry) {
        setSelectedInquiry({
          ...selectedInquiry,
          status: 'quote_ready',
          quoteAmount,
          leadTimeDays,
          dfmNotes,
        });
      }
    } catch (err: any) {
      toast({
        title: 'Email Dispatch Failed',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setIsSendingQuote(false);
    }
  };

  // KPIs
  const totalCount = inquiries.length;
  const pendingCount = inquiries.filter((i) => i.status === 'pending_dfm_review').length;
  const assignedCount = inquiries.filter((i) => i.status === 'dfm_assigned').length;
  const quotedCount = inquiries.filter((i) => i.status === 'quote_ready' || i.status === 'in_production').length;

  // Filtered List
  const filteredInquiries = inquiries.filter((item) => {
    const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
    const query = searchQuery.toLowerCase().trim();
    const matchesSearch = 
      !query ||
      item.university?.toLowerCase().includes(query) ||
      item.fullName?.toLowerCase().includes(query) ||
      item.email?.toLowerCase().includes(query) ||
      item.category?.toLowerCase().includes(query) ||
      item.material?.toLowerCase().includes(query);
    return matchesStatus && matchesSearch;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending_dfm_review':
        return <Badge variant="outline" className="border-primary/40 text-primary bg-primary/10 font-accent uppercase text-[10px] tracking-wider">Pending 48h DFM</Badge>;
      case 'dfm_assigned':
        return <Badge variant="outline" className="border-accent/40 text-accent bg-accent/10 font-accent uppercase text-[10px] tracking-wider">DFM Assigned</Badge>;
      case 'quote_ready':
        return <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 bg-emerald-950/30 font-accent uppercase text-[10px] tracking-wider">Quote Delivered</Badge>;
      case 'in_production':
        return <Badge variant="outline" className="border-cyan-500/40 text-cyan-400 bg-cyan-950/30 font-accent uppercase text-[10px] tracking-wider">In Spindle / SMT</Badge>;
      case 'delivered':
        return <Badge variant="outline" className="border-gray-500/40 text-gray-300 bg-gray-900 font-accent uppercase text-[10px] tracking-wider">Delivered</Badge>;
      default:
        return <Badge variant="outline" className="font-accent uppercase text-[10px]">{status}</Badge>;
    }
  };

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-8 max-w-7xl mx-auto pb-16">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/40 pb-6">
          <div>
            <div className="flex items-center gap-2 mb-1 text-xs font-accent text-primary uppercase tracking-widest">
              <Compass className="w-4 h-4 text-primary" />
              <span>SJTU Shanghai Liaison Hub</span>
            </div>
            <h1 className="text-3xl sm:text-5xl font-headline tracking-wide text-foreground uppercase text-glow">
              SEDS Sourcing Bridge Console
            </h1>
            <p className="text-sm text-muted-foreground font-body max-w-2xl">
              Review collegiate CAD files, assign Shanghai DFM engineering fellows, track benchmark quotes, and manage aerospace manufacturing pipelines.
            </p>
          </div>
          <Button
            onClick={fetchInquiries}
            disabled={loading}
            variant="outline"
            className="border-accent/30 font-accent uppercase tracking-wider text-xs flex items-center gap-2 self-start sm:self-auto"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-primary' : ''}`} />
            <span>Refresh Feed</span>
          </Button>
        </div>

        {/* 4 KPI Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="bg-card/80 backdrop-blur-md border-accent/20 shadow-lg shadow-accent/5">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-accent uppercase tracking-wider text-muted-foreground mb-1">Total Packages</p>
                <div className="text-3xl font-headline text-foreground tracking-wide text-glow">{totalCount}</div>
                <p className="text-[11px] text-muted-foreground font-body mt-0.5">Collegiate intake requests</p>
              </div>
              <div className="p-3 rounded-xl bg-primary/10 text-primary border border-primary/20">
                <Layers className="w-5 h-5" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/80 backdrop-blur-md border-accent/20 shadow-lg shadow-accent/5">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-accent uppercase tracking-wider text-primary mb-1">Pending 48H DFM</p>
                <div className="text-3xl font-headline text-primary tracking-wide text-glow">{pendingCount}</div>
                <p className="text-[11px] text-muted-foreground font-body mt-0.5">Awaiting geometric review</p>
              </div>
              <div className="p-3 rounded-xl bg-primary/10 text-primary border border-primary/20">
                <Clock className="w-5 h-5" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/80 backdrop-blur-md border-accent/20 shadow-lg shadow-accent/5">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-accent uppercase tracking-wider text-accent mb-1">Active DFM Reviews</p>
                <div className="text-3xl font-headline text-accent tracking-wide text-glow">{assignedCount}</div>
                <p className="text-[11px] text-muted-foreground font-body mt-0.5">Assigned to SJTU fellows</p>
              </div>
              <div className="p-3 rounded-xl bg-accent/10 text-accent border border-accent/20">
                <UserCheck className="w-5 h-5" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/80 backdrop-blur-md border-accent/20 shadow-lg shadow-accent/5">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-accent uppercase tracking-wider text-emerald-400 mb-1">Quoted &amp; Spindles</p>
                <div className="text-3xl font-headline text-emerald-400 tracking-wide text-glow">{quotedCount}</div>
                <p className="text-[11px] text-muted-foreground font-body mt-0.5">Benchmark rates delivered</p>
              </div>
              <div className="p-3 rounded-xl bg-emerald-950/40 text-emerald-400 border border-emerald-500/30">
                <DollarSign className="w-5 h-5" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filter Controls & Search */}
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 bg-card/60 p-4 rounded-xl border border-accent/20 backdrop-blur-md">
          {/* Search Input */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search university, lead name, material, category..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-background/80 border-border text-foreground font-body text-xs"
            />
          </div>

          {/* Status Filter Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'all', label: 'All' },
              { id: 'pending_dfm_review', label: 'Pending DFM' },
              { id: 'dfm_assigned', label: 'Assigned' },
              { id: 'quote_ready', label: 'Quote Ready' },
              { id: 'in_production', label: 'In Production' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-accent uppercase tracking-wider transition-all cursor-pointer ${
                  statusFilter === tab.id
                    ? 'bg-primary text-primary-foreground font-semibold shadow-md shadow-primary/20 border border-primary/40'
                    : 'bg-background/80 text-muted-foreground hover:text-foreground border border-border'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Sourcing Inquiries Table */}
        <div className="rounded-2xl border border-accent/20 bg-card/80 backdrop-blur-md overflow-hidden shadow-xl shadow-accent/5">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-accent/10 border-b border-border/40 text-[11px] font-accent uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-5 py-3.5">University &amp; Lead</th>
                  <th className="px-5 py-3.5">Hardware Category</th>
                  <th className="px-5 py-3.5">Material &amp; Scope</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">Assigned Fellow</th>
                  <th className="px-5 py-3.5">CAD Package</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20 font-body text-xs">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        <span>Loading sourcing pipeline from Firestore...</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredInquiries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                      No sourcing inquiries match the selected filter.
                    </td>
                  </tr>
                ) : (
                  filteredInquiries.map((inquiry) => (
                    <tr key={inquiry.id} className="hover:bg-accent/5 transition-colors">
                      {/* University & Lead */}
                      <td className="px-5 py-4">
                        <div className="font-semibold text-foreground text-sm">{inquiry.university}</div>
                        <div className="text-muted-foreground text-xs">{inquiry.fullName}</div>
                        <div className="text-[11px] text-muted-foreground/80 font-mono">{inquiry.email}</div>
                      </td>

                      {/* Category */}
                      <td className="px-5 py-4">
                        <span className="font-medium text-foreground">{inquiry.category}</span>
                        <div className="text-[11px] text-muted-foreground">{inquiry.affiliation}</div>
                      </td>

                      {/* Material & Quantity */}
                      <td className="px-5 py-4">
                        <div className="text-foreground">{inquiry.material || 'Aerospace Spec'}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">Qty: {inquiry.quantity}</div>
                      </td>

                      {/* Status */}
                      <td className="px-5 py-4">
                        {getStatusBadge(inquiry.status)}
                      </td>

                      {/* Assigned Fellow */}
                      <td className="px-5 py-4">
                        {inquiry.assignedEngineer ? (
                          <span className="text-accent font-medium">{inquiry.assignedEngineer}</span>
                        ) : (
                          <span className="text-muted-foreground/60 italic">Unassigned</span>
                        )}
                      </td>

                      {/* CAD Package */}
                      <td className="px-5 py-4">
                        {inquiry.fileDownloadUrl && (inquiry.fileDownloadUrl.startsWith('http://') || inquiry.fileDownloadUrl.startsWith('https://') || inquiry.fileDownloadUrl.startsWith('/')) ? (
                          <a
                            href={inquiry.fileDownloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => {
                              if (inquiry.fileDownloadUrl?.includes('storage.sedspakistan.org') || inquiry.fileDownloadUrl?.startsWith('/api/sourcing/download/1788352888412')) {
                                e.preventDefault();
                                toast({
                                  title: 'Legacy Prototype Record',
                                  description: 'This record was submitted during prototype testing before live storage linking. New submissions open/download directly.',
                                });
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent/10 border border-accent/25 text-accent hover:text-primary hover:border-primary/40 transition-colors text-xs font-mono"
                          >
                            {inquiry.fileDownloadUrl.includes('drive.google.com') || inquiry.fileDownloadUrl.includes('dropbox.com') || inquiry.fileDownloadUrl.includes('grabcad.com') || inquiry.fileDownloadUrl.includes('github.com') ? (
                              <>
                                <ExternalLink className="w-3.5 h-3.5 text-primary" />
                                <span className="truncate max-w-[120px]">Open CAD Link</span>
                              </>
                            ) : (
                              <>
                                <Download className="w-3.5 h-3.5" />
                                <span className="truncate max-w-[120px]">{inquiry.fileName || 'CAD File'}</span>
                              </>
                            )}
                          </a>
                        ) : inquiry.fileDownloadUrl ? (
                          <span className="text-muted-foreground/80 text-xs italic truncate max-w-[140px] block" title={inquiry.fileDownloadUrl}>
                            {inquiry.fileDownloadUrl}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 text-xs">No File</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-5 py-4 text-right">
                        <Button
                          onClick={() => openReviewModal(inquiry)}
                          size="sm"
                          variant="outline"
                          className="border-primary/40 text-primary hover:bg-primary/10 font-accent uppercase tracking-wider text-[10px] h-8"
                        >
                          Review &amp; DFM
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detailed Review & Quote Modal */}
        {selectedInquiry && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-accent/30 bg-card p-6 sm:p-8 shadow-2xl space-y-6">
              {/* Close Button */}
              <button
                onClick={() => setSelectedInquiry(null)}
                className="absolute top-5 right-5 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/10 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>

              {/* Modal Header */}
              <div className="border-b border-border/40 pb-4">
                <div className="flex items-center gap-2 text-xs font-accent text-primary uppercase tracking-wider mb-1">
                  <ShieldCheck className="w-4 h-4 text-primary" />
                  <span>Confidential Engineering Intake Review</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-headline tracking-wide text-foreground uppercase">
                  {selectedInquiry.university} · {selectedInquiry.category}
                </h2>
                <p className="text-xs text-muted-foreground font-body mt-0.5">
                  Package ID: <span className="font-mono">{selectedInquiry.id}</span> · Submitted: {new Date(selectedInquiry.createdAt).toLocaleString()}
                </p>
              </div>

              {/* 2-Column Info Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-body">
                <div className="p-4 rounded-xl bg-background/80 border border-border space-y-2">
                  <div className="text-xs font-accent uppercase tracking-wider text-muted-foreground mb-1 font-semibold">Lead Contact Information</div>
                  <div className="flex items-center gap-2"><UserCheck className="w-3.5 h-3.5 text-primary" /><span className="font-medium text-foreground">{selectedInquiry.fullName}</span></div>
                  <div className="flex items-center gap-2"><Mail className="w-3.5 h-3.5 text-accent" /><a href={`mailto:${selectedInquiry.email}`} className="text-accent underline font-mono">{selectedInquiry.email}</a></div>
                  <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 text-emerald-400" /><a href={`tel:${selectedInquiry.phone}`} className="text-emerald-400 font-mono">{selectedInquiry.phone}</a></div>
                  <div className="flex items-center gap-2"><Building className="w-3.5 h-3.5 text-muted-foreground" /><span>Chapter: {selectedInquiry.affiliation}</span></div>
                </div>

                <div className="p-4 rounded-xl bg-background/80 border border-border space-y-2">
                  <div className="text-xs font-accent uppercase tracking-wider text-muted-foreground mb-1 font-semibold">Technical Specifications</div>
                  <div><strong>Required Quantity:</strong> <span className="font-mono text-foreground">{selectedInquiry.quantity}</span></div>
                  <div><strong>Material &amp; Finish:</strong> <span className="text-foreground">{selectedInquiry.material || 'Standard Spec'}</span></div>
                  {selectedInquiry.deadline && <div><strong>Target Launch Date:</strong> <span className="text-primary font-mono">{selectedInquiry.deadline}</span></div>}
                  {selectedInquiry.tolerances && (
                    <div className="pt-1">
                      <strong>Critical Tolerances / GD&amp;T:</strong>
                      <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">{selectedInquiry.tolerances}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* CAD File Download Banner */}
              {selectedInquiry.fileDownloadUrl && (
                <div className="p-4 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileText className="w-6 h-6 text-primary" />
                    <div>
                      <div className="font-medium text-sm text-foreground">{selectedInquiry.fileName || 'Engineering CAD Archive'}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {selectedInquiry.fileSizeBytes ? `${(selectedInquiry.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB · Direct Cloud Storage` : 'Confidential Engineering Link'}
                      </div>
                    </div>
                  </div>
                  {selectedInquiry.fileDownloadUrl.startsWith('http://') || selectedInquiry.fileDownloadUrl.startsWith('https://') || selectedInquiry.fileDownloadUrl.startsWith('/') ? (
                    <a
                      href={selectedInquiry.fileDownloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => {
                        if (selectedInquiry.fileDownloadUrl?.includes('storage.sedspakistan.org') || selectedInquiry.fileDownloadUrl?.startsWith('/api/sourcing/download/1788352888412')) {
                          e.preventDefault();
                          toast({
                            title: 'Legacy Prototype Record',
                            description: 'This record was submitted during prototype testing before live storage linking. New submissions open/download directly.',
                          });
                        }
                      }}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground font-accent tracking-wider uppercase text-xs px-4 py-2 rounded-lg flex items-center gap-2 font-semibold shadow-md pulse-glow cursor-pointer"
                    >
                      {selectedInquiry.fileDownloadUrl.includes('drive.google.com') || selectedInquiry.fileDownloadUrl.includes('dropbox.com') || selectedInquiry.fileDownloadUrl.includes('grabcad.com') || selectedInquiry.fileDownloadUrl.includes('github.com') ? (
                        <>
                          <ExternalLink className="w-4 h-4" />
                          <span>Open CAD Package</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          <span>Download CAD</span>
                        </>
                      )}
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">{selectedInquiry.fileDownloadUrl}</span>
                  )}
                </div>
              )}

              {/* Form Controls for Review & Engineer Assignment */}
              <div className="border-t border-border/40 pt-5 space-y-4">
                <div className="text-xs font-accent uppercase tracking-wider text-primary font-semibold">
                  DFM Workflow &amp; Benchmark Pricing Controls
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Status Dropdown */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-accent uppercase tracking-wider">Lifecycle Status</Label>
                    <select
                      value={editStatus}
                      onChange={(e) => setEditStatus(e.target.value)}
                      className="w-full h-10 px-3 py-2 rounded-lg bg-background border border-border text-foreground font-body text-xs focus:ring-2 focus:ring-primary focus:outline-none"
                    >
                      <option value="pending_dfm_review">Pending 48h DFM</option>
                      <option value="dfm_assigned">DFM Assigned to SJTU Fellow</option>
                      <option value="quote_ready">Quote Delivered to Team</option>
                      <option value="in_production">In Production / Active Spindle</option>
                      <option value="delivered">Delivered to Campus</option>
                    </select>
                  </div>

                  {/* Assign Engineer */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-accent uppercase tracking-wider">Assigned DFM Fellow / Engineer</Label>
                    <Input
                      placeholder="e.g. SJTU Fellow / Muhammad Zubair"
                      value={assignedEngineer}
                      onChange={(e) => setAssignedEngineer(e.target.value)}
                      className="bg-background border-border text-foreground font-body text-xs"
                    />
                  </div>

                  {/* Benchmark Quote Amount */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-accent uppercase tracking-wider">Benchmark Quote Amount</Label>
                    <Input
                      placeholder="e.g. $420 USD (Includes 5-Axis + FAI)"
                      value={quoteAmount}
                      onChange={(e) => setQuoteAmount(e.target.value)}
                      className="bg-background border-border text-foreground font-body text-xs"
                    />
                  </div>

                  {/* Lead Time */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-accent uppercase tracking-wider">Production + Air Lead Time</Label>
                    <Input
                      placeholder="e.g. 10–14 Days Spindle + Express"
                      value={leadTimeDays}
                      onChange={(e) => setLeadTimeDays(e.target.value)}
                      className="bg-background border-border text-foreground font-body text-xs"
                    />
                  </div>
                </div>

                {/* DFM Feasibility Notes */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-accent uppercase tracking-wider">DFM Feedback &amp; Toolpath Feasibility Notes</Label>
                  <Textarea
                    rows={3}
                    placeholder="Enter geometric feedback, minimum wall thickness warnings, or surface finish notes for the applicant..."
                    value={dfmNotes}
                    onChange={(e) => setDfmNotes(e.target.value)}
                    className="bg-background border-border text-foreground font-body text-xs"
                  />
                </div>

                {/* Modal Actions */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-4 border-t border-border/40">
                  <Button
                    onClick={handleUpdateInquiry}
                    disabled={isUpdating}
                    variant="outline"
                    className="border-border font-accent uppercase tracking-wider text-xs"
                  >
                    {isUpdating ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                    <span>Save Internal Updates</span>
                  </Button>

                  <Button
                    onClick={handleSendQuoteEmail}
                    disabled={isSendingQuote}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground font-accent tracking-widest uppercase text-xs font-semibold py-2.5 px-5 shadow-lg shadow-primary/30 pulse-glow flex items-center gap-2"
                  >
                    {isSendingQuote ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    <span>Dispatch Official Quote Email</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthorizationGate>
  );
}
