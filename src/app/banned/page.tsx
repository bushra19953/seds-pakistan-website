"use client";

/**
 * /banned - reworked by the Phase 2 discipline rebuild (spec E.5).
 *
 * There is no "appeal" anymore, and there is no appeal-submitted state
 * to show. A member expelled by a Board vote sees their case number,
 * the vote reference, and the exact Founder-review position. A member
 * whose ban predates the case system sees a factual notice only.
 */
import { useEffect, useState } from 'react';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

const FOUNDER_REVIEW_COPY =
    "Founder review: the Founder may review any disciplinary decision and may uphold it, reduce the sanction, revoke the sanction, or reinstate the member. There is no appeal to an administrator.";

type ExpulsionCase = { caseId: string; caseNumber: string; boardVoteId: string | null };

export default function BannedPage() {
    const [expulsion, setExpulsion] = useState<ExpulsionCase | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/discipline/my-cases', { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    const found = (data.cases || []).find(
                        (c: any) => c.decision === 'strike3' && (c.status === 'closed' || c.status === 'sanction_applied')
                    );
                    if (found) {
                        setExpulsion({
                            caseId: found.caseId,
                            caseNumber: found.caseNumber,
                            boardVoteId: found.boardVoteId || null,
                        });
                    }
                }
            } catch {
                /* fall through to the factual notice */
            } finally {
                setLoaded(true);
            }
        })();
    }, []);

    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-background text-foreground text-center">
            <div className="max-w-md space-y-6">
                <div className="mx-auto w-24 h-24 bg-red-100 rounded-full flex items-center justify-center mb-6">
                    <Ban className="w-12 h-12 text-red-600" />
                </div>
                <h1 className="text-3xl font-bold tracking-tight">Membership Ended</h1>
                {expulsion ? (
                    <p className="text-muted-foreground">
                        Your membership was ended by a vote of the Board of Governors in case{' '}
                        <strong>{expulsion.caseNumber}</strong>
                        {expulsion.boardVoteId ? (
                            <>
                                {' '}(Board vote reference: <strong>{expulsion.boardVoteId}</strong>)
                            </>
                        ) : null}
                        . Access to this platform is restricted.
                    </p>
                ) : (
                    <p className="text-muted-foreground">
                        Your access to this platform is restricted.
                    </p>
                )}
                <div className="p-4 bg-muted/50 rounded-lg border border-border text-sm text-left">
                    {FOUNDER_REVIEW_COPY}
                </div>
                {loaded && expulsion && (
                    <div className="pt-2">
                        <Link href={`/profile/discipline/${expulsion.caseId}`}>
                            <Button>View your case and request Founder review</Button>
                        </Link>
                    </div>
                )}
                <div className="pt-2">
                    <Link href="/auth/login">
                        <Button variant="outline">Return to Login</Button>
                    </Link>
                </div>
            </div>
        </div>
    );
}
