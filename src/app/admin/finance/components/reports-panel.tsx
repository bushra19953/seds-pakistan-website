'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { financeFetch, pkr, type FinanceUser } from './finance-api';
import {
  generateBalanceSheetPdf,
  generateIncomeExpenditurePdf,
  generateVariancePdf,
} from '@/lib/finance/pdf/finance-report-pdf';
import type { BalanceSheetSummary, IncomeExpenditureReport, VarianceReport } from '@/lib/finance/reports';

/**
 * Reports panel (spec Part C 5.5). Figures come only from the reporting
 * API (posted entries). The consentPending disclosure and the "no
 * payables ledger" note print on the PDFs when they apply. Every export
 * is audit-logged server-side before the data is returned.
 */

export function ReportsPanel({ user, userLabel }: { user: FinanceUser; userLabel: string }) {
  const { toast } = useToast();
  const [fy, setFy] = useState('fy2026-27');
  const [summary, setSummary] = useState<string>('');
  const [auditor, setAuditor] = useState({ auditorName: '', firmName: '', appointedBy: 'board', appointedAt: '', engagementLetterDriveId: '' });
  const [auditorNote, setAuditorNote] = useState<string>('');

  const meta = (consentPending?: boolean) => ({
    fyLabel: fy,
    generatedBy: userLabel,
    generatedAt: new Date().toISOString(),
    asOf: new Date().toISOString().slice(0, 10),
    consentPending,
  });

  const download = (doc: { save: (name: string) => void }, name: string) => doc.save(name);

  const loadIncomeExpenditure = async () => {
    const data = await financeFetch<{ report: IncomeExpenditureReport }>(
      user,
      `/api/admin/finance/reports?type=income-expenditure&fy=${fy}`,
    );
    setSummary(
      `Income ${pkr(data.report.totalIncomePkr)} - Expenditure ${pkr(data.report.totalExpensePkr)} - Net ${pkr(data.report.netPkr)}`,
    );
    download(generateIncomeExpenditurePdf(data.report, meta()), `income-expenditure-${fy}.pdf`);
  };

  const loadVariance = async () => {
    const data = await financeFetch<{ report: { variance: VarianceReport; consentPending: boolean } }>(
      user,
      `/api/admin/finance/reports?type=variance&fy=${fy}`,
    );
    setSummary(
      `Allocated ${pkr(data.report.variance.totalAllocatedPkr)} - Actual ${pkr(data.report.variance.totalActualPkr)} - Unbudgeted posted ${pkr(data.report.variance.unbudgetedPostedExpensePkr)}`,
    );
    download(generateVariancePdf(data.report.variance, meta(data.report.consentPending)), `variance-${fy}.pdf`);
  };

  const loadBalanceSheet = async () => {
    const data = await financeFetch<{ report: BalanceSheetSummary }>(
      user,
      `/api/admin/finance/reports?type=balance-sheet&asOf=${new Date().toISOString().slice(0, 10)}`,
    );
    setSummary(
      `Total funds held ${pkr(data.report.totalFundsHeldPkr)} - Related-party unreceipted note ${pkr(data.report.relatedPartyUnreceiptedNotePkr)}`,
    );
    download(generateBalanceSheetPdf(data.report, meta()), `balance-sheet-${fy}.pdf`);
  };

  const run = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
      toast({ title: 'Report generated', description: 'This export was written to the audit log.' });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Report failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const saveAuditor = async () => {
    try {
      const data = await financeFetch<{ fallback: boolean }>(user, '/api/admin/finance/auditor', {
        method: 'PUT',
        body: { fyLabel: fy, ...auditor, firmName: auditor.firmName || null },
      });
      setAuditorNote(
        data.fallback
          ? 'Recorded. This appointment was made by Founder fallback and is disclosed as such.'
          : 'Auditor appointment recorded.',
      );
    } catch (e) {
      toast({ variant: 'destructive', title: 'Save failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div>
            <Label>Financial year</Label>
            <Input value={fy} onChange={(e) => setFy(e.target.value)} className="w-32" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={run(loadIncomeExpenditure)}>Income & Expenditure PDF</Button>
          <Button onClick={run(loadVariance)}>Variance PDF</Button>
          <Button onClick={run(loadBalanceSheet)}>Balance Sheet Summary PDF</Button>
        </div>
        <p className="text-xs text-muted-foreground">Exports are logged: every report generation writes an audit entry before the file is produced.</p>
        {summary && <p className="text-sm">{summary}</p>}
      </div>

      <div className="border rounded-md p-3 space-y-3">
        <h3 className="font-semibold">External auditor appointment</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div><Label>Auditor name (chartered accountant)</Label><Input value={auditor.auditorName} onChange={(e) => setAuditor({ ...auditor, auditorName: e.target.value })} /></div>
          <div><Label>Firm name</Label><Input value={auditor.firmName} onChange={(e) => setAuditor({ ...auditor, firmName: e.target.value })} /></div>
          <div>
            <Label>Appointed by</Label>
            <Select value={auditor.appointedBy} onValueChange={(v) => setAuditor({ ...auditor, appointedBy: v })}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="board">Board</SelectItem>
                <SelectItem value="founder_fallback">Founder fallback</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Appointed at (date)</Label><Input type="date" value={auditor.appointedAt} onChange={(e) => setAuditor({ ...auditor, appointedAt: e.target.value })} /></div>
          <div><Label>Engagement letter Drive ID</Label><Input value={auditor.engagementLetterDriveId} onChange={(e) => setAuditor({ ...auditor, engagementLetterDriveId: e.target.value })} /></div>
          <Button variant="outline" onClick={saveAuditor}>Record appointment</Button>
        </div>
        {auditorNote && <p className="text-sm text-muted-foreground">{auditorNote}</p>}
      </div>
    </div>
  );
}
