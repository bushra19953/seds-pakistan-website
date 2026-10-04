'use client';

import { useState, useEffect, Suspense, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { useAuthorization } from '@/hooks/use-authorization';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { format } from 'date-fns';
import { safeFormat } from '@/lib/date-utils';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Users,
  TrendingUp,
  BarChart3,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Rocket,
  FileDown,
  Loader2,
  Star
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────
interface WorkflowSummary {
  id: string;
  title: string;
  totalSteps: number;
  completedSteps: number;
  currentStepIndex: number;
  progressPercentage: number;
  isCompleted: boolean;
  participants: string[];
  createdAt: string;
  updatedAt: string;
  efficiencyScore?: number;
  overdueSteps?: number;
  description?: string;
  workflowDescription?: string;
  commanderStatement?: string;
}

interface WorkflowStep {
  id: string;
  title: string;
  description?: string;
  status: string;
  sequenceIndex: number;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeWhatsapp?: string;
  assigneeRole?: string;
  assigneePhoto?: string;
  assignees?: Array<{ id: string; name: string; photoURL?: string | null; role?: string | null; chapterName?: string | null }>;
  role?: string;
  individualDeadline?: string;
  isCurrentStep?: boolean;
  assigneeId?: string; // For profile linking
  points?: number;
  penaltyPoints?: number;
  workflowBonusPoints?: number;
  guidance?: string;
  stepInstructions?: string;
  workflowPriority?: 'low' | 'medium' | 'high' | 'critical';
  workflowTags?: string[];
  resources?: { type: 'link' | 'drive' | 'github' | 'doc' | 'video' | 'other'; url: string; title: string }[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────
async function urlToBase64(url: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) return undefined;
    
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Error converting URL to Base64:', error);
    return undefined;
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function getStatusBadge(workflow: WorkflowSummary) {
  if (workflow.isCompleted)
    return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Completed</Badge>;
  if (workflow.overdueSteps && workflow.overdueSteps > 0)
    return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Overdue</Badge>;
  if (workflow.progressPercentage > 0)
    return <Badge className="bg-sky-500/20 text-sky-400 border-sky-500/30">Active</Badge>;
  return <Badge className="bg-slate-500/20 text-muted-foreground border-slate-500/30">Pending</Badge>;
}

function getStepStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case 'completed': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    case 'in-progress': return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
    case 'submitted-for-review': return 'text-violet-400 bg-violet-500/10 border-violet-500/20';
    case 'overdue': return 'text-red-400 bg-red-500/10 border-red-500/20';
    default: return 'text-muted-foreground bg-slate-500/10 border-slate-500/20';
  }
}

function getStepIcon(status: string) {
  switch (status?.toLowerCase()) {
    case 'completed': return <CheckCircle className="h-4 w-4 text-emerald-400" />;
    case 'in-progress': return <Loader2 className="h-4 w-4 text-sky-400 animate-spin" />;
    case 'overdue': return <AlertTriangle className="h-4 w-4 text-red-400" />;
    default: return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

// ─── Step Row ─────────────────────────────────────────────────────────────────
function WorkflowStepRow({ step, index }: { step: WorkflowStep; index: number }) {
  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${getStepStatusColor(step.status)}`}>
      {/* Index circle */}
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-background/50 border border-current flex items-center justify-center text-xs font-bold">
        {index + 1}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {getStepIcon(step.status)}
          <span className="font-medium text-sm text-foreground truncate">{step.title}</span>
          {step.role && (
            <Badge variant="outline" className="text-[10px] border-current opacity-70">{step.role}</Badge>
          )}
        </div>

        {step.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{step.description}</p>
        )}

        {/* Assignee info — primary plus any co-assignees (in the loop) */}
        {step.assigneeName && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-foreground/80 font-medium">👤 {step.assigneeName}</span>
            {(step.assignees || []).filter(a => a.id !== step.assigneeId).map(a => (
              <span key={a.id} className="text-foreground/60">+ 👤 {a.name}{a.role ? ` (${a.role})` : ''}</span>
            ))}
            {step.assigneeEmail && (
              <a
                href={`mailto:${step.assigneeEmail}`}
                className="text-sky-400 hover:underline"
              >
                ✉ {step.assigneeEmail}
              </a>
            )}
            {step.assigneeWhatsapp && (
              <a
                href={`https://wa.me/${step.assigneeWhatsapp.replace(/\D/g, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:underline"
              >
                💬 {step.assigneeWhatsapp}
              </a>
            )}
            {step.individualDeadline && (
              <span className="text-amber-400">
                ⏰ {safeFormat(step.individualDeadline, 'MMM dd, yyyy')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Workflow Card ────────────────────────────────────────────────────────────
function WorkflowCard({ workflow, user }: { workflow: WorkflowSummary; user: any }) {
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [stepsLoaded, setStepsLoaded] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const { showToast: toast } = useEnhancedToast();

  const fetchSteps = useCallback(async () => {
    if (stepsLoaded || !user) return;
    setStepsLoading(true);
    try {
      const token = await user.getIdToken(true);
      const res = await fetch(`/api/workflows?workflowId=${encodeURIComponent(workflow.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch steps');
      const data = await res.json();
      setSteps(data.tasks || []);
      setStepsLoaded(true);
    } catch (e) {
      console.error('Steps fetch error:', e);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to load workflow steps.' });
    } finally {
      setStepsLoading(false);
    }
  }, [workflow.id, user, stepsLoaded]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !stepsLoaded) {
      fetchSteps();
    }
  };

  const handleExportPDF = async () => {
    setExportingPdf(true);
    try {
      // Ensure steps are loaded
      let pdfSteps = steps;
      let chapterName = '';
      
      if (!stepsLoaded) {
        await fetchSteps();
      }
      
      // Always fetch fresh data to get chapter info and full assignee details
      if (user) {
        const token = await user.getIdToken(true);
        const res = await fetch(`/api/workflows?workflowId=${encodeURIComponent(workflow.id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          pdfSteps = data.tasks || [];
          chapterName = data.chapterName || '';
        }
      }

      // Pre-process assignee photos to Base64 (primary + co-assignees)
      const processedSteps = await Promise.all(
        pdfSteps.map(async (s: WorkflowStep) => {
          let base64Photo = undefined;
          if (s.assigneePhoto) {
            base64Photo = await urlToBase64(s.assigneePhoto);
          }
          // Co-assignee names pass through; photos are skipped to keep the
          // personnel block a clean vertical stack (PDF layout rule).
          const processedAssignees = (s.assignees || []).map((a) => ({
            ...a,
          }));
          return {
            ...s,
            processedPhoto: base64Photo,
            processedAssignees,
          };
        })
      );

      const { exportWorkflowAsPDF } = await import('@/lib/workflow-pdf-export');
      await exportWorkflowAsPDF({
        id: workflow.id,
        title: workflow.title,
        progressPercentage: workflow.progressPercentage,
        totalSteps: workflow.totalSteps,
        completedSteps: workflow.completedSteps,
        isCompleted: workflow.isCompleted,
        chapterName,
        createdAt: workflow.createdAt,
        participants: workflow.participants,
        description: workflow.description || workflow.workflowDescription,
        commanderStatement: workflow.commanderStatement,
        steps: processedSteps.map((s) => ({
          id: (s as any).id,
          title: s.title,
          description: s.description,
          role: s.role || s.assigneeRole,
          assigneeName: s.assigneeName,
          assigneeEmail: s.assigneeEmail,
          assigneeWhatsapp: s.assigneeWhatsapp,
          assigneeChapter: (s as any).assigneeChapter || chapterName || undefined,
          assigneePhoto: s.processedPhoto,
          assignees: (s as any).processedAssignees?.map((a: any) => ({
            id: a.id,
            name: a.name,
            role: a.role || undefined,
            chapterName: a.chapterName || undefined,
          })),
          status: s.status,
          individualDeadline: s.individualDeadline,
          sequenceIndex: s.sequenceIndex,
          assigneeId: s.assigneeId,
          points: s.points,
          penaltyPoints: s.penaltyPoints,
          workflowBonusPoints: s.workflowBonusPoints,
          guidance: s.guidance,
          stepInstructions: s.stepInstructions,
          complexity: s.workflowPriority ? (s.workflowPriority === 'critical' ? 5 : s.workflowPriority === 'high' ? 4 : s.workflowPriority === 'medium' ? 3 : 2) : undefined,
          domain: s.workflowTags && s.workflowTags.length > 0 ? s.workflowTags[0] : undefined,
          resources: s.resources,
        })),
      });
    } catch (e: any) {
      console.error('PDF export error:', e);
      toast({ variant: 'destructive', title: 'PDF Error', description: e?.message || 'Failed to export PDF.' });
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div
      className={`rounded-xl border transition-all duration-300 overflow-hidden ${
        workflow.isCompleted
          ? 'border-emerald-500/20 bg-card/60'
          : workflow.overdueSteps && workflow.overdueSteps > 0
          ? 'border-red-500/20 bg-card/60'
          : 'border-primary/15 bg-card/70'
      }`}
    >
      {/* ── Collapsed Header ────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-muted/20 transition-colors select-none"
        onClick={handleToggle}
      >
        {/* Expand toggle */}
        <div className="flex-shrink-0 text-primary">
          {expanded ? (
            <ChevronDown className="h-5 w-5" />
          ) : (
            <Rocket className="h-5 w-5 transition-transform hover:rotate-12" />
          )}
        </div>

        {/* Title + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-foreground truncate">{workflow.title}</span>
            {getStatusBadge(workflow)}
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" /> {workflow.participants.length} member{workflow.participants.length !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center gap-1">
              <Star className="h-3 w-3" /> {workflow.completedSteps}/{workflow.totalSteps} steps
            </span>
            {workflow.efficiencyScore != null && (
              <span className="flex items-center gap-1 text-emerald-400">
                <TrendingUp className="h-3 w-3" /> {workflow.efficiencyScore}%
              </span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="hidden md:flex flex-col items-end gap-1 min-w-[120px]">
          <span className="text-xs text-muted-foreground">{workflow.progressPercentage}%</span>
          <Progress value={workflow.progressPercentage} className="h-1.5 w-28" />
        </div>

        {/* Created date */}
        <div className="hidden lg:block text-right text-xs text-muted-foreground min-w-[90px]">
          {safeFormat(workflow.createdAt, 'MMM dd, yyyy')}
        </div>

        {/* PDF button — stop propagation so it doesn't toggle the accordion */}
        <Button
          variant="outline"
          size="sm"
          className="flex-shrink-0 text-xs gap-1 border-primary/30 hover:border-primary hover:text-primary h-7 px-2"
          onClick={(e) => {
            e.stopPropagation();
            handleExportPDF();
          }}
          disabled={exportingPdf}
          title="Export PDF"
        >
          {exportingPdf ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileDown className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">PDF</span>
        </Button>
      </div>

      {/* ── Expanded Steps ───────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-border/30 p-4 bg-background/30 space-y-2 animate-in fade-in duration-200">
          {stepsLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : steps.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-6">
              No steps found for this workflow.
            </p>
          ) : (
            steps.map((step, i) => (
              <WorkflowStepRow key={step.id || i} step={step} index={step.sequenceIndex ?? i} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Inner Component ─────────────────────────────────────────────────────
function AdminWorkflowsPageInner() {
  const { user, isLoading: userLoading } = useUser();
  const { isAuthorized: canManageWorkflows, isLoading: authLoading } = useAuthorization('canManageWorkflows');
  const router = useRouter();
  const { showToast: toast } = useEnhancedToast();

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'completed' | 'overdue'>('all');
  const [sortBy, setSortBy] = useState<'created' | 'progress' | 'efficiency'>('created');


  useEffect(() => {
    if (!userLoading && !authLoading && user && canManageWorkflows) {
      fetchWorkflows();
    }
  }, [user, canManageWorkflows, userLoading, authLoading]);

  const fetchWorkflows = async () => {
    try {
      setLoading(true);
      setErrorMessage('');
      if (!user) throw new Error('User not authenticated');
      const idToken = await user.getIdToken(true);
      const response = await fetch('/api/workflows', {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        const msg = typeof err.error === 'string' ? err.error : 'Failed to fetch workflows';
        setErrorMessage(msg);
        throw new Error(msg);
      }
      const data = await response.json();
      setWorkflows(data.workflows || []);
    } catch (error) {
      console.error('Error fetching workflows:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to fetch workflows.' });
    } finally {
      setLoading(false);
    }
  };

  const filteredWorkflows = (() => {
    let list = [...workflows];
    switch (filterStatus) {
      case 'active':
        list = list.filter(w => !w.isCompleted && w.progressPercentage > 0);
        break;
      case 'completed':
        list = list.filter(w => w.isCompleted);
        break;
      case 'overdue':
        list = list.filter(w => w.overdueSteps && w.overdueSteps > 0);
        break;
    }
    list.sort((a, b) => {
      switch (sortBy) {
        case 'progress': return b.progressPercentage - a.progressPercentage;
        case 'efficiency': return (b.efficiencyScore || 0) - (a.efficiencyScore || 0);
        default: return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });
    return list;
  })();

  const analytics = {
    total: workflows.length,
    completed: workflows.filter(w => w.isCompleted).length,
    active: workflows.filter(w => !w.isCompleted && w.progressPercentage > 0).length,
    overdue: workflows.filter(w => w.overdueSteps && w.overdueSteps > 0).length,
  };

  if (userLoading || authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading mission control…</p>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageWorkflows">
      <>
      {/* ── Page Header ──────────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <Rocket className="h-8 w-8 text-primary" />
          <h1 className="text-4xl font-bold text-foreground">Mission Workflows</h1>
        </div>
        <p className="text-muted-foreground ml-11">
          Monitor and manage all mission workflows across the organization
        </p>
      </div>

      {/* ── Analytics Cards ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {[
          { label: 'Total Missions', value: analytics.total, icon: <BarChart3 className="h-4 w-4" />, color: 'text-primary' },
          { label: 'Completed', value: analytics.completed, icon: <CheckCircle className="h-4 w-4" />, color: 'text-emerald-400' },
          { label: 'Active', value: analytics.active, icon: <Clock className="h-4 w-4" />, color: 'text-sky-400' },
          { label: 'Overdue', value: analytics.overdue, icon: <AlertTriangle className="h-4 w-4" />, color: 'text-red-400' },
        ].map((stat) => (
          <Card key={stat.label} className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
              <span className={stat.color}>{stat.icon}</span>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="min-w-[180px]">
          <Label className="mb-1 block text-xs text-muted-foreground uppercase tracking-wide">Filter Status</Label>
          <Select value={filterStatus} onValueChange={(v: any) => setFilterStatus(v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Missions</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-[180px]">
          <Label className="mb-1 block text-xs text-muted-foreground uppercase tracking-wide">Sort By</Label>
          <Select value={sortBy} onValueChange={(v: any) => setSortBy(v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created">Recently Created</SelectItem>
              <SelectItem value="progress">Progress</SelectItem>
              <SelectItem value="efficiency">Efficiency</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" onClick={fetchWorkflows} disabled={loading} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* ── Workflows List ─────────────────────────────────────────────── */}
      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            Mission Overview
          </CardTitle>
          <CardDescription>
            {filteredWorkflows.length} of {workflows.length} missions shown · click a mission to expand steps
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : errorMessage ? (
            <div className="text-center py-8">
              <p className="text-destructive">Error: {errorMessage}</p>
              <Button className="mt-4" onClick={fetchWorkflows}>Retry</Button>
            </div>
          ) : filteredWorkflows.length > 0 ? (
            <div className="space-y-3">
              {filteredWorkflows.map((workflow) => (
                <WorkflowCard key={workflow.id} workflow={workflow} user={user} />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <Rocket className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">No missions found matching the current filters.</p>
            </div>
          )}
        </CardContent>
      </Card>
      </>
    </AuthorizationGate>
  );
}

export default function AdminWorkflowsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>}>
      <AdminWorkflowsPageInner />
    </Suspense>
  );
}