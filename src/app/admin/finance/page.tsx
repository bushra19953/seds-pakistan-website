'use client';

import { useState } from 'react';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import StarryBackground from '@/components/ui/starry-background';
import Footer from '@/components/layout/footer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useUser } from '@/firebase';
import { FINANCE_MAKER_CHECKER_ENFORCED } from '@/lib/finance/flags';
import { ApprovalsQueue } from './components/approvals-queue';
import { BudgetEditor } from './components/budget-editor';
import { LedgerTable } from './components/ledger-table';
import { ReconciliationForm } from './components/reconciliation-form';
import { ReceiptsInbox } from './components/receipts-inbox';
import { ReportsPanel } from './components/reports-panel';
import { DestinationsPanel } from './components/destinations-panel';

/**
 * Treasurer workspace (spec Part C 5.5). Records-and-evidence module
 * (Decision D12): the books of account live outside the site; this
 * workspace holds the budget, the entry ledger, reconciliations,
 * receipts, reports, and the maker-checker queue that governs every
 * money state change.
 */

const SECTIONS = [
  { id: 'approvals', label: 'Approvals' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'reconciliations', label: 'Reconciliations' },
  { id: 'receipts', label: 'Receipts' },
  { id: 'reports', label: 'Reports' },
  { id: 'destinations', label: 'Payment destinations' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export default function AdminFinancePage() {
  const { user } = useUser();
  const [section, setSection] = useState<SectionId>('approvals');

  return (
    <AuthorizationGate permission="canManageFinance">
      <div className="relative min-h-screen flex flex-col">
        <StarryBackground />
        <main className="flex-1 py-10">
          <div className="container mx-auto px-4 md:px-6">
            <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl">
              <CardHeader>
                <CardTitle className="text-2xl">Finance</CardTitle>
                <CardDescription>
                  Treasurer workspace: budgets, ledger, reconciliations, receipts, reports, and payment destinations.
                  Every money state change runs through maker-checker approval.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {!FINANCE_MAKER_CHECKER_ENFORCED && (
                  <div className="border border-amber-500/40 bg-amber-500/10 rounded-md p-3 text-sm">
                    Money controls are paused. Approval requests are unavailable right now; no fallback to
                    single-person changes is offered.
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {SECTIONS.map((s) => (
                    <Button
                      key={s.id}
                      size="sm"
                      variant={section === s.id ? 'default' : 'outline'}
                      onClick={() => setSection(s.id)}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>

                {!user ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : section === 'approvals' ? (
                  <ApprovalsQueue user={user} />
                ) : section === 'budgets' ? (
                  <BudgetEditor user={user} />
                ) : section === 'ledger' ? (
                  <LedgerTable user={user} />
                ) : section === 'reconciliations' ? (
                  <ReconciliationForm user={user} />
                ) : section === 'receipts' ? (
                  <ReceiptsInbox user={user} />
                ) : section === 'reports' ? (
                  <ReportsPanel user={user} userLabel={user.email || user.uid} />
                ) : (
                  <DestinationsPanel user={user} />
                )}
              </CardContent>
            </Card>
          </div>
        </main>
        <Footer />
      </div>
    </AuthorizationGate>
  );
}
